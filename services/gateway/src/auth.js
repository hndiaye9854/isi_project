import { auth } from 'express-oauth2-jwt-bearer';
import { env, envMap, HttpError } from '@surfwear/common';

/**
 * Authentification et autorisation.
 *
 * Mode "auth0" (par défaut) : le jeton est un JWT émis par Auth0 (RS256), vérifié avec les clés publiques (JWKS)
 * du tenant. L'audience doit être l'identifiant de l'API Surfwear déclarée dans Auth0.
 * La boutique est lue dans le claim personnalisé <namespace>boutique_id (ajouté par une Action Auth0),
 * ou à défaut retrouvée à partir de l'identifiant de l'application cliente (variable AUTH0_CLIENT_BOUTIQUES).
 *
 * Mode "dev" : jetons de démonstration "dev-<boutique>" ou "dev-commercial", sans Auth0. À ne jamais utiliser en production.
 */
const MODE = env('AUTH_MODE', 'auth0');
const NAMESPACE = env('AUTH0_CLAIM_NAMESPACE', 'https://surfwear.example/');

const SCOPES_BOUTIQUE = ['read:catalogue', 'read:commandes', 'write:commandes', 'manage:webhooks'];
const SCOPES_COMMERCIAL = ['read:catalogue', 'read:stats'];

export function authentification(logger) {
  if (MODE === 'dev') {
    logger.warn('AUTH_MODE=dev : authentification de démonstration active, à ne pas utiliser en production');
    return (req, _res, next) => {
      const jeton = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const m = jeton.match(/^dev-(.+)$/);
      if (!m) return next(new HttpError(401, 'Jeton manquant ou invalide (mode dev : "Bearer dev-B001" ou "Bearer dev-commercial")'));
      req.identite = m[1] === 'commercial'
        ? { sujet: 'dev|commercial', boutique: null, scopes: SCOPES_COMMERCIAL }
        : { sujet: `dev|${m[1]}`, boutique: m[1], scopes: SCOPES_BOUTIQUE };
      next();
    };
  }

  const domaine = env('AUTH0_DOMAIN');
  const verifierJwt = auth({
    issuerBaseURL: `https://${domaine}/`,
    audience: env('AUTH0_AUDIENCE'),
    tokenSigningAlg: 'RS256',
  });
  const clientsBoutiques = envMap('AUTH0_CLIENT_BOUTIQUES');
  logger.info({ domaine }, 'Authentification Auth0 active');

  return (req, res, next) => verifierJwt(req, res, (err) => {
    if (err) return next(new HttpError(err.status || 401, 'Jeton refusé', { raison: err.message }));
    const p = req.auth.payload;
    const scopes = [
      ...(typeof p.scope === 'string' ? p.scope.split(' ') : []),
      ...(Array.isArray(p.permissions) ? p.permissions : []),
    ];
    const clientId = p.azp || p.client_id || String(p.sub || '').replace(/@clients$/, '');
    req.identite = {
      sujet: p.sub,
      boutique: p[`${NAMESPACE}boutique_id`] || clientsBoutiques[clientId] || null,
      scopes,
    };
    next();
  });
}

export const exiger = (...scopes) => (req, _res, next) => {
  const manquants = scopes.filter((s) => !req.identite?.scopes.includes(s));
  if (manquants.length) return next(new HttpError(403, 'Droits insuffisants', { requis: scopes, manquants }));
  next();
};
