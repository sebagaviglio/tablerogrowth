// /api/_lib/google-ads-core.js
// ------------------------------------------------------------------
// Lógica compartida de Google Ads (auth OAuth2 + fetch de campañas de
// la MCC 113-524-1144 y sus cuentas hija). La usan tanto
// api/google-ads-proxy.js (solo lectura, para el panel) como
// api/google-ads-sheet-sync.js (escribe una copia a Google Sheets).
// Ver comentarios en google-ads-proxy.js para el detalle de las
// variables de entorno de Google Ads.
// ------------------------------------------------------------------

const API_VERSION = 'v23'; // revisar https://developers.google.com/google-ads/api/docs/release-notes

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

async function gAdsSearchStream(env, accessToken, customerId, loginCustomerId, query) {
  const headers = {
    'Content-Type': 'application/json',
    'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Authorization': `Bearer ${accessToken}`
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  const r = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    { method: 'POST', headers, body: JSON.stringify({ query }) }
  );
  const rawText = await r.text();
  if (!r.ok) {
    const err = new Error(`Google Ads API respondió ${r.status}`);
    err.status = r.status;
    err.detail = rawText.slice(0, 2000);
    throw err;
  }
  try { return JSON.parse(rawText); } catch (e) {
    const err = new Error('Respuesta de Google Ads no fue JSON válido');
    err.status = 502;
    err.detail = rawText.slice(0, 500);
    throw err;
  }
}

// Lista las cuentas hija (no-manager, habilitadas) bajo la MCC.
async function listChildAccounts(env, accessToken, mccId) {
  const query = `
    SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status
    FROM customer_client
    WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'
  `;
  const chunks = await gAdsSearchStream(env, accessToken, mccId, mccId, query);
  const out = [];
  chunks.forEach(chunk => {
    (chunk.results || []).forEach(row => {
      out.push({ id: String(row.customerClient.id), name: row.customerClient.descriptiveName });
    });
  });
  return out;
}

// Resuelve year/month/lastDay/startDate/endDate a partir de un "YYYY-MM" (o mes actual si viene vacío).
function resolveMonthWindow(monthParam) {
  const now = new Date();
  const year = monthParam ? parseInt(monthParam.slice(0, 4), 10) : now.getFullYear();
  const month = monthParam ? parseInt(monthParam.slice(5, 7), 10) : now.getMonth() + 1;
  if (!year || !month || month < 1 || month > 12) {
    const err = new Error(`Parámetro "month" inválido: "${monthParam}" (formato esperado YYYY-MM)`);
    err.status = 400;
    throw err;
  }
  const lastDay = daysInMonth(year, month);
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = isCurrentMonth
    ? `${year}-${String(month).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    : `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { year, month, lastDay, startDate, endDate };
}

// Trae gasto/clics/conversiones por campaña (agregado de todas las cuentas hija de la MCC)
// para el mes pedido. Devuelve el mismo shape que usa el endpoint de lectura.
async function fetchCampaigns(env, monthParam) {
  const required = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'];
  const missing = required.filter(k => !env[k]);
  if (missing.length) {
    const err = new Error(`Faltan variables de entorno en Vercel: ${missing.join(', ')}`);
    err.status = 500;
    throw err;
  }

  const { year, month, lastDay, startDate, endDate } = resolveMonthWindow(monthParam);
  const accessToken = await getAccessToken(env);
  const mccId = env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');

  const children = await listChildAccounts(env, accessToken, mccId);
  const base = {
    customerId: mccId, childAccountsQueried: children.length,
    month: `${year}-${String(month).padStart(2, '0')}`, startDate, endDate,
    fetchedAt: new Date().toISOString()
  };
  if (!children.length) {
    return { ...base, campaigns: [], warning: 'La MCC no tiene cuentas hija habilitadas, o el usuario del refresh token no tiene acceso a ninguna.' };
  }

  const metricsQuery = `
    SELECT
      campaign.id, campaign.name, campaign.status, segments.date,
      metrics.cost_micros, metrics.clicks, metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id ASC, segments.date ASC
  `;

  const campaigns = {}; // key = `${accountId}:${campaignId}` -> acumulador
  const perAccountErrors = [];

  for (const acc of children) {
    try {
      const chunks = await gAdsSearchStream(env, accessToken, acc.id, mccId, metricsQuery);
      chunks.forEach(chunk => {
        (chunk.results || []).forEach(row => {
          const key = `${acc.id}:${row.campaign.id}`;
          if (!campaigns[key]) {
            campaigns[key] = {
              id: row.campaign.id, name: row.campaign.name, status: row.campaign.status,
              accountId: acc.id, accountName: acc.name,
              spend: 0, clicks: 0, conversions: 0, daily: {}
            };
          }
          const c = campaigns[key];
          const costMicros = parseInt(row.metrics.costMicros || row.metrics.cost_micros || '0', 10);
          const spend = costMicros / 1e6;
          c.spend += spend;
          c.clicks += parseInt(row.metrics.clicks || '0', 10);
          c.conversions += parseFloat(row.metrics.conversions || '0');
          const d = row.segments.date;
          c.daily[d] = (c.daily[d] || 0) + spend;
        });
      });
    } catch (e) {
      perAccountErrors.push({ accountId: acc.id, accountName: acc.name, error: e.message, detail: e.detail });
    }
  }

  const list = Object.values(campaigns).map(c => {
    const daily = [];
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (dateStr in c.daily) daily.push(Math.round(c.daily[dateStr] * 100) / 100);
      else daily.push(dateStr <= endDate ? 0 : null);
    }
    return {
      id: c.id, name: c.name, status: c.status,
      accountId: c.accountId, accountName: c.accountName,
      spend: Math.round(c.spend * 100) / 100,
      clicks: c.clicks,
      conversions: Math.round(c.conversions * 100) / 100,
      cpa: c.conversions > 0 ? Math.round((c.spend / c.conversions) * 100) / 100 : null,
      daily
    };
  }).sort((a, b) => b.spend - a.spend);

  return {
    ...base,
    campaigns: list,
    accountErrors: perAccountErrors.length ? perAccountErrors : undefined
  };
}

module.exports = { fetchCampaigns, resolveMonthWindow, daysInMonth };
