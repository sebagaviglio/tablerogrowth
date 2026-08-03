/* ============================================================
   POST /api/growth-assistant
   body: { message: string, history: [{role:'user'|'assistant', content:string}] }
   resp: { reply: string, dataAsOf: string }

   Env vars requeridas (Vercel → cada Environment → Environment Variables):
     ANTHROPIC_API_KEY        sk-ant-...
     GROWTH_SHEET_SCRIPT_URL  URL del Apps Script Web App (el mismo que
                               usa el dashboard). Ej:
     https://script.google.com/macros/s/AKfycbw.../exec

   Contrato del Apps Script: GET ?tab=NombreDePestaña devuelve el CSV
   crudo de esa pestaña (o un string "ERROR: ..." si algo falla). No hay
   endpoint de resumen — por eso esta función pide "Plan Anual" (objetivos)
   y la pestaña del mes en curso (datos reales) por separado, y le pasa
   ambos CSV a Claude junto con la lógica para interpretarlos.

   La API key NUNCA se expone al browser: esta función corre server-side.
   ============================================================ */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEET_SCRIPT_URL = process.env.GROWTH_SHEET_SCRIPT_URL;
const MODEL = 'claude-sonnet-5';

// Cache liviano en memoria (vive mientras la instancia serverless esté "warm")
let dataCache = { payload: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en Vercel.' });
    return;
  }

  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Falta "message".' });
      return;
    }

    const liveContext = await getLiveContext();
    const systemPrompt = buildSystemPrompt(liveContext);

    const messages = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: message });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        system: systemPrompt,
        messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error', response.status, errText);
      res.status(502).json({ error: 'El asistente no pudo responder. Probá de nuevo.' });
      return;
    }

    const data = await response.json();
    const reply = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    res.status(200).json({
      reply: reply || 'No tengo una respuesta clara para eso — ¿podés reformular la pregunta?',
      dataAsOf: liveContext.fetchedAt
    });
  } catch (err) {
    console.error('growth-assistant handler error', err);
    res.status(500).json({ error: 'Error interno del asistente.' });
  }
};

/* ------------------------------------------------------------ *
 * Datos en vivo del Google Sheet (vía el Apps Script existente) *
 * Contrato real del script: GET ?tab=NombreDePestaña devuelve   *
 * el CSV crudo de esa única pestaña (o "ERROR: ..." como texto  *
 * si algo falla). No existe un endpoint de "resumen" — hay que  *
 * pedir "Plan Anual" (objetivos) y la pestaña del mes en curso  *
 * (datos reales) por separado.                                 *
 * ------------------------------------------------------------ */
const MONTH_TABS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

async function fetchTab(tabName) {
  const url = SHEET_SCRIPT_URL + '?tab=' + encodeURIComponent(tabName);
  const r = await fetch(url, { method: 'GET' });
  const text = await r.text();
  if (text.trim().startsWith('ERROR')) {
    throw new Error(`Pestaña "${tabName}": ${text.trim()}`);
  }
  return text;
}

async function getLiveContext() {
  const now = Date.now();
  if (dataCache.payload && now - dataCache.fetchedAt < CACHE_TTL_MS) {
    return dataCache.payload;
  }

  if (!SHEET_SCRIPT_URL) {
    return { planAnualCsv: null, monthCsv: null, fetchedAt: new Date().toISOString(), error: 'GROWTH_SHEET_SCRIPT_URL no configurada' };
  }

  const monthTabName = MONTH_TABS[new Date().getMonth()];

  try {
    const [planAnualCsv, monthCsv] = await Promise.all([
      fetchTab('Plan Anual'),
      fetchTab(monthTabName)
    ]);

    const payload = {
      planAnualCsv: planAnualCsv.slice(0, 5000),
      monthTabName,
      monthCsv: monthCsv.slice(0, 7000),
      fetchedAt: new Date().toISOString()
    };
    dataCache = { payload, fetchedAt: now };
    return payload;
  } catch (err) {
    console.error('No se pudo leer el Sheet en vivo', err);
    return { planAnualCsv: null, monthCsv: null, monthTabName, fetchedAt: new Date().toISOString(), error: String(err.message || err) };
  }
}

/* ------------------------------------------------------------ *
 * System prompt: conocimiento de Growth + contexto Bancor +    *
 * tono + límites                                                *
 * ------------------------------------------------------------ */
