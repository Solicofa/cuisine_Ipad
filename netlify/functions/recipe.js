// Fonction Netlify : lit une recette en ligne (données structurées schema.org/Recipe)
// Route : /.netlify/functions/recipe?url=https://...
// Aucune clé nécessaire.

const dns = require('dns').promises;
const net = require('net');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const reply = (statusCode, body) => ({
  statusCode,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  body: JSON.stringify(body)
});

const MAX_BYTES = 2.5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/* ---------- Protection SSRF : on refuse tout ce qui n'est pas un site public ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') ||
      v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
  }
  return true;
}

async function assertPublic(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { throw new Error('bad_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad_url');
  if (u.username || u.password) throw new Error('bad_url');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('forbidden');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('forbidden');
    return u;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw new Error('dns'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('forbidden');
  return u;
}

async function fetchHtml(urlStr) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublic(current);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6500);
    let res;
    try {
      res = await fetch(u.toString(), {
        redirect: 'manual',
        signal: ctl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5'
        }
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), u).toString();
        continue;
      }
      if (!res.ok) throw new Error('http_' + res.status);
      const type = res.headers.get('content-type') || '';
      if (!/html|xml/i.test(type)) throw new Error('not_html');
      // Lecture bornée en taille
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
        chunks.push(value);
      }
      return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too_many_redirects');
}

/* ---------- Extraction JSON-LD ---------- */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function clean(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function findRecipeNodes(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => findRecipeNodes(n, out)); return; }
  if (typeof node !== 'object') return;
  const t = node['@type'];
  const types = Array.isArray(t) ? t : [t];
  if (types.includes('Recipe')) out.push(node);
  if (node['@graph']) findRecipeNodes(node['@graph'], out);
  if (node.mainEntity) findRecipeNodes(node.mainEntity, out);
  if (node.mainEntityOfPage && typeof node.mainEntityOfPage === 'object') findRecipeNodes(node.mainEntityOfPage, out);
}

function extractRecipeNode(html) {
  const found = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim().replace(/^<!--/, '').replace(/-->$/, '');
    try { findRecipeNodes(JSON.parse(raw), found); }
    catch (e) {
      try { findRecipeNodes(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')), found); } catch (e2) { /* ignore */ }
    }
  }
  if (!found.length) return null;
  // On garde la plus complète
  found.sort((a, b) => score(b) - score(a));
  return found[0];
}
function score(n) {
  return (n.recipeIngredient ? n.recipeIngredient.length : 0) + (n.recipeInstructions ? 1 : 0) * 5;
}

function flattenSteps(ins, out) {
  if (!ins) return;
  if (typeof ins === 'string') {
    // Texte brut : on coupe par lignes, ou à défaut en phrases-étapes
    const parts = ins.split(/\r?\n|<br\s*\/?>/i).map(clean).filter(Boolean);
    parts.forEach(p => out.push(p.replace(/^\d+\s*[.)-]\s*/, '')));
    return;
  }
  if (Array.isArray(ins)) { ins.forEach(i => flattenSteps(i, out)); return; }
  if (typeof ins === 'object') {
    if (ins.itemListElement) { flattenSteps(ins.itemListElement, out); return; }
    const txt = ins.text || ins.name || '';
    if (txt) flattenSteps(String(txt).includes('\n') ? String(txt) : [clean(txt)], out);
  }
}

// "PT1H15M" -> minutes
function isoToMinutes(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  const total = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) + Math.round((+m[4] || 0) / 60);
  return total > 0 ? total : null;
}

function parseYield(y) {
  if (y == null) return null;
  const arr = Array.isArray(y) ? y : [y];
  for (const v of arr) {
    const m = String(v).match(/\d+/);
    if (m) {
      const n = parseInt(m[0], 10);
      if (n > 0 && n <= 100) return n;
    }
  }
  return null;
}

function pickImage(img) {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return pickImage(img[0]);
  if (typeof img === 'object') return img.url || null;
  return null;
}

function buildRecipe(node, html) {
  const ingredients = (Array.isArray(node.recipeIngredient) ? node.recipeIngredient
    : typeof node.recipeIngredient === 'string' ? [node.recipeIngredient] : [])
    .map(clean).filter(Boolean).slice(0, 80);
  const steps = [];
  flattenSteps(node.recipeInstructions, steps);
  const cleanSteps = steps.map(clean).filter(Boolean).slice(0, 60);

  let title = clean(node.name || '');
  if (!title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = t ? clean(t[1]) : '';
  }
  return {
    title: title.slice(0, 160),
    image: pickImage(node.image),
    servings: parseYield(node.recipeYield),
    minutes: isoToMinutes(node.totalTime) || (() => {
      const a = isoToMinutes(node.prepTime), b = isoToMinutes(node.cookTime);
      return a || b ? (a || 0) + (b || 0) : null;
    })(),
    ingredients,
    steps: cleanSteps
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'GET') return reply(405, { error: 'method' });

  const target = (event.queryStringParameters && event.queryStringParameters.url || '').trim();
  if (!target || target.length > 2000) return reply(400, { error: 'bad_url' });

  try {
    const html = await fetchHtml(target);
    const node = extractRecipeNode(html);
    if (!node) return reply(200, { ok: false, error: 'no_recipe' });
    const recipe = buildRecipe(node, html);
    if (!recipe.ingredients.length && !recipe.steps.length) return reply(200, { ok: false, error: 'no_recipe' });
    return reply(200, { ok: true, recipe });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg === 'forbidden' || msg === 'bad_url') return reply(400, { ok: false, error: msg });
    if (e && e.name === 'AbortError') return reply(200, { ok: false, error: 'timeout' });
    return reply(200, { ok: false, error: 'unreachable', detail: msg.slice(0, 60) });
  }
};

// Exposé pour les tests
exports._test = { isPrivateIp, extractRecipeNode, buildRecipe, isoToMinutes };
