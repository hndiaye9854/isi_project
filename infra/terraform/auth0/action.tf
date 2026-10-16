# Action « machine to machine » : ajoute la boutique de l'application dans le jeton (claim boutique_id).
# Claim sans namespace : autorisé par Auth0 pour une API à soi, et lisible tel quel par propagate_claims de KrakenD.
resource "auth0_action" "boutique_id" {
  name    = "Ajouter boutique_id au jeton"
  runtime = "node22"
  deploy  = true

  supported_triggers {
    id      = "credentials-exchange"
    version = "v2"
  }

  code = <<-JS
    exports.onExecuteCredentialsExchange = async (event, api) => {
      const boutique = event.client.metadata && event.client.metadata.boutique_id;
      if (boutique) {
        api.accessToken.setCustomClaim('boutique_id', boutique);
      }
    };
  JS
}

resource "auth0_trigger_actions" "credentials_exchange" {
  trigger = "credentials-exchange"

  actions {
    id           = auth0_action.boutique_id.id
    display_name = auth0_action.boutique_id.name
  }
}