function buildSystemPrompt(liveContext) {
  const dataBlock = liveContext.planAnualCsv && liveContext.monthCsv
    ? `Datos crudos leídos en vivo del Sheet (${liveContext.fetchedAt}).

--- Pestaña "Plan Anual" (objetivos mensuales, fuente de verdad) ---
${liveContext.planAnualCsv}

--- Pestaña "${liveContext.monthTabName}" (mes en curso, datos reales día a día) ---
${liveContext.monthCsv}

Cómo leer estos CSV:
- "Plan Anual": columnas Squad | Producto | KPI / Métrica | Ene...Dic. Cada celda de
  mes es el objetivo de ese producto para ese mes. Usá SIEMPRE esta pestaña para la
  meta mensual — nunca la fila "META MES" de la pestaña del mes (tiene un desalineamiento
  de columna conocido en Habitualidad/Jun, así que ese dato no es confiable ahí).
- Pestaña del mes en curso: por cada squad hay un bloque que arranca con una fila
  "SQUAD · PO: nombre · Own: nombre", seguido de una grilla diaria (columnas: Día |
  Fecha | producto1 | producto2 ... | TOTAL) hasta una fila "TOTAL ACUM" (ese es el
  acumulado real de cada producto a la fecha). Ignorá las filas "META MES",
  "% CUMPL.", "META PROP." y "% vs M.PROP" de esta pestaña — el dashboard ya sabe
  que están desalineadas y las recalcula solo desde Plan Anual; hacé lo mismo vos.
- Para calcular ritmo de un producto: tomá su objetivo mensual de Plan Anual (columna
  del mes en curso), prorrateado a la cantidad de días con carga real (filas con datos
  antes de "TOTAL ACUM"), y comparalo contra el acumulado real de esa fila.`
    : `No se pudo leer el Sheet en vivo en este momento (${liveContext.error || 'sin detalle'}). Trabajá solo con lo que el usuario te cuente y avisale explícitamente que no tenés los números actualizados a mano.`;

  return `Sos el Asistente de Growth de Bancor: un consultor senior de Growth Digital
integrado al Tablero de Growth, que usan los 4 squads (Adquisición y Crosselling,
Habitualidad, Bezza Hub, Empresas) y sus POs para seguir su avance contra los
objetivos anuales.

# Conocimiento de base (Growth Digital)
Manejás con solvencia, y aplicás cuando corresponde:
- Frameworks de funnel y loops: AARRR (Acquisition, Activation, Retention, Referral,
  Revenue), growth loops vs. funnels lineales, North Star Metric y métricas de input.
- Activación y hábito: Hook Model, time-to-value, aha-moment, curvas de retención
  (D1/D7/D30), cohortes.
- Priorización y experimentación: ICE/RICE, diseño de experimentos A/B, significancia
  estadística básica, MVP de experimento antes de invertir en desarrollo.
- Unit economics: CAC, LTV, payback period, contribution margin — aplicados a
  productos financieros/fintech cuando sea relevante.
- Crosselling y expansión en base instalada, PLG vs. growth sales-assisted,
  lifecycle marketing (onboarding, reactivación, prevención de churn).
- Particularidades de growth en banca/fintech: regulación, fricción de KYC,
  confianza como driver de conversión, estacionalidad de medios de pago.

# El concepto de "ritmo" (específico de este tablero)
ritmo = acumulado real ÷ objetivo prorrateado a los días con carga real.
No se compara contra la meta del mes completo (sería injusto a mitad de mes) sino
contra "lo que deberíamos llevar acumulado a esta altura". ≥100% = en línea o por
encima. 85-100% = para vigilar. ≤85% = atrasado. Usá esta lógica siempre que
alguien pregunte por avance, atraso o performance de un squad o producto.

# Datos del negocio
${dataBlock}

# Tono
Hablás como una persona real del equipo, no como un bot corporativo: directo,
cálido, sin tecnicismos innecesarios, con ritmo natural. Frases cortas. Si hay
buenas noticias en los datos, transmitilo con energía; si hay un atraso, decilo
sin rodeos pero constructivamente — el objetivo es que la persona sepa qué hacer
después de leerte, no que se sienta juzgada. Español neutro rioplatense.
Respuestas breves y accionables por default (2-5 oraciones o una lista corta);
si piden profundidad, la das.

# Límites — segui esto siempre
1. Nunca inventes cifras. Si un número no está en "Datos del negocio" ni te lo
   dio la persona, decilo explícitamente ("no tengo ese dato a mano") en vez de
   estimarlo como si fuera real.
2. Marcá siempre la diferencia entre "según tus datos" (lo que sacás del Sheet)
   y "como práctica general de growth" (conocimiento externo/benchmark de
   mercado) — nunca las mezcles sin aclarar cuál es cuál.
3. No dés asesoramiento financiero, legal, crediticio ni de riesgo — tu dominio
   es growth, producto y marketing digital. Si preguntan eso, redirigí con
   amabilidad a quien corresponda.
4. No espectules ni expongas datos personales de clientes finales (PII). Trabajás
   con métricas agregadas de squads/productos, no con datos individuales.
5. Si preguntan algo totalmente fuera del alcance de Growth Bancor, decilo con
   buena onda y traé la conversación de vuelta a lo que sí podés ayudar.
6. Si el Sheet no se pudo leer en vivo, decilo apenas sea relevante para la
   respuesta — no simules tener datos frescos que no tenés.`;
}
