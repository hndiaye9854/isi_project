import Redis from 'ioredis';
import {
  createLogger, createApp, finalizeApp, connectBus, env, envInt, route, fetchJson, sleep, HttpError, EVENTS,
} from '@surfwear/common';

/**
 * Service Catalogue et Disponibilité.
 * Il sert le catalogue et le stock (réel + potentiel) depuis un cache Redis.
 * Le cache est mis à jour en temps réel par les événements StockMisAJour.
 * Si l'ERP est arrêté pour maintenance, le catalogue reste consultable (problème P3).
 */
const SERVICE = 'catalogue';
const logger = createLogger(SERVICE);
const CONNECTEUR = env('ERP_CONNECTOR_URL', 'http://erp-connector:8085');
const redis = new Redis(env('REDIS_URL', 'redis://redis:6379'));
const bus = await connectBus({ url: env('RABBITMQ_URL'), service: SERVICE, logger });

const K_ARTICLES = 'catalogue:articles';
const kStock = (gtin) => `catalogue:stock:${gtin}`;

async function enregistrerStock(s) {
  await redis.set(kStock(s.gtin), JSON.stringify({ ...s, mis_a_jour_le: new Date().toISOString() }));
}

async function chargementInitial() {
  for (let i = 1; ; i++) {
    try {
      const articles = await fetchJson(`${CONNECTEUR}/articles`, { timeoutMs: 5000 });
      const stock = await fetchJson(`${CONNECTEUR}/stock`, { timeoutMs: 5000 });
      const pipe = redis.pipeline();
      for (const a of articles) pipe.hset(K_ARTICLES, a.gtin, JSON.stringify(a));
      await pipe.exec();
      for (const s of stock) await enregistrerStock(s);
      logger.info({ articles: articles.length }, 'Catalogue chargé depuis l\'ERP');
      return;
    } catch (err) {
      logger.warn({ err: err.message, tentative: i }, 'Chargement initial impossible, le cache existant reste servi');
      await sleep(Math.min(30000, 2000 * i));
    }
  }
}

await bus.subscribe('catalogue.stock', [EVENTS.STOCK_MIS_A_JOUR], async (evt) => {
  await enregistrerStock(evt.data);
});
chargementInitial();

async function lireStock(gtin) {
  const s = await redis.get(kStock(gtin));
  return s ? JSON.parse(s) : null;
}

function resume(stock) {
  if (!stock) return { stock_disponible: 0, stock_potentiel: 0, prochaine_livraison: null };
  const potentiel = stock.stock_potentiel || [];
  return {
    stock_disponible: stock.stock_disponible,
    stock_potentiel: potentiel.reduce((t, p) => t + p.quantite_disponible, 0),
    prochaine_livraison: potentiel[0]?.date_prevue || null,
  };
}

const app = createApp({ service: SERVICE, logger });

app.get('/produits', route(async (req, res) => {
  const tous = Object.values(await redis.hgetall(K_ARTICLES)).map((a) => JSON.parse(a));
  const filtres = req.query.categorie ? tous.filter((a) => a.categorie === req.query.categorie) : tous;
  const out = [];
  for (const a of filtres.sort((x, y) => x.reference.localeCompare(y.reference))) {
    out.push({ ...a, disponibilite: resume(await lireStock(a.gtin)) });
  }
  res.json(out);
}));

app.get('/produits/:gtin', route(async (req, res) => {
  const a = await redis.hget(K_ARTICLES, req.params.gtin);
  if (!a) throw new HttpError(404, 'Article inconnu');
  res.json({ ...JSON.parse(a), disponibilite: resume(await lireStock(req.params.gtin)) });
}));

// Répond à la question du responsable de boutique : "si je commande N pièces, quand seront-elles livrées ?"
app.get('/disponibilites/:gtin', route(async (req, res) => {
  const gtin = req.params.gtin;
  if (!(await redis.hexists(K_ARTICLES, gtin))) throw new HttpError(404, 'Article inconnu');
  const stock = await lireStock(gtin);
  const voulue = Math.max(1, Number(req.query.quantite || 1));
  let reste = voulue;
  const immediate = Math.min(reste, stock?.stock_disponible || 0);
  reste -= immediate;
  const plusTard = [];
  for (const lot of stock?.stock_potentiel || []) {
    if (reste === 0) break;
    const q = Math.min(reste, lot.quantite_disponible);
    if (q > 0) plusTard.push({ quantite: q, date_prevue: lot.date_prevue });
    reste -= q;
  }
  res.json({
    gtin,
    quantite_demandee: voulue,
    livrable_immediatement: immediate,
    livrable_plus_tard: plusTard,
    non_disponible: reste,
    stock_disponible: stock?.stock_disponible || 0,
    stock_potentiel: stock?.stock_potentiel || [],
    mis_a_jour_le: stock?.mis_a_jour_le || null,
  });
}));

finalizeApp(app, logger);
const port = envInt('PORT', 8081);
app.listen(port, () => logger.info({ port }, 'Service Catalogue démarré'));
