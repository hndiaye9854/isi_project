import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createLogger, createApp, finalizeApp, createDb, connectBus, tx, env, envInt, route, fetchJson,
  sleep, HttpError, boutiqueId, EVENTS,
} from '@surfwear/common';

/**
 * Service Commandes et Réservation.
 * Une commande est réservée dans l'ERP dès sa création (problème P2).
 * Si l'ERP ne répond pas, la commande est acceptée "en attente" et rejouée automatiquement (problème P3).
 */
const SERVICE = 'commandes';
const logger = createLogger(SERVICE);
const CONNECTEUR = env('ERP_CONNECTOR_URL', 'http://erp-connector:8085');
const schema = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
const db = await createDb({ url: env('COMMANDES_DATABASE_URL'), logger, schema });
const bus = await connectBus({ url: env('RABBITMQ_URL'), service: SERVICE, logger });

const Commande = z.object({
  reference_boutique: z.string().max(64).optional(),
  lignes: z.array(z.object({
    gtin: z.string().regex(/^\d{8,14}$/, 'GTIN invalide (8 à 14 chiffres)'),
    quantite: z.number().int().positive().max(10000),
  })).min(1).max(200),
}).strict();

const outbox = (client, type, payload) =>
  client.query('INSERT INTO outbox (id, type, payload) VALUES ($1,$2,$3)', [randomUUID(), type, payload]);

async function lire(id, boutique) {
  const { rows: [c] } = await db.query(
    `SELECT id, boutique_id, statut, reference_boutique, numero_bl, montant_total::float AS montant_total, cree_le, modifie_le
       FROM commandes WHERE id = $1 ${boutique ? 'AND boutique_id = $2' : ''}`, boutique ? [id, boutique] : [id]);
  if (!c) return null;
  const { rows: lignes } = await db.query(
    `SELECT gtin, quantite, quantite_stock, quantite_production, to_char(date_prevue,'YYYY-MM-DD') AS date_prevue,
            quantite_non_couverte, quantite_expediee, prix_unitaire::float AS prix_unitaire
       FROM lignes WHERE commande_id = $1 ORDER BY gtin`, [id]);
  return { ...c, lignes };
}

function statutApresReservation(lignes) {
  const tout = lignes.every((l) => l.quantite_stock === l.quantite_demandee);
  return tout ? 'RESERVEE' : 'RESERVEE_PARTIELLEMENT';
}

/** Appel synchrone au connecteur ERP pour réserver le stock. */
async function reserver(commande) {
  const resultat = await fetchJson(`${CONNECTEUR}/reservations`, {
    method: 'POST',
    timeoutMs: 5000,
    body: { commande_id: commande.id, boutique_id: commande.boutique_id, lignes: commande.lignes.map(({ gtin, quantite }) => ({ gtin, quantite })) },
  });
  await tx(db, async (c) => {
    let total = 0;
    for (const l of resultat.lignes) {
      const prod = l.production.reduce((t, p) => t + p.quantite, 0);
      total += (l.quantite_stock + prod) * (l.prix_unitaire || 0);
      await c.query(
        `UPDATE lignes SET quantite_stock = $3, quantite_production = $4, date_prevue = $5, quantite_non_couverte = $6, prix_unitaire = $7
          WHERE commande_id = $1 AND gtin = $2`,
        [commande.id, l.gtin, l.quantite_stock, prod, l.production.at(-1)?.date_prevue || null, l.quantite_non_couverte, l.prix_unitaire]);
    }
    const statut = statutApresReservation(resultat.lignes);
    await c.query('UPDATE commandes SET statut = $2, montant_total = $3, modifie_le = now() WHERE id = $1', [commande.id, statut, total]);
    await outbox(c, EVENTS.COMMANDE_RESERVEE, {
      commande_id: commande.id, boutique_id: commande.boutique_id, statut, montant_total: total, lignes: resultat.lignes,
    });
  });
}

const app = createApp({ service: SERVICE, logger });

