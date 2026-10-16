import { env } from '@surfwear/common';

/**
 * Obtention du jeton d'accès : flux OAuth2 "client credentials", identique dans les deux modes.
 * Mode auth0 : application machine à machine de la boutique dans Auth0.
 * Mode dev : faux fournisseur mock-oauth2 (vrais JWT signés, client "boutique-b001"...), sans compte Auth0.
 */
let cache = { jeton: null, expire: 0 };

function parametres() {
  if (env('AUTH_MODE', 'auth0') === 'dev') {
    return {
      url: env('OAUTH_DEV_TOKEN_URL', 'http://mock-oauth2:8080/surfwear/token'),
      client_id: `boutique-${env('BOUTIQUE_ID').toLowerCase()}`,
      client_secret: 'dev',
    };
  }
  return {
    url: `https://${env('AUTH0_DOMAIN')}/oauth/token`,
    client_id: env('AUTH0_CLIENT_ID'),
    client_secret: env('AUTH0_CLIENT_SECRET'),
  };
}

export async function jeton() {
  if (cache.jeton && Date.now() < cache.expire - 60_000) return cache.jeton;
  const { url, ...identifiants } = parametres();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      audience: env('AUTH0_AUDIENCE', 'https://api.surfwear.example'),
      ...identifiants,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Le fournisseur d'identité a refusé la demande de jeton : ${data.error_description || data.error}`);
  cache = { jeton: data.access_token, expire: Date.now() + data.expires_in * 1000 };
  return cache.jeton;
}
