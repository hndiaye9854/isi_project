output "auth0_domain" {
  value = var.auth0_domain
}

output "audience" {
  value = auth0_resource_server.api.identifier
}

output "boutiques_client_id" {
  description = "Client ID de chaque boutique."
  value       = { for code, c in auth0_client.boutique : code => c.client_id }
}

output "boutiques_client_secret" {
  description = "Secret de chaque boutique (terraform output -json pour le lire)."
  value       = { for code, c in auth0_client_credentials.boutique : code => c.client_secret }
  sensitive   = true
}

output "commercial_client_id" {
  value = auth0_client.commercial.client_id
}

output "commercial_client_secret" {
  value     = auth0_client_credentials.commercial.client_secret
  sensitive = true
}
