import {
  createLogger, createApp, finalizeApp, createDb, connectBus, env, envInt, route, EVENTS,
} from '@surfwear/common';

/**
 * Service Analytics : alimente le tableau de bord des commerciaux à partir des événements (problème P8).
 * Les commerciaux ne saisissent plus les commandes : ils analysent les tendances pour anticiper la production.
 */
const SERVICE = 'analytics';
const logger = createLogger(SERVICE);
const db = await createDb({
  url: env('ANALYTICS_DATABASE_URL'), logger,
  schema: `
    CREATE TABLE IF NOT EXISTS evenements_traites (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS demandes (
      commande_id TEXT NOT NULL, boutique_id TEXT NOT NULL, gtin TEXT NOT NULL,
      quantite_demandee INT NOT NULL, quantite_stock INT NOT NULL, quantite_production INT NOT NULL,
      quantite_non_couverte INT NOT NULL, montant NUMERIC(12,2) NOT NULL, jour DATE NOT NULL DEFAULT CURRENT_DATE,
      PRIMARY KEY (commande_id, gtin));
    CREATE TABLE IF NOT EXISTS expeditions (
      numero_bl TEXT PRIMARY KEY, commande_id TEXT NOT NULL, boutique_id TEXT NOT NULL,
      quantite INT NOT NULL, expediee_le TIMESTAMPTZ NOT NULL DEFAULT now());`,
});
const bus = await connectBus({ url: env('RABBITMQ_URL'), service: SERVICE, logger });

await bus.subscribe('analytics.commandes', [EVENTS.COMMANDE_RESERVEE, EVENTS.COMMANDE_EXPEDIEE], async (evt) => {
  // Dédoublonnage : un événement peut être livré plusieurs fois (garantie "au moins une fois").
  const { rowCount } = await db.query('INSERT INTO evenements_traites VALUES ($1) ON CONFLICT DO NOTHING', [evt.id]);
  if (!rowCount) return;
  const d = evt.data;
  if (evt.type === EVENTS.COMMANDE_RESERVEE) {
    for (const l of d.lignes) {
      const prod = l.production.reduce((t, p) => t + p.quantite, 0);
      await db.query(
        `INSERT INTO demandes VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [d.commande_id, d.boutique_id, l.gtin, l.quantite_demandee, l.quantite_stock, prod, l.quantite_non_couverte,
          (l.quantite_stock + prod) * (l.prix_unitaire || 0)]);
    }
  } else {
    await db.query('INSERT INTO expeditions (numero_bl, commande_id, boutique_id, quantite) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [d.numero_bl, d.commande_id, d.boutique_id, d.lignes.reduce((t, l) => t + l.quantite, 0)]);
  }
});

const app = createApp({ service: SERVICE, logger });

app.get('/stats/boutiques', route(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT boutique_id, count(DISTINCT commande_id)::int AS commandes, sum(quantite_demandee)::int AS pieces_demandees,
            sum(montant)::float AS chiffre_affaires_ht, sum(quantite_non_couverte)::int AS pieces_non_couvertes
       FROM demandes GROUP BY boutique_id ORDER BY chiffre_affaires_ht DESC`);
  res.json(rows);
}));

app.get('/stats/references', route(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT gtin, sum(quantite_demandee)::int AS demande_totale, sum(quantite_stock)::int AS servie_sur_stock,
            sum(quantite_production)::int AS servie_sur_production, sum(quantite_non_couverte)::int AS non_couverte,
            count(DISTINCT boutique_id)::int AS boutiques
       FROM demandes GROUP BY gtin ORDER BY demande_totale DESC`);
  res.json(rows);
}));

// Références dont la demande dépasse l'offre : à signaler pour lancer de la production.
app.get('/stats/tensions', route(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT gtin, sum(quantite_production + quantite_non_couverte)::int AS pieces_en_attente,
            sum(quantite_non_couverte)::int AS non_couverte
       FROM demandes GROUP BY gtin HAVING sum(quantite_production + quantite_non_couverte) > 0
      ORDER BY non_couverte DESC, pieces_en_attente DESC`);
  res.json(rows);
}));

finalizeApp(app, logger);
const port = envInt('PORT', 8084);
app.listen(port, () => logger.info({ port }, 'Service Analytics démarré'));
