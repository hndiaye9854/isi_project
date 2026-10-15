CREATE TABLE IF NOT EXISTS articles (
  gtin TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  libelle TEXT NOT NULL,
  categorie TEXT NOT NULL,
  taille TEXT,
  couleur TEXT,
  prix_unitaire NUMERIC(10,2) NOT NULL
);
CREATE TABLE IF NOT EXISTS stock (
  gtin TEXT PRIMARY KEY REFERENCES articles(gtin),
  quantite_physique INT NOT NULL CHECK (quantite_physique >= 0),
  quantite_reservee INT NOT NULL DEFAULT 0 CHECK (quantite_reservee >= 0),
  CHECK (quantite_reservee <= quantite_physique)
);
CREATE TABLE IF NOT EXISTS production (
  id SERIAL PRIMARY KEY,
  gtin TEXT NOT NULL REFERENCES articles(gtin),
  quantite INT NOT NULL CHECK (quantite > 0),
  quantite_reservee INT NOT NULL DEFAULT 0,
  date_prevue DATE NOT NULL,
  statut TEXT NOT NULL DEFAULT 'EN_COURS',
  CHECK (quantite_reservee <= quantite)
);
CREATE TABLE IF NOT EXISTS commandes_erp (
  commande_id TEXT PRIMARY KEY,
  boutique_id TEXT NOT NULL,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  commande_id TEXT NOT NULL REFERENCES commandes_erp(commande_id),
  gtin TEXT NOT NULL REFERENCES articles(gtin),
  quantite INT NOT NULL CHECK (quantite > 0),
  source TEXT NOT NULL,
  production_id INT REFERENCES production(id),
  statut TEXT NOT NULL DEFAULT 'RESERVEE'
);
CREATE TABLE IF NOT EXISTS expeditions (
  numero_bl TEXT PRIMARY KEY,
  commande_id TEXT NOT NULL REFERENCES commandes_erp(commande_id),
  expediee_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS bl_seq;
-- Journal des changements, lu par le connecteur ERP (simulation d'une capture de changements)
CREATE TABLE IF NOT EXISTS changements (
  seq BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
