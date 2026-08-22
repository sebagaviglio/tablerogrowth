/* ============================================================
   api/_lib/growth-data.js

   Lógica de datos compartida entre el Asistente de Growth (chat) y
   el nuevo Generador de Informes. Es un port 1:1 de las funciones
   equivalentes que ya vivían en api/growth-assistant.js (fetch de
   pestañas del Sheet, parseo de CSV, cálculo de "ritmo" e insights)
   para que NINGÚN consumidor recalcule esto por su cuenta — todos
   tienen que ver los mismos números que ve el equipo en el tablero.

   Si en el futuro tocás la lógica de ritmo/insights, tocala acá
   una sola vez: growth-assistant.js y growth-report.js la importan
   de este módulo.
   ============================================================ */

const SHEET_SCRIPT_URL = process.env.GROWTH_SHEET_SCRIPT_URL;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const INSIGHTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — lectura pesada (13 pestañas)

const MONTH_TABS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MONTH_LABELS_ES = {
  Ene: 'enero', Feb: 'febrero', Mar: 'marzo', Abr: 'abril', May: 'mayo', Jun: 'junio',
  Jul: 'julio', Ago: 'agosto', Sep: 'septiembre', Oct: 'octubre', Nov: 'noviembre', Dic: 'diciembre'
};
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SQUAD_NAME_VARIANTS = {
  'ADQUISICIÓN Y CROSSELLING': 'Adquisición y Crosselling',
  HABITUALIDAD: 'Habitualidad',
  'BEZZA HUB': 'Bezza Hub',
  EMPRESAS: 'Empresas'
};

function currentMonthTab() {
  return MONTH_TABS[new Date().getMonth()];
}

/** Los últimos `n` días calendario, terminando hoy (incluido), en orden ascendente. */
function lastNDates(n, refDate) {
  const ref = refDate ? new Date(refDate) : new Date();
  const dates = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - i);
    dates.push(d);
  }
  return dates;
}
function monthTabForDate(d) { return MONTH_TABS[d.getMonth()]; }
function fmtDateEs(d) { return `${d.getDate()} de ${MONTH_LABELS_ES[monthTabForDate(d)]}`; }
/** Etiqueta legible del período semanal, ej. "16 al 22 de agosto de 2026". */
function weekLabel(days) {
  const first = days[0], last = days[days.length - 1];
  const year = last.getFullYear();
  if (monthTabForDate(first) === monthTabForDate(last)) {
    return `${first.getDate()} al ${last.getDate()} de ${MONTH_LABELS_ES[monthTabForDate(last)]} de ${year}`;
  }
  return `${fmtDateEs(first)} al ${fmtDateEs(last)} de ${year}`;
}

/* ------------------------------------------------------------ *
 * Fetch de pestañas del Sheet (vía el Apps Script existente)   *
 * ------------------------------------------------------------ */
async function fetchTab(tabName) {
  const url = SHEET_SCRIPT_URL + '?tab=' + encodeURIComponent(tabName);
  const r = await fetch(url, { method: 'GET' });
  const text = await r.text();
  if (text.trim().startsWith('ERROR')) {
    throw new Error(`Pestaña "${tabName}": ${text.trim()}`);
  }
  return text;
}

let baseCache = { payload: null, fetchedAt: 0 };
const monthTabCache = {};

