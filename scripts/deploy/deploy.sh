#!/usr/bin/env bash
# Déploiement sur le VPS (appelé en SSH par .github/workflows/deploy.yml, ou à la main).
#
# Usage : scripts/deploy.sh <namespace-dockerhub> <tag-image>
#   ex.  : ~/surfwear/scripts/deploy.sh monlogin 1c4fc87...    (rollback : relancer avec un ancien tag)
#
# Le .env du VPS n'est jamais écrasé : au premier déploiement il est créé avec des mots de passe
# aléatoires et AUTH_MODE=dev, à compléter ensuite (Auth0) à la main. Seules les lignes
# DOCKERHUB_NAMESPACE et IMAGE_TAG sont mises à jour à chaque déploiement.
set -euo pipefail

NAMESPACE=${1:?namespace DockerHub manquant}
TAG=${2:?tag de l image manquant}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE=(docker compose -f "$DIR/docker-compose.prod.yml" --env-file "$DIR/.env")
cd "$DIR"

# --- .env : création au premier déploiement ---
if [ ! -f .env ]; then
  echo ">> Premier déploiement : création de $DIR/.env"
  aleatoire() { tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32; }
  umask 077
  cat > .env <<EOF
# Généré au premier déploiement. Fichier propre au VPS : jamais écrasé par le pipeline.
# Passer AUTH_MODE=auth0 et renseigner AUTH0_* (voir docs/auth0.md) pour une vraie production.
AUTH_MODE=dev
AUTH0_DOMAIN=
AUTH0_AUDIENCE=
AUTH0_CLAIM_NAMESPACE=https://surfwear.example/
AUTH0_CLIENT_BOUTIQUES=
AUTH0_B001_CLIENT_ID=
AUTH0_B001_CLIENT_SECRET=
AUTH0_B002_CLIENT_ID=
AUTH0_B002_CLIENT_SECRET=
AUTH0_B003_CLIENT_ID=
AUTH0_B003_CLIENT_SECRET=

POSTGRES_PASSWORD=$(aleatoire)
RABBITMQ_USER=surfwear
RABBITMQ_PASSWORD=$(aleatoire)
GRAFANA_PASSWORD=$(aleatoire)

# Ports locaux (127.0.0.1) à adapter si déjà pris sur le VPS
GATEWAY_PORT=8201
ERP_PORT=8202
BOUTIQUE_1_PORT=7001
BOUTIQUE_2_PORT=7002
BOUTIQUE_3_PORT=7003
MAILPIT_PORT=8025
RABBITMQ_CONSOLE_PORT=15672

# Mis à jour par le pipeline
DOCKERHUB_NAMESPACE=
IMAGE_TAG=latest
EOF
  echo "!! AUTH_MODE=dev : jetons de démonstration acceptés. Configurer Auth0 dans $DIR/.env."
fi
chmod 600 .env

# --- Image à déployer (on garde la précédente pour un éventuel rollback) ---
ANCIEN_TAG=$(sed -n 's/^IMAGE_TAG=//p' .env)
majvar() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
majvar DOCKERHUB_NAMESPACE "$NAMESPACE"
majvar IMAGE_TAG "$TAG"
majvar PREVIOUS_IMAGE_TAG "${ANCIEN_TAG:-latest}"

echo ">> Déploiement de $NAMESPACE/surfwear-*:$TAG (précédent : ${ANCIEN_TAG:-aucun})"
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" pull --quiet

# --wait : échoue si un service n'est pas « healthy » dans le délai.
if ! "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 300; then
  echo "!! Des services ne sont pas sains. État et derniers journaux :"
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" logs --no-color --tail 50
  echo "!! Rollback manuel : $DIR/scripts/deploy.sh $NAMESPACE ${ANCIEN_TAG:-latest}"
  exit 1
fi

# Vérification HTTP de la passerelle, comme le ferait le reverse proxy.
PORT=$(sed -n 's/^GATEWAY_PORT=//p' .env); PORT=${PORT:-8201}
if command -v curl > /dev/null; then curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null
else wget -qO /dev/null "http://127.0.0.1:$PORT/health"; fi
echo ">> Passerelle OK sur 127.0.0.1:$PORT"

"${COMPOSE[@]}" ps
docker image prune -f > /dev/null
echo ">> Déploiement terminé ($TAG)"
