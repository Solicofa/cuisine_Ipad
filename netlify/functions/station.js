// Fonction Netlify : lecture de la station météo (Weather Underground, station ISAINT11292)
// Route : /.netlify/functions/station
// Variable d'environnement requise : WU_API_KEY (clé API de ton compte Weather Underground)
// Option de contrôle : /.netlify/functions/station?debug=1 renvoie la réponse brute de WU
//   (utile pour vérifier les noms de champs) — la clé n'apparaît jamais dans la réponse.

const STATION_ID = 'ISAINT11292';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const debug = !!(event.queryStringParameters && event.queryStringParameters.debug);
  const headers = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': debug ? 'no-store' : 'public, max-age=90' };
  const key = process.env.WU_API_KEY;
  if (!key) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, error: 'WU_API_KEY manquante' }) };

  try {
    const url = 'https://api.weather.com/v2/pws/observations/current?stationId=' + STATION_ID
      + '&format=json&units=m&numericPrecision=decimal&apiKey=' + encodeURIComponent(key);
    const r = await fetch(url);
    if (r.status === 204) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, error: 'aucune donnée (204)' }) };
    const raw = await r.json().catch(() => null);
    if (debug) return { statusCode: 200, headers, body: JSON.stringify({ status: r.status, raw }, null, 2) };
    const o = raw && raw.observations && raw.observations[0];
    if (!r.ok || !o) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, error: 'réponse WU inattendue (' + r.status + ')' }) };
    const m = o.metric || {};
    const ts = o.epoch ? o.epoch * 1000 : (o.obsTimeUtc ? Date.parse(o.obsTimeUtc) : null);
    const out = {
      ok: true,
      ts,
      age: ts ? Math.max(0, Math.round((Date.now() - ts) / 60000)) : null,
      temp: num(m.temp),
      humidity: num(o.humidity),
      wind: num(m.windSpeed),
      gust: num(m.windGust),
      dir: num(o.winddir),
      pressure: num(m.pressure),
      rain: num(m.precipTotal),
      rainRate: num(m.precipRate),
      uv: num(o.uv)
    };
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) };
  }
};
