# Image commune à tous les services du monorepo.
# Exemple : docker build --build-arg SERVICE_PATH=services/catalogue -t surfwear/catalogue .
FROM node:22-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

FROM base AS deps
ARG SERVICE_PATH
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
COPY simulators ./simulators
# Installe uniquement les dépendances du service visé (et de la bibliothèque commune).
RUN npm ci --omit=dev --no-audit --no-fund --workspace=${SERVICE_PATH} \
 && mkdir -p ${SERVICE_PATH}/node_modules

FROM base AS runtime
ARG SERVICE_PATH
ENV SERVICE_PATH=${SERVICE_PATH}
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY packages ./packages
COPY ${SERVICE_PATH} ./${SERVICE_PATH}
# Dépendances propres au service, quand sa version diffère de celle des autres (ex. zod 4 pour le serveur MCP).
COPY --from=deps /app/${SERVICE_PATH}/node_modules ./${SERVICE_PATH}/node_modules
COPY docs/openapi.yaml ./docs/openapi.yaml
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node ${SERVICE_PATH}/src/index.js"]
