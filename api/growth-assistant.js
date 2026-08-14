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

function recentHistoryText(history) {
  if (!Array.isArray(history)) return '';
  return history.slice(-4).map((m) => (m && m.content) || '').join(' ');
}

// Cache liviano en memoria (vive mientras la instancia serverless esté "warm")
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

    const liveContext = await getLiveContext(detectMentionedMonths(message + ' ' + recentHistoryText(history)));
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
        max_tokens: 3000,
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
    if (data.stop_reason === 'max_tokens') {
      console.warn('growth-assistant: respuesta cortada por max_tokens. Considerá subir el límite si esto se repite.');
    }
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

// alias en español (nombre completo o abreviatura) -> nombre de pestaña real
const MONTH_ALIASES = {
  enero: 'Ene', ene: 'Ene',
  febrero: 'Feb', feb: 'Feb',
  marzo: 'Mar', mar: 'Mar',
  abril: 'Abr', abr: 'Abr',
  mayo: 'May', may: 'May',
  junio: 'Jun', jun: 'Jun',
  julio: 'Jul', jul: 'Jul',
  agosto: 'Ago', ago: 'Ago',
  septiembre: 'Sep', setiembre: 'Sep', sept: 'Sep', sep: 'Sep',
  octubre: 'Oct', oct: 'Oct',
  noviembre: 'Nov', nov: 'Nov',
  diciembre: 'Dic', dic: 'Dic'
};

function detectMentionedMonths(text) {
  const lower = (text || '').toLowerCase();
  const found = new Set();
  for (const alias in MONTH_ALIASES) {
    if (new RegExp('\\b' + alias + '\\b', 'i').test(lower)) found.add(MONTH_ALIASES[alias]);
  }
  return Array.from(found);
}

async function fetchTab(tabName) {
  const url = SHEET_SCRIPT_URL + '?tab=' + encodeURIComponent(tabName);
  const r = await fetch(url, { method: 'GET' });
  const text = await r.text();
  if (text.trim().startsWith('ERROR')) {
    throw new Error(`Pestaña "${tabName}": ${text.trim()}`);
  }
  return text;
}

// Caché de la base (Plan Anual + mes en curso) — la parte que se pide siempre.
let baseCache = { payload: null, fetchedAt: 0 };
// Caché de pestañas de meses puntuales pedidas bajo demanda (una entrada por mes).
const monthTabCache = {};

async function getBaseContext() {
  const now = Date.now();
  if (baseCache.payload && now - baseCache.fetchedAt < CACHE_TTL_MS) {
    return baseCache.payload;
  }
  const currentMonthTab = MONTH_TABS[new Date().getMonth()];

  // Plan Anual + mes en curso son críticos: si fallan, no hay contexto de datos.
  let planAnualCsv, monthCsv, coreError;
  try {
    [planAnualCsv, monthCsv] = await Promise.all([
      fetchTab('Plan Anual'),
      fetchTab(currentMonthTab)
    ]);
  } catch (err) {
    console.error('No se pudo leer el Sheet en vivo (base)', err);
    coreError = String(err.message || err);
  }

  // "Campañas" y "Equipo" son un plus: si fallan, seguimos igual con el resto.
  let campaignsCsv = null, campaignsError = null;
  let equipoCsv = null, equipoError = null;
  await Promise.all([
    fetchTab('Campañas').then((csv) => { campaignsCsv = csv.slice(0, 6000); }).catch((err) => { campaignsError = String(err.message || err); }),
    fetchTab('Equipo').then((csv) => { equipoCsv = csv.slice(0, 3000); }).catch((err) => { equipoError = String(err.message || err); })
  ]);

  if (coreError) {
    return { planAnualCsv: null, monthCsv: null, currentMonthTab, campaignsCsv, campaignsError, equipoCsv, equipoError, fetchedAt: new Date().toISOString(), error: coreError };
  }

  const payload = {
    planAnualCsv: planAnualCsv.slice(0, 5000),
    currentMonthTab,
    monthCsv: monthCsv.slice(0, 7000),
    campaignsCsv,
    campaignsError,
    equipoCsv,
    equipoError,
    fetchedAt: new Date().toISOString()
  };
  baseCache = { payload, fetchedAt: now };
  return payload;
}

async function getExtraMonthTab(tabName) {
  const now = Date.now();
  const cached = monthTabCache[tabName];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  try {
    const csv = await fetchTab(tabName);
    const entry = { csv: csv.slice(0, 7000), error: null, fetchedAt: now };
    monthTabCache[tabName] = entry;
    return entry;
  } catch (err) {
    const entry = { csv: null, error: String(err.message || err), fetchedAt: now };
    monthTabCache[tabName] = entry;
    return entry;
  }
}

