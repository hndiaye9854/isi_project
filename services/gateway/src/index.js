import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import swaggerUi from 'swagger-ui-express';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { createLogger, createApp, finalizeApp, env, envInt } from '@surfwear/common';
import { authentification, exiger } from './auth.js';

/**
 * Passerelle d'API (API Gateway) : seule porte d'entrée de la plateforme.
 * Elle vérifie le jeton, contrôle les droits, injecte l'identité de la boutique et route vers les services.
 */
const SERVICE = 'gateway';
const logger = createLogger(SERVICE);
const app = createApp({ service: SERVICE, logger });

const openapiPath = env('OPENAPI_PATH', fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url)));
const openapi = YAML.parse(readFileSync(openapiPath, 'utf8'));
app.get('/', (_req, res) => res.redirect('/docs'));
app.get('/openapi.json', (_req, res) => res.json(openapi));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'API Surfwear B2B' }));

app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: envInt('RATE_LIMIT_PAR_MINUTE', 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { erreur: 'Trop de requêtes, réessayez dans une minute' },
}));
app.use('/api', authentification(logger));

// L'identité est injectée par la passerelle ; tout en-tête envoyé par le client est écrasé.
function versService(cible, prefixe) {
  return createProxyMiddleware({
    target: cible,
    changeOrigin: true,
    pathRewrite: (path) => prefixe + path,
    proxyTimeout: 10_000,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.removeHeader('x-boutique-id');
        if (req.identite.boutique) proxyReq.setHeader('X-Boutique-Id', req.identite.boutique);
        proxyReq.setHeader('X-Sujet', req.identite.sujet);
        proxyReq.setHeader('X-Request-Id', req.id);
        fixRequestBody(proxyReq, req);
      },
      error: (err, _req, res) => {
        logger.error({ err: err.message }, 'Service injoignable');
        if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erreur: 'Service temporairement indisponible' }));
      },
    },
  });
}

const URL_CATALOGUE = env('CATALOGUE_URL', 'http://catalogue:8081');
const URL_COMMANDES = env('COMMANDES_URL', 'http://commandes:8082');
const URL_NOTIFICATIONS = env('NOTIFICATIONS_URL', 'http://notifications:8083');
const URL_ANALYTICS = env('ANALYTICS_URL', 'http://analytics:8084');

const lecture = (scope) => (req, res, next) => (req.method === 'GET' ? exiger(scope)(req, res, next) : next());

app.use('/api/v1/produits', exiger('read:catalogue'), versService(URL_CATALOGUE, '/produits'));
app.use('/api/v1/disponibilites', exiger('read:catalogue'), versService(URL_CATALOGUE, '/disponibilites'));
app.use('/api/v1/commandes',
  lecture('read:commandes'),
  (req, res, next) => (req.method === 'POST' ? exiger('write:commandes')(req, res, next) : next()),
  versService(URL_COMMANDES, '/commandes'));
app.use('/api/v1/webhooks', exiger('manage:webhooks'), versService(URL_NOTIFICATIONS, '/webhooks'));
app.use('/api/v1/stats', exiger('read:stats'), versService(URL_ANALYTICS, '/stats'));

finalizeApp(app, logger);
const port = envInt('PORT', 8080);
app.listen(port, () => logger.info({ port }, 'Passerelle d\'API démarrée'));
