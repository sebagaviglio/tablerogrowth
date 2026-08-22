/* ============================================================
   POST /api/growth-report
   body: { comentariosPO?: { [squadName]: string } }
   resp: { report: {...}, period: {...}, dataAsOf, commentsSaved, commentsError }

   Genera el INFORME SEMANAL de Growth para Dirección: evolución de
   cumplimiento de objetivos de los ÚLTIMOS 7 DÍAS, principales
   campañas/experimentos del período (solo si hay algo destacable —
   nunca se fuerza a mostrar medios pagos si no aportan nada) y 2-3
   insights relevantes (positivos y negativos).

   Diseño clave: el "ritmo" semanal por producto/squad y el % de
   cumplimiento se calculan ACÁ, en código determinístico (mismo
   criterio que el resto del tablero, ver api/_lib/growth-data.js) —
   nunca se le pide al modelo que invente o recalcule un porcentaje.
   A Claude se le pasan esos números ya calculados y se le pide
   redacción ejecutiva (resumen, bajadas por squad, selección de
   insights e interpretación) — nunca cifras nuevas.

   Los comentarios que cargan los PO antes de generar el informe se
   guardan en la pestaña "Comentarios PO" del Sheet (requiere el
   doPost agregado al Apps Script, ver LEEME_integracion.md) y además
   se usan como contexto para este informe puntual.

   Env vars requeridas (las mismas que ya usa growth-assistant.js):
     ANTHROPIC_API_KEY
     GROWTH_SHEET_SCRIPT_URL
   ============================================================ */

