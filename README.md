# Surfwear Interop : plateforme d'interopérabilité B2B

Prototype de la **solution d'interopérabilité** entre une entreprise de surfwear et ses boutiques clientes.
Projet fil rouge du module *Interopérabilité des systèmes d'information*, Master 2 SIGLIS, Université de Pau et des Pays de l'Adour (collège STEE), 2026/2027.

Auteurs : ALLOUCH Salma, NDIAYE Hamidou, FAYE Serigne Saliou HASNAOUI Ilyas. Enseignant : E. BEGON.

---

## Sommaire

1. [Le problème](#1-le-problème)
2. [La solution](#2-la-solution)
3. [Démarrage rapide](#3-démarrage-rapide)
4. [Scénario de démonstration](#4-scénario-de-démonstration)
5. [Authentification avec Auth0](#5-authentification-avec-auth0)
6. [Utiliser l'API](#6-utiliser-lapi)
7. [Structure du monorepo](#7-structure-du-monorepo)
8. [Tests et intégration continue](#8-tests-et-intégration-continue)
9. [Supervision](#9-supervision)
10. [Développement sans Docker](#10-développement-sans-docker)
11. [Dépannage](#11-dépannage)
12. [Déploiement sur le VPS](#12-déploiement-sur-le-vps)

---

## 1. Le problème

Aujourd'hui, les commandes des 50 boutiques sont prises par téléphone le lundi. Le stock n'est retiré de l'ERP que le mercredi, au moment de la préparation du colis. Entre les deux, plusieurs boutiques peuvent se voir promettre les mêmes articles. Les fiches et les bons de livraison circulent par mail, puis sont ressaisis à la main dans le logiciel de chaque boutique.

La direction veut que chaque boutique commande en ligne, 24h/24 et 7j/7, en voyant la disponibilité réelle et les délais.

## 2. La solution

Une plateforme qui combine API REST et événements. Elle se place entre l'ERP de l'entreprise et les logiciels des boutiques.

![Schéma des flux](docs/schema-flux-to-be.png)

| Ce qui change | Comment |
| --- | --- |
| Plus de double réservation | Le stock est réservé dans l'ERP **au moment de la commande**, dans une transaction qui verrouille les lignes de stock. |
| Commande 24h/24 | API REST documentée (OpenAPI 3), protégée par Auth0. Le catalogue est servi depuis un cache, même si l'ERP est en maintenance. |
| Délais connus tout de suite | Le stock potentiel (production en cours) est réservé avec sa date de livraison prévue. |
| Plus de ressaisie | La confirmation et le bon de livraison arrivent dans le logiciel de la boutique par **webhook signé**. |
| Commerciaux libérés | Statistiques des références en tension pour anticiper la production. |
| ERP protégé | Il n'est jamais exposé : seul un connecteur y accède, depuis un réseau isolé. |

**Composants**

| Composant | Rôle |
| --- | --- |
| `gateway` | Passerelle d'API **KrakenD** : vérification des jetons Auth0, permissions, quotas, routage déclaratif |
| `catalogue` | Catalogue et disponibilité (cache Redis) |
| `commandes` | Commandes et réservation (PostgreSQL, outbox) |
| `notifications` | Webhooks signés et e-mails |
| `analytics` | Tableau de bord des commerciaux |
| `erp-connector` | Adaptateur ERP vers bus d'événements |
| `erp-mock` | ERP simulé + écran du logisticien |
| `boutique-simulator` | Logiciel de gestion d'une boutique (3 instances) |

**Infrastructure** : RabbitMQ (bus d'événements), PostgreSQL (une base par service), Redis (cache), Mailpit (boîte mail de test). Prometheus et Grafana sont disponibles en option.

Le détail des choix techniques est dans [docs/architecture.md](docs/architecture.md).

> **Périmètre du prototype** : uniquement des échanges REST et des événements. Les adaptateurs EDIFACT et CSV/SFTP du schéma cible, ainsi que le serveur MCP, sont prévus pour une étape suivante.

## 3. Démarrage rapide

### Prérequis

- Docker 24 ou plus récent, avec Docker Compose v2. **Podman** fonctionne aussi, avec `podman compose`.
- Environ 2 Go de mémoire libre.
- Ports libres : 8080, 8088, 8090, 8099, 7001 à 7003, 8025, 15672.

### Lancer l'écosystème

```bash
git clone https://github.com/<votre-compte>/surfwear-interop.git
cd surfwear-interop
docker compose up -d --build
```

Sans fichier `.env`, la plateforme démarre en **mode démonstration** (`AUTH_MODE=dev`), sans compte Auth0 : un faux fournisseur OAuth2 (`mock-oauth2`) délivre de vrais jetons JWT. Pour utiliser Auth0, voir la [section 5](#5-authentification-avec-auth0).

Attendez que tous les services soient prêts (environ une minute au premier lancement) :

```bash
docker compose ps
```

### Les adresses utiles

| Adresse | Contenu |
| --- | --- |
| http://localhost:8088 | Documentation interactive de l'API (Swagger UI), qui appelle la passerelle sur http://localhost:8080 |
| http://localhost:8099 | Faux fournisseur OAuth2 du mode démonstration (jetons : `bash scripts/jeton.sh B001`) |
| http://localhost:8090/logistique/ | ERP simulé : écran du logisticien (expédier, réceptionner la production) |
| http://localhost:7001 | Logiciel de la boutique de Biarritz (B001) |
| http://localhost:7002 | Logiciel de la boutique de Hossegor (B002) |
| http://localhost:7003 | Logiciel de la boutique de Lacanau (B003) |
| http://localhost:8025 | Boîte mail de test (e-mails envoyés aux boutiques) |
| http://localhost:15672 | Console RabbitMQ (identifiant et mot de passe : `surfwear`) |

### Arrêter

```bash
docker compose down        # arrêt
docker compose down -v     # arrêt et suppression des données
```

## 4. Scénario de démonstration

Un script guidé rejoue le scénario complet. Il demande `curl` et `jq`.

```bash
bash scripts/demo.sh
```

Vous pouvez aussi le faire à la main :

**1. Trois boutiques commandent en même temps le même article rare.** Il y a 5 pots de wax en stock et chaque boutique en veut 4.

```bash
for p in 7001 7002 7003; do
  curl -s -X POST localhost:$p/commander -H 'Content-Type: application/json' \
    -d '{"lignes":[{"gtin":"3760123450097","quantite":4}]}' &
done; wait
```

Résultat : exactement 5 pots sont réservés sur le stock (par exemple 4 + 1 + 0). Le reste est réservé sur la production en cours, avec sa date de livraison. Il n'y a **aucune double réservation**.

**2. Le logisticien expédie une commande.** Ouvrez http://localhost:8090/logistique/ et cliquez sur « Colis prêt, expédier ».

**3. La boutique est prévenue automatiquement.** Ouvrez http://localhost:7001 : le stock local de la boutique a été mis à jour par webhook, sans ressaisie. L'e-mail est visible sur http://localhost:8025.

**4. L'ERP tombe en panne.** Arrêtez-le :

```bash
docker compose stop erp-mock
```

Le catalogue répond toujours. Une nouvelle commande est acceptée avec le statut `EN_ATTENTE_ERP` (HTTP 202). Redémarrez l'ERP :

```bash
docker compose start erp-mock
```

Quelques secondes plus tard, la commande passe automatiquement au statut `RESERVEE`.

**5. Le commercial consulte les références en tension.**

```bash
curl -s -H "Authorization: Bearer $(bash scripts/jeton.sh COMMERCIAL --imprimer)" localhost:8080/api/v1/stats/tensions | jq
```

### Démo animée des flux (observatoire)

Une page web montre **en direct** les échanges entre les composants : chaque paquet animé est un vrai appel REST, un événement du bus, un webhook ou un e-mail, capté au moment où il a lieu.

```bash
docker compose --profile demo up -d --build
```

Ouvrez ensuite http://localhost:8070.

- **Visite guidée** : six étapes à lancer une par une (catalogue, commande, trois boutiques en même temps, expédition, réception de production, message invalide jusqu'à la file d'erreurs). Chaque étape explique ce que l'on va voir.
- **Mode libre** : choisir une boutique, un article et une quantité, puis commander, expédier ou réceptionner.
- **Swagger** : les appels faits sur http://localhost:8088 apparaissent aussi.
- La vitesse se règle (× 0,5 à × 4) : les échanges réels durent quelques millisecondes, ils sont rejoués dans l'ordre pour rester lisibles.
- Le schéma est rendu avec [archify](https://github.com/tt-a1i/archify) à partir de `services/observatoire/schema/surfwear.architecture.json` (logos RabbitMQ, Redis, PostgreSQL, Node.js). Après une modification du schéma : `archify deliver architecture services/observatoire/schema/surfwear.architecture.json services/observatoire/public/schema.html --quality showcase`.

Fonctionnement : chaque service publie une courte trace pour chaque échange sur l'échange RabbitMQ `surfwear.traces` (au mieux, sans effet sur le traitement ; `TRACES=off` pour désactiver). Le service `observatoire` les remet dans l'ordre et les pousse au navigateur (Server-Sent Events). Il est relié aux trois réseaux pour piloter les boutiques et l'ERP : c'est un outil de démonstration, à ne jamais déployer en production.

## 5. Authentification avec Auth0

En production, l'identité est gérée par **Auth0**. Chaque logiciel de boutique est une application *machine à machine*, qui obtient un jeton JWT avec le flux OAuth2 *client credentials*. La passerelle vérifie :

- la signature (RS256, clés publiques du tenant) ;
- l'émetteur, l'audience et l'expiration du jeton ;
- les permissions.

Elle lit ensuite la boutique dans le jeton.

| Permission | Boutique | Commercial |
| --- | :---: | :---: |
| `read:catalogue` | ✔ | ✔ |
| `read:commandes` | ✔ | |
| `write:commandes` | ✔ | |
| `manage:webhooks` | ✔ | |
| `read:stats` | | ✔ |

**Configuration en code (Terraform)** : l'API, ses permissions, les applications des boutiques et du commercial, leurs autorisations et l'Action qui ajoute `boutique_id` au jeton sont décrites dans [infra/terraform/auth0](infra/terraform/auth0/README.md). Ajouter une boutique, c'est une ligne dans `variables.tf`.

```bash
cd infra/terraform/auth0 && terraform init && terraform apply && cd ../../..
bash scripts/env-depuis-terraform.sh     # recopie Client ID et secrets dans .env
```

Puis `AUTH_MODE=auth0` dans `.env` et `docker compose up -d`. Le guide complet est dans [docs/auth0.md](docs/auth0.md).

**Mode démonstration** (`AUTH_MODE=dev`, utilisé par défaut et par la CI) : le faux fournisseur `mock-oauth2` remplace Auth0 et délivre des jetons signés avec les mêmes permissions et le même claim `boutique_id`. La passerelle les vérifie exactement comme ceux d'Auth0. Ce mode ne doit jamais être utilisé en production.

**Obtenir un jeton** (pour Swagger ou curl) : `bash scripts/jeton.sh B001` le copie dans le presse-papiers ; `B002`, `B003` ou `COMMERCIAL` pour les autres profils. Le script interroge le faux fournisseur ou Auth0 selon `AUTH_MODE`.

## 6. Utiliser l'API

La documentation complète est servie sur http://localhost:8088 (bouton **Authorize** : coller un jeton de `scripts/jeton.sh`). Le contrat est dans [docs/openapi.yaml](docs/openapi.yaml), les événements dans [docs/asyncapi.yaml](docs/asyncapi.yaml).

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/api/v1/produits` | Catalogue avec disponibilité |
| GET | `/api/v1/produits/{gtin}` | Détail d'un article |
| GET | `/api/v1/disponibilites/{gtin}?quantite=N` | Livrable tout de suite, plus tard (avec date) ou non disponible |
| POST | `/api/v1/commandes` | Passer une commande (en-tête `Idempotency-Key` obligatoire) |
| GET | `/api/v1/commandes` | Commandes de la boutique |
| GET | `/api/v1/commandes/{id}` | Suivi d'une commande |
| POST | `/api/v1/webhooks` | S'abonner aux événements (renvoie le secret de signature) |
| GET | `/api/v1/webhooks/livraisons` | Journal des webhooks envoyés |
| GET | `/api/v1/stats/boutiques`, `/references`, `/tensions` | Statistiques (commerciaux) |

**Exemple : passer une commande**

```bash
TOKEN=$(bash scripts/jeton.sh B001 --imprimer)
curl -s -X POST http://localhost:8080/api/v1/commandes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reference_boutique":"BIA-0412","lignes":[{"gtin":"3760123450035","quantite":10},{"gtin":"3760123450097","quantite":20}]}' | jq
```

**Statuts d'une commande** : `RECUE`, `EN_ATTENTE_ERP`, `RESERVEE`, `RESERVEE_PARTIELLEMENT` (une partie sur la production), `EXPEDIEE_PARTIELLEMENT` et `EXPEDIEE`.

**Vérifier un webhook** (côté logiciel de la boutique) : calculer `sha256=` suivi du HMAC SHA-256 du corps brut, avec le secret reçu à l'abonnement, puis le comparer à l'en-tête `X-Surfwear-Signature`. Un exemple complet se trouve dans `simulators/boutique/src/index.js`.

## 7. Structure du monorepo

```
surfwear-interop/
├── packages/
│   └── common/              Bibliothèque partagée : bus, base de données, HTTP, journaux, métriques
├── services/
│   ├── catalogue/           Catalogue et disponibilité
│   ├── commandes/           Commandes et réservation
│   ├── notifications/       Webhooks et e-mails
│   ├── analytics/           Statistiques des commerciaux
│   ├── erp-connector/       Adaptateur ERP
│   └── erp-mock/            ERP simulé + écran du logisticien
├── simulators/
│   └── boutique/            Logiciel de boutique simulé
├── infra/
│   ├── krakend/             Passerelle d'API (modèle + settings/routes.json)
│   ├── terraform/auth0/     Configuration Auth0 en Terraform
│   ├── mock-oauth2/         Faux fournisseur OAuth2 (mode démonstration)
│   └── postgres, prometheus, grafana
├── docs/                    OpenAPI, AsyncAPI, architecture, guide Auth0, schéma des flux
├── scripts/                 Démonstration et test de bout en bout
├── Dockerfile               Image commune (argument SERVICE_PATH)
├── docker-compose.yml       Orchestration complète
└── .github/workflows/ci.yml Intégration continue
```

Le monorepo utilise les *workspaces* npm. Une seule image Docker sert pour tous les services : l'argument `SERVICE_PATH` choisit le service, et seules ses dépendances sont installées.

```bash
docker build --build-arg SERVICE_PATH=services/catalogue -t surfwear/catalogue .
```

## 8. Tests et intégration continue

```bash
npm ci && npm test              # tests unitaires
bash scripts/smoke-test.sh      # test de bout en bout (plateforme démarrée, mode dev)
```

Le test de bout en bout vérifie :

- la sécurité ;
- le catalogue ;
- l'absence de double réservation lors de commandes simultanées ;
- l'idempotence ;
- l'expédition avec notification par webhook ;
- les statistiques.

La CI GitHub Actions (`.github/workflows/ci.yml`) lance les tests unitaires. Elle construit ensuite toutes les images, démarre l'écosystème complet et exécute le test de bout en bout à chaque *push* et *pull request*.

## 9. Supervision

Chaque service expose `/health` et `/metrics` (format Prometheus) et écrit des journaux JSON structurés.

```bash
docker compose --profile monitoring up -d
```

Prometheus est alors disponible sur http://localhost:9090, et Grafana sur http://localhost:3000 (identifiant `admin`, mot de passe `surfwear`), avec la source Prometheus déjà configurée.

Les messages en échec définitif sont visibles dans les files `*.dlq` de la console RabbitMQ.

## 10. Développement sans Docker

Il faut Node.js 20 ou plus récent, ainsi que PostgreSQL, Redis et RabbitMQ en local.

```bash
npm install
export AUTH_MODE=dev RABBITMQ_URL=amqp://guest:guest@localhost:5672 REDIS_URL=redis://localhost:6379
export ERP_DATABASE_URL=postgres://postgres:postgres@localhost:5432/erp
node services/erp-mock/src/index.js
```

Chaque service lit sa configuration dans des variables d'environnement, avec des valeurs par défaut adaptées à docker compose. Elles sont visibles dans `docker-compose.yml`.

## 11. Dépannage

| Symptôme | Solution |
| --- | --- |
| `docker compose ps` affiche un service « unhealthy » | `docker compose logs <service>`. Au premier lancement, RabbitMQ peut mettre 30 secondes à démarrer : les services se reconnectent seuls. |
| 401 sur toutes les requêtes | Jeton absent, expiré ou d'un autre fournisseur : en mode Auth0, vérifier `AUTH0_DOMAIN` (sans `https://`) et `AUTH0_AUDIENCE` ; en mode dev, prendre un jeton avec `scripts/jeton.sh`. Décoder le jeton sur jwt.io. |
| 403 renvoyé par la passerelle | Le jeton n'a pas la permission de la route (`scope`) : voir `infra/krakend/settings/routes.json`. |
| 429 « Too Many Requests » | Plus de 300 requêtes par minute depuis la même adresse IP (`qos/ratelimit/router` dans `infra/krakend/krakend.tmpl`). |
| 403 « Aucune boutique associée à ce jeton » | Le jeton ne contient pas le claim `boutique_id` : vérifier que l'Action Terraform est déployée et que l'application a `client_metadata.boutique_id`. |
| Port déjà utilisé | Modifier la partie gauche de `ports:` dans `docker-compose.yml`. |
| Un service redémarre en boucle avec `PRECONDITION_FAILED` (`x-dead-letter-exchange`) | Les files RabbitMQ ont été créées par une version précédente avec d'autres paramètres. Repartir de zéro (ligne suivante) ou supprimer les files concernées dans la console RabbitMQ. |
| Repartir de zéro | `docker compose down -v && docker compose up -d --build` |

## 12. Déploiement sur le VPS

Chaque *push* sur `main` (ou un lancement manuel dans l'onglet *Actions*) exécute `.github/workflows/deploy.yml` :

1. la CI (tests unitaires et test de bout en bout) ;
2. la construction des 8 images (dont la passerelle KrakenD, construite depuis `infra/krakend`), poussées sur DockerHub sous `<DOCKERHUB_USERNAME>/surfwear-<service>`, avec les tags `latest` et le SHA du commit ;
3. la copie de `docker-compose.prod.yml`, `infra/`, `docs/openapi.yaml` et `scripts/deploy/deploy.sh` sur le VPS, puis l'exécution de ce script en SSH (`pull`, `up --wait`, contrôle de la passerelle).

**Secrets GitHub** (*Settings > Secrets and variables > Actions*) : `DOCKERHUB_USERNAME`, `DOCKERHUB_PASSWORD` (jeton d'accès DockerHub), `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (clé privée dont la clé publique est dans `~/.ssh/authorized_keys` du VPS), `VPS_SSH_PORT`. Variable facultative : `VPS_DEPLOY_PATH` (par défaut `~/surfwear`).

**Prérequis sur le VPS** : Docker et Docker Compose v2, et l'utilisateur `VPS_USER` membre du groupe `docker`. Les dépôts DockerHub créés au premier *push* sont publics ; s'ils sont privés, faire une fois `docker login` sur le VPS.

**Configuration** : le fichier `~/surfwear/.env` du VPS n'est jamais écrasé. Au premier déploiement, il est créé avec des mots de passe aléatoires et `AUTH_MODE=dev`. Pour la vraie production, y passer `AUTH_MODE=auth0` et renseigner les variables `AUTH0_*` produites par Terraform (section 5), puis relancer le workflow.

**Exposition** : les conteneurs n'écoutent que sur `127.0.0.1` (passerelle `8201`, ERP `8202`, Swagger UI `8203`, boutiques `7001` à `7003`, mailpit `8025`, console RabbitMQ `15672`). Le nginx de l'hôte fait le reverse proxy en HTTPS, par exemple :

```nginx
location / {
    proxy_pass http://127.0.0.1:8201;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**Commandes utiles sur le VPS** :

```bash
cd ~/surfwear
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f gateway
./scripts/deploy.sh <DOCKERHUB_USERNAME> <ancien-sha>   # rollback (PREVIOUS_IMAGE_TAG dans .env)
```
