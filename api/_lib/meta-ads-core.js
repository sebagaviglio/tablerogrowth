// /api/_lib/meta-ads-core.js
// ------------------------------------------------------------------
// Lógica compartida para traer campañas de Meta Ads desde la Graph API.
// La usan api/meta-ads-proxy.js (panel en vivo), api/meta-ads-sheet-sync.js
// (snapshot al Sheet) y api/meta-insights.js (healthcheck).
//
// A partir de acá son 6 cuentas activas en whitelist (no una sola, y no
// se listan dinámicamente vía /me/adaccounts): 3 del portfolio de Bancor
// + 3 de Wobra. Cada campaña sale tageada con accountId/accountName,
// mismo patrón que "Cuenta" en el panel de Google Ads (MCC).
//
// Env vars:
//   META_ACCESS_TOKEN     -> token del System User (permiso ads_read)
//   META_AD_ACCOUNT_IDS   -> lista separada por coma, SIN "act_", ej:
//                            "1384278082031817,881914691586954,..."
//
// fetchCampaigns(env, monthParam) -> {
//   campaigns: [{ id, name, status, objective, accountId, accountName,
//                  spend, conversions, cpa, daily:[...] }],
//   month, since, until, fetchedAt,
//   accountErrors: [{ accountId, error }]   // cuentas que fallaron, si alguna
// }
//
// checkAccountsHealth(env, datePreset) -> {
//   checkedAt, results: [{ accountId, accountName, ok, spend7d, error }]
// }

const GRAPH_API_VERSION = 'v21.0';

function getAccountIds(env) {
  const raw = env.META_AD_ACCOUNT_IDS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchCampaigns(env, monthParam) {
  const accessToken = env.META_ACCESS_TOKEN;
  const accountIds = getAccountIds(env);
  if (!accessToken) {
    const err = new Error('Falta META_ACCESS_TOKEN.');
    err.status = 500;
    throw err;
  }
  if (!accountIds.length) {
    const err = new Error('Falta META_AD_ACCOUNT_IDS (whitelist de cuentas, separadas por coma).');
    err.status = 500;
    throw err;
  }

  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentMonthKey();
  const { since, until, daysInRange } = monthToRange(month);

  const allCampaigns = [];
  const accountErrors = [];

  // Secuencial y no Promise.all: si una cuenta falla (permisos, cuenta
  // deshabilitada, etc.) no queremos que tire abajo el fetch de las otras
  // 5. Con 6 cuentas el costo de hacerlo secuencial es despreciable.
  for (const accountId of accountIds) {
    try {
      const [accountMeta, campaignsMeta, insightsRows] = await Promise.all([
        fetchAccountMeta(accountId, accessToken),
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
          accountName: accountMeta.name || accountId,
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

      Object.values(byId)
        .filter((c) => c.spend > 0 || c.conversions > 0)
        .forEach((c) => {
          allCampaigns.push({
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
          });
        });
    } catch (err) {
      accountErrors.push({ accountId, error: err.message || String(err) });
    }
  }

  return { campaigns: allCampaigns, month, since, until, fetchedAt: new Date().toISOString(), accountErrors };
}

// Healthcheck liviano: por cada cuenta de la whitelist, un solo request de
// insights a nivel de cuenta (no de campaña) con el date_preset pedido.
// Sirve para verificar rápido que token + permisos + las 6 IDs están bien,
// sin traer todas las campañas.
async function checkAccountsHealth(env, datePreset) {
  const accessToken = env.META_ACCESS_TOKEN;
  const accountIds = getAccountIds(env);
  const preset = datePreset || 'last_7d';

  if (!accessToken) {
    const err = new Error('Falta META_ACCESS_TOKEN.');
    err.status = 500;
    throw err;
  }
  if (!accountIds.length) {
    const err = new Error('META_AD_ACCOUNT_IDS está vacía o no está seteada — revisá el nombre exacto de la env var en Vercel y que el deploy sea posterior a cargarla.');
    err.status = 500;
    throw err;
  }

  const results = [];
  for (const accountId of accountIds) {
    try {
      const [accountMeta, spend] = await Promise.all([
        fetchAccountMeta(accountId, accessToken),
        fetchAccountSpend(accountId, accessToken, preset),
      ]);
      results.push({ accountId, accountName: accountMeta.name || accountId, ok: true, spend7d: spend });
    } catch (err) {
      results.push({ accountId, accountName: null, ok: false, error: err.message || String(err) });
    }
  }

  return { checkedAt: new Date().toISOString(), datePreset: preset, results };
}

async function fetchAccountMeta(accountId, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}?fields=id,name,account_status&access_token=${accessToken}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`Meta account meta: ${j.error ? j.error.message : r.status}`);
  return j;
}

async function fetchAccountSpend(accountId, accessToken, datePreset) {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights` +
    `?level=account&date_preset=${encodeURIComponent(datePreset)}&fields=spend&access_token=${accessToken}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`Meta account insights: ${j.error ? j.error.message : r.status}`);
  const row = (j.data || [])[0];
  return row ? parseFloat(row.spend || '0') : 0;
}

async function fetchAllCampaignsMeta(accountId, accessToken) {
  let url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/campaigns` +
    `?fields=id,name,status,objective&limit=500&access_token=${accessToken}`;
  const out = [];
  while (url) {
    const r = await fetch(url);
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
    `&limit=500&access_token=${accessToken}`;
  const out = [];
  while (url) {
    const r = await fetch(url);
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

module.exports = { fetchCampaigns, checkAccountsHealth, getAccountIds };