const {
  getWeeklyContext,
  computeWeeklyInsightsList,
  saveWeeklyComments,
  getRecentPOComments,
  getBaseContext,
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

const ESTADO_ORDER = ['atrasado', 'vigilar', 'en línea'];
function estadoFromRitmo(ritmo) {
  if (ritmo === null || ritmo === undefined) return 'sin datos';
  if (ritmo >= 1.0) return 'en línea';
  if (ritmo >= 0.85) return 'vigilar';
  return 'atrasado';
}

function parseEquipoPO(equipoCsv) {
  const map = {};
  if (!equipoCsv) return map;
  const lines = equipoCsv.split('\n').map((l) => l.trim()).filter(Boolean);
  const squadNames = ['Adquisición y Crosselling', 'Habitualidad', 'Bezza Hub', 'Empresas'];
  lines.forEach((line) => {
    const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    squadNames.forEach((sq) => {
      if (map[sq]) return;
      if (!cols.some((c) => c.toLowerCase().includes(sq.toLowerCase()))) return;
      const nameGuess = cols.find((c) => c && c !== sq && c.length > 2 && /[a-záéíóúñ]/i.test(c) && !/po|owner|squad/i.test(c));
      if (nameGuess) map[sq] = nameGuess;
    });
  });
  return map;
}

/** Arma el array "squads" con todos los números ya resueltos en código — Claude solo agrega el texto de "headline" por squad. */
function buildSquadsSkeleton(weeklyDataset, equipoCsv) {
  const poBySquad = parseEquipoPO(equipoCsv);
  return Object.keys(weeklyDataset).map((squadName) => {
    const productos = Object.keys(weeklyDataset[squadName].products).map((prodName) => {
      const d = weeklyDataset[squadName].products[prodName];
      const ritmoPct = d.ritmoSemanal !== null ? Math.round(d.ritmoSemanal * 100) : null;
      return {
        nombre: prodName,
        kpi: d.kpi,
        ritmoPct,
        estado: d.weeklyTarget > 0 ? estadoFromRitmo(d.ritmoSemanal) : 'sin datos',
        real: Math.round(d.weeklyReal),
        objetivo: Math.round(d.weeklyTarget)
      };
    });
    const conDatos = productos.filter((p) => p.ritmoPct !== null);
    const ritmoPromedioPct = conDatos.length
      ? Math.round(conDatos.reduce((sum, p) => sum + p.ritmoPct, 0) / conDatos.length)
      : 0;
    let estado = 'sin datos';
    if (conDatos.length) {
      const estados = conDatos.map((p) => p.estado);
      estado = ESTADO_ORDER.find((e) => estados.includes(e)) || 'en línea';
    }
    return { nombre: squadName, po: poBySquad[squadName] || 'Sin asignar', estado, ritmoPromedioPct, productos };
  });
}

function cumplimientoPct(squadsSkeleton) {
  let total = 0, cumplidos = 0;
  squadsSkeleton.forEach((sq) => {
    sq.productos.forEach((p) => {
      if (p.ritmoPct === null) return;
      total++;
      if (p.ritmoPct >= 100) cumplidos++;
    });
  });
  return total > 0 ? Math.round((cumplidos / total) * 100) : 0;
}

function buildSystemPrompt(periodLabel, squadsSkeleton, weeklyInsightItems, dataBlock, comentariosPO, comentariosHistoricos) {
  const squadsJson = JSON.stringify(squadsSkeleton, null, 2);
  const insightsJson = JSON.stringify(weeklyInsightItems, null, 2);
  const comentariosBlock = Object.keys(comentariosPO || {}).length
    ? `\n# Comentarios de los PO para esta semana (cargados a mano antes de generar el informe)\n${Object.entries(comentariosPO).map(([sq, txt]) => `- ${sq}: "${txt}"`).join('\n')}\n\nSon información real y de primera mano — tenelos en cuenta al redactar el resumen ejecutivo y las bajadas por squad. Si un comentario contradice o matiza el número de ritmo, mencioná ambos (el dato y la lectura del PO) en vez de ignorar uno de los dos.`
    : '\n# Comentarios de los PO\nNo se cargaron comentarios de PO para esta semana.';
  const historicosBlock = (comentariosHistoricos && comentariosHistoricos.length)
    ? `\n# Comentarios de PO de semanas anteriores (base de conocimiento acumulada, para dar continuidad — no son de esta semana)\n${comentariosHistoricos.map((c) => `- [${c.semana}] ${c.squad}: "${c.texto}"`).join('\n')}`
    : '';

  return `Sos el Asistente de Growth de Bancor generando el INFORME SEMANAL para Dirección
(el equipo directivo del banco). Lo van a leer personas que no miran el tablero día a día:
tiene que ser claro, ejecutivo y basado 100% en datos reales.

# Conocimiento de base que aplicás al interpretar los datos
Frameworks de funnel/loops (AARRR, growth loops), activación y hábito (Hook Model, D1/D7/D30),
priorización (ICE/RICE), unit economics (CAC, LTV, payback), particularidades de growth en
banca/fintech (fricción de KYC, confianza como driver de conversión, estacionalidad de medios
de pago). Usalo para dar contexto e interpretación, nunca para inventar cifras.

# Período de este informe
Últimos 7 días: ${periodLabel}. Es un informe SEMANAL, no mensual — toda lectura de ritmo
y cumplimiento que menciones tiene que referirse a esta ventana de 7 días, no al mes completo
ni al año.

# Ritmo semanal por squad y producto — YA CALCULADO, es la fuente de verdad
Estos números están calculados en código a partir de los datos reales del Sheet (ritmo semanal
= acumulado real de los últimos 7 días ÷ objetivo semanal, que es el objetivo mensual de Plan
Anual prorrateado a 7 días). NO los recalcules, NO los cambies, NO agregues productos o squads
que no estén en esta lista — solo usalos para escribir la interpretación ejecutiva.

${squadsJson}

# Insights semanales candidatos — YA CALCULADOS (▲ ritmo≥110%, ▼ ritmo≤85%, ordenados por magnitud)
${insightsJson}

# Datos crudos adicionales (campañas, equipo, medios pagos) — para cruzar contexto, nunca para inventar ritmo
${dataBlock}
${comentariosBlock}
${historicosBlock}

# Tu tarea
Devolvé ÚNICAMENTE un objeto JSON válido (sin texto antes ni después, sin \`\`\`), con esta
forma EXACTA:

{
  "resumenEjecutivo": "2-3 oraciones, tono directo y ejecutivo, con el estado general de la semana. Si hay comentarios de PO relevantes, incorporalos.",
  "cumplimiento": {
    "headline": "una frase corta sobre cómo viene el cumplimiento esta semana vs. lo esperado"
  },
  "squadHeadlines": {
    "<nombre de squad exactamente como aparece arriba>": "1-2 oraciones concretas sobre cómo viene ese squad esta semana. Si hay comentario de su PO, integralo. Si el squad no tiene datos cargados esta semana, decilo así de directo."
  },
  "comentariosPOInterpretados": {
    "<nombre de squad, SOLO para los squads que tengan comentario de PO en la sección de arriba>": "Reescribí el comentario crudo del PO en 1 oración clara y ejecutiva (máx. ~25 palabras): mejorá la redacción, sacá relleno, y destacá el dato o el punto más accionable si el comentario trae varios. No agregues información que el PO no haya dicho, no inventes números nuevos — es una edición de estilo, no contenido nuevo. Si el comentario ya es corto y claro, podés dejarlo casi igual."
  },
  "campanas": [
    {
      "nombre": "...",
      "squad": "...",
      "canal": "Azure DevOps" | "Google Ads" | "Meta Ads" | "Otro",
      "estado": "...",
      "presupuesto": "string formateado con $ o '—'",
      "gastoMTD": "string formateado con $ o '—'",
      "cpa": "string formateado con $ o '—'",
      "nota": "1 oración: qué está haciendo esta campaña y cómo se relaciona con el ritmo semanal del squad"
    }
  ],
  "insights": [
    {
      "tipo": "positive" | "negative",
      "titulo": "título corto y contundente (5-8 palabras)",
      "metrica": "el número destacado, tomado de los insights semanales candidatos o de los datos crudos, ej. '+34%' o '112% de ritmo'",
      "cuerpo": "2-3 oraciones explicando el insight, con el dato que lo respalda y por qué importa para Dirección",
      "squad": "squad al que aplica, o 'General' si es transversal"
    }
  ],
  "recomendaciones": ["0 a 3 recomendaciones accionables y breves, solo si se desprenden claramente de los datos o los comentarios de PO"]
}

Reglas estrictas:
1. NUNCA inventes cifras nuevas. Los únicos números que podés citar son los que ya están en
   "squadHeadlines" (referite a ellos en texto, no hace falta repetir el número exacto si ya
   se muestra en la tarjeta del squad), en los insights semanales candidatos, o valores
   explícitos de gasto/CPA/presupuesto que estén tal cual en los datos crudos.
2. "campanas": esto es OPCIONAL — devolvé un array VACÍO si no hay ninguna campaña o gasto en
   medios pagos que realmente valga la pena destacar esta semana (por ejemplo, si Google Ads o
   Meta Ads no tuvieron gasto relevante, o si no aportan nada al ritmo de ningún squad). No
   fuerces a incluir medios pagos "porque hay que llenar la sección" — Dirección prefiere no
   ver una sección vacía de relleno. Si incluís algo, máximo 4, priorizando lo más relevante.
3. "insights": entre 2 y 3, priorizando primero los insights semanales candidatos que ya están
   calculados (elegí los de mayor magnitud, mezclando positivo y negativo si los hay de ambos
   tipos). Podés sumar como insight algo de los datos crudos (ej. una baja de CPA visible en la
   comparación de campañas, o un sobrecumplimiento evidente en Campañas/Azure) solo si el dato
   que lo respalda está explícito en el contexto — nunca una estimación.
4. "squadHeadlines": incluí una entrada para cada uno de los squads que aparecen en la lista de
   arriba, ni uno más ni uno menos.
5. "comentariosPOInterpretados": es una reescritura editorial del comentario del PO, NO una
   síntesis del ritmo del squad (eso ya va en "squadHeadlines") — tiene que seguir sonando como
   la voz del PO, solo que más prolija y directa. Si el PO no cargó comentario para un squad, no
   incluyas esa clave.
6. Español neutro rioplatense, directo, sin tecnicismos innecesarios — tono ejecutivo, frases
   cortas, cero relleno.`;
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
    const comentariosPO = (body.comentariosPO && typeof body.comentariosPO === 'object') ? body.comentariosPO : {};

    const [weekly, base, historicos] = await Promise.all([
      getWeeklyContext(),
      getBaseContext(),
      getRecentPOComments(12)
    ]);

    if (!weekly.dataset) {
      res.status(200).json({
        error: `No se pudo leer el Sheet en vivo para armar el informe semanal (${weekly.error || 'sin detalle'}).`,
        dataAsOf: weekly.fetchedAt
      });
      return;
    }

    const periodLabel = weekly.label;
    const squadsSkeleton = buildSquadsSkeleton(weekly.dataset, base.equipoCsv);
    const { items: weeklyInsightItems } = computeWeeklyInsightsList(weekly.dataset, null);
    const dataBlock = describeLiveContext(base);

    // Guardar los comentarios de los PO en el Sheet en paralelo con la llamada a Claude —
    // si falla, no bloquea el informe, solo se informa al front-end.
    const systemPrompt = buildSystemPrompt(periodLabel, squadsSkeleton, weeklyInsightItems, dataBlock, comentariosPO, historicos);
    const [saveResult, callResult] = await Promise.all([
      saveWeeklyComments(periodLabel, comentariosPO),
      callClaudeForJson(systemPrompt, `Generá el informe semanal de Growth para Dirección correspondiente a los últimos 7 días: ${periodLabel}.`)
    ]);

    const { parsed, debug } = callResult;
    if (!parsed) {
      console.error('growth-report: no se pudo generar JSON válido.', debug);
      res.status(200).json({
        error: 'No se pudo generar el informe en este momento — probá de nuevo en un rato.',
        debug,
        dataAsOf: weekly.fetchedAt
      });
      return;
    }

    // Merge: los números (ya resueltos en código) + el texto que devolvió Claude por squad.
    const squadHeadlines = parsed.squadHeadlines || {};
    const comentariosInterpretados = parsed.comentariosPOInterpretados || {};
    const squads = squadsSkeleton.map((sq) => ({
      ...sq,
      headline: squadHeadlines[sq.nombre] || '',
      comentarioPO: comentariosPO[sq.nombre]
        ? (comentariosInterpretados[sq.nombre] || comentariosPO[sq.nombre]) // si Claude no lo devolvió, se usa el crudo como respaldo
        : null
    }));

    const report = {
      resumenEjecutivo: parsed.resumenEjecutivo || '',
      cumplimiento: {
        pctObjetivosCumplidos: cumplimientoPct(squadsSkeleton),
        headline: (parsed.cumplimiento && parsed.cumplimiento.headline) || ''
      },
      squads,
      campanas: Array.isArray(parsed.campanas) ? parsed.campanas : [],
      insights: Array.isArray(parsed.insights) ? parsed.insights : [],
      recomendaciones: Array.isArray(parsed.recomendaciones) ? parsed.recomendaciones : []
    };

    res.status(200).json({
      report,
      period: { label: periodLabel, days: weekly.days.map((d) => d.toISOString().slice(0, 10)), generatedAt: new Date().toISOString() },
      dataAsOf: weekly.fetchedAt,
      commentsSaved: saveResult.saved,
      commentsSavedCount: saveResult.count,
      commentsError: saveResult.error || null
    });
  } catch (err) {
    console.error('growth-report handler error', err);
    res.status(500).json({ error: 'Error interno generando el informe.' });
  }
};
