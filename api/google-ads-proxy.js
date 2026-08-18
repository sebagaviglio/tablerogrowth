// /api/google-ads-proxy.js
// ------------------------------------------------------------------
// Proxy serverless (Vercel) entre el Tablero de Growth de Bancor y la
// Google Ads API. Mismo patrón que api/sheet-proxy.js: el cliente
// (index.html) SOLO llama a este endpoint same-origin — nunca pega
// directo a googleads.googleapis.com desde el navegador, porque eso
// expondría las credenciales.
//
// VARIABLES DE ENTORNO REQUERIDAS (Vercel → Project Settings →
// Environment Variables). Nunca hardcodear estos valores acá ni en
// el HTML/repo:
//
//   GOOGLE_ADS_CLIENT_ID          → OAuth2 Client ID (Google Cloud Console)
//   GOOGLE_ADS_CLIENT_SECRET      → OAuth2 Client Secret
//   GOOGLE_ADS_REFRESH_TOKEN      → generado UNA VEZ manualmente (ver nota abajo)
//   GOOGLE_ADS_DEVELOPER_TOKEN    → API Center de la cuenta de Google Ads
//   GOOGLE_ADS_CUSTOMER_ID        → "1135241144" (sin guiones) — cuenta 113-524-1144
//
// Opcional, SOLO si en algún momento se agrega una MCC arriba de esta cuenta:
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID  → Customer ID de la manager account
//
// Cómo generar GOOGLE_ADS_REFRESH_TOKEN (una sola vez, manual, fuera del dashboard):
//   1. En Google Cloud Console, con el Client ID/Secret de arriba, correr el flujo
//      OAuth2 "installed app" / "web app" con el scope
//      https://www.googleapis.com/auth/adwords, autorizando con la cuenta de
//      Google que tiene acceso a 113-524-1144.
//   2. Google devuelve un refresh_token una sola vez — guardarlo directo como
//      env var acá, no en ningún otro lado.
//   Guía oficial: https://developers.google.com/google-ads/api/docs/oauth/cloud-project
//
// Versión de la API: revisar la última en
// https://developers.google.com/google-ads/api/docs/release-notes antes de
// desplegar — al momento de escribir esto la última es v23.
// ------------------------------------------------------------------

const API_VERSION = 'v23';

function daysInMonth(year, month /* 1-12 */) {
  return new Date(year, month, 0).getDate();
}

let cachedToken = null; // vive mientras dure la instancia serverless (cold start la resetea)

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`No se pudo renovar el access token OAuth (${res.status}): ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text);
  cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.accessToken;
}

module.exports = async (req, res) => {
  const env = process.env;
  try {
    const required = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'];
    const missing = required.filter(k => !env[k]);
    if (missing.length) {
      res.status(500).json({ error: `Faltan variables de entorno en Vercel: ${missing.join(', ')}` });
      return;
    }

    // month = "YYYY-MM". Default: mes calendario actual.
    const monthParam = (req.query && req.query.month) ? String(req.query.month) : '';
    const now = new Date();
    const year = monthParam ? parseInt(monthParam.slice(0, 4), 10) : now.getFullYear();
    const month = monthParam ? parseInt(monthParam.slice(5, 7), 10) : now.getMonth() + 1;
    if (!year || !month || month < 1 || month > 12) {
      res.status(400).json({ error: `Parámetro "month" inválido: "${monthParam}" (formato esperado YYYY-MM)` });
      return;
    }
    const lastDay = daysInMonth(year, month);
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = isCurrentMonth
      ? `${year}-${String(month).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      : `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const accessToken = await getAccessToken(env);
    const customerId = env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');

    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        segments.date,
        metrics.cost_micros,
        metrics.clicks,
        metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
        AND campaign.status != 'REMOVED'
      ORDER BY campaign.id ASC, segments.date ASC
    `;

    const headers = {
      'Content-Type': 'application/json',
      'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'Authorization': `Bearer ${accessToken}`
    };
    if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers['login-customer-id'] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
    }

    const gAdsRes = await fetch(
      `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
      { method: 'POST', headers, body: JSON.stringify({ query }) }
    );
    const rawText = await gAdsRes.text();
    if (!gAdsRes.ok) {
      res.status(gAdsRes.status).json({ error: `Google Ads API respondió ${gAdsRes.status}`, detail: rawText.slice(0, 2000) });
      return;
    }

    let chunks;
    try { chunks = JSON.parse(rawText); } catch (e) {
      res.status(502).json({ error: 'Respuesta de Google Ads no fue JSON válido', detail: rawText.slice(0, 500) });
      return;
    }

    const campaigns = {}; // id -> acumulador
    chunks.forEach(chunk => {
      (chunk.results || []).forEach(row => {
        const id = row.campaign.id;
        if (!campaigns[id]) {
          campaigns[id] = { id, name: row.campaign.name, status: row.campaign.status, spend: 0, clicks: 0, conversions: 0, daily: {} };
        }
        const c = campaigns[id];
        const costMicros = parseInt(row.metrics.costMicros || row.metrics.cost_micros || '0', 10);
        const spend = costMicros / 1e6;
        c.spend += spend;
        c.clicks += parseInt(row.metrics.clicks || '0', 10);
        c.conversions += parseFloat(row.metrics.conversions || '0');
        const d = row.segments.date;
        c.daily[d] = (c.daily[d] || 0) + spend;
      });
    });

    const list = Object.values(campaigns).map(c => {
      const daily = [];
      for (let d = 1; d <= lastDay; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (dateStr in c.daily) daily.push(Math.round(c.daily[dateStr] * 100) / 100);
        else daily.push(dateStr <= endDate ? 0 : null);
      }
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        spend: Math.round(c.spend * 100) / 100,
        clicks: c.clicks,
        conversions: Math.round(c.conversions * 100) / 100,
        cpa: c.conversions > 0 ? Math.round((c.spend / c.conversions) * 100) / 100 : null,
        daily,
        budget: null // reservado: cuando exista un objetivo de gasto mensual por campaña, va acá y el cliente calcula "ritmo" igual que el resto del tablero
      };
    }).sort((a, b) => b.spend - a.spend);

    res.status(200).json({
      customerId,
      month: `${year}-${String(month).padStart(2, '0')}`,
      startDate,
      endDate,
      fetchedAt: new Date().toISOString(),
      campaigns: list
    });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Error desconocido en el proxy de Google Ads' });
  }
};
