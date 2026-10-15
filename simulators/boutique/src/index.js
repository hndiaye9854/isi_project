import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger, createApp, finalizeApp, env, envInt, route, sleep, HttpError } from '@surfwear/common';
import { jeton } from './token.js';

/**
 * Simulateur du logiciel de gestion d'une boutique (type A : logiciel avec API REST).
 * - commande via l'API de la plateforme (avec clé d'idempotence) ;
 * - reçoit les webhooks signés et met à jour son stock local tout seul : plus de ressaisie du bon de livraison.
 */
const ID = env('BOUTIQUE_ID');
const NOM = env('BOUTIQUE_NOM', ID);
const SERVICE = `boutique-${ID}`;
const logger = createLogger(SERVICE);
const GATEWAY = env('GATEWAY_URL', 'http://gateway:8080');
const URL_PUBLIQUE = env('PUBLIC_URL');

const etat = { stock: {}, commandes: [], evenements: [], secret: null, catalogue: {} };

async function api(chemin, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${GATEWAY}/api/v1${chemin}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await jeton()}`, ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new HttpError(res.status, data?.erreur || `Erreur ${res.status}`, data);
  return data;
}

async function demarrage() {
  for (let i = 1; ; i++) {
    try {
      const abo = await api('/webhooks', { method: 'POST', body: { url: `${URL_PUBLIQUE}/webhooks` } });
      etat.secret = abo.secret;
      for (const p of await api('/produits')) etat.catalogue[p.gtin] = p.libelle + (p.taille ? ` (${p.taille})` : '');
      logger.info({ url: abo.url }, 'Abonnement aux webhooks enregistré auprès de la plateforme');
      return;
    } catch (err) {
      logger.warn({ err: err.message, tentative: i }, 'Plateforme indisponible, nouvel essai');
      await sleep(3000);
    }
  }
}

const app = createApp({ service: SERVICE, logger, rawBody: true });

app.post('/commander', route(async (req, res) => {
  const lignes = req.body?.lignes;
  if (!Array.isArray(lignes) || !lignes.length) throw new HttpError(400, 'lignes obligatoires');
  const c = await api('/commandes', {
    method: 'POST',
    headers: { 'Idempotency-Key': req.body.cle || randomUUID() },
    body: { lignes, reference_boutique: req.body.reference_boutique },
  });
  etat.commandes.unshift(c);
  res.status(201).json(c);
}));

// Réception des webhooks : vérification de la signature HMAC avant tout traitement.
app.post('/webhooks', (req, res) => {
  const attendu = Buffer.from('sha256=' + createHmac('sha256', etat.secret || '').update(req.rawBody || '').digest('hex'));
  const recu = Buffer.from(String(req.headers['x-surfwear-signature'] || ''));
  if (!etat.secret || attendu.length !== recu.length || !timingSafeEqual(attendu, recu)) {
    logger.warn('Webhook rejeté : signature invalide');
    return res.status(401).json({ erreur: 'Signature invalide' });
  }
  const evt = req.body;
  if (etat.evenements.some((e) => e.id === evt.id)) return res.status(200).json({ doublon: true });
  etat.evenements.unshift({ id: evt.id, type: evt.type, recu_le: new Date().toISOString(), data: evt.data });
  if (evt.type === 'com.surfwear.commande.expediee') {
    // Intégration automatique du bon de livraison dans le stock local.
    for (const l of evt.data.lignes) etat.stock[l.gtin] = (etat.stock[l.gtin] || 0) + l.quantite;
    logger.info({ bl: evt.data.numero_bl }, 'Bon de livraison intégré automatiquement au stock local');
  }
  const c = etat.commandes.find((x) => x.id === evt.data.commande_id);
  if (c) {
    c.statut = evt.type.endsWith('expediee')
      ? (evt.data.reste_a_livrer?.length ? 'EXPEDIEE_PARTIELLEMENT' : 'EXPEDIEE')
      : evt.data.statut;
  }
  res.status(200).json({ recu: true });
});

app.get('/etat', (_req, res) => res.json({ boutique: ID, nom: NOM, stock_local: etat.stock, commandes: etat.commandes, evenements: etat.evenements.slice(0, 30) }));

app.get('/', (_req, res) => {
  const lib = (g) => etat.catalogue[g] || g;
  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${NOM}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#222}h1{color:#8A950E}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}
th,td{border:1px solid #ddd;padding:.4rem;text-align:left}th{background:#8A950E;color:#fff}small{color:#7C7C7B}</style></head><body>
<h1>${NOM} <small>(${ID}), logiciel de gestion simulé</small></h1>
<h2>Stock local (mis à jour automatiquement à chaque expédition)</h2>
<table><tr><th>Article</th><th>Quantité</th></tr>${Object.entries(etat.stock).map(([g, q]) => `<tr><td>${lib(g)}</td><td>${q}</td></tr>`).join('') || '<tr><td colspan="2">Aucun article reçu pour le moment.</td></tr>'}</table>
<h2>Commandes passées</h2>
<table><tr><th>Commande</th><th>Statut</th><th>Lignes</th></tr>${etat.commandes.map((c) => `<tr><td>${c.id.slice(0, 8)}</td><td>${c.statut}</td>
<td>${c.lignes.map((l) => `${lib(l.gtin)} : ${l.quantite} (stock ${l.quantite_stock ?? '?'}, production ${l.quantite_production ?? 0}${l.date_prevue ? ' le ' + l.date_prevue : ''}, non couvert ${l.quantite_non_couverte ?? 0})`).join('<br>')}</td></tr>`).join('') || '<tr><td colspan="3">Aucune commande.</td></tr>'}</table>
<h2>Derniers événements reçus</h2>
<table><tr><th>Reçu le</th><th>Type</th></tr>${etat.evenements.slice(0, 10).map((e) => `<tr><td>${e.recu_le}</td><td>${e.type}</td></tr>`).join('') || '<tr><td colspan="2">Aucun.</td></tr>'}</table>
<p><small>Pour commander : POST /commander avec {"lignes":[{"gtin":"3760123450097","quantite":4}]}</small></p></body></html>`);
});

finalizeApp(app, logger);
const port = envInt('PORT', 7000);
app.listen(port, () => logger.info({ port }, `Simulateur de la boutique ${NOM} démarré`));
demarrage();
