import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import {
  createLogger, createApp, finalizeApp, createDb, connectBus, env, envInt, envMap, route, sleep,
  HttpError, boutiqueId, EVENTS, tracer,
} from '@surfwear/common';

/**
 * Service Notifications.
 * Remplace les fiches envoyées à la main (problème P5) :
 *  - webhooks signés (HMAC SHA-256) vers les logiciels des boutiques, avec nouvelles tentatives ;
 *  - e-mail lisible au responsable de boutique.
 */
const SERVICE = 'notifications';
const logger = createLogger(SERVICE);
const schema = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
const db = await createDb({ url: env('NOTIFICATIONS_DATABASE_URL'), logger, schema });
const bus = await connectBus({ url: env('RABBITMQ_URL'), service: SERVICE, logger });
const EMAILS = envMap('BOUTIQUE_EMAILS');
const mailer = nodemailer.createTransport({
  host: env('SMTP_HOST', 'mailpit'), port: envInt('SMTP_PORT', 1025), secure: false, ignoreTLS: true,
});
const EVENEMENTS_AUTORISES = [EVENTS.COMMANDE_RESERVEE, EVENTS.COMMANDE_EXPEDIEE];

const Abonnement = z.object({
  url: z.string().url(),
  evenements: z.array(z.enum(EVENEMENTS_AUTORISES)).min(1).default(EVENEMENTS_AUTORISES),
}).strict();

export function signer(secret, corps) {
  return 'sha256=' + createHmac('sha256', secret).update(corps).digest('hex');
}

async function livrer(abo, evt) {
  const corps = JSON.stringify(evt);
  const cible = new URL(abo.url).hostname;
  let derniere;
  for (let t = 1; t <= 4; t++) {
    const debut = Date.now();
    tracer({ type: 'webhook', de: SERVICE, vers: cible, evenement: evt.type, essai: t, id: evt.id });
    try {
      const res = await fetch(abo.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/cloudevents+json',
          'X-Surfwear-Event': evt.type,
          'X-Surfwear-Delivery': evt.id,
          'X-Surfwear-Signature': signer(abo.secret, corps),
        },
        body: corps,
        signal: AbortSignal.timeout(5000),
      });
      derniere = { code: res.status };
      tracer({ type: 'reponse', de: cible, vers: SERVICE, statut: res.status, duree: Date.now() - debut, id: evt.id });
      if (res.ok) {
        await journal(abo, evt, 'LIVRE', t, res.status);
        return;
      }
    } catch (err) {
      derniere = { erreur: err.message };
      tracer({ type: 'reponse', de: cible, vers: SERVICE, statut: 'injoignable', duree: Date.now() - debut, id: evt.id });
    }
    await sleep(500 * 2 ** t);
  }
  await journal(abo, evt, 'ECHEC', 4, derniere?.code, derniere?.erreur);
  logger.error({ url: abo.url, evenement: evt.id }, 'Webhook non livré après 4 tentatives');
}

const journal = (abo, evt, statut, tentatives, code, erreur) => db.query(
  `INSERT INTO livraisons (abonnement_id, evenement_id, type, statut, tentatives, code_http, erreur)
   VALUES ($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT (abonnement_id, evenement_id) DO UPDATE SET statut = EXCLUDED.statut, tentatives = EXCLUDED.tentatives,
     code_http = EXCLUDED.code_http, erreur = EXCLUDED.erreur`,
  [abo.id, evt.id, evt.type, statut, tentatives, code || null, erreur || null]);