app.post('/commandes', route(async (req, res) => {
  const boutique = boutiqueId(req);
  const cle = req.headers['idempotency-key'];
  if (!cle) throw new HttpError(400, 'En-tête Idempotency-Key obligatoire');
  const parsed = Commande.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Commande invalide', parsed.error.issues);

  // Idempotence : la même clé renvoie la même commande, même si la boutique réessaie.
  const { rows: [deja] } = await db.query('SELECT id FROM commandes WHERE boutique_id = $1 AND cle_idempotence = $2', [boutique, cle]);
  if (deja) return res.status(200).json(await lire(deja.id, boutique));

  // Fusion des lignes portant le même GTIN.
  const parGtin = {};
  for (const l of parsed.data.lignes) parGtin[l.gtin] = (parGtin[l.gtin] || 0) + l.quantite;
  const commande = {
    id: randomUUID(), boutique_id: boutique,
    lignes: Object.entries(parGtin).map(([gtin, quantite]) => ({ gtin, quantite })),
  };
  try {
    await tx(db, async (c) => {
      await c.query(
        `INSERT INTO commandes (id, boutique_id, cle_idempotence, statut, reference_boutique) VALUES ($1,$2,$3,'RECUE',$4)`,
        [commande.id, boutique, cle, parsed.data.reference_boutique || null]);
      for (const l of commande.lignes) {
        await c.query('INSERT INTO lignes (commande_id, gtin, quantite) VALUES ($1,$2,$3)', [commande.id, l.gtin, l.quantite]);
      }
      await outbox(c, EVENTS.COMMANDE_CREEE, { commande_id: commande.id, boutique_id: boutique, lignes: commande.lignes });
    });
  } catch (err) {
    if (err.code === '23505') {
      const { rows: [c] } = await db.query('SELECT id FROM commandes WHERE boutique_id = $1 AND cle_idempotence = $2', [boutique, cle]);
      return res.status(200).json(await lire(c.id, boutique));
    }
    throw err;
  }

  try {
    await reserver(commande);
    res.status(201).location(`/api/v1/commandes/${commande.id}`).json(await lire(commande.id, boutique));
  } catch (err) {
    logger.warn({ err: err.message, commande: commande.id }, 'ERP indisponible, commande mise en attente');
    await db.query(`UPDATE commandes SET statut = 'EN_ATTENTE_ERP', modifie_le = now() WHERE id = $1`, [commande.id]);
    res.status(202).location(`/api/v1/commandes/${commande.id}`).json(await lire(commande.id, boutique));
  }
}));

app.get('/commandes', route(async (req, res) => {
  const boutique = boutiqueId(req);
  const { rows } = await db.query(
    `SELECT id FROM commandes WHERE boutique_id = $1 ${req.query.statut ? 'AND statut = $2' : ''} ORDER BY cree_le DESC LIMIT 100`,
    req.query.statut ? [boutique, req.query.statut] : [boutique]);
  const out = [];
  for (const r of rows) out.push(await lire(r.id, boutique));
  res.json(out);
}));

app.get('/commandes/:id', route(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'Commande introuvable');
  const c = await lire(req.params.id, boutiqueId(req));
  if (!c) throw new HttpError(404, 'Commande introuvable');
  res.json(c);
}));

// L'ERP signale l'expédition : la commande passe à "expédiée" et garde le numéro de bon de livraison.
await bus.subscribe('commandes.expeditions', [EVENTS.COMMANDE_EXPEDIEE], async (evt) => {
  const e = evt.data;
  await tx(db, async (c) => {
    for (const l of e.lignes) {
      await c.query('UPDATE lignes SET quantite_expediee = quantite_expediee + $3 WHERE commande_id = $1 AND gtin = $2',
        [e.commande_id, l.gtin, l.quantite]);
    }
    const statut = e.reste_a_livrer.length ? 'EXPEDIEE_PARTIELLEMENT' : 'EXPEDIEE';
    await c.query('UPDATE commandes SET statut = $2, numero_bl = $3, modifie_le = now() WHERE id = $1', [e.commande_id, statut, e.numero_bl]);
  });
});

finalizeApp(app, logger);
const port = envInt('PORT', 8082);
app.listen(port, () => logger.info({ port }, 'Service Commandes démarré'));

// Tâche de fond 1 : publication des événements de l'outbox.
(async function relaisOutbox() {
  for (;;) {
    try {
      const { rows } = await db.query('SELECT * FROM outbox WHERE NOT publie ORDER BY cree_le LIMIT 50');
      for (const r of rows) {
        await bus.publish(r.type, r.payload, r.id);
        await db.query('UPDATE outbox SET publie = true WHERE id = $1', [r.id]);
      }
      if (rows.length) continue;
    } catch (err) {
      logger.warn({ err: err.message }, 'Relais outbox en échec');
    }
    await sleep(500);
  }
})();

// Tâche de fond 2 : reprise des commandes en attente quand l'ERP redevient disponible.
(async function reprise() {
  for (;;) {
    await sleep(envInt('RETRY_INTERVAL_MS', 5000));
    try {
      const { rows } = await db.query(`SELECT id, boutique_id FROM commandes WHERE statut = 'EN_ATTENTE_ERP' ORDER BY cree_le LIMIT 20`);
      for (const r of rows) {
        const { rows: lignes } = await db.query('SELECT gtin, quantite FROM lignes WHERE commande_id = $1', [r.id]);
        await reserver({ ...r, lignes });
        logger.info({ commande: r.id }, 'Commande en attente réservée après retour de l\'ERP');
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'ERP toujours indisponible');
    }
  }
})();
