// /api/debug-meta-token.js
// ------------------------------------------------------------------
// TEMPORAL — borrar después de resolver el problema del token.
//
// No expone el token completo: solo un "fingerprint" (primeros y
// últimos caracteres + longitud) para poder confirmar, comparando con
// lo que ves en el Access Token Debugger de Meta, si el valor que está
// corriendo en este deploy es el mismo que generaste y verificaste, o
// si sigue siendo uno viejo (env var mal aplicada / deploy no
// actualizado / environment equivocado).
//
// GET /api/debug-meta-token
// ------------------------------------------------------------------

module.exports = async (req, res) => {
  const token = process.env.META_ACCESS_TOKEN || '';

  if (!token) {
    res.status(200).json({ present: false, message: 'META_ACCESS_TOKEN no está seteada en este deploy.' });
    return;
  }

  res.status(200).json({
    present: true,
    length: token.length,
    startsWith: token.slice(0, 8),
    endsWith: token.slice(-8),
    // El vercelEnv indica si esta invocación corrió en production, preview o development —
    // útil para confirmar que estás pegando en el dominio que corresponde al environment que editaste.
    vercelEnv: process.env.VERCEL_ENV || 'desconocido',
    deploymentUrl: process.env.VERCEL_URL || 'desconocido',
  });
};
