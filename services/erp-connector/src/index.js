import Redis from 'ioredis';
import {
  createLogger, createApp, finalizeApp, connectBus, env, envInt, route, fetchJson, sleep, EVENTS,
} from '@surfwear/common';

/**
 * Connecteur ERP (adaptateur).
 * 1. Façade REST : seul point d'accès de la plateforme à l'ERP (l'ERP n'est jamais exposé, problème P1).
 * 2. Lecture du journal de changements de l'ERP et publication des événements sur le bus.
 */
const SERVICE = 'erp-connector';
const logger = createLogger(SERVICE);
const ERP = env('ERP_URL', 'http://erp-mock:8090');
const POLL_MS = envInt('POLL_INTERVAL_MS', 1000);
const OFFSET_KEY = 'erp-connector:offset';

const redis = new Redis(env('REDIS_URL', 'redis://redis:6379'));
const bus = await connectBus({ url: env('RABBITMQ_URL'), service: SERVICE, logger });

const app = createApp({ service: SERVICE, logger });
app.get('/articles', route(async (_req, res) => res.json(await fetchJson(`${ERP}/articles`, { timeoutMs: 5000 }))));
app.get('/stock', route(async (_req, res) => res.json(await fetchJson(`${ERP}/stock`, { timeoutMs: 5000 }))));
app.get('/stock/:gtin', route(async (req, res) => res.json(await fetchJson(`${ERP}/stock/${encodeURIComponent(req.params.gtin)}`))));
app.post('/reservations', route(async (req, res) => {
  res.status(201).json(await fetchJson(`${ERP}/reservations`, { method: 'POST', body: req.body, timeoutMs: 5000 }));
}));
finalizeApp(app, logger);
const port = envInt('PORT', 8085);
app.listen(port, () => logger.info({ port }, 'Connecteur ERP démarré'));

// Traduction des changements ERP en événements métier (modèle commun).
const TRADUCTION = {
  STOCK_MAJ: EVENTS.STOCK_MIS_A_JOUR,
  EXPEDITION: EVENTS.COMMANDE_EXPEDIEE,
};

async function boucle() {
  for (;;) {
    try {
      const depuis = Number(await redis.get(OFFSET_KEY) || 0);
      const changements = await fetchJson(`${ERP}/changements?depuis=${depuis}&limite=100`);
      for (const c of changements) {
        const type = TRADUCTION[c.type];
        // L'identifiant de l'événement est dérivé du numéro de changement : les consommateurs peuvent dédoublonner.
        if (type) await bus.publish(type, c.payload, `erp-${c.seq}`);
        await redis.set(OFFSET_KEY, c.seq);
      }
      if (changements.length === 100) continue;
    } catch (err) {
      logger.warn({ err: err.message }, 'Lecture des changements ERP impossible, nouvel essai');
    }
    await sleep(POLL_MS);
  }
}
boucle();
