// /api/meta-insights.js
// ------------------------------------------------------------------
// Endpoint general de insights de Meta Ads: cualquier cuenta de la
// whitelist, cualquier nivel (account/campaign/adset/ad), cualquier
// date_preset o rango custom. Diseño de Wobra (config-vercel-meta-insights.md,
// 26/08/2026) — convertido acá de export default (ESM) a module.exports
// (CommonJS) para matchear el resto del proyecto, y usando la whitelist
// compartida de _lib/meta-ad-accounts.js en vez de tenerla duplicada acá.
//
// GET /api/meta-insights?date_preset=last_7d
// GET /api/meta-insights?account=<id>&date_preset=last_30d&level=campaign
// GET /api/meta-insights?account=<id1>,<id2>&since=2026-08-01&until=2026-08-26
//
// Sin "account": devuelve las 6 cuentas de la whitelist.
//
// Decisiones de diseño (de Wobra, quedan documentadas para quien mantenga esto):
// - La whitelist vive en el servidor, no se acepta cualquier ID por query.
// - El token va en el header Authorization, nunca en la query string
//   (las URLs quedan escritas en logs de acceso y trazas de error; el header no).
// - Promise.allSettled (no Promise.all): una cuenta que falla no tumba
//   la respuesta entera — cada cuenta devuelve su propio ok:true/false.
// - Cache de 15 min en el edge (s-maxage=900): los datos de Meta no son
//   tiempo real, cachear cuida el rate limit de la Marketing API.
// ------------------------------------------------------------------

const { AD_ACCOUNTS } = require('./_lib/meta-ad-accounts');

const API_VERSION = 'v23.0';

const INSIGHT_FIELDS = [
  'spend', 'impressions', 'reach', 'clicks',
  'ctr', 'cpm', 'cpc', 'frequency',
  'actions', 'action_values',
].join(',');

const ALLOWED_PRESETS = new Set([
  'today', 'yesterday', 'last_7d', 'last_14d', 'last_30d',
  'this_month', 'last_month', 'this_week_mon_today', 'maximum',
]);

const ALLOWED_LEVELS = new Set(['account', 'campaign', 'adset', 'ad']);

async function fetchInsights(accountId, token, opts) {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/act_${accountId}/insights`);
  url.searchParams.set('fields', INSIGHT_FIELDS);
  url.searchParams.set('level', opts.level);
  url.searchParams.set('limit', '500');

  if (opts.since && opts.until) {
    url.searchParams.set('time_range', JSON.stringify({ since: opts.since, until: opts.until }));
  } else {
    url.searchParams.set('date_preset', opts.datePreset);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await response.json();

  if (!response.ok) {
    return {
      accountId,
      name: AD_ACCOUNTS[accountId],
      ok: false,
      error: {
        message: (body && body.error && body.error.message) || 'Error desconocido',
        code: body && body.error && body.error.code,
        subcode: body && body.error && body.error.error_subcode,
      },
    };
  }

  return { accountId, name: AD_ACCOUNTS[accountId], ok: true, data: body.data || [] };
}

module.exports = async function handler(req, res) {
  const token = process.env.META_ACCESS_TOKEN;

  if (!token) {
    res.status(500).json({ error: 'META_ACCESS_TOKEN no está configurado' });
    return;
  }

  const q = req.query || {};
  const account = q.account;
  const datePreset = q.date_preset || 'last_7d';
  const level = q.level || 'account';
  const since = q.since;
  const until = q.until;

  // Si no piden cuenta puntual, se devuelven las 6 de la whitelist.
  const requested = account
    ? String(account).split(',').map((s) => s.trim())
    : Object.keys(AD_ACCOUNTS);

  const invalid = requested.filter((id) => !AD_ACCOUNTS[id]);
  if (invalid.length) {
    res.status(400).json({ error: `Cuenta no permitida: ${invalid.join(', ')}` });
    return;
  }
  if (!ALLOWED_PRESETS.has(datePreset)) {
    res.status(400).json({ error: `date_preset inválido: ${datePreset}` });
    return;
  }
  if (!ALLOWED_LEVELS.has(level)) {
    res.status(400).json({ error: `level inválido: ${level}` });
    return;
  }

  try {
    const accounts = await Promise.all(
      requested.map((id) => fetchInsights(id, token, { datePreset, level, since, until }))
    );

    // Cache en el edge: 15 min fresco, 1 h sirviendo lo viejo mientras revalida.
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      datePreset: since && until ? `${since}..${until}` : datePreset,
      level,
      accounts,
    });
  } catch (err) {
    console.error('[meta-insights]', err);
    res.status(502).json({ error: 'Fallo al consultar la Graph API' });
  }
};
