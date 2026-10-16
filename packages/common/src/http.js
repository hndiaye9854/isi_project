import express from 'express';
import pinoHttp from 'pino-http';
import client from 'prom-client';
import { randomUUID } from 'node:crypto';
import { initTraces, serviceCourant, tracer } from './traces.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Application Express avec journalisation, santé, métriques et gestion d'erreurs. */
export function createApp({ service, logger, rawBody = false }) {
  const app = express();
  initTraces({ service, logger });
  client.collectDefaultMetrics({ labels: { service } });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Durée des requêtes HTTP',
    labelNames: ['service', 'method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.3, 1, 3],
  });

  app.disable('x-powered-by');
  app.use(express.json({
    limit: '1mb',
    type: ['application/json', 'application/*+json'],
    verify: rawBody ? (req, _res, buf) => { req.rawBody = buf; } : undefined,
  }));
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
    autoLogging: { ignore: (req) => ['/health', '/metrics'].includes(req.url) },
  }));
  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => end({ service, method: req.method, route: req.route?.path || req.path, status: res.statusCode }));
    next();
  });
  // Requête relayée par la passerelle KrakenD (seule à poser X-Sujet, tiré du jeton) : on trace les deux étapes
  // appelant → passerelle → service pour l'observatoire, KrakenD ne publiant rien lui-même.
  app.use((req, res, next) => {
    if (!req.headers['x-sujet']) return next();
    const appelant = req.headers['x-appelant'] || (service === 'mcp' ? 'assistant-ia' : 'navigateur');
    const debut = Date.now();
    const chemin = req.path;
    tracer({ type: 'requete', de: appelant, vers: 'gateway', methode: req.method, chemin: service === 'mcp' ? chemin : `/api/v1${chemin}`, t: debut });
    tracer({ type: 'requete', de: 'gateway', vers: service, methode: req.method, chemin, t: debut + 1 });
    res.on('finish', () => {
      const fin = Date.now();
      tracer({ type: 'reponse', de: service, vers: 'gateway', statut: res.statusCode, duree: fin - debut, t: fin });
      tracer({ type: 'reponse', de: 'gateway', vers: appelant, statut: res.statusCode, t: fin + 1 });
    });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service }));
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  });
  return app;
}

/** À appeler après la déclaration des routes. */
export function finalizeApp(app, logger) {
  app.use((req, res) => res.status(404).json({ erreur: 'Ressource introuvable', chemin: req.path }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error({ err }, 'Erreur serveur');
    res.status(status).json({ erreur: err.message, details: err.details, requestId: req.id });
  });
}

/** Encapsule une route asynchrone pour transmettre les erreurs à Express. */
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Appel HTTP JSON avec délai maximal.
 * La requête et la réponse sont tracées pour l'observatoire (trace: false pour un appel répétitif, de: pour nommer l'appelant).
 */
export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 3000, trace = true, de } = {}) {
  const { hostname, pathname } = new URL(url);
  const appelant = de || serviceCourant();
  const debut = Date.now();
  if (trace) tracer({ type: 'requete', de: appelant, vers: hostname, methode: method, chemin: pathname });
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Appelant': appelant || '', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (trace) tracer({ type: 'reponse', de: hostname, vers: appelant, statut: 'injoignable', duree: Date.now() - debut });
    throw err;
  }
  if (trace) tracer({ type: 'reponse', de: hostname, vers: appelant, statut: res.status, duree: Date.now() - debut });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new HttpError(res.status, data?.erreur || `Erreur HTTP ${res.status}`, data);
  return data;
}

/** Lit l'identifiant de boutique injecté par la passerelle. */
export function boutiqueId(req) {
  const id = req.headers['x-boutique-id'];
  if (!id) throw new HttpError(403, 'Aucune boutique associée à ce jeton');
  return id;
}
