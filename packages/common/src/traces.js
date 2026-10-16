import amqp from 'amqplib';
import { sleep } from './config.js';

/**
 * Traces de communication, affichées en direct par l'observatoire (démo animée des flux).
 *
 * Chaque service publie un court message pour chaque échange (requête, réponse, événement, webhook...) sur l'échange
 * "surfwear.traces" (fanout, non durable). Sans observatoire branché, RabbitMQ les jette aussitôt.
 * C'est du "au mieux" : une trace perdue n'a aucune conséquence, et une erreur ici ne doit jamais gêner le service.
 * Désactivation : TRACES=off.
 */
export const ECHANGE_TRACES = 'surfwear.traces';

const etat = { service: null, ch: null, demarre: false };

export function initTraces({ service, logger, url = process.env.RABBITMQ_URL }) {
  if (etat.demarre) return;
  etat.demarre = true;
  etat.service = service;
  if (!url || process.env.TRACES === 'off') return;
  (async function connecter() {
    for (let attente = 2000; ; attente = Math.min(attente * 2, 60000)) {
      try {
        const conn = await amqp.connect(url);
        const ch = await conn.createChannel();
        await ch.assertExchange(ECHANGE_TRACES, 'fanout', { durable: false });
        conn.on('error', () => {});
        ch.on('error', () => {});
        etat.ch = ch;
        await new Promise((resolve) => conn.on('close', resolve));
        etat.ch = null;
        attente = 2000;
      } catch (err) {
        logger?.debug({ err: err.message }, 'Traces indisponibles, nouvel essai');
      }
      await sleep(attente);
    }
  })();
}

export const serviceCourant = () => etat.service;

/** Publie une trace : { de, vers, type, ...détails }. Ne lève jamais d'erreur. */
export function tracer(trace) {
  if (!etat.ch) return;
  try {
    etat.ch.publish(ECHANGE_TRACES, '', Buffer.from(JSON.stringify({ t: Date.now(), ...trace })), { expiration: '10000' });
  } catch {
    // trace perdue : sans importance
  }
}
