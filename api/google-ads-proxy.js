// /api/google-ads-proxy.js
// ------------------------------------------------------------------
// Proxy serverless (Vercel) de SOLO LECTURA entre el Tablero de Growth
// de Bancor y la Google Ads API. El cliente (index.html) SOLO llama a
// este endpoint same-origin — nunca pega directo a
// googleads.googleapis.com desde el navegador, porque eso expondría
// las credenciales.
//
// Toda la lógica de auth OAuth2 + fetch de campañas vive en
// api/_lib/google-ads-core.js (compartida con api/google-ads-sheet-sync.js,
// que además escribe una copia de estos datos en Google Sheets para que
// el equipo asigne squad y objetivo a mano o desde el panel del tablero.
//
// VARIABLES DE ENTORNO REQUERIDAS (Vercel → Project Settings →
// Environment Variables). Nunca hardcodear estos valores acá ni en
// el HTML/repo:
//
//   GOOGLE_ADS_CLIENT_ID          → OAuth2 Client ID (Google Cloud Console)
//   GOOGLE_ADS_CLIENT_SECRET      → OAuth2 Client Secret
//   GOOGLE_ADS_REFRESH_TOKEN      → generado UNA VEZ manualmente
//   GOOGLE_ADS_DEVELOPER_TOKEN    → API Center de la cuenta de Google Ads
//   GOOGLE_ADS_CUSTOMER_ID        → "1135241144" (MCC, sin guiones)
// ------------------------------------------------------------------

const { fetchCampaigns } = require('./_lib/google-ads-core');

module.exports = async (req, res) => {
  try {
    const monthParam = (req.query && req.query.month) ? String(req.query.month) : '';
    const data = await fetchCampaigns(process.env, monthParam);
    // budget queda reservado en el shape para compatibilidad con el cliente actual;
    // el objetivo real ahora vive en la pestaña "Google Ads" del Sheet (columna H),
    // el cliente lo mergea del lado suyo (ver fetchGoogleAdsAssignments/GADS_ASSIGN en index.html).
    data.campaigns = data.campaigns.map(c => ({ ...c, budget: null }));
    res.status(200).json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error desconocido en el proxy de Google Ads', detail: err.detail });
  }
};
