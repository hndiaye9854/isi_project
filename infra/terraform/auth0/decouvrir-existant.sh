#!/usr/bin/env bash
# Reprise de l'existant : retrouve les identifiants des ressources Auth0 créées à la main
# (API, applications des boutiques, autorisations) et écrit imports.auto.tfvars.json pour imports.tf.
# À lancer une fois, avant le premier "terraform plan". Lit terraform.tfvars et AUTH0_CLIENT_BOUTIQUES du .env.
# Demande curl et jq. Les secrets ne sont jamais affichés.
set -euo pipefail
cd "$(dirname "$0")"

lire_tfvar() { sed -n "s/^$1[[:space:]]*=[[:space:]]*\"\(.*\)\"/\1/p" terraform.tfvars; }
DOMAINE=$(lire_tfvar auth0_domain)
CLIENT_ID=$(lire_tfvar terraform_client_id)
CLIENT_SECRET=$(lire_tfvar terraform_client_secret)
# Audience : variable d'environnement, sinon terraform.tfvars, sinon la valeur par défaut de variables.tf.
AUDIENCE=${AUDIENCE:-$(lire_tfvar audience)}
AUDIENCE=${AUDIENCE:-$(sed -n '/variable "audience"/,/^}/s/^[[:space:]]*default[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' variables.tf)}
echo "Audience recherchée : $AUDIENCE"
[ -n "$DOMAINE" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] || { echo "Compléter terraform.tfvars d'abord"; exit 1; }

# Correspondance Client ID -> boutique, telle qu'elle était configurée à la main dans le .env du projet.
CORRESPONDANCE=$(sed -n 's/^AUTH0_CLIENT_BOUTIQUES=//p' ../../../.env 2>/dev/null || true)

JETON=$(curl -fsS -X POST "https://$DOMAINE/oauth/token" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg id "$CLIENT_ID" --arg s "$CLIENT_SECRET" --arg a "https://$DOMAINE/api/v2/" \
        '{grant_type: "client_credentials", client_id: $id, client_secret: $s, audience: $a}')" | jq -r .access_token)
api() { curl -fsS -G "https://$DOMAINE/api/v2/$1" -H "Authorization: Bearer $JETON" "${@:2}"; }

API_ID=$(api resource-servers | jq -r --arg a "$AUDIENCE" '.[] | select(.identifier == $a) | .id')
CLIENTS='{}'; GRANTS='{}'
IFS=',' read -ra PAIRES <<< "$CORRESPONDANCE"
for paire in "${PAIRES[@]}"; do
  cid=${paire%%:*}; code=${paire##*:}
  [ -n "$cid" ] && [ -n "$code" ] || continue
  CLIENTS=$(jq --arg k "$code" --arg v "$cid" '. + {($k): $v}' <<< "$CLIENTS")
  gid=$(api client-grants --data-urlencode "client_id=$cid" --data-urlencode "audience=$AUDIENCE" | jq -r '.[0].id // empty')
  [ -n "$gid" ] && GRANTS=$(jq --arg k "$code" --arg v "$gid" '. + {($k): $v}' <<< "$GRANTS")
done

jq -n --arg api "$API_ID" --argjson c "$CLIENTS" --argjson g "$GRANTS" \
  '{import_api_id: (if $api == "" then null else $api end), import_clients: $c, import_grants: $g}' > imports.auto.tfvars.json
echo "imports.auto.tfvars.json écrit :"
cat imports.auto.tfvars.json
