# Reprise des ressources créées à la main dans la console Auth0 : Terraform les adopte au lieu de les recréer
# (mêmes Client ID). Les identifiants sont fournis par decouvrir-existant.sh (imports.auto.tfvars.json).
# Sans ce fichier, les variables sont vides et rien n'est importé.

import {
  for_each = var.import_api_id == null ? toset([]) : toset([var.import_api_id])
  to       = auth0_resource_server.api
  id       = each.value
}

# Les permissions d'une API existante doivent être importées (le provider refuse de les créer par-dessus).
import {
  for_each = var.import_api_id == null ? toset([]) : toset([var.audience])
  to       = auth0_resource_server_scopes.api
  id       = each.value
}

import {
  for_each = var.import_clients
  to       = auth0_client.boutique[each.key]
  id       = each.value
}

import {
  for_each = var.import_clients
  to       = auth0_client_credentials.boutique[each.key]
  id       = each.value
}

import {
  for_each = var.import_grants
  to       = auth0_client_grant.boutique[each.key]
  id       = each.value
}
