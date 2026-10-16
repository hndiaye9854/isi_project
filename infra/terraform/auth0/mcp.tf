# Serveur MCP (assistants IA) : une API Auth0 distincte, pour que les jetons des assistants soient liés au serveur MCP
# (exigence de la spécification MCP) et ne servent pas sur l'API REST, et inversement.
# Mêmes permissions que l'API REST ; chaque outil MCP exige celle de la route REST correspondante.

variable "mcp_audience" {
  description = "Identifiant (audience) de l'API du serveur MCP."
  type        = string
  default     = "https://mcp.surfwear.isi"
}

resource "auth0_resource_server" "mcp" {
  name                                            = "MCP Surfwear B2B (assistants IA)"
  identifier                                      = var.mcp_audience
  signing_alg                                     = "RS256"
  token_lifetime                                  = 86400
  allow_offline_access                            = false
  skip_consent_for_verifiable_first_party_clients = true
}

resource "auth0_resource_server_scopes" "mcp" {
  resource_server_identifier = auth0_resource_server.mcp.identifier

  dynamic "scopes" {
    for_each = local.permissions
    content {
      name        = scopes.key
      description = scopes.value
    }
  }
}

# Les applications existantes peuvent aussi obtenir un jeton pour le serveur MCP (assistant agissant pour elles).
resource "auth0_client_grant" "boutique_mcp" {
  for_each = var.boutiques

  client_id = auth0_client.boutique[each.key].client_id
  audience  = auth0_resource_server.mcp.identifier
  scopes    = local.permissions_boutique

  depends_on = [auth0_resource_server_scopes.mcp]
}

resource "auth0_client_grant" "commercial_mcp" {
  client_id = auth0_client.commercial.client_id
  audience  = auth0_resource_server.mcp.identifier
  scopes    = local.permissions_commercial

  depends_on = [auth0_resource_server_scopes.mcp]
}

output "mcp_audience" {
  value = auth0_resource_server.mcp.identifier
}
