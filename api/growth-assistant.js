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

// Reutilizamos las mismas libs que ya usan google-ads-proxy.js y
// meta-ads-proxy.js — llaman directo a las APIs en vivo, así que
// sirven para historial que puede no estar volcado al Sheet todavía.
const { fetchCampaigns: fetchGoogleAdsHistory } = require('./_lib/google-ads-core');
const { fetchCampaigns: fetchMetaAdsHistory } = require('./_lib/meta-ads-core');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEET_SCRIPT_URL = process.env.GROWTH_SHEET_SCRIPT_URL;
const MODEL = 'claude-sonnet-5';

function recentHistoryText(history) {
  if (!Array.isArray(history)) return '';
  return history.slice(-4).map((m) => (m && m.content) || '').join(' ');
}

// Cache liviano en memoria (vive mientras la instancia serverless esté "warm")
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Llama a la API de Anthropic. Reintenta hasta 3 veces con una pausa corta
 * entre intentos (cubre 429/529 — rate limit / servidor sobrecargado — que
 * suelen resolverse solos si se espera un toque). Devuelve { reply, debug }:
 * debug queda null si salió bien, o el detalle real del fallo si no.
 */
async function callClaude(systemPrompt, messages) {
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
          max_tokens: 3000,
          // Sonnet 5 trae "adaptive thinking" prendido por default, y esos
          // tokens de razonamiento salen del mismo max_tokens que la
          // respuesta — en preguntas analíticas puede gastarse todo el
          // presupuesto pensando y no dejar nada para el texto final
          // (stop_reason: "max_tokens" con una respuesta vacía). Lo
          // desactivamos: para este asistente priorizamos una respuesta
          // confiable por sobre el razonamiento interno extendido.
          thinking: { type: 'disabled' },
          system: systemPrompt,
          messages
        })
      });
    } catch (networkErr) {
      lastDebug = `fetch falló (intento ${attempt}): ${String(networkErr.message || networkErr)}`;
      console.error(lastDebug);
      await sleep(600 * attempt);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      lastDebug = `Anthropic devolvió ${response.status} (intento ${attempt}): ${errText}`;
      console.error(lastDebug);
      // 429 (rate limit) y 529 (sobrecargado) suelen resolverse solos con una pausa.
      if (response.status === 429 || response.status === 529) {
        await sleep(800 * attempt);
        continue;
      }
      // otros errores (401, 400, etc.) no se arreglan reintentando igual.
      break;
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

    if (reply) return { reply, debug: null };

    lastDebug = `Respuesta vacía (intento ${attempt}): stop_reason=${data.stop_reason}, content=${JSON.stringify(data.content)}, usage=${JSON.stringify(data.usage)}`;
    console.error(lastDebug);
    await sleep(400 * attempt);
  }

  return { reply: null, debug: lastDebug };
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
    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Falta "message".' });
      return;
    }

    const combinedText = message + ' ' + recentHistoryText(history);
    const mentionedMonths = detectMentionedMonths(combinedText);
    const wantsInsights = /\b(growth insights?|dato destacado|oportunidad(es)?|alerta(s)?|resumen general|c[oó]mo viene(n)? (todos|los squads))\b/i.test(combinedText);
    const wantsAdsHistory = mentionsAds(combinedText) && mentionedMonths.length > 0;

    const [liveContext, insightsBlock, adsHistoryBlock] = await Promise.all([
      getLiveContext(mentionedMonths),
      wantsInsights ? getGrowthInsightsBlock() : Promise.resolve(null),
      wantsAdsHistory ? getAdsHistoryBlock(mentionedMonths) : Promise.resolve(null)
    ]);

    const systemPrompt = buildSystemPrompt(liveContext, insightsBlock, adsHistoryBlock);

    const messages = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: message });

    const { reply, debug } = await callClaude(systemPrompt, messages);

    if (!reply) {
      console.error('growth-assistant: se agotaron los reintentos. Último detalle:', debug);
    }

    res.status(200).json({
      reply: reply || 'Tuve un problema generando la respuesta recién — probá de nuevo en un momento.',
      debug: reply ? undefined : debug, // detalle técnico solo cuando falló, para diagnosticar sin ir a los logs
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

const MONTH_NUM = { Ene: 1, Feb: 2, Mar: 3, Abr: 4, May: 5, Jun: 6, Jul: 7, Ago: 8, Sep: 9, Oct: 10, Nov: 11, Dic: 12 };
function monthTabToYYYYMM(tabName, year) {
  const num = MONTH_NUM[tabName];
  if (!num) return null;
  return `${year || new Date().getFullYear()}-${String(num).padStart(2, '0')}`;
}

function mentionsAds(text) {
  return /\b(google ads|meta ads|adwords|facebook ads|instagram ads|\bcpa\b|gasto en (medios|ads|publicidad)|campa[ñn]as? hist[oó]ric|medios pagos)/i.test(text || '');
}

// Caché de historial de Ads por plataforma+mes — evita pegarle a las APIs
// externas en cada mensaje si preguntan por el mismo mes varias veces seguidas.
const googleAdsHistoryCache = {};
const metaAdsHistoryCache = {};

async function getGoogleAdsHistory(tabName) {
  const now = Date.now();
  const cached = googleAdsHistoryCache[tabName];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  try {
    const data = await fetchGoogleAdsHistory(process.env, monthTabToYYYYMM(tabName));
    const entry = { data, error: null, fetchedAt: now };
    googleAdsHistoryCache[tabName] = entry;
    return entry;
  } catch (err) {
    const entry = { data: null, error: String(err.message || err), fetchedAt: now };
    googleAdsHistoryCache[tabName] = entry;
    return entry;
  }
}

async function getMetaAdsHistory(tabName) {
  const now = Date.now();
  const cached = metaAdsHistoryCache[tabName];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  try {
    const data = await fetchMetaAdsHistory(process.env, monthTabToYYYYMM(tabName));
    const entry = { data, error: null, fetchedAt: now };
    metaAdsHistoryCache[tabName] = entry;
    return entry;
  } catch (err) {
    const entry = { data: null, error: String(err.message || err), fetchedAt: now };
    metaAdsHistoryCache[tabName] = entry;
    return entry;
  }
}

function formatAdsCampaignList(campaigns) {
  if (!Array.isArray(campaigns) || !campaigns.length) return '(sin campañas con gasto o conversiones en ese mes)';
  return campaigns.slice(0, 15).map((c) => {
    const parts = [`- ${c.name} [${c.status}]`];
    if (c.accountName) parts.push(`cuenta ${c.accountName}`);
    if (c.objective) parts.push(`objetivo ${c.objective}`);
    parts.push(`gasto $${c.spend}`);
    parts.push(`conversiones ${c.conversions}`);
    parts.push(`CPA ${c.cpa !== null && c.cpa !== undefined ? '$' + c.cpa : '—'}`);
    return parts.join(' · ');
  }).join('\n');
}

/** Arma el bloque de historial de Ads (Google + Meta, API en vivo) para los meses detectados en el mensaje. */
async function getAdsHistoryBlock(tabNames) {
  const sections = await Promise.all(tabNames.map(async (tabName) => {
    const [ga, ma] = await Promise.all([getGoogleAdsHistory(tabName), getMetaAdsHistory(tabName)]);
    const gaText = ga.data
      ? formatAdsCampaignList(ga.data.campaigns)
      : `(no se pudo traer Google Ads de ${tabName}: ${ga.error || 'sin detalle'})`;
    const maText = ma.data
      ? formatAdsCampaignList(ma.data.campaigns)
      : `(no se pudo traer Meta Ads de ${tabName}: ${ma.error || 'sin detalle'})`;
    return `--- ${tabName}: Google Ads (histórico, API en vivo) ---\n${gaText}\n\n--- ${tabName}: Meta Ads (histórico, API en vivo) ---\n${maText}`;
  }));

  return `\n--- Historial de medios pagos pedido a demanda (directo de las APIs de Google Ads y Meta Ads, no del Sheet — sirve para meses o campañas que no estén volcados a la pestaña "Google Ads"/"Meta Ads" del Sheet) ---
${sections.join('\n\n')}

Esto es un listado de campañas crudo (no tiene la columna "Squad" que sí tiene la pestaña del Sheet, porque esa asignación es manual). Si necesitás saber a qué squad pertenece una de estas campañas y no es obvio por el nombre, decilo en vez de inventar la asignación.`;
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

  // "Campañas", "Equipo", "Google Ads" y "Meta Ads" son un plus: si fallan, seguimos igual con el resto.
  let campaignsCsv = null, campaignsError = null;
  let equipoCsv = null, equipoError = null;
  let googleAdsCsv = null, googleAdsError = null;
  let metaAdsCsv = null, metaAdsError = null;
  await Promise.all([
    fetchTab('Campañas').then((csv) => { campaignsCsv = csv.slice(0, 6000); }).catch((err) => { campaignsError = String(err.message || err); }),
    fetchTab('Equipo').then((csv) => { equipoCsv = csv.slice(0, 3000); }).catch((err) => { equipoError = String(err.message || err); }),
    fetchTab('Google Ads').then((csv) => { googleAdsCsv = csv.slice(0, 4000); }).catch((err) => { googleAdsError = String(err.message || err); }),
    fetchTab('Meta Ads').then((csv) => { metaAdsCsv = csv.slice(0, 4000); }).catch((err) => { metaAdsError = String(err.message || err); })
  ]);

  if (coreError) {
    return { planAnualCsv: null, monthCsv: null, currentMonthTab, campaignsCsv, campaignsError, equipoCsv, equipoError, googleAdsCsv, googleAdsError, metaAdsCsv, metaAdsError, fetchedAt: new Date().toISOString(), error: coreError };
  }

  const payload = {
    planAnualCsv: planAnualCsv.slice(0, 5000),
    currentMonthTab,
    monthCsv: monthCsv.slice(0, 7000),
    campaignsCsv,
    campaignsError,
    equipoCsv,
    equipoError,
    googleAdsCsv,
    googleAdsError,
    metaAdsCsv,
    metaAdsError,
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

/* ============================================================
 * GROWTH INSIGHTS / DATO DESTACADO
 * Port 1:1 de la lógica de index.html (parseCSV, parsePlanAnual,
 * parseMonthTab, buildWorkingDataset, computeInsights) para que el
 * asistente diga EXACTAMENTE lo mismo que el tablero — nunca lo
 * recalcula Claude leyendo CSV crudo, evita cualquier divergencia.
 * ============================================================ */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SQUAD_NAME_VARIANTS = {
  'ADQUISICIÓN Y CROSSELLING': 'Adquisición y Crosselling',
  HABITUALIDAD: 'Habitualidad',
  'BEZZA HUB': 'Bezza Hub',
  EMPRESAS: 'Empresas'
};

function normCell(s) { return (s || '').toString().replace(/\s+/g, ' ').trim(); }

function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (field.length || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parsePlanAnualRows(rows) {
  const plan = {};
  let curSquad = null;
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const squadCell = normCell(row[0]);
    const prod = normCell(row[1]);
    const kpi = normCell(row[2]);
    if (squadCell) curSquad = squadCell;
    if (prod && curSquad) {
      const months = [];
      for (let i = 0; i < 12; i++) {
        const v = parseFloat((row[3 + i] || '').replace(/[^0-9.-]/g, ''));
        months.push(isNaN(v) ? null : v);
      }
      plan[curSquad] = plan[curSquad] || {};
      plan[curSquad][prod] = { kpi, plan: months };
    }
  }
  return plan;
}

function parseMonthTabRows(rows) {
  const result = {};
  const maxR = rows.length;
  let r = 0;
  while (r < maxR) {
    const c0 = rows[r] ? rows[r][0] : '';
    if (c0 && c0.includes('PO:')) {
      const namePart = c0.split('·')[0].trim().toUpperCase();
      let squad = namePart;
      for (const key in SQUAD_NAME_VARIANTS) { if (namePart.includes(key)) { squad = SQUAD_NAME_VARIANTS[key]; break; } }
      const headerRow = rows[r + 1] || [];
      const prodCols = [];
      for (let ci = 2; ci < headerRow.length; ci++) {
        const h = normCell(headerRow[ci]);
        if (h && h.toUpperCase().startsWith('TOTAL')) break;
        if (h) prodCols.push([ci, h]);
      }
      let rr = r + 2;
      const daily = {}; prodCols.forEach(([ci, name]) => { daily[name] = []; });
      while (rr < maxR) {
        const row = rows[rr] || [];
        const c0b = normCell(row[0]);
        if (c0b.includes('PO:')) break;
        const dia = parseFloat(row[0]);
        if (!isNaN(dia) && row[0] !== '') {
          prodCols.forEach(([ci, name]) => {
            const v = parseFloat((row[ci] || '').replace(/[^0-9.-]/g, ''));
            daily[name].push(isNaN(v) ? null : v);
          });
          rr++;
        } else if (normCell(row[1]) === 'TOTAL ACUM') {
          break;
        } else { rr++; }
      }
      const acum = {};
      while (rr < maxR) {
        const row = rows[rr] || [];
        if (normCell(row[1]) === 'TOTAL ACUM') {
          prodCols.forEach(([ci, name]) => {
            const v = parseFloat((row[ci] || '').replace(/[^0-9.-]/g, ''));
            acum[name] = isNaN(v) ? null : v;
          });
          rr++; break;
        }
        if (normCell(row[0]).includes('PO:')) break;
        rr++;
      }
      const asOfDay = {};
      prodCols.forEach(([ci, name]) => {
        let last = 0;
        daily[name].forEach((v, i) => { if (v !== null) last = i + 1; });
        asOfDay[name] = last;
      });
      result[squad] = { products: prodCols.map((p) => p[1]), acum, asOfDay };
      r = rr; continue;
    }
    r++;
  }
  return result;
}

/** ritmo anual = acumulado real (meses con carga) / objetivo prorrateado (mismos meses) — igual que buildWorkingDataset() en index.html */
function buildWorkingDataset(planBySquad, monthlyBySquadByMonth) {
  const dataset = {};
  Object.keys(planBySquad).forEach((squad) => {
    dataset[squad] = { products: {} };
    Object.keys(planBySquad[squad]).forEach((prod) => {
      const p = planBySquad[squad][prod];
      let yearReal = 0, yearProrated = 0;
      MONTH_TABS.forEach((m, mi) => {
        const monthData = monthlyBySquadByMonth[m] && monthlyBySquadByMonth[m][squad];
        const acum = monthData ? monthData.acum[prod] : undefined;
        const asOfDay = monthData ? (monthData.asOfDay[prod] || 0) : 0;
        if (acum !== undefined && acum !== null && asOfDay > 0) {
          const target = p.plan[mi];
          if (target !== null && target !== undefined) {
            yearReal += acum;
            yearProrated += target * (asOfDay / DAYS_IN_MONTH[mi]);
          }
        }
      });
      dataset[squad].products[prod] = {
        kpi: p.kpi,
        ritmo: yearProrated > 0 ? yearReal / yearProrated : null
      };
    });
  });
  return dataset;
}

function pctFmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n * 100).toFixed(0) + '%';
}

/** Mismos umbrales y mismo texto que computeInsights() en index.html */
function computeInsightsList(dataset, squadFilter) {
  const items = [];
  const noData = [];
  Object.keys(dataset).forEach((squad) => {
    if (squadFilter && squad !== squadFilter) return;
    Object.keys(dataset[squad].products).forEach((prod) => {
      const d = dataset[squad].products[prod];
      if (d.ritmo === null) {
        noData.push({ seg: squad, prod, kpi: d.kpi });
        return;
      }
      if (d.ritmo >= 1.10) {
        items.push({ type: 'positive', seg: squad, prod, text: `${prod} va ${pctFmt(d.ritmo - 1)} por encima del objetivo prorrateado a la fecha (${d.kpi}).`, mag: d.ritmo - 1 });
      } else if (d.ritmo <= 0.85) {
        items.push({ type: 'negative', seg: squad, prod, text: `${prod} está ${pctFmt(1 - d.ritmo)} por debajo del ritmo esperado a esta altura del mes (${d.kpi}).`, mag: 1 - d.ritmo });
      }
    });
  });
  items.sort((a, b) => b.mag - a.mag);
  return { items: items.slice(0, 8), noData };
}

let insightsCache = { text: null, fetchedAt: 0 };
const INSIGHTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — es una lectura más pesada (13 pestañas), no hace falta recalcular en cada mensaje

/** Trae Plan Anual + los 12 meses (los borrados devuelven error, se ignoran), arma el dataset y calcula insights + dato destacado, ya formateados en texto listo para el prompt. */
async function getGrowthInsightsBlock() {
  const now = Date.now();
  if (insightsCache.text && now - insightsCache.fetchedAt < INSIGHTS_CACHE_TTL_MS) {
    return insightsCache.text;
  }

  let planCsv;
  try {
    planCsv = await fetchTab('Plan Anual');
  } catch (err) {
    return `\n(No se pudieron calcular Growth Insights / Dato destacado en este momento: ${String(err.message || err)}.)`;
  }

  const monthlyBySquadByMonth = {};
  await Promise.all(MONTH_TABS.map(async (m) => {
    try {
      const csv = await fetchTab(m);
      monthlyBySquadByMonth[m] = parseMonthTabRows(parseCsvRows(csv));
    } catch (err) {
      // pestañas borradas (Ene-Jun) o sin datos todavía: se tratan como mes sin carga, no es un error real
    }
  }));

  const planBySquad = parsePlanAnualRows(parseCsvRows(planCsv));
  const dataset = buildWorkingDataset(planBySquad, monthlyBySquadByMonth);

  const global = computeInsightsList(dataset, null);
  let destacado;
  if (global.items.length) {
    const top = global.items[0];
    destacado = `${top.type === 'positive' ? 'Dato destacado · oportunidad' : 'Dato destacado · alerta'} (${top.seg}): ${top.text}`;
  } else if (global.noData.length) {
    destacado = `Dato destacado: ${global.noData.length} producto${global.noData.length > 1 ? 's' : ''} todavía sin carga de resultados este año — no hay desvíos fuertes que reportar por ahora.`;
  } else {
    destacado = `Dato destacado: todos los productos con carga están dentro del rango esperado (entre 85% y 110% de ritmo).`;
  }

  const bySquadLines = Object.keys(dataset).map((squad) => {
    const { items, noData } = computeInsightsList(dataset, squad);
    const lines = items.map((it) => `  - [${it.type === 'positive' ? '▲ oportunidad' : '▼ atención'}] ${it.text}`);
    const noDataLines = noData.map((n) => `  - [sin carga de datos] "${n.prod}" (${n.kpi}) todavía no tiene resultados diarios cargados este año.`);
    const all = [...lines, ...noDataLines];
    return `${squad}:\n${all.length ? all.join('\n') : '  (nada para reportar — dentro del rango esperado o sin datos)'}`;
  }).join('\n');

  const text = `\n--- Growth Insights y Dato destacado (calculados igual que el tablero — ritmo ANUAL: acumulado real de todos los meses con carga ÷ objetivo de esos mismos meses prorrateado por día, NO es el ritmo de un solo mes) ---
${destacado}

Growth Insights por squad (▲ oportunidad si ritmo ≥110%, ▼ atención si ritmo ≤85%, hasta 8 por squad ordenados por magnitud):
${bySquadLines}

Usá estos insights tal cual cuando te pregunten por "Growth Insights", "dato destacado", "oportunidades" o "alertas" — no los recalcules desde las pestañas mensuales sueltas, ya vienen calculados con el mismo criterio que ve el equipo en el tablero. Esta es una métrica DISTINTA del ritmo mensual simple que usás para el resto de las respuestas (acumulado del mes ÷ meta del mes prorrateada a los días transcurridos) — si mezclás ambas en una misma respuesta, aclarale a la persona cuál es cuál.`;

  insightsCache = { text, fetchedAt: now };
  return text;
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
function buildSystemPrompt(liveContext, insightsBlock, adsHistoryBlock) {
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

    const googleAdsBlock = liveContext.googleAdsCsv
      ? `\n--- Pestaña "Google Ads" (cuenta MCC 113-524-1144, agregado de cuentas hija) ---\n${liveContext.googleAdsCsv}\n\nCómo leer "Google Ads": columnas ID | Nombre | Cuenta | Estado | Gasto MTD | CPA |
  Squad | Presupuesto. "Gasto MTD" es el gasto acumulado en lo que va del mes
  (month-to-date), y "CPA" el costo por adquisición de esa campaña puntual.
  Esta pestaña es una fuente distinta de "Campañas" (esa viene de Azure DevOps,
  ésta directo de Google Ads) — pueden referirse a la misma campaña real con
  nombres parecidos pero no idénticos; si el nombre no coincide exacto, decilo
  en vez de asumir que son la misma. Cruzala con el ritmo del squad correspondiente:
  gasto alto + CPA alto + ritmo atrasado es una señal fuerte de ineficiencia en medios
  pagos que vale la pena señalar. No inventes gasto, CPA ni presupuesto que no
  esté explícito en esta pestaña — y no confundas "Presupuesto" (lo planeado)
  con "Gasto MTD" (lo efectivamente gastado).`
      : liveContext.googleAdsError
        ? `\n(No se pudo leer la pestaña "Google Ads" en este momento: ${liveContext.googleAdsError}. Si preguntan por gasto en medios pagos, avisá que no lo tenés disponible ahora.)`
        : '';

    const metaAdsBlock = liveContext.metaAdsCsv
      ? `\n--- Pestaña "Meta Ads" ---\n${liveContext.metaAdsCsv}\n\nCómo leer "Meta Ads": columnas ID | Nombre | Estado | Objetivo | Gasto MTD |
  Conversiones | CPA | Squad. "Objetivo" es el objetivo de campaña de Meta (ej.
  Conversiones, Tráfico, Reconocimiento) — no lo confundas con el objetivo
  mensual del squad en Plan Anual, son cosas distintas con el mismo nombre.
  "Conversiones" es la cantidad real reportada por Meta, y "CPA" ya viene
  calculado (Gasto MTD ÷ Conversiones, en general). Es una fuente separada de
  "Google Ads" — mismo squad puede tener campañas corriendo en los dos canales
  a la vez; si te preguntan por "medios pagos" en general sin especificar canal,
  sumá o compará ambas fuentes explícitamente aclarando de dónde sale cada
  número, nunca las mezcles en un solo total sin decirlo. No inventes gasto,
  conversiones ni CPA que no esté explícito en esta pestaña.`
      : liveContext.metaAdsError
        ? `\n(No se pudo leer la pestaña "Meta Ads" en este momento: ${liveContext.metaAdsError}. Si preguntan por gasto en Meta, avisá que no lo tenés disponible ahora.)`
        : '';

    dataBlock = `Datos crudos leídos en vivo del Sheet (${liveContext.fetchedAt}).

--- Pestaña "Plan Anual" (objetivos mensuales, fuente de verdad) ---
${liveContext.planAnualCsv}

--- Pestaña "${liveContext.currentMonthTab}" (mes en curso, datos reales día a día) ---
${liveContext.monthCsv}
${extraBlocks}
${campaignsBlock}
${equipoBlock}
${googleAdsBlock}
${metaAdsBlock}
${insightsBlock || ''}
${adsHistoryBlock || ''}

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
