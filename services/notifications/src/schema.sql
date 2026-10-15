CREATE TABLE IF NOT EXISTS abonnements (
  id UUID PRIMARY KEY,
  boutique_id TEXT NOT NULL,
  url TEXT NOT NULL,
  evenements TEXT[] NOT NULL,
  secret TEXT NOT NULL,
  actif BOOLEAN NOT NULL DEFAULT true,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (boutique_id, url)
);
CREATE TABLE IF NOT EXISTS livraisons (
  id BIGSERIAL PRIMARY KEY,
  abonnement_id UUID REFERENCES abonnements(id) ON DELETE CASCADE,
  evenement_id TEXT NOT NULL,
  type TEXT NOT NULL,
  statut TEXT NOT NULL,
  tentatives INT NOT NULL,
  code_http INT,
  erreur TEXT,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (abonnement_id, evenement_id)
);
