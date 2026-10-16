#!/usr/bin/env bash
# Recopie dans .env les valeurs Auth0 produites par Terraform (infra/terraform/auth0) :
# domaine, audiences (API et MCP), Client ID et secrets des boutiques et du commercial. Les autres lignes du .env sont conservées.
# Usage : bash scripts/env-depuis-terraform.sh   (après "terraform apply"). Demande jq, et terraform ou Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
DOSSIER=infra/terraform/auth0

if command -v terraform > /dev/null; then SORTIES=$(terraform -chdir="$DOSSIER" output -json)
else SORTIES=$(docker run --rm -v "$PWD/$DOSSIER":/w -w /w hashicorp/terraform:latest output -json); fi

touch .env && chmod 600 .env
majvar() {   # remplace ou ajoute NOM=valeur, sans afficher la valeur
  local tmp; tmp=$(mktemp)
  awk -v nom="$1" -v val="$2" 'BEGIN { fait = 0 } $0 ~ "^" nom "=" { print nom "=" val; fait = 1; next } { print } END { if (!fait) print nom "=" val }' .env > "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}
val() { jq -r "$1" <<< "$SORTIES"; }

majvar AUTH0_DOMAIN "$(val .auth0_domain.value)"
majvar AUTH0_AUDIENCE "$(val .audience.value)"
majvar MCP_AUDIENCE "$(val .mcp_audience.value)"
for code in $(val '.boutiques_client_id.value | keys[]'); do
  majvar "AUTH0_${code}_CLIENT_ID" "$(val ".boutiques_client_id.value[\"$code\"]")"
  majvar "AUTH0_${code}_CLIENT_SECRET" "$(val ".boutiques_client_secret.value[\"$code\"]")"
done
majvar AUTH0_COMMERCIAL_CLIENT_ID "$(val .commercial_client_id.value)"
majvar AUTH0_COMMERCIAL_CLIENT_SECRET "$(val .commercial_client_secret.value)"
echo ".env mis à jour avec les identifiants Auth0 de Terraform. Passer AUTH_MODE=auth0 puis : docker compose up -d"
