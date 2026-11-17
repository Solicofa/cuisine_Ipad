// Fonction Netlify : saint du jour (source : Nominis, sans clé)
// Route : /.netlify/functions/saint
// Si la source change ou est indisponible, la fonction répond { saint: null } et l'iPad masque simplement la ligne.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

function pickName(data) {
  // Le format exact n'est pas garanti : on cherche prudemment un « prénom du jour ».
  const seen = [];
  (function walk(o, depth) {
    if (!o || depth > 5) return;
    if (typeof o === 'string') return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
    Object.keys(o).forEach(k => {
      const v = o[k];
      if (typeof v === 'string' && /^(prenom|nom|saint|title|name)$/i.test(k)) seen.push(v);
      else walk(v, depth + 1);
    });
  })(data, 0);
  const first = seen.find(s => s && s.length < 60);
  return first ? first.replace(/^saint[e]?\s+/i, '').replace(/<[^>]*>/g, '').trim() : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const headers = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch('https://nominis.cef.fr/json/saintdujour.php', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('http');
    const data = await res.json();
    const saint = pickName(data);
    return { statusCode: 200, headers, body: JSON.stringify({ saint: saint || null }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ saint: null }) };
  }
};

exports._test = { pickName };
