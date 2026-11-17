// Fonction Netlify : éléments orbitaux (TLE) de la Station spatiale internationale
// Route : /.netlify/functions/ciel
// Sans clé. L'iPad calcule lui-même les passages visibles au-dessus de chez toi.
// Sources essayées dans l'ordre : CelesTrak, puis un miroir public. Réponse : { ok, line1, line2, source }

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'cuisine-ipad/1.0' } });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function fromText(txt) {
  const lines = String(txt).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const i = lines.findIndex(l => l.startsWith('1 '));
  if (i >= 0 && lines[i + 1] && lines[i + 1].startsWith('2 ')) return { line1: lines[i], line2: lines[i + 1] };
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const out = (code, body, cache) => ({ statusCode: code, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' }, body: JSON.stringify(body) });
  const sources = [
    ['celestrak', async () => fromText(await get('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle'))],
    ['mirror', async () => { const j = JSON.parse(await get('https://tle.ivanstanojevic.me/api/tle/25544')); return j && j.line1 && j.line2 ? { line1: j.line1, line2: j.line2 } : null; }]
  ];
  for (const [name, fn] of sources) {
    try {
      const r = await fn();
      if (r && /^1 25544/.test(r.line1)) return out(200, { ok: true, ...r, source: name }, 'public, max-age=21600');
    } catch (e) { /* source suivante */ }
  }
  return out(200, { ok: false, error: 'tle_indisponible' });
};
