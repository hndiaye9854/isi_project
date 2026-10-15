#!/usr/bin/env bash
# Déploiement sur le VPS (appelé en SSH par .github/workflows/deploy.yml, ou à la main).
#
# Usage : scripts/deploy.sh <namespace-dockerhub> <tag-image>
#   ex.  : ~/surfwear/scripts/deploy.sh monlogin 1c4fc87...    (rollback : relancer avec un ancien tag)
#
# Le .env est généré par le pipeline à partir des secrets GitHub et déposé en .env.new :
# il remplace alors le .env courant. Lancé à la main sans .env.new, le .env courant est réutilisé.
set -euo pipefail

NAMESPACE=${1:?namespace DockerHub manquant}
TAG=${2:?tag de l image manquant}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE=(docker compose -f "$DIR/docker-compose.prod.yml" --env-file "$DIR/.env")
cd "$DIR"
umask 077

# --- .env : celui du pipeline s'il y en a un nouveau ---
ANCIEN_TAG=$( [ -f .env ] && sed -n 's/^IMAGE_TAG=//p' .env || true )
if [ -f .env.new ]; then
  mv -f .env.new .env
  echo ">> .env du pipeline appliqué"
elif [ ! -f .env ]; then
  echo "!! Aucun $DIR/.env : lancer le workflow Deploy depuis GitHub." >&2
  exit 1
else
  echo ">> Aucun .env.new : le .env existant est réutilisé"
fi
chmod 600 .env

majvar() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
majvar DOCKERHUB_NAMESPACE "$NAMESPACE"
majvar IMAGE_TAG "$TAG"
majvar PREVIOUS_IMAGE_TAG "${ANCIEN_TAG:-latest}"

echo ">> Déploiement de $NAMESPACE/surfwear-*:$TAG (précédent : ${ANCIEN_TAG:-aucun})"
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" pull --quiet

# --- Infrastructure d'abord, puis alignement des mots de passe ---
# Postgres et RabbitMQ ne lisent leurs identifiants qu'à la création du volume : si les secrets
# changent ensuite, on les applique explicitement (idempotent).
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 postgres rabbitmq redis
printf '%s\n' "ALTER USER postgres PASSWORD :'pw';" \
  | "${COMPOSE[@]}" exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U postgres -v pw="$POSTGRES_PASSWORD"'
"${COMPOSE[@]}" exec -T rabbitmq sh -c '
  u="$RABBITMQ_DEFAULT_USER"; p="$RABBITMQ_DEFAULT_PASS"
  rabbitmqctl -q add_user "$u" "$p" 2> /dev/null || true
  rabbitmqctl -q change_password "$u" "$p"
  rabbitmqctl -q set_user_tags "$u" administrator
  rabbitmqctl -q set_permissions -p / "$u" ".*" ".*" ".*"' > /dev/null
echo ">> Identifiants Postgres et RabbitMQ alignés sur le .env"

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
