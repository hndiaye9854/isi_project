#!/usr/bin/env bash
# Obtient un jeton d'accès (flux OAuth2 client credentials) pour tester l'API, par exemple dans Swagger.
# Usage : bash scripts/jeton.sh [B001|B002|B003|COMMERCIAL] [--imprimer] [--mcp]
#   - --mcp : jeton pour le serveur MCP (audience MCP_AUDIENCE) au lieu de l'API REST ;
#   - par défaut, le jeton est copié dans le presse-papiers ; --imprimer l'affiche (pour les scripts) ;
#   - AUTH_MODE=dev (défaut) : faux fournisseur mock-oauth2 sur http://localhost:8099, aucun secret ;
#   - AUTH_MODE=auth0 : identifiants AUTH0_<QUI>_CLIENT_ID et AUTH0_<QUI>_CLIENT_SECRET du .env (jamais affichés).
# Un AUTH_MODE passé en variable d'environnement l'emporte sur celui du .env.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE_IMPOSE=${AUTH_MODE:-}
if [ -f .env ]; then set -a; source .env; set +a; fi
AUTH_MODE=${MODE_IMPOSE:-${AUTH_MODE:-dev}}

QUI=$(printf %s "${1:-B001}" | tr '[:lower:]' '[:upper:]')
IMPRIMER=false; MCP=false
for arg in "$@"; do
  [ "$arg" = "--imprimer" ] && IMPRIMER=true
  [ "$arg" = "--mcp" ] && MCP=true
done
if $MCP; then AUDIENCE=${MCP_AUDIENCE:-https://mcp.surfwear.example}; else AUDIENCE=${AUTH0_AUDIENCE:-https://api.surfwear.example}; fi

if [ "$AUTH_MODE" = "auth0" ]; then
  URL="https://${AUTH0_DOMAIN:?AUTH0_DOMAIN absent du .env}/oauth/token"
  ID_VAR="AUTH0_${QUI}_CLIENT_ID"; SECRET_VAR="AUTH0_${QUI}_CLIENT_SECRET"
  ID=${!ID_VAR:-}; SECRET=${!SECRET_VAR:-}
  if [ -z "$ID" ] || [ -z "$SECRET" ]; then echo "Variables $ID_VAR et $SECRET_VAR absentes du .env" >&2; exit 1; fi
else
  URL="${MOCK_OAUTH_URL:-http://localhost:8099}/surfwear/token"
  if [ "$QUI" = "COMMERCIAL" ]; then ID=commercial; else ID="boutique-$(printf %s "$QUI" | tr '[:upper:]' '[:lower:]')"; fi
  SECRET=dev
fi

REPONSE=$(curl -s -X POST "$URL" \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=$ID" \
  --data-urlencode "client_secret=$SECRET" \
  --data-urlencode "audience=$AUDIENCE")
JETON=$(echo "$REPONSE" | jq -r '.access_token // empty' 2>/dev/null || true)
if [ -z "$JETON" ]; then
  echo "Jeton refusé ($AUTH_MODE) : $(echo "$REPONSE" | jq -r '.error_description // .error // .' 2>/dev/null || echo "$REPONSE")" >&2
  exit 1
fi

if $IMPRIMER; then printf '%s\n' "$JETON"; exit 0; fi
if command -v pbcopy > /dev/null; then printf %s "$JETON" | pbcopy
elif command -v xclip > /dev/null; then printf %s "$JETON" | xclip -selection clipboard
else printf '%s\n' "$JETON"; exit 0; fi
echo "Jeton $QUI ($AUTH_MODE) copié dans le presse-papiers. Collez-le dans Authorize sur http://localhost:8088 (sans écrire Bearer)."
