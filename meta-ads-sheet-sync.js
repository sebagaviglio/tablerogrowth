// /api/meta-ads-sheet-sync.js
// ------------------------------------------------------------------
// Escribe (upsert) la lista de campañas de Meta Ads del mes (de las 6
// cuentas activas en whitelist — ver _lib/meta-ads-core.js) en la
// pestaña "Meta Ads" del Google Sheet del tablero, para que el equipo
// pueda asignarles Squad — a mano en el Sheet (mismo lugar que Google
// Ads). A diferencia de Google Ads, acá "Objetivo" NO es manual: sale
// directo de la API de Meta (campaign.objective) y se re-escribe en
// cada sync, no se preserva.
//
// Columnas de la pestaña "Meta Ads" (se crea sola si no existe):
//   A: ID  B: Nombre  C: Cuenta (Bancor/Wobra, cuál de las 6)  D: Estado
//   E: Objetivo (automático, se re-escribe siempre)  F: Gasto MTD
//   G: Conversiones  H: CPA  I: Squad (manual)
//
// En cada sync se recalculan A-H desde la API de Meta y se PRESERVA
// solo I (Squad) por ID de campaña — igual que Google Ads preserva
// Squad y Objetivo, acá solo hay una columna manual que cuidar.
//
// Usa la MISMA Service Account que google-ads-sheet-sync.js (mismo
// Sheet, mismas credenciales — no hace falta darla de alta de nuevo):
//
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY
//
// Además necesita, igual que meta-ads-proxy.js:
//   META_ACCESS_TOKEN
//   META_AD_ACCOUNT_ID
// ------------------------------------------------------------------

const { getSheetsAccessToken, sheetsFetch } = require('./_lib/sheets-auth');
const { fetchCampaigns } = require('./_lib/meta-ads-core');

const SHEET_TAB = 'Meta Ads';

// Copia liviana del mapeo de objective -> etiqueta en español que usa el
// dashboard (META_OBJETIVO_LABELS en index.html). Si se agregan objetivos
// nuevos ahí, replicar acá también para que el Sheet muestre lo mismo que
// el panel.
const OBJETIVO_LABELS = {
  OUTCOME_SALES: 'Ventas',
  OUTCOME_LEADS: 'Leads',
  OUTCOME_ENGAGEMENT: 'Interacción',
  OUTCOME_AWARENESS: 'Reconocimiento',
  OUTCOME_TRAFFIC: 'Tráfico',
  OUTCOME_APP_PROMOTION: 'Promoción de app',
  CONVERSIONS: 'Conversión',
  LINK_CLICKS: 'Tráfico',
  LEAD_GENERATION: 'Leads',
  BRAND_AWARENESS: 'Reconocimiento',
  REACH: 'Alcance',
  APP_INSTALLS: 'Promoción de app',
  VIDEO_VIEWS: 'Interacción',
  MESSAGES: 'Interacción',
  PRODUCT_CATALOG_SALES: 'Ventas',
  STORE_VISITS: 'Visitas a local',
  POST_ENGAGEMENT: 'Interacción',
};
function objetivoLabel(objective) {
  if (!objective) return '';
  return OBJETIVO_LABELS[objective] || objective;
}

async function ensureTabExists(accessToken, sheetId) {
  const meta = await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`);
  const exists = (meta.sheets || []).some(s => s.properties.title === SHEET_TAB);
  if (exists) return;
  await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] })
  });
}

async function readExistingSquads(accessToken, sheetId) {
  const range = `${encodeURIComponent(SHEET_TAB)}!A2:I5000`;
  const data = await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`);
  const map = {}; // campaignId -> squad
  (data.values || []).forEach(row => {
    const id = row[0];
    if (!id) return;
    map[id] = row[8] || ''; // I: Squad (corrida una columna por "Cuenta" nueva)
  });
  return map;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const sheetId = q.sheetId ? String(q.sheetId) : (process.env.META_ADS_SHEET_ID || '');
    if (!sheetId) {
      res.status(400).json({ error: 'Falta el parámetro "sheetId" (o la env var META_ADS_SHEET_ID de respaldo).' });
      return;
    }

    const monthParam = q.month ? String(q.month) : '';
    const [campaignsData, accessToken] = await Promise.all([
      fetchCampaigns(process.env, monthParam),
      getSheetsAccessToken(process.env)
    ]);

    await ensureTabExists(accessToken, sheetId);
    const existingSquads = await readExistingSquads(accessToken, sheetId);

    const header = ['ID', 'Nombre', 'Cuenta', 'Estado', 'Objetivo', 'Gasto MTD', 'Conversiones', 'CPA', 'Squad'];
    const rows = campaignsData.campaigns.map(c => {
      const prevSquad = existingSquads[c.id] || '';
      return [c.id, c.name, c.accountName || c.accountId || '', c.status || '', objetivoLabel(c.objective), c.spend, c.conversions, c.cpa !== null ? c.cpa : '', prevSquad];
    });

    // Igual que google-ads-sheet-sync.js: limpia el rango viejo primero
    // (por si el mes anterior tenía más filas que el actual) y después
    // escribe header + filas de una sola vez.
    await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A1:I5000:clear`, { method: 'POST' });
    await sheetsFetch(
      accessToken,
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A1?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: [header, ...rows] }) }
    );

    res.status(200).json({
      success: true,
      sheetTab: SHEET_TAB,
      month: campaignsData.month,
      rowsWritten: rows.length,
      preservedSquads: Object.keys(existingSquads).length,
      fetchedAt: campaignsData.fetchedAt
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error desconocido sincronizando a Google Sheets', detail: err.detail });
  }
};