function mail(evt) {
  const d = evt.data;
  const fmt = (l) => `  - ${l.gtin} : ${l.quantite_stock ?? l.quantite} en stock`
    + (l.production?.length ? `, ${l.production.map((p) => `${p.quantite} prévus le ${p.date_prevue}`).join(', ')}` : '')
    + (l.quantite_non_couverte ? `, ${l.quantite_non_couverte} non disponibles` : '');
  if (evt.type === EVENTS.COMMANDE_RESERVEE) {
    return {
      subject: `Commande ${d.commande_id.slice(0, 8)} confirmée (${d.statut === 'RESERVEE' ? 'complète' : 'partielle'})`,
      text: `Bonjour,\n\nVotre commande est enregistrée et le stock est réservé.\n\n${d.lignes.map(fmt).join('\n')}\n\nMontant : ${d.montant_total.toFixed(2)} € HT\n\nL'équipe Surfwear`,
    };
  }
  return {
    subject: `Commande ${d.commande_id.slice(0, 8)} expédiée, bon de livraison ${d.numero_bl}`,
    text: `Bonjour,\n\nVotre colis est parti (bon de livraison ${d.numero_bl}).\n\n${d.lignes.map((l) => `  - ${l.gtin} : ${l.quantite}`).join('\n')}`
      + (d.reste_a_livrer.length ? `\n\nReste à livrer :\n${d.reste_a_livrer.map((l) => `  - ${l.gtin} : ${l.quantite} prévus le ${l.date_prevue}`).join('\n')}` : '')
      + '\n\nL\'équipe Surfwear',
  };
}

async function traiter(evt) {
  const boutique = evt.data.boutique_id;
  const { rows: abos } = await db.query(
    'SELECT * FROM abonnements WHERE boutique_id = $1 AND actif AND $2 = ANY(evenements)', [boutique, evt.type]);
  await Promise.all(abos.map((a) => livrer(a, evt)));
  if (EMAILS[boutique]) {
    try {
      const message = mail(evt);
      await mailer.sendMail({ from: 'Surfwear <commandes@surfwear.test>', to: EMAILS[boutique], ...message });
      tracer({ type: 'mail', de: SERVICE, vers: 'mailpit', sujet: message.subject, destinataire: EMAILS[boutique] });
    } catch (err) {
      logger.warn({ err: err.message }, 'E-mail non envoyé');
    }
  }
}

await bus.subscribe('notifications.commandes', EVENEMENTS_AUTORISES, traiter);

const app = createApp({ service: SERVICE, logger });

app.post('/webhooks', route(async (req, res) => {
  const boutique = boutiqueId(req);
  const p = Abonnement.safeParse(req.body);
  if (!p.success) throw new HttpError(400, 'Abonnement invalide', p.error.issues);
  const secret = 'whsec_' + randomBytes(24).toString('hex');
  const { rows: [a] } = await db.query(
    `INSERT INTO abonnements (id, boutique_id, url, evenements, secret) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (boutique_id, url) DO UPDATE SET evenements = EXCLUDED.evenements, secret = EXCLUDED.secret, actif = true
     RETURNING id, url, evenements, secret, cree_le`,
    [randomUUID(), boutique, p.data.url, p.data.evenements, secret]);
  // Le secret n'est renvoyé qu'à la création : la boutique s'en sert pour vérifier les signatures.
  res.status(201).json(a);
}));

app.get('/webhooks', route(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, url, evenements, actif, cree_le FROM abonnements WHERE boutique_id = $1 ORDER BY cree_le', [boutiqueId(req)]);
  res.json(rows);
}));

app.delete('/webhooks/:id', route(async (req, res) => {
  const r = await db.query('DELETE FROM abonnements WHERE id::text = $1 AND boutique_id = $2', [req.params.id, boutiqueId(req)]);
  if (!r.rowCount) throw new HttpError(404, 'Abonnement introuvable');
  res.status(204).end();
}));

app.get('/webhooks/livraisons', route(async (req, res) => {
  const { rows } = await db.query(
    `SELECT l.evenement_id, l.type, l.statut, l.tentatives, l.code_http, l.erreur, l.cree_le, a.url
       FROM livraisons l JOIN abonnements a ON a.id = l.abonnement_id
      WHERE a.boutique_id = $1 ORDER BY l.cree_le DESC LIMIT 50`, [boutiqueId(req)]);
  res.json(rows);
}));

finalizeApp(app, logger);
const port = envInt('PORT', 8083);
app.listen(port, () => logger.info({ port }, 'Service Notifications démarré'));
