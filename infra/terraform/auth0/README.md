# Auth0 en Terraform

Toute la configuration Auth0 de la plateforme est décrite ici, au lieu d'être cliquée dans la console :

| Ressource | Rôle |
| --- | --- |
| `auth0_resource_server` + `auth0_resource_server_scopes` | API « Surfwear B2B » (variable `audience`, `https://api.surfwear.isi` par défaut) et ses 5 permissions |
| `auth0_client` (une par boutique) + `auth0_client_credentials` | Applications machine à machine des boutiques, avec `client_metadata.boutique_id` |
| `auth0_client_grant` | Autorisation de chaque application sur l'API, avec ses permissions |
| `auth0_client.commercial` | Application des commerciaux (`read:catalogue`, `read:stats`) |
| `auth0_action` + `auth0_trigger_actions` | Action *credentials-exchange* qui ajoute le claim `boutique_id` au jeton |
| `mcp.tf` | API « MCP Surfwear B2B » (variable `mcp_audience`, `https://mcp.surfwear.isi` par défaut), ses permissions et les autorisations des boutiques et du commercial |

Les audiences ne peuvent plus changer une fois les API créées : un tenant qui en utilise d'autres les indique dans `terraform.tfvars` (`audience`, `mcp_audience`).

**Ajouter une boutique** : une ligne dans `boutiques` (`variables.tf`), puis `terraform apply` et `bash scripts/env-depuis-terraform.sh`.

## Prérequis (une seule fois)

1. Terraform 1.7 ou plus récent (`brew install hashicorp/tap/terraform`), ou l'image Docker `hashicorp/terraform`.
2. Dans la console Auth0, créer l'application qui permet à Terraform d'agir : **Applications > Create Application > Machine to Machine**, nommée « Terraform », autorisée sur **Auth0 Management API** avec au moins :
   `read:clients create:clients update:clients delete:clients read:client_keys read:client_credentials create:client_credentials update:client_credentials read:resource_servers create:resource_servers update:resource_servers delete:resource_servers read:client_grants create:client_grants update:client_grants delete:client_grants read:actions create:actions update:actions delete:actions`.
   C'est la seule étape manuelle.
3. Copier `terraform.tfvars.example` en `terraform.tfvars` (ignoré par Git) et le compléter.

## Reprendre ce qui a été créé à la main

L'API et les applications des boutiques existent déjà dans le tenant. Pour que Terraform les adopte (mêmes Client ID) au lieu de les recréer :

```bash
bash infra/terraform/auth0/decouvrir-existant.sh
```

Le script interroge la Management API et écrit `imports.auto.tfvars.json` (identifiant de l'API, Client ID et autorisations de chaque boutique, retrouvés grâce à `AUTH0_CLIENT_BOUTIQUES` du `.env`). Les blocs de `imports.tf` s'en servent au prochain `plan`. Sans ce fichier, rien n'est importé.

## Appliquer

```bash
cd infra/terraform/auth0
terraform init
terraform plan      # vérifier : "import" pour l'existant, "create" pour le commercial et l'Action
terraform apply
cd ../../..
bash scripts/env-depuis-terraform.sh   # recopie Client ID et secrets dans .env
```

Puis passer `AUTH_MODE=auth0` dans `.env` et relancer `docker compose up -d`.

## État Terraform

`terraform.tfstate` contient les secrets des applications : il reste local et n'est jamais versionné (`.gitignore`). Pour travailler à plusieurs, utiliser un backend distant chiffré (par exemple HCP Terraform, gratuit pour une petite équipe).
