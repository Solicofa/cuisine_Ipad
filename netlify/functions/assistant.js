// Fonction Netlify : assistant vocal de la cuisine (Gemini, offre gratuite)
// Route : /.netlify/functions/assistant
// Variable d'environnement requise : GEMINI_API_KEY (Netlify -> Site configuration -> Environment variables)
// Variable optionnelle : GEMINI_MODEL (pour forcer un modèle précis)

const MODELS = [...new Set([
  process.env.GEMINI_MODEL,
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest'
].filter(Boolean))];

const SYSTEM_PROMPT = `Tu es l'assistant vocal d'une cuisine familiale, affiché sur un iPad mural. Tes réponses sont LUES À VOIX HAUTE.

STYLE
- Français, tutoiement, ton chaleureux et direct.
- 1 à 3 phrases courtes. Pas de markdown, pas de liste, pas d'émoji, pas de symboles.
- Écris les nombres et unités comme on les dit : « dix minutes », « cent quatre-vingts degrés ».
- Si tu n'es pas sûr, ou si l'information est récente et que tu ne peux pas la vérifier, dis-le franchement. N'invente jamais.

CONTEXTE
Un objet « contexte » te donne la date et l'heure, la météo, la page affichée, la liste de courses, les minuteurs en cours, le menu de la semaine (« semaine » : date, jour, dîner prévu) et, si l'utilisateur cuisine, la recette en cours (« cuisine » : nom, étape, texte de l'étape, ingrédients). Utilise-le pour répondre (« qu'est-ce qu'il me manque ? », « il reste combien sur le gratin ? », « je n'ai pas de crème, je mets quoi ? »). Si « cuisine » est renseigné, réponds en priorité sur cette recette (substitutions, quantités, cuisson) en restant très bref.
« station » donne les mesures en direct de la station météo de la maison (vent corrigé, rafales, pluie du jour, température dehors, pression) : utilise-les pour « il a plu combien ? », « il y a du vent ? », « il fait combien dehors ? » ; absent si la station ne répond pas.

ACTIONS (uniquement si l'utilisateur le demande clairement)
- add_items : { "type":"add_items", "items":["Lait","Œufs"] }  (noms courts, sans article, première lettre en majuscule)
- remove_items : { "type":"remove_items", "items":["Farine"] }  (reprendre le nom exact présent dans la liste)
- check_items : { "type":"check_items", "items":["Tomates"] }  (cocher comme « pris »)
- start_timer : { "type":"start_timer", "minutes":10, "seconds":0, "label":"Pâtes" }
- go_to_page : { "type":"go_to_page", "page":"infos" | "dehors" | "galerie" | "courses" | "semaine" | "recette" }
- plan_menu : { "type":"plan_menu", "days":[ { "date":"2026-11-19", "title":"Lasagnes", "ingredients":["500 g de bœuf haché","12 feuilles de lasagne"] } ] }
  Pour inscrire ou proposer des dîners. « date » est au format AAAA-MM-JJ, tirée de « semaine » (« jeudi soir » = la date du jeudi de la semaine affichée, ou de la suivante si elle est passée). « title » : nom court du plat. « ingredients » : 5 à 10 lignes avec quantités pour 4 personnes (« 300 g de riz »). Si on te demande de proposer un menu, ne remplis que les jours où « diner » est null, à partir d'aujourd'hui, et varie les plats.
Quand tu exécutes une action, ta réponse la confirme au passé composé, par exemple « C'est noté : lait et œufs sont sur ta liste. »

SUGGESTION (facultatif)
Si ta réponse donne une durée de cuisson ou d'attente, ajoute une suggestion de minuteur que l'utilisateur pourra lancer d'un toucher :
{ "type":"start_timer", "minutes":10, "seconds":0, "label":"Œufs durs" }
Ne la mets pas dans « actions » si l'utilisateur n'a pas demandé de lancer le minuteur.

FORMAT DE SORTIE
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour :
{ "reply": "texte à lire à voix haute", "actions": [ ... ], "suggestion": null }
« actions » est un tableau (vide si aucune action). « suggestion » vaut null ou un objet start_timer.`;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const reply = (statusCode, body) => ({
  statusCode,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const cut = (s, n) => String(s == null ? '' : s).slice(0, n);

function parseModelJson(raw) {
  let txt = String(raw || '').trim();
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(txt);
  } catch (e) {
    const a = txt.indexOf('{');
    const b = txt.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try { return JSON.parse(txt.slice(a, b + 1)); } catch (e2) { /* ignore */ }
    }
  }
  return null;
}

