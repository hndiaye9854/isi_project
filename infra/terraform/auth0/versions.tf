terraform {
  # 1.7+ : blocs import avec for_each (reprise des ressources créées à la main).
  required_version = ">= 1.7"

  required_providers {
    auth0 = {
      source = "auth0/auth0"
      # Les versions antérieures à 1.29 ne fonctionnent plus depuis juillet 2026.
      version = "~> 1.59"
    }
  }
}

provider "auth0" {
  domain        = var.auth0_domain
  client_id     = var.terraform_client_id
  client_secret = var.terraform_client_secret
  # Explicite : sinon le provider lit AUTH0_AUDIENCE dans l'environnement, qui désigne notre API (via le .env)
  # et non la Management API d'Auth0.
  audience = "https://${var.auth0_domain}/api/v2/"
}
