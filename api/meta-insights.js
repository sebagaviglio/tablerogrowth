// /api/meta-insights.js
// ------------------------------------------------------------------
// Healthcheck liviano para verificar rápido que el token y las 6 cuentas
// de la whitelist (META_AD_ACCOUNT_IDS) están bien configuradas, sin
// traer todas las campañas como hace meta-ads-proxy.js.
//
// GET /api/meta-insights?date_preset=last_7d
// -> { checkedAt, datePreset, results: [{ accountId, accountName, ok, spend7d|error }] }
//
// Un resultado con ok:true para las 6 cuentas confirma: token válido,
// permiso ads_read sobre cada cuenta, y las 6 IDs de la whitelist están
// bien escritas.
// ------------------------------------------------------------------

const { checkAccountsHealth } = require('./_lib/meta-ads-core');

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const datePreset = q.date_preset ? String(q.date_preset) : 'last_7d';
    const data = await checkAccountsHealth(process.env, datePreset);
    res.status(200).json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error desconocido en meta-insights', detail: err.detail });
  }
};
