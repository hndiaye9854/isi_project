import amqp from 'amqplib';
import { cloudEvent } from './events.js';
import { sleep } from './config.js';
import { initTraces, tracer } from './traces.js';

const EXCHANGE = 'surfwear.events';
const MAX_RETRIES = 3;

/**
 * Connexion au bus d'événements (RabbitMQ, échange de type "topic").
 * En cas de perte de connexion, le processus s'arrête : l'orchestrateur le redémarre.
 */
export async function connectBus({ url, service, logger, attempts = 30 }) {
  initTraces({ service, logger, url });
  let conn;
  for (let i = 1; i <= attempts; i++) {
    try {
      conn = await amqp.connect(url);
      break;
    } catch (err) {
      logger.warn({ err: err.message, tentative: i }, 'Bus indisponible, nouvelle tentative');
      await sleep(2000);
    }
  }
  if (!conn) throw new Error('Impossible de se connecter au bus');
  conn.on('close', () => {
    logger.error('Connexion au bus perdue, arrêt du service');
    process.exit(1);
  });
  const ch = await conn.createConfirmChannel();
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  logger.info('Connecté au bus d\'événements');

  async function publish(type, data, id) {
    const evt = cloudEvent(type, service, data, id);
    ch.publish(EXCHANGE, type, Buffer.from(JSON.stringify(evt)), {
      persistent: true,
      contentType: 'application/cloudevents+json',
      messageId: evt.id,
    });
    await ch.waitForConfirms();
    tracer({ type: 'evenement', de: service, vers: 'rabbitmq', evenement: type, id: evt.id });
    logger.info({ type, id: evt.id }, 'Événement publié');
    return evt;
  }

  // Publication directe dans une file, résolue seulement quand le broker a confirmé l'écriture.
  const versFile = (file, contenu, options) => new Promise((resolve, reject) => {
    ch.sendToQueue(file, contenu, options, (err) => (err ? reject(err) : resolve()));
  });

  /**
   * Abonnement d'une file aux événements, avec nouvelles tentatives et file d'erreurs.
   *
   *   <queue>          file principale ; un message rejeté part vers <queue>.dlq
   *   <queue>.retry.N  file d'attente sans consommateur (TTL de 2^N s) ; à expiration, le message revient dans <queue>
   *   <queue>.dlq      file d'erreurs : messages en échec après MAX_RETRIES essais
   *
   * Les files secondaires passent par l'échange par défaut (routage par nom de file) : un échec dans un service
   * ne touche ni les files des autres services ni leur file d'erreurs. Tout reste dans RabbitMQ (messages persistants),
   * donc un redémarrage pendant l'attente ne perd rien.
   */
  async function subscribe(queue, patterns, handler) {
    await ch.assertQueue(queue, { durable: true, deadLetterExchange: '', deadLetterRoutingKey: `${queue}.dlq` });
    await ch.assertQueue(`${queue}.dlq`, { durable: true });
    for (let n = 1; n <= MAX_RETRIES; n++) {
      await ch.assertQueue(`${queue}.retry.${n}`, {
        durable: true, messageTtl: 1000 * 2 ** n, deadLetterExchange: '', deadLetterRoutingKey: queue,
      });
    }
    for (const p of patterns) await ch.bindQueue(queue, EXCHANGE, p);
    await ch.prefetch(10);
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      const essai = msg.properties.headers?.['x-retries'] || 0;
      let typeEvt = msg.fields.routingKey;
      try {
        const evt = JSON.parse(msg.content.toString());
        typeEvt = evt.type || typeEvt;
        tracer({ type: 'livraison', de: 'rabbitmq', vers: service, evenement: typeEvt, file: queue, essai, id: evt.id });
        await handler(evt);
        ch.ack(msg);
        return;
      } catch (err) {
        const retries = essai + 1;
        if (retries > MAX_RETRIES) {
          tracer({ type: 'dlq', de: service, vers: 'rabbitmq', evenement: typeEvt, file: `${queue}.dlq`, erreur: err.message });
          logger.error({ err: err.message, queue }, 'Échec définitif, message envoyé en file d\'erreurs (DLQ)');
          ch.nack(msg, false, false);
          return;
        }
        logger.warn({ err: err.message, queue, retries }, 'Traitement en échec, nouvel essai');
        tracer({ type: 'retry', de: service, vers: 'rabbitmq', evenement: typeEvt, file: `${queue}.retry.${retries}`, essai: retries, delai: 2 ** retries, erreur: err.message });
        try {
          // La copie est confirmée par le broker AVANT d'acquitter l'original : le message n'est jamais perdu.
          await versFile(`${queue}.retry.${retries}`, msg.content, {
            ...msg.properties, persistent: true, headers: { ...msg.properties.headers, 'x-retries': retries },
          });
          ch.ack(msg);
        } catch (errRepub) {
          // Copie non confirmée : l'original est remis dans la file (au pire traité deux fois, jamais perdu).
          logger.error({ err: errRepub.message, queue }, 'Nouvel essai impossible à planifier, message remis en file');
          ch.nack(msg, false, true);
        }
      }
    });
    logger.info({ queue, patterns }, 'Abonnement au bus actif');
  }

  return { publish, subscribe, close: () => conn.close() };
}
