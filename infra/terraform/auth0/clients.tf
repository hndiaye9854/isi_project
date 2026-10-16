# Une application machine à machine par boutique (flux client credentials), et une pour les commerciaux.
resource "auth0_client" "boutique" {
  for_each = var.boutiques

  name        = "${each.value.nom} (${each.key})"
  description = "Logiciel de gestion de la boutique ${each.key}"
  app_type    = "non_interactive"
  grant_types = ["client_credentials"]

  # Lu par l'Action (action.tf) et ajouté au jeton : la passerelle en déduit la boutique.
  client_metadata = {
    boutique_id = each.key
  }
}

resource "auth0_client_credentials" "boutique" {
  for_each = var.boutiques

  client_id             = auth0_client.boutique[each.key].client_id
  authentication_method = "client_secret_post"
}

resource "auth0_client_grant" "boutique" {
  for_each = var.boutiques

  client_id = auth0_client.boutique[each.key].client_id
  audience  = auth0_resource_server.api.identifier
  scopes    = local.permissions_boutique

  depends_on = [auth0_resource_server_scopes.api]
}

resource "auth0_client" "commercial" {
  name        = "Commerciaux Surfwear"
  description = "Tableau de bord des commerciaux (statistiques)"
  app_type    = "non_interactive"
  grant_types = ["client_credentials"]
}

resource "auth0_client_credentials" "commercial" {
  client_id             = auth0_client.commercial.client_id
  authentication_method = "client_secret_post"
}

resource "auth0_client_grant" "commercial" {
  client_id = auth0_client.commercial.client_id
  audience  = auth0_resource_server.api.identifier
  scopes    = local.permissions_commercial

  depends_on = [auth0_resource_server_scopes.api]
}
