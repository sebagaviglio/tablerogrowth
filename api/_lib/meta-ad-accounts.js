// /api/_lib/meta-ad-accounts.js
// ------------------------------------------------------------------
// Whitelist de cuentas publicitarias de Meta habilitadas para el
// tablero — 3 del portfolio de Bancor + 3 de Wobra. Vive acá, en el
// servidor, a propósito: si el endpoint aceptara cualquier "account"
// de la query sin validar contra esta lista, alguien podría probar
// IDs arbitrarios. Con el diccionario acá, una cuenta que no esté
// devuelve 400 sin siquiera llamar a Meta.
//
// Fuente: config-vercel-meta-insights.md (Wobra), 26/08/2026.
// Portfolio: Banco de Córdoba — 201156063854310
// App: Bancor | App | Seba G — 2251854105629836
// System user: whatsapp_masseges — 122138013711097223
//
// Único lugar para tocar si se agrega/saca una cuenta — todo lo demás
// (meta-insights.js, meta-ads-core.js) lee de acá.

const AD_ACCOUNTS = {
  '1384278082031817': 'Cuenta Publicitaria Bancor',
  '881914691586954': 'BanCor x Winclap',
  '870424196005227': 'Bezza (Bancor)',
  '1319682568137212': 'TT | BANCOR',
  '986514209146863': 'TT | Bezza Pay - Bancor',
  '805058551618372': 'TT | Bezza Billetera - Bancor',
  // '1458586752513315': 'BanCor', // inhabilitada (account_status: 2) — descomentar si se reactiva
};

module.exports = { AD_ACCOUNTS };
