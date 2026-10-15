import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createLogger, createApp, finalizeApp, createDb, env, envInt, route, HttpError } from '@surfwear/common';
import { seed } from './seed.js';
import { snapshot, reserver, expedier, receptionner } from './erp.js';

const SERVICE = 'erp-mock';
const logger = createLogger(SERVICE);
const schema = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
const pool = await createDb({ url: env('ERP_DATABASE_URL'), logger, schema });
await seed(pool, logger);

const app = createApp({ service: SERVICE, logger });
// Interface web simulée du poste logisticien (réseau interne uniquement).
app.use('/logistique', express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/', (_req, res) => res.redirect('/logistique/'));

app.get('/articles', route(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT gtin, reference, libelle, categorie, taille, couleur, prix_unitaire::float AS prix_unitaire FROM articles ORDER BY reference');
  res.json(rows);
}));

app.get('/stock', route(async (_req, res) => {
  const { rows } = await pool.query('SELECT gtin FROM articles ORDER BY reference');
  const out = [];
  for (const r of rows) out.push(await snapshot(pool, r.gtin));
  res.json(out);
}));

app.get('/stock/:gtin', route(async (req, res) => {
  const s = await snapshot(pool, req.params.gtin);
  if (!s) throw new HttpError(404, 'Article inconnu');
  res.json(s);
}));

app.post('/reservations', route(async (req, res) => {
  const { commande_id, boutique_id, lignes } = req.body || {};
  if (!commande_id || !boutique_id || !Array.isArray(lignes) || lignes.length === 0) {
    throw new HttpError(400, 'commande_id, boutique_id et lignes sont obligatoires');
  }
  res.status(201).json(await reserver(pool, { commande_id, boutique_id, lignes }));
}));

app.post('/expeditions', route(async (req, res) => {
  if (!req.body?.commande_id) throw new HttpError(400, 'commande_id obligatoire');
  res.status(201).json(await expedier(pool, req.body.commande_id));
}));

app.get('/production', route(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.gtin, a.reference, p.quantite, p.quantite_reservee, to_char(p.date_prevue,'YYYY-MM-DD') AS date_prevue, p.statut
       FROM production p JOIN articles a USING (gtin) ORDER BY p.date_prevue, p.id`);
  res.json(rows);
}));

app.post('/production/:id/reception', route(async (req, res) => {
  res.json(await receptionner(pool, Number(req.params.id)));
}));

app.get('/commandes-a-preparer', route(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT c.commande_id, c.boutique_id, to_char(c.cree_le, 'YYYY-MM-DD HH24:MI') AS cree_le,
            json_agg(json_build_object('gtin', r.gtin, 'reference', a.reference, 'quantite', r.quantite)) AS lignes
       FROM commandes_erp c JOIN reservations r USING (commande_id) JOIN articles a ON a.gtin = r.gtin
      WHERE r.statut = 'RESERVEE' AND r.source = 'STOCK'
      GROUP BY c.commande_id, c.boutique_id, c.cree_le ORDER BY c.cree_le`);
  res.json(rows);
}));

// Flux de changements consommé par le connecteur ERP.
app.get('/changements', route(async (req, res) => {
  const depuis = Number(req.query.depuis || 0);
  const limite = Math.min(Number(req.query.limite || 100), 500);
  const { rows } = await pool.query(
    'SELECT seq::int AS seq, type, payload FROM changements WHERE seq > $1 ORDER BY seq LIMIT $2', [depuis, limite]);
  res.json(rows);
}));

finalizeApp(app, logger);
const port = envInt('PORT', 8090);
app.listen(port, () => logger.info({ port }, 'ERP simulé démarré'));
