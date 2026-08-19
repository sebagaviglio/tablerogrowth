// /api/google-ads-sheet-sync.js
// ------------------------------------------------------------------
// Escribe (upsert) la lista de campañas de Google Ads del mes en la
// pestaña "Google Ads" del Google Sheet del tablero, para que el
// equipo pueda asignarles Squad y Presupuesto a mano, con la misma
// lógica que ya usan en la pestaña "Campañas" (Azure DevOps).
//
// Columnas de la pestaña "Google Ads" (se crea sola si no existe):
//   A: ID  B: Nombre  C: Cuenta  D: Estado  E: Gasto MTD  F: CPA
//   G: Squad (manual)  H: Presupuesto (manual)
//
// En cada sync se recalculan A-F desde la API de Google Ads y se
// PRESERVAN G y H por ID de campaña — nunca se pisa lo que carga el
// equipo a mano.
//
// Esto necesita una credencial DISTINTA a la de Google Ads (esa es de
// solo lectura de campañas) porque acá hay que escribir en un Sheet.
// Usamos una Service Account de Google (sin login interactivo):
//
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL          → ej. bancor-growth@tu-proyecto.iam.gserviceaccount.com
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY    → la private_key del JSON descargado, TAL CUAL
//                                                   (con los \n literales; este archivo los des-escapa solo)
//
// Cómo generarlas (una sola vez, en Google Cloud Console):
//   1. IAM & Admin → Service Accounts → Create Service Account (cualquier nombre, ej. "bancor-growth-sheets").
//   2. Keys → Add Key → Create new key → JSON. Se descarga un archivo — ahí están
//      "client_email" (va en GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL) y "private_key"
//      (va en GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY).
//   3. Habilitar la Google Sheets API en ese mismo proyecto de Cloud (Library → "Google Sheets API" → Enable).
//   4. IMPORTANTE: compartir el Google Sheet del tablero con el email de la Service Account
//      (el "client_email" del punto 2) dándole permiso de Editor — igual que compartirías
//      un Sheet con una persona más.
//
// También necesita, además de estas 2 variables nuevas, las mismas 5
// variables de Google Ads que ya tenés cargadas (GOOGLE_ADS_CLIENT_ID, etc.)
// porque este endpoint vuelve a pedir los datos de campañas antes de escribirlos.
// ------------------------------------------------------------------

const crypto = require('crypto');
const { fetchCampaigns } = require('./_lib/google-ads-core');

const SHEET_TAB = 'Google Ads';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedSheetsToken = null;

async function getSheetsAccessToken(env) {
  if (cachedSheetsToken && cachedSheetsToken.expiresAt > Date.now() + 30000) {
    return cachedSheetsToken.accessToken;
  }
  const privateKey = (env.GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL,
    scope: SHEETS_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`No se pudo autenticar la Service Account contra Google (${res.status}): ${text.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }
  const json = JSON.parse(text);
  cachedSheetsToken = { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedSheetsToken.accessToken;
}

async function sheetsFetch(accessToken, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* deja json null */ }
  if (!res.ok) {
    const err = new Error(`Google Sheets API respondió ${res.status}${json && json.error ? ': ' + json.error.message : ''}`);
    err.status = res.status;
    err.detail = text.slice(0, 1000);
    throw err;
  }
  return json;
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

async function readExistingAssignments(accessToken, sheetId) {
  const range = `${encodeURIComponent(SHEET_TAB)}!A2:H5000`;
  const data = await sheetsFetch(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`);
  const map = {}; // campaignId -> {squad, presupuesto}
  (data.values || []).forEach(row => {
    const id = row[0];
    if (!id) return;
    map[id] = { squad: row[6] || '', presupuesto: row[7] || '' };
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
    const required = ['GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      res.status(500).json({ error: `Faltan variables de entorno en Vercel: ${missing.join(', ')}` });
      return;
    }

    const monthParam = q.month ? String(q.month) : '';
    const [campaignsData, accessToken] = await Promise.all([
      fetchCampaigns(process.env, monthParam),
      getSheetsAccessToken(process.env)
    ]);

    await ensureTabExists(accessToken, sheetId);
    const existing = await readExistingAssignments(accessToken, sheetId);

    const header = ['ID', 'Nombre', 'Cuenta', 'Estado', 'Gasto MTD', 'CPA', 'Squad', 'Presupuesto'];
    const rows = campaignsData.campaigns.map(c => {
      const prev = existing[c.id] || { squad: '', presupuesto: '' };
      return [c.id, c.name, c.accountName || '', c.status || '', c.spend, c.cpa !== null ? c.cpa : '', prev.squad, prev.presupuesto];
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
