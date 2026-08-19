// /api/google-ads-sheet-sync.js
// ------------------------------------------------------------------
// Escribe (upsert) la lista de campañas de Google Ads del mes en la
// pestaña "Google Ads" del Google Sheet del tablero, para que el
// equipo pueda asignarles Squad y Objetivo — a mano en el Sheet, o
// directo desde el panel del tablero (ver api/google-ads-assign.js).
//
// Columnas de la pestaña "Google Ads" (se crea sola si no existe):
//   A: ID  B: Nombre  C: Cuenta  D: Estado  E: Gasto MTD  F: CPA
//   G: Squad (manual)  H: Objetivo (manual)
//
// En cada sync se recalculan A-F desde la API de Google Ads y se
// PRESERVAN G y H por ID de campaña — nunca se pisa lo que carga el
// equipo a mano ni lo que se guardó desde el panel del tablero.
//
// Usa una Service Account de Google para escribir en Sheets (auth
// compartida en api/_lib/sheets-auth.js — ver ese archivo para las
// instrucciones completas de cómo generar las 2 variables de entorno):
//
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY
//
// También necesita, además de estas 2 variables, las 5 de Google Ads
// que ya tenés cargadas (GOOGLE_ADS_CLIENT_ID, etc.) porque este
// endpoint vuelve a pedir los datos de campañas antes de escribirlos.
// ------------------------------------------------------------------

const { getSheetsAccessToken, sheetsFetch } = require('./_lib/sheets-auth');
const { fetchCampaigns } = require('./_lib/google-ads-core');

const SHEET_TAB = 'Google Ads';

async function ensureTabExists(accessToken, sheetId) {
  const meta = await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`);
  const exists = (meta.sheets || []).some(s => s.properties.title === SHEET_TAB);
  if (exists) return;
  await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] })
  });
}

async function readExistingAssignments(accessToken, sheetId) {
  const range = `${encodeURIComponent(SHEET_TAB)}!A2:H5000`;
  const data = await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`);
  const map = {}; // campaignId -> {squad, objetivo}
  (data.values || []).forEach(row => {
    const id = row[0];
    if (!id) return;
    map[id] = { squad: row[6] || '', objetivo: row[7] || '' };
  });
  return map;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const sheetId = q.sheetId ? String(q.sheetId) : (process.env.GOOGLE_ADS_SHEET_ID || '');
    if (!sheetId) {
      res.status(400).json({ error: 'Falta el parámetro "sheetId" (o la env var GOOGLE_ADS_SHEET_ID de respaldo).' });
      return;
    }

    const monthParam = q.month ? String(q.month) : '';
    const [campaignsData, accessToken] = await Promise.all([
      fetchCampaigns(process.env, monthParam),
      getSheetsAccessToken(process.env)
    ]);

    await ensureTabExists(accessToken, sheetId);
    const existing = await readExistingAssignments(accessToken, sheetId);

    const header = ['ID', 'Nombre', 'Cuenta', 'Estado', 'Gasto MTD', 'CPA', 'Squad', 'Objetivo'];
    const rows = campaignsData.campaigns.map(c => {
      const prev = existing[c.id] || { squad: '', objetivo: '' };
      return [c.id, c.name, c.accountName || '', c.status || '', c.spend, c.cpa !== null ? c.cpa : '', prev.squad, prev.objetivo];
    });

    // Limpia el rango viejo primero (por si el mes anterior tenía más filas que el actual)
    // y después escribe header + filas de una sola vez.
    await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A1:H5000:clear`, { method: 'POST' });
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
      preservedAssignments: Object.keys(existing).length,
      fetchedAt: campaignsData.fetchedAt
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error desconocido sincronizando a Google Sheets', detail: err.detail });
  }
};