async function getBaseContext() {
  const now = Date.now();
  if (baseCache.payload && now - baseCache.fetchedAt < CACHE_TTL_MS) {
    return baseCache.payload;
  }
  const monthTab = currentMonthTab();

  let planAnualCsv, monthCsv, coreError;
  try {
    [planAnualCsv, monthCsv] = await Promise.all([fetchTab('Plan Anual'), fetchTab(monthTab)]);
  } catch (err) {
    coreError = String(err.message || err);
  }

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
    const payload = { planAnualCsv: null, monthCsv: null, currentMonthTab: monthTab, campaignsCsv, campaignsError, equipoCsv, equipoError, googleAdsCsv, googleAdsError, metaAdsCsv, metaAdsError, fetchedAt: new Date().toISOString(), error: coreError };
    return payload;
  }

  const payload = {
    planAnualCsv: planAnualCsv.slice(0, 5000),
    currentMonthTab: monthTab,
    monthCsv: monthCsv.slice(0, 7000),
    campaignsCsv, campaignsError,
    equipoCsv, equipoError,
    googleAdsCsv, googleAdsError,
    metaAdsCsv, metaAdsError,
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
 * Parseo de CSV + cálculo de ritmo (igual que index.html)      *
 * ------------------------------------------------------------ */
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
      const daily = {}; const dailyByDay = {};
      prodCols.forEach(([ci, name]) => { daily[name] = []; dailyByDay[name] = {}; });
      while (rr < maxR) {
        const row = rows[rr] || [];
        const c0b = normCell(row[0]);
        if (c0b.includes('PO:')) break;
        const dia = parseFloat(row[0]);
        if (!isNaN(dia) && row[0] !== '') {
          prodCols.forEach(([ci, name]) => {
            const v = parseFloat((row[ci] || '').replace(/[^0-9.-]/g, ''));
            const val = isNaN(v) ? null : v;
            daily[name].push(val);
            dailyByDay[name][dia] = val; // clave = número de día del mes, no posición — evita corrimientos si hay huecos
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
      result[squad] = { products: prodCols.map((p) => p[1]), acum, asOfDay, dailyByDay };
      r = rr; continue;
    }
    r++;
  }
  return result;
}

/** ritmo anual = acumulado real (meses con carga) / objetivo prorrateado (mismos meses) */
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
        items.push({ type: 'positive', seg: squad, prod, text: `${prod} va ${pctFmt(d.ritmo - 1)} por encima del objetivo prorrateado a la fecha (${d.kpi}).`, mag: d.ritmo - 1, ritmo: d.ritmo });
      } else if (d.ritmo <= 0.85) {
        items.push({ type: 'negative', seg: squad, prod, text: `${prod} está ${pctFmt(1 - d.ritmo)} por debajo del ritmo esperado a esta altura del mes (${d.kpi}).`, mag: 1 - d.ritmo, ritmo: d.ritmo });
      }
    });
  });
  items.sort((a, b) => b.mag - a.mag);
  return { items: items.slice(0, 8), noData };
}

let insightsCache = { text: null, dataset: null, fetchedAt: 0 };

