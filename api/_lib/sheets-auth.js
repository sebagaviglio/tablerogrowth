// /api/_lib/sheets-auth.js
// ------------------------------------------------------------------
// Autenticación de Service Account (JWT firmado a mano con RS256, sin
// librerías externas) contra la Google Sheets API v4. Compartido entre
// api/google-ads-sheet-sync.js y api/google-ads-set-objetivo.js.
//
// Variables de entorno necesarias (ver instrucciones completas en
// api/google-ads-sheet-sync.js):
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY
// ------------------------------------------------------------------

const crypto = require('crypto');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedSheetsToken = null;

async function getSheetsAccessToken(env) {
  const required = ['GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY'];
  const missing = required.filter(k => !env[k]);
  if (missing.length) {
    const err = new Error(`Faltan variables de entorno en Vercel: ${missing.join(', ')}`);
    err.status = 500;
    throw err;
  }
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

module.exports = { getSheetsAccessToken, sheetsFetch };
