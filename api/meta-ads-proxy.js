// /api/meta-ads-proxy.js
// ------------------------------------------------------------------
// Endpoint que consume el dashboard en vivo para el panel "Medios pagos ·
// Meta Ads". Wrapper delgado sobre _lib/meta-ads-core.js — toda la lógica
// de la Graph API vive ahí, compartida con meta-ads-sheet-sync.js, mismo
// patrón que google-ads-proxy.js + _lib/google-ads-core.js.
//
// GET /api/meta-ads-proxy?month=YYYY-MM
// ------------------------------------------------------------------

const { fetchCampaigns } = require('./_lib/meta-ads-core');

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const monthParam = q.month ? String(q.month) : '';
    const data = await fetchCampaigns(process.env, monthParam);
    res.status(200).json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error desconocido en meta-ads-proxy', detail: err.detail });
  }
};
