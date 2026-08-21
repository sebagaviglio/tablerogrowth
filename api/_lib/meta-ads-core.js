// /api/_lib/meta-ads-core.js
// ------------------------------------------------------------------
// Lógica compartida para traer campañas de Meta Ads desde la Graph API:
// la usan tanto api/meta-ads-proxy.js (para mostrar en vivo en el panel)
// como api/meta-ads-sheet-sync.js (para volcar el snapshot al Sheet),
// mismo patrón que api/_lib/google-ads-core.js con fetchCampaigns.
//
// fetchCampaigns(env, monthParam) -> {
//   campaigns: [{ id, name, status, objective, spend, conversions, cpa, daily:[...] }],
//   month, since, until, fetchedAt
// }
//
// Env vars requeridas:
//   META_ACCESS_TOKEN   -> token del System User (permiso ads_read)
//   META_AD_ACCOUNT_ID  -> ID de cuenta, SIN el prefijo "act_"
//
// Conversiones = suma de TODOS los action_type que reporta Meta en
// `actions`, sin filtrar por tipo (así lo pidió el equipo).

const GRAPH_API_VERSION = 'v21.0';

async function fetchCampaigns(env, monthParam) {
  const accessToken = env.META_ACCESS_TOKEN;
  const adAccountId = env.META_AD_ACCOUNT_ID;
  if (!accessToken || !adAccountId) {
    const err = new Error('Faltan META_ACCESS_TOKEN y/o META_AD_ACCOUNT_ID.');
    err.status = 500;
    throw err;
  }

  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentMonthKey();
  const { since, until, daysInRange } = monthToRange(month);

  const [campaignsMeta, insightsRows] = await Promise.all([
    fetchAllCampaignsMeta(adAccountId, accessToken),
    fetchDailyInsights(adAccountId, accessToken, since, until),
  ]);

  const byId = {};
  campaignsMeta.forEach((c) => {
    byId[c.id] = {
      id: c.id,
      name: c.name,
      status: (c.status || '').toLowerCase(),
      objective: c.objective || null,
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

  const campaigns = Object.values(byId)
    .filter((c) => c.spend > 0 || c.conversions > 0)
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      spend: round2(c.spend),
      conversions: c.conversions,
      cpa: c.conversions > 0 ? round2(c.spend / c.conversions) : null,
      daily: c.daily,
    }));

  return { campaigns, month, since, until, fetchedAt: new Date().toISOString() };
}

async function fetchAllCampaignsMeta(adAccountId, accessToken) {
  let url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${adAccountId}/campaigns` +
    `?fields=id,name,status,objective&limit=500&access_token=${accessToken}`;
  const out = [];
  while (url) {
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) {
      const err = new Error(`Meta campaigns: ${j.error ? j.error.message : r.status}`);
      err.status = r.status;
      throw err;
    }
    out.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return out;
}

async function fetchDailyInsights(adAccountId, accessToken, since, until) {
  let url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${adAccountId}/insights` +
    `?level=campaign&time_increment=1` +
    `&fields=campaign_id,spend,actions` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
    `&limit=500&access_token=${accessToken}`;
  const out = [];
  while (url) {
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) {
      const err = new Error(`Meta insights: ${j.error ? j.error.message : r.status}`);
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
