// /api/_lib/meta-ads-core.js
// ------------------------------------------------------------------
// Lógica compartida para traer campañas de Meta Ads desde la Graph API,
// para el panel del dashboard y el sync al Sheet (api/meta-ads-proxy.js
// y api/meta-ads-sheet-sync.js). Las 6 cuentas activas salen de la
// whitelist compartida en _lib/meta-ad-accounts.js — mismo diccionario
// que usa api/meta-insights.js, así los nombres de cuenta nunca quedan
// desincronizados entre los distintos endpoints.
//
// Dos decisiones tomadas de config-vercel-meta-insights.md (Wobra):
// - El token va en el header Authorization, nunca en la query string.
// - Promise.allSettled en vez de secuencial o Promise.all: las 6 cuentas
//   se piden en paralelo (más rápido) y si una falla no tumba a las
//   otras 5 — cada una devuelve su propio resultado u error.
//
// Env var:
//   META_ACCESS_TOKEN -> token del System User (permiso ads_read)
//
// fetchCampaigns(env, monthParam) -> {
//   campaigns: [{ id, name, status, objective, accountId, accountName,
//                  spend, conversions, cpa, daily:[...] }],
//   month, since, until, fetchedAt,
//   accountErrors: [{ accountId, accountName, error }]
// }

const { AD_ACCOUNTS } = require('./meta-ad-accounts');

const GRAPH_API_VERSION = 'v23.0';

async function fetchCampaigns(env, monthParam) {
  const accessToken = env.META_ACCESS_TOKEN;
  if (!accessToken) {
    const err = new Error('Falta META_ACCESS_TOKEN.');
    err.status = 500;
    throw err;
  }

  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentMonthKey();
  const { since, until, daysInRange } = monthToRange(month);

  const accountIds = Object.keys(AD_ACCOUNTS);
  const settled = await Promise.allSettled(
    accountIds.map((accountId) => fetchOneAccount(accountId, accessToken, since, until, daysInRange))
  );

  const allCampaigns = [];
  const accountErrors = [];

  settled.forEach((result, i) => {
    const accountId = accountIds[i];
    if (result.status === 'fulfilled') {
      allCampaigns.push(...result.value);
    } else {
      accountErrors.push({
        accountId,
        accountName: AD_ACCOUNTS[accountId],
        error: (result.reason && result.reason.message) || String(result.reason),
      });
    }
  });

  return { campaigns: allCampaigns, month, since, until, fetchedAt: new Date().toISOString(), accountErrors };
}

async function fetchOneAccount(accountId, accessToken, since, until, daysInRange) {
  const accountName = AD_ACCOUNTS[accountId];
  const [campaignsMeta, insightsRows] = await Promise.all([
    fetchAllCampaignsMeta(accountId, accessToken),
    fetchDailyInsights(accountId, accessToken, since, until),
  ]);

  const byId = {};
  campaignsMeta.forEach((c) => {
    byId[c.id] = {
      id: c.id,
      name: c.name,
      status: (c.status || '').toLowerCase(),
      objective: c.objective || null,
      accountId,
      accountName,
      spend: 0,
      conversions: 0,
      daily: new Array(daysInRange).fill(null),
    };
  });

  insightsRows.forEach((row) => {
    const c = byId[row.campaign_id];
    if (!c) return;
    const spend = parseFloat(row.spend || '0');
    const conversions = sumAllActions(row.actions);
    const dayIdx = dateToDayIndex(row.date_start, since);
    if (dayIdx >= 0 && dayIdx < daysInRange) c.daily[dayIdx] = round2(spend);
    c.spend += spend;
    c.conversions += conversions;
  });

  return Object.values(byId)
    .filter((c) => c.spend > 0 || c.conversions > 0)
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      accountId: c.accountId,
      accountName: c.accountName,
      spend: round2(c.spend),
      conversions: c.conversions,
      cpa: c.conversions > 0 ? round2(c.spend / c.conversions) : null,
      daily: c.daily,
    }));
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function fetchAllCampaignsMeta(accountId, accessToken) {
  let url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/campaigns` +
    `?fields=id,name,status,objective&limit=500`;
  const out = [];
  while (url) {
    const r = await fetch(url, { headers: authHeaders(accessToken) });
    const j = await r.json();
    if (!r.ok) {
      const err = new Error(`Meta campaigns (act_${accountId}): ${j.error ? j.error.message : r.status}`);
      err.status = r.status;
      throw err;
    }
    out.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return out;
}

async function fetchDailyInsights(accountId, accessToken, since, until) {
  let url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights` +
    `?level=campaign&time_increment=1` +
    `&fields=campaign_id,spend,actions` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
    `&limit=500`;
  const out = [];
  while (url) {
    const r = await fetch(url, { headers: authHeaders(accessToken) });
    const j = await r.json();
    if (!r.ok) {
      const err = new Error(`Meta insights (act_${accountId}): ${j.error ? j.error.message : r.status}`);
      err.status = r.status;
      throw err;
    }
    out.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return out;
}

function sumAllActions(actions) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, a) => sum + (parseInt(a.value, 10) || 0), 0);
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthToRange(month) {
  const [y, m] = month.split('-').map(Number);
  const now = new Date();
  const since = new Date(Date.UTC(y, m - 1, 1));
  const isCurrentMonth = y === now.getUTCFullYear() && m === now.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0));
  const until = isCurrentMonth ? now : lastDay;
  const daysInRange = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { since: fmt(since), until: fmt(until), daysInRange };
}

function dateToDayIndex(dateStr, sinceStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const since = new Date(sinceStr + 'T00:00:00Z');
  return Math.round((d - since) / 86400000);
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { fetchCampaigns };