async function callGemini(model, apiKey, payload, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(payload),
        signal: ctl.signal
      }
    );
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return reply(500, { error: 'no_key' });

  let body;
  try {
    if (event.body && event.body.length > 30000) return reply(413, { error: 'too_big' });
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'bad_json' });
  }

  const text = cut(body.text, 400).trim();
  if (!text) return reply(400, { error: 'empty' });

  // Contexte du dashboard, borné pour rester léger
  const c = body.context || {};
  const context = {
    maintenant: cut(c.now, 80),
    meteo: cut(c.meteo, 60),
    page_affichee: cut(c.page, 20),
    liste_de_courses: (Array.isArray(c.items) ? c.items : []).slice(0, 60)
      .map(i => ({ texte: cut(i && i.text, 60), coche: !!(i && i.checked) })),
    semaine: (Array.isArray(c.semaine) ? c.semaine : []).slice(0, 7)
      .map(d => ({ date: cut(d && d.date, 10), jour: cut(d && d.jour, 10), diner: d && d.diner ? cut(d.diner, 60) : null })),
    cuisine: c.cuisine && typeof c.cuisine === 'object' ? {
      recette: cut(c.cuisine.recette, 100),
      personnes: Number(c.cuisine.personnes) || null,
      etape: Number(c.cuisine.etape) || 0,
      sur: Number(c.cuisine.sur) || 0,
      texte_de_l_etape: cut(c.cuisine.texte, 600),
      ingredients: (Array.isArray(c.cuisine.ingredients) ? c.cuisine.ingredients : []).slice(0, 40).map(x => cut(x, 80))
    } : null,
    station: c.station && typeof c.station === 'object' ? {
      vent_kmh: Number(c.station.vent_kmh) || 0,
      rafale_kmh: Number(c.station.rafale_kmh) || 0,
      rafale_max_du_jour_kmh: Number(c.station.rafale_max_du_jour_kmh) || 0,
      direction: cut(c.station.direction, 20),
      pluie_aujourdhui_mm: Number(c.station.pluie_aujourdhui_mm) || 0,
      pluie_en_cours: !!c.station.pluie_en_cours,
      temperature_dehors: Number(c.station.temperature_dehors),
      humidite_pct: Number(c.station.humidite_pct) || null,
      pression_hpa: Number(c.station.pression_hpa) || null,
      tendance_pression_3h: Number(c.station.tendance_pression_3h) || 0
    } : null,
    minuteurs: (Array.isArray(c.timers) ? c.timers : []).slice(0, 10)
      .map(t => ({
        nom: cut(t && t.label, 40),
        secondes_restantes: Number(t && t.remaining) || 0,
        en_cours: !!(t && t.running),
        termine: !!(t && t.done)
      }))
  };

  // Derniers échanges (pour les questions de suivi)
  const history = (Array.isArray(body.history) ? body.history : []).slice(-3);
  const contents = [];
  history.forEach(h => {
    if (h && h.q && h.a) {
      contents.push({ role: 'user', parts: [{ text: cut(h.q, 300) }] });
      contents.push({ role: 'model', parts: [{ text: JSON.stringify({ reply: cut(h.a, 400), actions: [], suggestion: null }) }] });
    }
  });
  contents.push({
    role: 'user',
    parts: [{ text: `contexte: ${JSON.stringify(context)}\n\nDemande de l'utilisateur: ${text}` }]
  });

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.5,
      maxOutputTokens: 2048
    }
  };

  let lastStatus = 0;
  for (const model of MODELS) {
    let r;
    try {
      r = await callGemini(model, apiKey, payload, 7000);
    } catch (e) {
      return reply(504, { error: 'timeout' });
    }
    lastStatus = r.status;

    if (r.status === 200) {
      const raw = r.data && r.data.candidates && r.data.candidates[0] &&
        r.data.candidates[0].content && r.data.candidates[0].content.parts
        ? r.data.candidates[0].content.parts.map(p => p.text || '').join('')
        : '';
      const parsed = parseModelJson(raw);
      if (parsed && typeof parsed.reply === 'string') {
        return reply(200, {
          reply: cut(parsed.reply, 600),
          actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 8) : [],
          suggestion: parsed.suggestion && typeof parsed.suggestion === 'object' ? parsed.suggestion : null
        });
      }
      // Réponse non structurée : on la lit telle quelle plutôt que d'échouer
      if (raw.trim()) return reply(200, { reply: cut(raw.replace(/[{}"]/g, ''), 400), actions: [], suggestion: null });
      return reply(502, { error: 'empty_answer' });
    }

    // Modèle inconnu, surcharge ou quota : on essaie le suivant de la liste
    if ([400, 404, 429, 500, 503].includes(r.status)) continue;
    break;
  }

  if (lastStatus === 429) return reply(429, { error: 'quota' });
  return reply(502, { error: 'unavailable', status: lastStatus });
};