/**
 * mentionedMonths: nombres de pestaña (p.ej. ['Jul']) detectados en el mensaje
 * del usuario (y últimos turnos de la conversación), a pedir además de la base.
 */
async function getLiveContext(mentionedMonths) {
  if (!SHEET_SCRIPT_URL) {
    return { planAnualCsv: null, monthCsv: null, extraMonths: {}, fetchedAt: new Date().toISOString(), error: 'GROWTH_SHEET_SCRIPT_URL no configurada' };
  }

  const base = await getBaseContext();
  const extrasToFetch = (mentionedMonths || []).filter((m) => m !== base.currentMonthTab).slice(0, 3);

  const extraMonths = {};
  await Promise.all(extrasToFetch.map(async (tabName) => {
    extraMonths[tabName] = await getExtraMonthTab(tabName);
  }));

  return { ...base, extraMonths };
}

/* ------------------------------------------------------------ *
 * System prompt: conocimiento de Growth + contexto Bancor +    *
 * tono + límites                                                *
 * ------------------------------------------------------------ */
function buildSystemPrompt(liveContext) {
  let dataBlock;
  if (liveContext.planAnualCsv && liveContext.monthCsv) {
    const extraEntries = Object.entries(liveContext.extraMonths || {});
    const extraBlocks = extraEntries.map(([tabName, entry]) => {
      if (entry.csv) {
        return `\n--- Pestaña "${tabName}" (pedida a demanda, cerrada) ---\n${entry.csv}`;
      }
      return `\n--- Pestaña "${tabName}" ---\nNo se pudo leer (${entry.error || 'sin detalle'}). Puede que esa pestaña no exista (recordá: Ene-Jun fueron borradas a propósito, la medición real arrancó en julio 2026) — si es una de esas, decilo así en vez de sugerir que es un error.`;
    }).join('\n');

    const campaignsBlock = liveContext.campaignsCsv
      ? `\n--- Pestaña "Campañas" (sincronizada desde Azure DevOps) ---\n${liveContext.campaignsCsv}\n\nCómo leer "Campañas": columnas ID | Nombre | Estado | Fecha inicio | Fecha fin |
  Squad/Canal | Presupuesto | Interpretación IA. Es el registro de campañas de cada
  squad. "Interpretación IA" ya es un análisis automático generado por Azure DevOps
  sobre esa campaña puntual — podés citarlo como referencia, pero contextualizalo
  vos, no lo repitas literal sin aportar nada. Cruzá esto con el ritmo cuando tenga
  sentido: si un squad/producto está atrasado, revisá si tiene una campaña activa
  (Estado + fechas) que debería estar empujando el número, o si no tiene ninguna
  corriendo — eso también es un dato accionable. No inventes campañas que no estén
  en esta lista, ni supongas presupuesto o estado que no esté explícito.`
      : liveContext.campaignsError
        ? `\n(No se pudo leer la pestaña "Campañas" en este momento: ${liveContext.campaignsError}. Si preguntan por campañas, avisá que no la tenés disponible ahora.)`
        : '';

    const equipoBlock = liveContext.equipoCsv
      ? `\n--- Pestaña "Equipo" (personas de Growth) ---\n${liveContext.equipoCsv}\n\nUsala para identificar quién es el PO/Owner de un squad o producto cuando
  te lo pregunten, o para dar contexto de a quién recurrir. No es una pestaña
  de desempeño — no evalúes, rankees ni compares personas entre sí a partir
  de los números de otras pestañas; los datos de ritmo son del squad/producto,
  no de la persona.`
      : liveContext.equipoError
        ? `\n(No se pudo leer la pestaña "Equipo" en este momento: ${liveContext.equipoError}.)`
        : '';

    dataBlock = `Datos crudos leídos en vivo del Sheet (${liveContext.fetchedAt}).

--- Pestaña "Plan Anual" (objetivos mensuales, fuente de verdad) ---
${liveContext.planAnualCsv}

--- Pestaña "${liveContext.currentMonthTab}" (mes en curso, datos reales día a día) ---
${liveContext.monthCsv}
${extraBlocks}
${campaignsBlock}
${equipoBlock}

Cómo leer estos CSV:
- "Plan Anual": columnas Squad | Producto | KPI / Métrica | Ene...Dic. Cada celda de
  mes es el objetivo de ese producto para ese mes. Usá SIEMPRE esta pestaña para la
  meta mensual — nunca la fila "META MES" de una pestaña mensual (tiene un desalineamiento
  de columna conocido en Habitualidad/Jun, así que ese dato no es confiable ahí).
- Cada pestaña mensual: por cada squad hay un bloque que arranca con una fila
  "SQUAD · PO: nombre · Own: nombre", seguido de una grilla diaria (columnas: Día |
  Fecha | producto1 | producto2 ... | TOTAL) hasta una fila "TOTAL ACUM" (ese es el
  acumulado real de cada producto a la fecha, o al cierre del mes si ya cerró).
  Ignorá las filas "META MES", "% CUMPL.", "META PROP." y "% vs M.PROP" de cualquier
  pestaña mensual — el dashboard ya sabe que están desalineadas y las recalcula
  siempre desde Plan Anual; hacé lo mismo vos.
- Para calcular ritmo de un producto en el mes en curso: tomá su objetivo mensual de
  Plan Anual (columna del mes correspondiente), prorrateado a la cantidad de días con
  carga real, y comparalo contra el acumulado real de esa fila. Para un mes ya cerrado
  (como los que te llegan bajo "pedida a demanda, cerrada"), el % de cumplimiento es
  simplemente acumulado real ÷ objetivo del mes completo (sin prorratear, porque el
  mes ya terminó).
- Si te preguntan por un mes y no está en "Datos del negocio" (ni en la base ni en las
  pestañas a demanda), decilo explícitamente — no seas específico con un número que
  no tenés.`;
  } else {
    dataBlock = `No se pudo leer el Sheet en vivo en este momento (${liveContext.error || 'sin detalle'}). Trabajá solo con lo que el usuario te cuente y avisale explícitamente que no tenés los números actualizados a mano.`;
  }

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

# Formato de las respuestas
El chat ahora renderiza markdown de verdad (tablas, negrita, listas, encabezados,
código) con scroll horizontal si una tabla es angosta. Cuando compartas una serie
diaria u otra tabla, usá una tabla markdown estándar con una fila por dato (ej.
| Día | Colocaciones |) — nunca partas los datos en columnas dobles o en paralelo
para "ahorrar espacio", la interfaz ya lo resuelve con scroll.

Si te piden un resumen o reporte más largo (ej. "dame un resumen del mes",
"reporte de campañas"), organizalo con subtítulos markdown (## Sección) por
tema y una lista o tabla debajo de cada uno — así se lee como un reporte real,
no como un párrafo largo.

## Gráficos
Cuando una serie en el tiempo, una comparación entre squads/productos, o una
distribución (ej. presupuesto de campañas por squad) se entienda mejor con un
gráfico, generalo con un bloque de código de lenguaje "chart" con SOLO un JSON
de esta forma exacta (sin texto extra adentro del bloque):

\`\`\`chart
{"type":"bar","title":"Ritmo por squad — agosto","labels":["Adquisición y Crosselling","Habitualidad","Bezza Hub","Empresas"],"datasets":[{"label":"Ritmo %","data":[104,91,78,112]}]}
\`\`\`

Reglas para los gráficos:
- "type" es únicamente "bar", "line", "pie" o "doughnut".
- Usá "line" para evolución en el tiempo (día a día o mes a mes), "bar" para
  comparar squads/productos entre sí, "pie"/"doughnut" para distribución de
  un total (ej. presupuesto por squad).
- Los valores en "data" tienen que salir de los datos reales que tenés en
  contexto — nunca inventes números para que el gráfico "cierre visualmente".
  Si no tenés suficientes datos para graficar algo con confianza, no generes
  el bloque y decilo en el texto.
- El JSON tiene que ser válido y completo siempre. Nunca acortes un array
  "data" con "..." o cualquier otro placeholder para "ahorrar espacio" —
  eso rompe el gráfico por completo. Si la serie es muy larga (por ejemplo,
  combinar dos meses día a día son 40+ puntos), preferí agrupar por semana
  en vez de por día, o hacer un gráfico separado por mes — pero siempre con
  el array entero, nunca truncado.
- Además del gráfico, siempre escribí 1-2 oraciones interpretando lo que
  muestra — el gráfico acompaña la respuesta, nunca la reemplaza.
- Como mucho un gráfico por respuesta, salvo que te pidan explícitamente
  comparar varias cosas distintas a la vez.

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
   respuesta — no simules tener datos frescos que no tenés.
7. Usá la pestaña "Equipo" solo para identificar quién es quién (PO/Owner de
   un squad, a quién recurrir). Nunca cruces esos nombres con el ritmo u otras
   métricas para evaluar, rankear o hacer juicios sobre el desempeño de una
   persona — el ritmo mide al squad/producto, no a los individuos.`;
}
