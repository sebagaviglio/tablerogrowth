// api/sheet-proxy.js
// Deploy this file at that exact path in tu repo de Vercel (carpeta /api en la raíz del proyecto).
// El dashboard lo detecta y lo usa automáticamente como respaldo si el fetch directo a Google falla.
//
// Por qué existe: el navegador aplica CORS a los fetch desde el cliente. Un fetch servidor-a-servidor
// (como este, corriendo en la función serverless de Vercel) no tiene esa restricción, así que evita
// el problema por completo sin depender de que Google mande los headers correctos.

export default async function handler(req, res) {
  const { sheetId, tab } = req.query;

  if (!sheetId || !tab) {
    res.status(400).json({ error: 'Faltan parámetros: se necesita sheetId y tab.' });
    return;
  }

  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&_cb=${Date.now()}`;

  try {
    const googleRes = await fetch(url, { cache: 'no-store' });

    if (!googleRes.ok) {
      res.status(googleRes.status).json({
        error: `Google respondió ${googleRes.status} para la pestaña "${tab}". Revisá que el Sheet esté publicado como CSV.`
      });
      return;
    }

    const text = await googleRes.text();

    // Si Google no encuentra la pestaña o el sheet no está publicado, a veces devuelve
    // una página HTML (login o error) con status 200 igual. La detectamos acá.
    if (text.trim().startsWith('<')) {
      res.status(502).json({
        error: `La pestaña "${tab}" no devolvió CSV válido — probablemente el Sheet no está publicado como CSV o el nombre de pestaña no coincide.`
      });
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(text);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
