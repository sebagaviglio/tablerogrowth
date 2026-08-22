/* ============================================================
   POST /api/growth-report
   body: { monthTab?: string }  // ej. "Ago" — si no viene, usa el mes en curso
   resp: { report: {...}, dataAsOf: string }

   Genera el contenido (JSON estructurado) del informe semanal de
   Growth para Dirección: evolución de cumplimiento de objetivos,
   principales campañas/experimentos del período y 2-3 insights
   relevantes (positivos y negativos). El front-end (report.js) lo
   renderiza como pieza visual con identidad Bancor + Bezza.

   Reutiliza exactamente la misma lectura de datos y el mismo
   cálculo de "ritmo" / Growth Insights que usa el Asistente de
   Growth (api/_lib/growth-data.js) — el informe nunca puede decir
   un número distinto al que ve el equipo en el tablero o en el chat.

   Env vars requeridas (las mismas que ya usa growth-assistant.js):
     ANTHROPIC_API_KEY
     GROWTH_SHEET_SCRIPT_URL
   ============================================================ */

const {
  MONTH_TABS,
  MONTH_LABELS_ES,
  DAYS_IN_MONTH,
  currentMonthTab,
  getLiveContext,
  getExtraMonthTab,
  getGrowthInsights,
  describeLiveContext
} = require('./_lib/growth-data');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function stripJsonFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function callClaudeForJson(systemPrompt, userMessage) {
  let lastDebug = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4000,
          thinking: { type: 'disabled' },
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        })
      });
    } catch (networkErr) {
      lastDebug = `fetch falló (intento ${attempt}): ${String(networkErr.message || networkErr)}`;
      await sleep(600 * attempt);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      lastDebug = `Anthropic devolvió ${response.status} (intento ${attempt}): ${errText}`;
      console.error(lastDebug);
      if (response.status === 429 || response.status === 529) {
        await sleep(800 * attempt);
        continue;
      }
      break;
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) {
      lastDebug = `Respuesta vacía (intento ${attempt}): stop_reason=${data.stop_reason}`;
      await sleep(400 * attempt);
      continue;
    }

    try {
      const parsed = JSON.parse(stripJsonFences(text));
      return { parsed, raw: text, debug: null };
    } catch (parseErr) {
      lastDebug = `JSON inválido (intento ${attempt}): ${String(parseErr.message || parseErr)} — respuesta: ${text.slice(0, 300)}`;
      console.error(lastDebug);
      await sleep(300 * attempt);
      continue;
    }
  }
  return { parsed: null, raw: null, debug: lastDebug };
}

function buildPeriod(monthTab) {
  const now = new Date();
  const year = now.getFullYear();
  const isCurrentMonth = monthTab === currentMonthTab();
  const monthIdx = MONTH_TABS.indexOf(monthTab);
  const daysInMonth = DAYS_IN_MONTH[monthIdx] || 30;
  const asOfDay = isCurrentMonth ? now.getDate() : daysInMonth;
  const label = isCurrentMonth
    ? `${MONTH_LABELS_ES[monthTab]} ${year} · del 1 al ${asOfDay} (corte al día de hoy)`
    : `${MONTH_LABELS_ES[monthTab]} ${year} · mes cerrado`;
  return {
    monthTab,
    label,
    year,
    asOfDay,
    daysInMonth,
    isCurrentMonth,
    generatedAt: now.toISOString()
  };
}

