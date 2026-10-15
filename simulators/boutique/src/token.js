import { env } from '@surfwear/common';

/**
 * Obtention du jeton d'accès.
 * Mode auth0 : flux "client credentials" (application machine à machine de la boutique dans Auth0).
 * Mode dev : jeton de démonstration.
 */
let cache = { jeton: null, expire: 0 };

export async function jeton() {
  if (env('AUTH_MODE', 'auth0') === 'dev') return `dev-${env('BOUTIQUE_ID')}`;
  if (cache.jeton && Date.now() < cache.expire - 60_000) return cache.jeton;
  const res = await fetch(`https://${env('AUTH0_DOMAIN')}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env('AUTH0_CLIENT_ID'),
      client_secret: env('AUTH0_CLIENT_SECRET'),
      audience: env('AUTH0_AUDIENCE'),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Auth0 a refusé la demande de jeton : ${data.error_description || data.error}`);
  cache = { jeton: data.access_token, expire: Date.now() + data.expires_in * 1000 };
  return cache.jeton;
}
