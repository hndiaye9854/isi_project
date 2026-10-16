import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import amqp from 'amqplib';
import {
  createLogger, createApp, finalizeApp, env, envInt, route, fetchJson, sleep, tracer, HttpError, ECHANGE_TRACES, EVENTS,
} from '@surfwear/common';

/**
 * Observatoire : démo animée des flux (outil pédagogique, profil docker compose "demo").
 *  - reçoit les traces publiées par tous les services (échange surfwear.traces) ;
 *  - les remet dans l'ordre chronologique et les diffuse en direct au navigateur (Server-Sent Events) ;
 *  - déclenche de vraies actions pour la visite guidée (commande d'une boutique, expédition, réception...).
 * Il est relié aux trois réseaux pour piloter les boutiques et l'ERP : à ne pas déployer en production.
 */
const SERVICE = 'observatoire';
const logger = createLogger(SERVICE);
const ERP = env('ERP_URL', 'http://erp-mock:8090');
const BOUTIQUES = { biarritz: 'http://boutique-biarritz:7000', hossegor: 'http://boutique-hossegor:7000', lacanau: 'http://boutique-lacanau:7000' };
const RETENUE_MS = 400;   // délai de remise en ordre : les traces arrivent par plusieurs connexions

const clients = new Set();
let tampon = [];

function diffuser(trace) {
  const ligne = `data: ${JSON.stringify(trace)}\n\n`;
  for (const res of clients) res.write(ligne);
}

setInterval(() => {
  const limite = Date.now() - RETENUE_MS;
  const prets = tampon.filter((t) => t.t <= limite).sort((a, b) => a.t - b.t);
  if (!prets.length) return;
  tampon = tampon.filter((t) => t.t > limite);
  prets.forEach(diffuser);
}, 100);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

let canal = null;
(async function ecouter() {
  for (;;) {
    try {
      const conn = await amqp.connect(env('RABBITMQ_URL'));
      const ch = await conn.createChannel();
      await ch.assertExchange(ECHANGE_TRACES, 'fanout', { durable: false });
      const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
      await ch.bindQueue(queue, ECHANGE_TRACES, '');
      await ch.consume(queue, (msg) => {
        try { tampon.push(JSON.parse(msg.content.toString())); } catch { /* trace illisible ignorée */ }
      }, { noAck: true });
      canal = ch;
      logger.info('À l\'écoute des traces');
      await new Promise((resolve) => conn.on('close', resolve));
      canal = null;
    } catch (err) {
      logger.warn({ err: err.message }, 'RabbitMQ indisponible, nouvel essai');
    }
    await sleep(3000);
  }
})();

const app = createApp({ service: SERVICE, logger });
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.get('/flux', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connecté\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

const urlBoutique = (nom) => {
  if (!BOUTIQUES[nom]) throw new HttpError(400, 'Boutique inconnue (biarritz, hossegor ou lacanau)');
  return BOUTIQUES[nom];
};

async function commander(boutique, gtin, quantite) {
  try {
    const c = await fetchJson(`${urlBoutique(boutique)}/commander`, {
      method: 'POST', timeoutMs: 20000,
      body: { lignes: [{ gtin, quantite }], reference_boutique: 'demo-animee', cle: randomUUID() },
    });
    return { boutique, ok: true, commande: c };
  } catch (err) {
    return { boutique, ok: false, erreur: err.message };
  }
}

app.get('/actions/articles', route(async (_req, res) => {
  res.json(await fetchJson(`${ERP}/stock`, { trace: false }));
}));

app.post('/actions/catalogue', route(async (req, res) => {
  res.json(await fetchJson(`${urlBoutique(req.body.boutique || 'biarritz')}/catalogue/rafraichir`, { method: 'POST', timeoutMs: 15000 }));
}));

app.post('/actions/commander', route(async (req, res) => {
  const { boutique = 'biarritz', gtin, quantite = 1 } = req.body || {};
  if (!gtin) throw new HttpError(400, 'gtin obligatoire');
  res.json(await commander(boutique, gtin, Number(quantite)));
}));

// Trois boutiques commandent le même article au même instant : la réservation verrouillée évite la double vente.
app.post('/actions/concurrence', route(async (req, res) => {
  const { gtin, quantite = 4 } = req.body || {};
  if (!gtin) throw new HttpError(400, 'gtin obligatoire');
  res.json(await Promise.all(Object.keys(BOUTIQUES).map((b) => commander(b, gtin, Number(quantite)))));
}));

// Le logisticien expédie une commande (celle demandée, sinon la plus ancienne à préparer).
app.post('/actions/expedier', route(async (req, res) => {
  const aPreparer = await fetchJson(`${ERP}/commandes-a-preparer`, { trace: false });
  const id = aPreparer.some((c) => c.commande_id === req.body?.commande_id) ? req.body.commande_id : aPreparer[0]?.commande_id;
  if (!id) throw new HttpError(409, 'Aucune commande à préparer : passez d\'abord une commande');
  res.json(await fetchJson(`${ERP}/expeditions`, { method: 'POST', body: { commande_id: id }, de: 'logisticien' }));
}));

// Réception d'un lot de production (de préférence un lot déjà en partie réservé).
app.post('/actions/receptionner', route(async (_req, res) => {
  const lots = (await fetchJson(`${ERP}/production`, { trace: false })).filter((l) => l.statut === 'EN_COURS');
  const lot = lots.find((l) => l.quantite_reservee > 0) || lots[0];
  if (!lot) throw new HttpError(409, 'Aucun lot de production en cours');
  res.json({ lot, stock: await fetchJson(`${ERP}/production/${lot.id}/reception`, { method: 'POST', de: 'logisticien' }) });
}));

// Message volontairement invalide : montre les nouvelles tentatives (2, 4, 8 s) puis la file d'erreurs.
app.post('/actions/message-empoisonne', route(async (_req, res) => {
  if (!canal) throw new HttpError(503, 'RabbitMQ indisponible');
  const evt = {
    specversion: '1.0', id: `demo-${randomUUID()}`, source: '/surfwear/observatoire', type: EVENTS.STOCK_MIS_A_JOUR,
    time: new Date().toISOString(), datacontenttype: 'application/json', data: null,
  };
  canal.publish('surfwear.events', evt.type, Buffer.from(JSON.stringify(evt)), { persistent: true, contentType: 'application/cloudevents+json' });
  tracer({ type: 'evenement', de: SERVICE, vers: 'rabbitmq', evenement: evt.type, id: evt.id, invalide: true });
  res.json({ publie: evt.id });
}));

finalizeApp(app, logger);
const port = envInt('PORT', 8070);
app.listen(port, () => logger.info({ port }, 'Observatoire démarré : http://localhost:' + port));
