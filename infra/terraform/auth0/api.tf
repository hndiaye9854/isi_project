# L'API Surfwear B2B et ses permissions, vérifiées par la passerelle KrakenD.
resource "auth0_resource_server" "api" {
  name                                            = "API Surfwear B2B"
  identifier                                      = var.audience
  signing_alg                                     = "RS256"
  token_lifetime                                  = 86400
  allow_offline_access                            = false
  skip_consent_for_verifiable_first_party_clients = true
  # Les permissions sont gérées à part, par auth0_resource_server_scopes.
}

locals {
  permissions = {
    "read:catalogue"  = "Consulter le catalogue et la disponibilité"
    "read:commandes"  = "Consulter ses commandes"
    "write:commandes" = "Passer des commandes"
    "manage:webhooks" = "Gérer ses abonnements aux événements"
    "read:stats"      = "Consulter les statistiques (commerciaux)"
  }
  permissions_boutique   = ["read:catalogue", "read:commandes", "write:commandes", "manage:webhooks"]
  permissions_commercial = ["read:catalogue", "read:stats"]
}

resource "auth0_resource_server_scopes" "api" {
  resource_server_identifier = auth0_resource_server.api.identifier

  dynamic "scopes" {
    for_each = local.permissions
    content {
      name        = scopes.key
      description = scopes.value
    }
  }
}
