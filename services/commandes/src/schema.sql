CREATE TABLE IF NOT EXISTS commandes (
  id UUID PRIMARY KEY,
  boutique_id TEXT NOT NULL,
  cle_idempotence TEXT NOT NULL,
  statut TEXT NOT NULL,
  reference_boutique TEXT,
  numero_bl TEXT,
  montant_total NUMERIC(12,2),
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (boutique_id, cle_idempotence)
);
CREATE TABLE IF NOT EXISTS lignes (
  commande_id UUID NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
  gtin TEXT NOT NULL,
  quantite INT NOT NULL CHECK (quantite > 0),
  quantite_stock INT,
  quantite_production INT,
  date_prevue DATE,
  quantite_non_couverte INT,
  quantite_expediee INT NOT NULL DEFAULT 0,
  prix_unitaire NUMERIC(10,2),
  PRIMARY KEY (commande_id, gtin)
);
-- Patron "transactional outbox" : l'événement est écrit dans la même transaction que la commande,
-- puis publié sur le bus par une tâche de fond. Aucun événement n'est perdu.
CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  publie BOOLEAN NOT NULL DEFAULT false,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_a_publier ON outbox (cree_le) WHERE NOT publie;