/** Trae Plan Anual + los 12 meses, arma el dataset y calcula insights + dato destacado. Devuelve texto (para el prompt) Y el dataset crudo (para armar el informe). */
async function getGrowthInsights() {
  const now = Date.now();
  if (insightsCache.text && now - insightsCache.fetchedAt < INSIGHTS_CACHE_TTL_MS) {
    return insightsCache;
  }

  let planCsv;
  try {
    planCsv = await fetchTab('Plan Anual');
  } catch (err) {
    const text = `\n(No se pudieron calcular Growth Insights / Dato destacado en este momento: ${String(err.message || err)}.)`;
    return { text, dataset: null, fetchedAt: now };
  }

  const monthlyBySquadByMonth = {};
  await Promise.all(MONTH_TABS.map(async (m) => {
    try {
      const csv = await fetchTab(m);
      monthlyBySquadByMonth[m] = parseMonthTabRows(parseCsvRows(csv));
    } catch (err) { /* pestañas borradas o sin datos todavía: no es un error real */ }
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

  const text = `\n--- Growth Insights y Dato destacado (ritmo ANUAL: acumulado real de todos los meses con carga ÷ objetivo de esos mismos meses prorrateado por día) ---
${destacado}

Growth Insights por squad (▲ oportunidad si ritmo ≥110%, ▼ atención si ritmo ≤85%, hasta 8 por squad ordenados por magnitud):
${bySquadLines}`;

  insightsCache = { text, dataset, destacado, fetchedAt: now };
  return insightsCache;
}

/* ------------------------------------------------------------ *
 * RITMO SEMANAL — últimos 7 días calendario (para el informe    *
 * semanal a Dirección). Distinto del "ritmo" anual/mensual que  *
 * usa el asistente de chat: acá el objetivo prorrateado y el    *
 * acumulado real se calculan SOLO sobre los últimos 7 días,     *
 * sumando ambos meses si la semana cruza un límite de mes.      *
 * ------------------------------------------------------------ */

/** Trae Plan Anual + las pestañas mensuales que toquen los últimos 7 días (1 o 2), y arma el dataset semanal por squad/producto. */
async function getWeeklyContext() {
  const days = lastNDates(7);
  const label = weekLabel(days);
  const neededTabs = Array.from(new Set(days.map(monthTabForDate)));

  let planCsv, planError;
  try {
    planCsv = await fetchTab('Plan Anual');
  } catch (err) {
    planError = String(err.message || err);
  }
  if (planError) {
    return { dataset: null, days, label, neededTabs, error: planError, fetchedAt: new Date().toISOString() };
  }

  const monthlyParsed = {};
  const monthErrors = {};
  await Promise.all(neededTabs.map(async (tab) => {
    try {
      const csv = await fetchTab(tab);
      monthlyParsed[tab] = parseMonthTabRows(parseCsvRows(csv));
    } catch (err) {
      monthErrors[tab] = String(err.message || err);
    }
  }));

  const planBySquad = parsePlanAnualRows(parseCsvRows(planCsv));
  const dataset = {};
  Object.keys(planBySquad).forEach((squad) => {
    dataset[squad] = { products: {} };
    Object.keys(planBySquad[squad]).forEach((prod) => {
      const p = planBySquad[squad][prod];
      let weeklyReal = 0, weeklyTarget = 0, anyData = false, anyTarget = false;
      days.forEach((d) => {
        const tab = monthTabForDate(d);
        const mi = MONTH_TABS.indexOf(tab);
        const target = p.plan[mi];
        const dim = DAYS_IN_MONTH[mi];
        if (target !== null && target !== undefined) {
          weeklyTarget += target / dim;
          anyTarget = true;
        }
        const monthData = monthlyParsed[tab] && monthlyParsed[tab][squad];
        const val = monthData && monthData.dailyByDay[prod] ? monthData.dailyByDay[prod][d.getDate()] : undefined;
        if (val !== undefined && val !== null) {
          weeklyReal += val;
          anyData = true;
        }
      });
      dataset[squad].products[prod] = {
        kpi: p.kpi,
        weeklyReal,
        weeklyTarget,
        ritmoSemanal: (anyData && anyTarget && weeklyTarget > 0) ? weeklyReal / weeklyTarget : null
      };
    });
  });

  return { dataset, days, label, neededTabs, monthErrors, fetchedAt: new Date().toISOString() };
}

/** Mismos umbrales que computeInsightsList (▲ ≥110%, ▼ ≤85%) pero sobre ritmo SEMANAL. */
function computeWeeklyInsightsList(dataset, squadFilter) {
  const items = [];
  const noData = [];
  Object.keys(dataset).forEach((squad) => {
    if (squadFilter && squad !== squadFilter) return;
    Object.keys(dataset[squad].products).forEach((prod) => {
      const d = dataset[squad].products[prod];
      if (d.ritmoSemanal === null) {
        if (d.weeklyTarget > 0) noData.push({ seg: squad, prod, kpi: d.kpi });
        return;
      }
      if (d.ritmoSemanal >= 1.10) {
        items.push({ type: 'positive', seg: squad, prod, kpi: d.kpi, ritmo: d.ritmoSemanal, real: d.weeklyReal, target: d.weeklyTarget, text: `${prod} (${squad}) cerró los últimos 7 días ${pctFmt(d.ritmoSemanal - 1)} por encima del objetivo semanal (${d.kpi}: ${Math.round(d.weeklyReal)} reales vs. ${Math.round(d.weeklyTarget)} esperados).`, mag: d.ritmoSemanal - 1 });
      } else if (d.ritmoSemanal <= 0.85) {
        items.push({ type: 'negative', seg: squad, prod, kpi: d.kpi, ritmo: d.ritmoSemanal, real: d.weeklyReal, target: d.weeklyTarget, text: `${prod} (${squad}) cerró los últimos 7 días ${pctFmt(1 - d.ritmoSemanal)} por debajo del objetivo semanal (${d.kpi}: ${Math.round(d.weeklyReal)} reales vs. ${Math.round(d.weeklyTarget)} esperados).`, mag: 1 - d.ritmoSemanal });
      }
    });
  });
  items.sort((a, b) => b.mag - a.mag);
  return { items, noData };
}

/* ------------------------------------------------------------ *
 * Comentarios/insights de los PO — quedan guardados en el Sheet *
 * (pestaña "Comentarios PO", vía doPost en el Apps Script) para *
 * que sean parte de la base de conocimiento a futuro.           *
 * ------------------------------------------------------------ */

/** Persiste los comentarios semanales de los PO en el Sheet. Requiere el doPost agregado al Apps Script (ver LEEME). Si no está disponible, falla en silencio y lo informa — nunca bloquea la generación del informe. */
async function saveWeeklyComments(label, comments) {
  const entries = Object.entries(comments || {}).filter(([, v]) => typeof v === 'string' && v.trim());
  if (!entries.length) return { saved: true, count: 0 };
  if (!SHEET_SCRIPT_URL) return { saved: false, count: 0, error: 'GROWTH_SHEET_SCRIPT_URL no configurada' };

  try {
    const r = await fetch(SHEET_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'saveWeeklyComments',
        weekLabel: label,
        comments: entries.map(([squad, texto]) => ({ squad, texto: texto.trim() })),
        timestamp: new Date().toISOString()
      })
    });
    const text = await r.text();
    if (!r.ok || text.trim().toUpperCase().startsWith('ERROR')) {
      return { saved: false, count: 0, error: text.trim() || `HTTP ${r.status}` };
    }
    return { saved: true, count: entries.length };
  } catch (err) {
    return { saved: false, count: 0, error: String(err.message || err) };
  }
}

