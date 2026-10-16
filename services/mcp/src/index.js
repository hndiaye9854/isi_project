import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createLogger, createApp, finalizeApp, env, envInt, fetchJson } from '@surfwear/common';
import { enregistrer } from './outils.js';

/**
 * Serveur MCP (Model Context Protocol, spec 2026-07-28) : les assistants IA consultent la disponibilité
 * et préparent les commandes.
 *
 * Il est placé DERRIÈRE la passerelle KrakenD, comme les autres services : KrakenD vérifie le jeton (audience MCP),
 * puis transmet l'identité tirée du jeton (X-Boutique-Id, X-Sujet, X-Scopes). Le serveur ne voit jamais le jeton et
 * appelle les services internes directement avec ces en-têtes, sans jeton : pas de « token passthrough ».
 * Sans état : chaque requête MCP est servie par une instance neuve, avec des réponses JSON (pas de flux SSE).
 */
const SERVICE = 'mcp';
const logger = createLogger(SERVICE);
const urls = {
  catalogue: env('CATALOGUE_URL', 'http://catalogue:8081'),
  commandes: env('COMMANDES_URL', 'http://commandes:8082'),
  analytics: env('ANALYTICS_URL', 'http://analytics:8084'),
};

// Adresse publique du serveur MCP (identifiant de ressource OAuth, RFC 9728) et serveur d'autorisation.
const RESSOURCE = env('MCP_RESOURCE', 'http://localhost:8080/mcp');
const AUTORISATION = env('AUTH_MODE', 'dev') === 'auth0'
  ? `https://${env('AUTH0_DOMAIN')}/`
  : env('OAUTH_DEV_ISSUER', 'http://localhost:8099/surfwear');
const PERMISSIONS = ['read:catalogue', 'read:commandes', 'write:commandes', 'manage:webhooks', 'read:stats'];

const metadonnees = {
  resource: RESSOURCE,
  resource_name: 'Surfwear B2B (assistants IA)',
  authorization_servers: [AUTORISATION],
  scopes_supported: PERMISSIONS,
  bearer_methods_supported: ['header'],
};

// Une instance par requête, construite à partir de l'identité transmise par la passerelle.
function creerServeur({ requestInfo, authInfo }) {
  const boutique = requestInfo?.headers.get('x-boutique-id') || null;
  // Seule la boutique est transmise aux services (X-Sujet reste réservé à la passerelle).
  const entetes = boutique ? { 'X-Boutique-Id': boutique } : {};
  const appel = (url, options = {}) => fetchJson(url, { timeoutMs: 5000, ...options, headers: { ...entetes, ...options.headers } });

  const serveur = new McpServer(
    { name: 'surfwear-b2b', title: 'Surfwear B2B', version: '1.0.0' },
    {
      instructions: 'Plateforme B2B de Surfwear (surfwear). Tu agis pour '
        + (boutique ? `la boutique ${boutique}` : 'un commercial de Surfwear')
        + '. Utilise les codes GTIN des articles. Avant passer_commande, montre le résultat de preparer_commande et obtiens un accord explicite.',
    },
  );
  enregistrer(serveur, { appel, urls, boutique, permissions: authInfo?.scopes || [] });
  return serveur;
}

const gestionnaire = createMcpHandler(creerServeur, {
  responseMode: 'json',
  onerror: (err) => logger.warn({ err: err.message }, 'Requête MCP en échec'),
});
const versNode = toNodeHandler(gestionnaire, { onerror: (err) => logger.error({ err }, 'Erreur du serveur MCP') });

const app = createApp({ service: SERVICE, logger });

// Découverte OAuth (RFC 9728) : publique, pour que l'assistant sache auprès de qui obtenir un jeton.
app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json(metadonnees));

app.all('/mcp', (req, res) => {
  // Seule la passerelle pose X-Sujet : un appel direct, sans jeton vérifié, est refusé.
  if (!req.headers['x-sujet']) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', RESSOURCE)}"`);
    return res.status(401).json({ erreur: 'Jeton requis (passer par la passerelle)' });
  }
  // Identité vérifiée par KrakenD, transmise au SDK : elle sert aux contrôles de permission par outil (requireScopes).
  req.auth = {
    token: '',
    clientId: String(req.headers['x-sujet']),
    scopes: String(req.headers['x-scopes'] || '').split(' ').filter(Boolean),
    resource: new URL(RESSOURCE),
  };
  versNode(req, res, req.body);
});

finalizeApp(app, logger);
const port = envInt('PORT', 8086);
app.listen(port, () => logger.info({ port, ressource: RESSOURCE }, 'Serveur MCP démarré'));
