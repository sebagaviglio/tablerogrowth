// /api/google-ads-assign.js
// ------------------------------------------------------------------
// Guarda Squad (columna G) y Objetivo (columna H) de UNA campaña
// puntual en la pestaña "Google Ads" del Sheet, sin tocar el resto de
// las filas ni volver a pedirle nada a la API de Google Ads (a
// diferencia de api/google-ads-sheet-sync.js, que reescribe toda la
// pestaña). Es lo que llama el panel de Paid Media del tablero cuando
// el usuario asigna un squad y/o carga un objetivo directo ahí, sin
// tener que abrir el Sheet.
//
// Usa las mismas credenciales de Service Account que google-ads-sheet-sync.js
// (ver api/_lib/sheets-auth.js para las instrucciones de esas 2 variables).
//
// Body esperado (POST, JSON): { sheetId, campaignId, squad, objetivo }
//   squad: string (nombre exacto del squad) o "" para desasignar.
//   objetivo: number, o null/"" para borrarlo.
//
// Si la campaña todavía no tiene fila en la pestaña "Google Ads" (nunca
// corrió un sync completo), devuelve error pidiendo que se corra un
// refresh del tablero primero — no crea filas sueltas acá, para no
// duplicar lo que ya arma google-ads-sheet-sync.js con datos completos.
// ------------------------------------------------------------------

const { getSheetsAccessToken, sheetsFetch } = require('./_lib/sheets-auth');

const SHEET_TAB = 'Google Ads';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Body no es JSON válido')); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Usá POST con { sheetId, campaignId, squad, objetivo } en el body.' });
      return;
    }
    const body = await readBody(req);
    const sheetId = body.sheetId ? String(body.sheetId) : '';
    const campaignId = body.campaignId ? String(body.campaignId) : '';
    if (!sheetId || !campaignId) {
      res.status(400).json({ error: 'Faltan "sheetId" y/o "campaignId" en el body.' });
      return;
    }
    const squad = (body.squad === null || body.squad === undefined) ? '' : String(body.squad);
    const objetivo = (body.objetivo === null || body.objetivo === undefined || body.objetivo === '')
      ? ''
      : Number(body.objetivo);
    if (objetivo !== '' && (isNaN(objetivo) || objetivo < 0)) {
      res.status(400).json({ error: `"objetivo" inválido: ${body.objetivo}` });
      return;
    }

    const accessToken = await getSheetsAccessToken(process.env);

    // Busca la fila de esta campaña por ID (columna A) para saber qué fila pisar en G:H.
    const idsData = await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!A2:A5000`);
    const ids = (idsData.values || []).map(r => r[0]);
    const rowIdx = ids.indexOf(campaignId); // 0-based dentro del rango A2:A5000
    if (rowIdx === -1) {
      res.status(404).json({ error: `La campaña ${campaignId} todavía no tiene fila en la pestaña "Google Ads" — corré "Actualizar ahora" en el tablero una vez y volvé a intentar.` });
      return;
    }
    const sheetRow = rowIdx + 2; // +2: la data empieza en la fila 2 (fila 1 = header)

    await sheetsFetch(
      accessToken,
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(SHEET_TAB)}!G${sheetRow}:H${sheetRow}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: [[squad, objetivo]] }) }
    );

    res.status(200).json({ success: true, campaignId, row: sheetRow, squad: squad || null, objetivo: objetivo === '' ? null : objetivo });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error desconocido guardando la asignación', detail: err.detail });
  }
};