/** Comentarios de PO de semanas anteriores (si la pestaña "Comentarios PO" existe — se lee con el mismo doGet genérico, no requiere código nuevo del lado de lectura). Se usa como contexto extra para el informe; si la pestaña no existe todavía, se ignora sin error. */
async function getRecentPOComments(maxRows) {
  try {
    const csv = await fetchTab('Comentarios PO');
    const rows = parseCsvRows(csv).filter((r) => r && r.some((c) => normCell(c)));
    if (rows.length <= 1) return [];
    return rows.slice(1).slice(-1 * (maxRows || 12)).map((r) => ({
      fecha: normCell(r[0]), semana: normCell(r[1]), squad: normCell(r[2]), texto: normCell(r[3])
    })).filter((c) => c.texto);
  } catch (err) {
    return []; // la pestaña puede no existir todavía — no es un error real
  }
}

/* ------------------------------------------------------------ *
 * Bloque de datos crudos con notas de lectura — mismo texto     *
 * que arma buildSystemPrompt() en growth-assistant.js, para que *
 * el informe interprete las pestañas exactamente igual.        *
 * ------------------------------------------------------------ */
function describeLiveContext(liveContext) {
  if (!liveContext.planAnualCsv || !liveContext.monthCsv) {
    return `No se pudo leer el Sheet en vivo en este momento (${liveContext.error || 'sin detalle'}).`;
  }

  const campaignsBlock = liveContext.campaignsCsv
    ? `\n--- Pestaña "Campañas" (sincronizada desde Azure DevOps) ---\n${liveContext.campaignsCsv}\n\nColumnas: ID | Nombre | Estado | Fecha inicio | Fecha fin | Squad/Canal | Presupuesto | Interpretación IA. Cruzá esto con el ritmo: si un producto está atrasado, revisá si tiene una campaña activa que debería empujarlo, o si no tiene ninguna corriendo.`
    : liveContext.campaignsError
      ? `\n(No se pudo leer "Campañas": ${liveContext.campaignsError}.)`
      : '';

  const equipoBlock = liveContext.equipoCsv
    ? `\n--- Pestaña "Equipo" ---\n${liveContext.equipoCsv}\n\nUsala solo para identificar PO/Owner de cada squad. Nunca evalúes ni rankees personas.`
    : liveContext.equipoError
      ? `\n(No se pudo leer "Equipo": ${liveContext.equipoError}.)`
      : '';

  const googleAdsBlock = liveContext.googleAdsCsv
    ? `\n--- Pestaña "Google Ads" (cuenta MCC agregada) ---\n${liveContext.googleAdsCsv}\n\nColumnas: ID | Nombre | Cuenta | Estado | Gasto MTD | CPA | Squad | Presupuesto. Gasto alto + CPA alto + ritmo atrasado = señal de ineficiencia en medios pagos.`
    : liveContext.googleAdsError
      ? `\n(No se pudo leer "Google Ads": ${liveContext.googleAdsError}.)`
      : '';

  const metaAdsBlock = liveContext.metaAdsCsv
    ? `\n--- Pestaña "Meta Ads" ---\n${liveContext.metaAdsCsv}\n\nColumnas: ID | Nombre | Estado | Objetivo | Gasto MTD | Conversiones | CPA | Squad. Fuente separada de Google Ads — no las mezcles en un total sin aclararlo.`
    : liveContext.metaAdsError
      ? `\n(No se pudo leer "Meta Ads": ${liveContext.metaAdsError}.)`
      : '';

  return `--- Pestaña "Plan Anual" (objetivos mensuales, fuente de verdad) ---
${liveContext.planAnualCsv}

--- Pestaña "${liveContext.currentMonthTab}" (mes en curso, datos reales día a día) ---
${liveContext.monthCsv}
${campaignsBlock}
${equipoBlock}
${googleAdsBlock}
${metaAdsBlock}

Cómo leer: en cada pestaña mensual, por squad hay un bloque "SQUAD · PO: ... · Own: ..." con una grilla diaria hasta "TOTAL ACUM" (acumulado real). Objetivo mensual = siempre de "Plan Anual", nunca de la fila "META MES" (desalineada). Ritmo del mes en curso = acumulado real ÷ (objetivo mensual prorrateado a los días con carga real).`;
}

module.exports = {
  MONTH_TABS,
  MONTH_LABELS_ES,
  DAYS_IN_MONTH,
  currentMonthTab,
  lastNDates,
  monthTabForDate,
  weekLabel,
  fetchTab,
  getBaseContext,
  getExtraMonthTab,
  getLiveContext,
  parseCsvRows,
  parsePlanAnualRows,
  parseMonthTabRows,
  buildWorkingDataset,
  computeInsightsList,
  getGrowthInsights,
  getWeeklyContext,
  computeWeeklyInsightsList,
  saveWeeklyComments,
  getRecentPOComments,
  describeLiveContext,
  pctFmt
};
