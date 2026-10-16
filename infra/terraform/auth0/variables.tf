variable "auth0_domain" {
  description = "Domaine du tenant Auth0, sans https:// (ex. dev-xxxx.us.auth0.com)."
  type        = string
}

variable "terraform_client_id" {
  description = "Client ID de l'application « Terraform » autorisée sur la Management API (créée une fois à la main)."
  type        = string
}

variable "terraform_client_secret" {
  description = "Secret de l'application « Terraform »."
  type        = string
  sensitive   = true
}

variable "audience" {
  description = "Identifiant (audience) de l'API Surfwear. Ne peut plus changer une fois l'API créée."
  type        = string
  default     = "https://api.surfwear.example"
}

variable "boutiques" {
  description = "Boutiques clientes : une entrée par boutique. Ajouter une ligne crée son application Auth0."
  type = map(object({
    nom = string
  }))
  default = {
    B001 = { nom = "Boutique Biarritz" }
    B002 = { nom = "Boutique Hossegor" }
    B003 = { nom = "Boutique Lacanau" }
  }
}

# --- Reprise de l'existant (voir imports.tf) : renseignés par decouvrir-existant.sh ---

variable "import_api_id" {
  description = "Identifiant interne de l'API déjà créée à la main (null : rien à reprendre)."
  type        = string
  default     = null
}

variable "import_clients" {
  description = "Client ID des applications de boutique déjà créées, par code boutique (ex. { B001 = \"abc\" })."
  type        = map(string)
  default     = {}
}

variable "import_grants" {
  description = "Identifiant des autorisations (client grants) existantes, par code boutique."
  type        = map(string)
  default     = {}
}