function buildSystemPrompt(period, dataBlock, insightsText) {
  return `Sos el Asistente de Growth de Bancor generando el INFORME SEMANAL para Dirección
(el equipo directivo del banco). Lo van a leer personas que no miran el tablero día a día:
tiene que ser claro, ejecutivo y basado 100% en datos reales, nunca inventado.

# Conocimiento de base que aplicás al interpretar los datos
Frameworks de funnel/loops (AARRR, growth loops), activación y hábito (Hook Model, D1/D7/D30),
priorización (ICE/RICE), unit economics (CAC, LTV, payback), particularidades de growth en
banca/fintech (fricción de KYC, confianza como driver de conversión, estacionalidad de medios
de pago). Usalo para dar contexto a los números, no para inventarlos.

# Período del informe
${period.label}. Trabajás EXCLUSIVAMENTE con datos de este período — si un dato relevante no
está disponible para este período, decilo explícitamente en el campo correspondiente en vez
de omitirlo o de usar un número de otro período sin aclararlo.

# El concepto de "ritmo"
ritmo = acumulado real ÷ objetivo prorrateado a los días con carga real. ≥100% = en línea o
por encima. 85-100% = para vigilar. ≤85% = atrasado.

# Datos del negocio (Sheet en vivo, ${period.generatedAt})
${dataBlock}

${insightsText}

# Tu tarea
Devolvé ÚNICAMENTE un objeto JSON válido (sin texto antes ni después, sin \`\`\`), con esta
forma EXACTA:

{
  "resumenEjecutivo": "2-3 oraciones, tono directo y ejecutivo, con el estado general del período",
  "cumplimiento": {
    "pctObjetivosCumplidos": <number 0-100, cantidad de productos con ritmo>=100% sobre el total con objetivo definido en este período>,
    "headline": "una frase corta sobre la evolución de cumplimiento vs. lo esperado a esta altura"
  },
  "squads": [
    {
      "nombre": "Adquisición y Crosselling" | "Habitualidad" | "Bezza Hub" | "Empresas",
      "po": "nombre del PO si está en la pestaña Equipo, si no 'Sin asignar'",
      "estado": "en línea" | "vigilar" | "atrasado",
      "ritmoPromedioPct": <number, promedio del ritmo de sus productos con datos, 0 si no hay>,
      "headline": "una frase corta y concreta sobre cómo viene el squad en este período",
      "productos": [
        { "nombre": "...", "kpi": "...", "ritmoPct": <number>, "estado": "en línea"|"vigilar"|"atrasado"|"sin datos" }
      ]
    }
  ],
  "campanas": [
    {
      "nombre": "...",
      "squad": "...",
      "canal": "Azure DevOps" | "Google Ads" | "Meta Ads" | "Otro",
      "estado": "...",
      "presupuesto": "string formateado con $ o '—' si no aplica",
      "gastoMTD": "string formateado con $ o '—'",
      "cpa": "string formateado con $ o '—'",
      "nota": "1 oración: qué está haciendo esta campaña y cómo se relaciona con el ritmo del squad"
    }
  ],
  "insights": [
    {
      "tipo": "positive" | "negative",
      "titulo": "título corto y contundente (5-8 palabras)",
      "metrica": "el número destacado, ej. '+34%' o '-19,6% CPA' o '112% de ritmo'",
      "cuerpo": "2-3 oraciones explicando el insight, con el dato que lo respalda y por qué importa para Dirección",
      "squad": "squad al que aplica, o 'General' si es transversal"
    }
  ],
  "recomendaciones": ["0 a 3 recomendaciones accionables y breves, solo si se desprenden claramente de los datos"]
}

Reglas estrictas:
1. NUNCA inventes cifras. Si algo no está en los datos, omitilo o decí explícitamente que no hay
   dato disponible para ese período dentro del campo correspondiente — nunca lo completes con un
   número estimado.
2. "campanas": máximo 5, priorizando las de mayor presupuesto/gasto o las más relevantes para el
   ritmo del período. Si no hay datos de campañas disponibles, devolvé un array vacío.
3. "insights": entre 2 y 3, mezclando lo positivo y lo negativo cuando los datos lo permitan (no
   fuerces negativos si todo viene bien, ni fuerces positivos si todo viene mal) — priorizá
   uplifts, sobrecumplimientos, bajas de CPA, ganancias de eficiencia, o atrasos y sobrecostos
   reales y significativos, no variaciones menores dentro de rango esperado.
4. "squads": incluí los 4 squads siempre que tengan al menos un producto con objetivo definido
   en Plan Anual, aunque no tengan datos cargados en este período (en ese caso, "estado":
   "atrasado" solo si corresponde por ritmo real — si no hay carga, usá "sin datos" a nivel
   producto y contalo así en el headline del squad).
5. Todos los números en los campos "ritmoPct" / "pctObjetivosCumplidos" son valores numéricos
   (no strings, sin el símbolo %).
6. Español neutro rioplatense, directo, sin tecnicismos innecesarios — el mismo tono del
   Asistente de Growth, pero en formato ejecutivo (frases más cortas, cero relleno).`;
}

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
    const body = req.body || {};
    let monthTab = typeof body.monthTab === 'string' && MONTH_TABS.includes(body.monthTab)
      ? body.monthTab
      : currentMonthTab();

    const period = buildPeriod(monthTab);

    // Si piden un mes que no es el mes en curso, lo pedimos como pestaña extra
    // (getLiveContext ya trae Plan Anual + mes en curso siempre como base).
    const liveContext = await getLiveContext(monthTab === currentMonthTab() ? [] : [monthTab]);

    let effectiveContext = liveContext;
    if (monthTab !== currentMonthTab()) {
      const extra = liveContext.extraMonths && liveContext.extraMonths[monthTab];
      if (extra && extra.csv) {
        effectiveContext = { ...liveContext, currentMonthTab: monthTab, monthCsv: extra.csv };
      } else {
        res.status(200).json({
          error: `No se pudo leer la pestaña "${monthTab}" (${(extra && extra.error) || 'sin detalle'}). Puede que ese mes no tenga datos cargados.`,
          dataAsOf: liveContext.fetchedAt
        });
        return;
      }
    }

    const dataBlock = describeLiveContext(effectiveContext);
    const insightsResult = await getGrowthInsights();
    const insightsText = insightsResult.text || '';

    const systemPrompt = buildSystemPrompt(period, dataBlock, insightsText);
    const userMessage = `Generá el informe semanal de Growth para Dirección correspondiente al período: ${period.label}.`;

    const { parsed, debug } = await callClaudeForJson(systemPrompt, userMessage);

    if (!parsed) {
      console.error('growth-report: no se pudo generar JSON válido.', debug);
      res.status(200).json({
        error: 'No se pudo generar el informe en este momento — probá de nuevo en un rato.',
        debug,
        dataAsOf: liveContext.fetchedAt
      });
      return;
    }

    res.status(200).json({
      report: parsed,
      period,
      dataAsOf: liveContext.fetchedAt
    });
  } catch (err) {
    console.error('growth-report handler error', err);
    res.status(500).json({ error: 'Error interno generando el informe.' });
  }
};
