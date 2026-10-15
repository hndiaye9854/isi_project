# Configurer Auth0

La plateforme délègue l'identité à **Auth0**. La passerelle d'API vérifie chaque jeton JWT (signature RS256 avec les clés publiques du tenant, émetteur, audience, expiration) puis contrôle les droits (*permissions*) avant de router la requête.

Les logiciels des boutiques sont des clients **machine à machine** : ils obtiennent un jeton avec le flux OAuth2 *client credentials*.

## 1. Créer le tenant

Créez un compte gratuit sur auth0.com, puis un tenant (région Europe conseillée, par exemple `surfwear-demo.eu.auth0.com`).

## 2. Déclarer l'API

**Applications > APIs > Create API**

| Champ | Valeur |
| --- | --- |
| Name | API Surfwear B2B |
| Identifier | `https://api.surfwear.example` (c'est l'*audience*, elle ne peut plus être modifiée) |
| Signing Algorithm | RS256 |

Dans l'onglet **Permissions** de l'API, ajoutez :

| Permission | Description |
| --- | --- |
| `read:catalogue` | Consulter le catalogue et la disponibilité |
| `read:commandes` | Consulter ses commandes |
| `write:commandes` | Passer des commandes |
| `manage:webhooks` | Gérer ses abonnements aux événements |
| `read:stats` | Consulter les statistiques (commerciaux) |

## 3. Créer une application par boutique

**Applications > Applications > Create Application**, type **Machine to Machine Applications**.

Créez trois applications :

- Boutique Biarritz (B001) ;
- Boutique Hossegor (B002) ;
- Boutique Lacanau (B003).

À la création, autorisez chacune sur l'**API Surfwear B2B** avec les permissions `read:catalogue`, `read:commandes`, `write:commandes` et `manage:webhooks`.

Créez aussi une application **Commercial** autorisée avec `read:catalogue` et `read:stats`.

## 4. Associer chaque application à sa boutique

La passerelle doit savoir à quelle boutique appartient un jeton, pour qu'une boutique ne voie jamais les données d'une autre. Deux options s'offrent à vous.

### Option A (recommandée) : un claim personnalisé ajouté par une Action

1. Dans chaque application de boutique, allez dans **Settings > Advanced Settings > Application Metadata**. Ajoutez la clé `boutique_id` avec la valeur `B001`, `B002` ou `B003`.
2. Dans **Actions > Library > Create Action > Build from scratch**, créez une Action avec le déclencheur **Machine to Machine** (*credentials-exchange*) :

```js
exports.onExecuteCredentialsExchange = async (event, api) => {
  const boutique = event.client.metadata?.boutique_id;
  if (boutique) {
    api.accessToken.setCustomClaim('https://surfwear.example/boutique_id', boutique);
  }
};
```

3. Cliquez sur **Deploy**.
4. Dans **Actions > Triggers > Machine to Machine** (menu appelé *Flows* dans les anciennes versions de la console), glissez l'Action dans le flux, puis cliquez sur **Apply**.

Le namespace (`https://surfwear.example/`) doit correspondre à `AUTH0_CLAIM_NAMESPACE` dans `.env`.

### Option B : une correspondance dans `.env`

Si vous ne voulez pas utiliser d'Action, renseignez les *Client ID* dans `.env` :

```
AUTH0_CLIENT_BOUTIQUES=AbCdEf123:B001,GhIjKl456:B002,MnOpQr789:B003
```

## 5. Renseigner `.env`

```bash
cp .env.example .env
```

Puis complétez le fichier :

```
AUTH_MODE=auth0
AUTH0_DOMAIN=surfwear-demo.eu.auth0.com
AUTH0_AUDIENCE=https://api.surfwear.example
AUTH0_B001_CLIENT_ID=...
AUTH0_B001_CLIENT_SECRET=...
(idem pour B002 et B003)
```

Relancez ensuite la plateforme :

```bash
docker compose up -d
```

## 6. Obtenir un jeton à la main (tests, Swagger)

```bash
curl -s --request POST "https://$AUTH0_DOMAIN/oauth/token" \
  --header 'content-type: application/json' \
  --data "{\"client_id\":\"$AUTH0_B001_CLIENT_ID\",\"client_secret\":\"$AUTH0_B001_CLIENT_SECRET\",\"audience\":\"$AUTH0_AUDIENCE\",\"grant_type\":\"client_credentials\"}" \
  | jq -r .access_token
```

Collez le jeton dans le bouton **Authorize** de la documentation (`http://localhost:8080/docs`), ou utilisez-le avec curl :

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/produits
```

Pour vérifier le contenu d'un jeton (permissions, claim `boutique_id`), décodez-le sur jwt.io.

## Évolution : responsables de boutique connectés à un portail web

Pour un futur portail web utilisé par des personnes, on utiliserait le flux *Authorization Code + PKCE* d'Auth0 :

- le `boutique_id` serait stocké dans l'`app_metadata` de l'utilisateur ;
- une Action *post-login* l'ajouterait au jeton ;
- les permissions seraient attribuées par rôle (RBAC).

La passerelle n'aurait pas à changer : elle lit déjà le claim et le tableau `permissions`.
