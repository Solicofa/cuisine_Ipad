// Fonction Netlify : contenus générés pour la galerie et la cuisine (Gemini, offre gratuite)
// Route : /.netlify/functions/jour?mode=fait | recette | restes
//   fait    : « Le saviez-vous ? » du jour            -> { ok, texte, theme }
//   recette : une recette de saison complète          -> { ok, recipe: { title, servings, minutes, ingredients[], steps[] } }
//   restes  : idées de plats à partir de « items »    -> { ok, plats: [{ nom, minutes, utilise[], manque[] }] }
// Variable d'environnement requise : GEMINI_API_KEY (la même que l'assistant)

const MODELS = [...new Set([
  process.env.GEMINI_MODEL,
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest'
].filter(Boolean))];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const reply = (code, body) => ({ statusCode: code, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function parseJson(raw) {
  if (!raw) return null;
  let t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

async function callGemini(model, apiKey, payload, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(payload), signal: ctl.signal }
    );
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally { clearTimeout(timer); }
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function buildPrompt(mode, q) {
  const now = new Date();
  const mois = MOIS[now.getMonth()];
  if (mode === 'fait') {
    const avoid = cut(q.avoid, 80);
    return {
      system: 'Tu écris en français, pour un écran de cuisine familial. Tu ne réponds qu\'en JSON.',
      user: `Donne UN fait surprenant et vrai qui apprend quelque chose (science, nature, histoire, cuisine, corps humain, techniques, bricolage, géographie). Une ou deux phrases, 160 caractères maximum, claires, sans chiffre douteux, sans « saviez-vous ». ${avoid ? 'Évite ce thème : ' + avoid + '.' : ''} Variante n° ${cut(q.seed, 10) || '1'}.
Format : {"texte":"...","theme":"un ou deux mots"}`,
      temp: 1.0, tokens: 300
    };
  }
  if (mode === 'recette') {
    return {
      system: 'Tu es un cuisinier français. Tu ne réponds qu\'en JSON valide.',
      user: `Propose UNE recette familiale française simple, de saison (nous sommes en ${mois}), pour 4 personnes, réalisable en moins d'1 h 15, avec ingrédients courants. ${q.avoid ? 'Évite : ' + cut(q.avoid, 80) + '.' : ''}
Format : {"title":"...","servings":4,"minutes":40,"ingredients":["200 g de ...","2 oignons", ...],"steps":["Étape complète avec durées et températures (ex. Préchauffez le four à 200 °C).", ...]}
8 à 14 ingrédients, 5 à 9 étapes courtes.`,
      temp: 0.9, tokens: 1800
    };
  }
  const items = cut(q.items, 400);
  return {
    system: 'Tu es un cuisinier français pragmatique. Tu ne réponds qu\'en JSON valide.',
    user: `Il reste à la maison : ${items}. On suppose aussi la base (sel, poivre, huile, beurre, farine, oignon, ail). Propose 3 plats de dîner différents, réalisables surtout avec cela. Pour chacun : nom, durée totale en minutes, ingrédients de la liste utilisés, et ce qu'il faudrait acheter en plus (1 à 2 éléments au maximum, vide si tout y est).
Format : {"plats":[{"nom":"...","minutes":30,"utilise":["..."],"manque":["..."]}]}`,
    temp: 0.8, tokens: 900
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const q = event.queryStringParameters || {};
  const mode = q.mode;
  if (!['fait', 'recette', 'restes'].includes(mode)) return reply(400, { ok: false, error: 'mode' });
  if (mode === 'restes' && !cut(q.items, 400)) return reply(400, { ok: false, error: 'items' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return reply(200, { ok: false, error: 'no_key' });

  const p = buildPrompt(mode, q);
  const payload = {
    systemInstruction: { parts: [{ text: p.system }] },
    contents: [{ role: 'user', parts: [{ text: p.user }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: p.temp, maxOutputTokens: p.tokens }
  };

  const t0 = Date.now();
  for (const model of MODELS) {
    const left = 9000 - (Date.now() - t0);
    if (left < 1500) break;
    let r;
    try { r = await callGemini(model, apiKey, payload, left); } catch (e) { return reply(200, { ok: false, error: 'timeout' }); }
    if (r.status === 200) {
      const cand = r.data && r.data.candidates && r.data.candidates[0];
      const raw = cand && cand.content && cand.content.parts ? cand.content.parts.map(x => x.text || '').join('') : '';
      const j = parseJson(raw);
      if (!j) continue;
      if (mode === 'fait') {
        const texte = cut(j.texte, 220);
        if (texte) return reply(200, { ok: true, texte, theme: cut(j.theme, 30) });
      } else if (mode === 'recette') {
        const ing = (Array.isArray(j.ingredients) ? j.ingredients : []).map(x => cut(x, 100)).filter(Boolean).slice(0, 20);
        const steps = (Array.isArray(j.steps) ? j.steps : []).map(x => cut(x, 400)).filter(Boolean).slice(0, 14);
        if (j.title && ing.length >= 3 && steps.length >= 3) {
          return reply(200, { ok: true, recipe: { title: cut(j.title, 90), servings: Number(j.servings) || 4, minutes: Number(j.minutes) || null, ingredients: ing, steps } });
        }
      } else {
        const plats = (Array.isArray(j.plats) ? j.plats : []).slice(0, 4).map(x => ({
          nom: cut(x && x.nom, 80), minutes: Number(x && x.minutes) || null,
          utilise: (Array.isArray(x && x.utilise) ? x.utilise : []).map(s => cut(s, 40)).slice(0, 8),
          manque: (Array.isArray(x && x.manque) ? x.manque : []).map(s => cut(s, 40)).slice(0, 3)
        })).filter(x => x.nom);
        if (plats.length) return reply(200, { ok: true, plats });
      }
      continue;
    }
    if ([400, 404, 429, 500, 503].includes(r.status)) continue;
    break;
  }
  return reply(200, { ok: false, error: 'unavailable' });
};
