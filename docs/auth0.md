# Configurer Auth0

La plateforme délègue l'identité à **Auth0**. La passerelle **KrakenD** vérifie chaque jeton JWT (signature RS256 avec les clés publiques du tenant, émetteur, audience, expiration), contrôle la permission de la route, puis transmet la boutique au service (claim `boutique_id` → en-tête `X-Boutique-Id`).

Les logiciels des boutiques sont des clients **machine à machine** : ils obtiennent un jeton avec le flux OAuth2 *client credentials*.

Toute la configuration Auth0 est **décrite en code avec Terraform** dans [`infra/terraform/auth0`](../infra/terraform/auth0/README.md). Plus besoin de cliquer dans la console, sauf une fois pour l'application qui autorise Terraform.

## Ce que Terraform crée

| Élément | Détail |
| --- | --- |
| API « API Surfwear B2B » | identifiant (audience) `https://api.surfwear.example`, RS256, jetons valables 24 h |
| 5 permissions | `read:catalogue`, `read:commandes`, `write:commandes`, `manage:webhooks`, `read:stats` |
| Une application par boutique | B001, B002, B003 (liste `boutiques` de `variables.tf`), avec `client_metadata.boutique_id` |
| Application des commerciaux | `read:catalogue` et `read:stats` |
| Autorisations (*client grants*) | chaque application sur l'API, avec ses permissions |
| Action *credentials-exchange* | ajoute le claim `boutique_id` au jeton à partir des métadonnées de l'application |

Le claim `boutique_id` n'a pas de namespace : Auth0 l'autorise pour une API à soi, et KrakenD le lit tel quel.

## 1. Créer le tenant et l'application « Terraform » (une seule fois)

1. Créez un compte gratuit sur auth0.com, puis un tenant.
2. **Applications > Applications > Create Application**, type **Machine to Machine**, nommée « Terraform », autorisée sur **Auth0 Management API**. La liste des permissions à cocher est dans [`infra/terraform/auth0/README.md`](../infra/terraform/auth0/README.md).
3. Copiez `infra/terraform/auth0/terraform.tfvars.example` en `terraform.tfvars` et renseignez le domaine, le Client ID et le secret de cette application.

## 2. Reprendre une configuration faite à la main (facultatif)

Si l'API et les applications des boutiques ont déjà été créées dans la console, Terraform les adopte au lieu de les recréer (mêmes Client ID) :

```bash
bash infra/terraform/auth0/decouvrir-existant.sh
```

## 3. Appliquer

```bash
cd infra/terraform/auth0
terraform init
terraform plan
terraform apply
cd ../../..
bash scripts/env-depuis-terraform.sh
```

Le dernier script recopie dans `.env` le domaine, l'audience, les Client ID et les secrets. Passez ensuite `AUTH_MODE=auth0` dans `.env` et relancez :

```bash
docker compose up -d
```

**Ajouter une boutique** : une ligne dans `boutiques` (`variables.tf`), puis `terraform apply` et `bash scripts/env-depuis-terraform.sh`.

## 4. Obtenir un jeton (tests, Swagger)

```bash
bash scripts/jeton.sh B001          # copie le jeton dans le presse-papiers
bash scripts/jeton.sh COMMERCIAL    # profil commercial
```

Collez-le dans le bouton **Authorize** de Swagger UI (http://localhost:8088), ou utilisez-le avec curl :

```bash
curl -H "Authorization: Bearer $(bash scripts/jeton.sh B001 --imprimer)" http://localhost:8080/api/v1/produits
```

Le jeton peut aussi être obtenu dans la console Auth0 (**APIs > API Surfwear B2B > Test**). Pour vérifier son contenu (`scope`, `boutique_id`, `aud`), décodez-le sur jwt.io.

## Mode démonstration (sans Auth0)

Avec `AUTH_MODE=dev` (valeur par défaut, utilisée par la CI), le conteneur `mock-oauth2` joue le rôle d'Auth0 : il délivre de vrais jetons signés, avec les mêmes permissions et le même claim `boutique_id` (`infra/mock-oauth2/config.json`). KrakenD les vérifie de la même façon. `scripts/jeton.sh` les obtient automatiquement.

## Évolution : responsables de boutique connectés à un portail web

Pour un futur portail web utilisé par des personnes, on utiliserait le flux *Authorization Code + PKCE* d'Auth0 : le `boutique_id` serait stocké dans l'`app_metadata` de l'utilisateur, une Action *post-login* l'ajouterait au jeton, et les permissions seraient attribuées par rôle (RBAC). La passerelle n'aurait pas à changer.
