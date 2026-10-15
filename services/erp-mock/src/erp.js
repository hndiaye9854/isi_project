import { tx, HttpError } from '@surfwear/common';

/** Photographie du stock d'un article : réel, réservé, disponible et potentiel (production). */
export async function snapshot(db, gtin) {
  const { rows: [s] } = await db.query(
    `SELECT a.gtin, a.reference, a.libelle, s.quantite_physique, s.quantite_reservee
       FROM articles a JOIN stock s USING (gtin) WHERE a.gtin = $1`, [gtin]);
  if (!s) return null;
  const { rows: prod } = await db.query(
    `SELECT id AS lot, quantite - quantite_reservee AS quantite_disponible, to_char(date_prevue, 'YYYY-MM-DD') AS date_prevue
       FROM production WHERE gtin = $1 AND statut = 'EN_COURS' ORDER BY date_prevue`, [gtin]);
  return {
    gtin: s.gtin,
    reference: s.reference,
    stock_physique: s.quantite_physique,
    stock_reserve: s.quantite_reservee,
    stock_disponible: s.quantite_physique - s.quantite_reservee,
    stock_potentiel: prod.filter((p) => p.quantite_disponible > 0),
  };
}

/**
 * Écrit les changements d'une transaction dans le journal lu par le connecteur ERP.
 *
 * Le connecteur mémorise le dernier numéro lu (seq) et ne relit que les numéros supérieurs. Or un numéro est attribué
 * à l'insertion, pas à la validation : si la transaction A obtient 10, puis B obtient 11 et valide la première,
 * le connecteur lit 11 et ne verra jamais 10. Le verrou global, gardé jusqu'au COMMIT, garantit que les numéros
 * suivent l'ordre des validations.
 * À appeler une seule fois, en toute fin de transaction : le verrou est pris après les verrous de lignes et
 * son détenteur n'en demande plus aucun, il ne peut donc pas y avoir d'interblocage.
 */
const VERROU_JOURNAL = 4242;

async function journaliser(db, changements) {
  if (!changements.length) return;
  await db.query('SELECT pg_advisory_xact_lock($1)', [VERROU_JOURNAL]);
  for (const [type, payload] of changements) {
    await db.query('INSERT INTO changements (type, payload) VALUES ($1, $2)', [type, payload]);
  }
}

const stockMaj = async (db, gtins) => {
  const out = [];
  for (const gtin of new Set(gtins)) out.push(['STOCK_MAJ', await snapshot(db, gtin)]);
  return out;
};

async function detailCommande(db, commandeId) {
  const { rows } = await db.query(
    `SELECT r.gtin, r.quantite, r.source, to_char(p.date_prevue, 'YYYY-MM-DD') AS date_prevue, a.prix_unitaire
       FROM reservations r JOIN articles a USING (gtin) LEFT JOIN production p ON p.id = r.production_id
      WHERE r.commande_id = $1 AND r.statut <> 'ANNULEE' ORDER BY r.id`, [commandeId]);
  return rows;
}

function regrouper(lignes, detail) {
  return lignes.map(({ gtin, quantite }) => {
    const d = detail.filter((r) => r.gtin === gtin);
    const stock = d.filter((r) => r.source === 'STOCK').reduce((t, r) => t + r.quantite, 0);
    const production = d.filter((r) => r.source === 'PRODUCTION').map((r) => ({ quantite: r.quantite, date_prevue: r.date_prevue }));
    const prod = production.reduce((t, p) => t + p.quantite, 0);
    return {
      gtin,
      quantite_demandee: quantite,
      quantite_stock: stock,
      production,
      quantite_non_couverte: Math.max(0, quantite - stock - prod),
      prix_unitaire: Number(d[0]?.prix_unitaire || 0),
    };
  });
}

/**
 * Réservation transactionnelle du stock pour une commande.
 * Les lignes de stock sont verrouillées (SELECT ... FOR UPDATE) : deux commandes simultanées
 * ne peuvent plus réserver les mêmes articles. C'est la réponse au problème P2.
 */
export async function reserver(pool, { commande_id, boutique_id, lignes }) {
  return tx(pool, async (db) => {
    const inserted = await db.query(
      'INSERT INTO commandes_erp (commande_id, boutique_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING commande_id',
      [commande_id, boutique_id]);
    if (inserted.rowCount === 0) {
      // Idempotence : la commande a déjà été réservée, on renvoie le résultat existant.
      return { commande_id, deja_traitee: true, lignes: regrouper(lignes, await detailCommande(db, commande_id)) };
    }
    const resultat = [];
    const modifies = [];
    // Tri par GTIN pour toujours verrouiller dans le même ordre (évite les interblocages).
    const triees = [...lignes].sort((a, b) => a.gtin.localeCompare(b.gtin));
    for (const { gtin, quantite } of triees) {
      const { rows: [s] } = await db.query(
        'SELECT s.*, a.prix_unitaire FROM stock s JOIN articles a USING (gtin) WHERE gtin = $1 FOR UPDATE OF s', [gtin]);
      if (!s) {
        resultat.push({ gtin, quantite_demandee: quantite, quantite_stock: 0, production: [], quantite_non_couverte: quantite, inconnu: true });
        continue;
      }
      let reste = quantite;
      const qStock = Math.min(reste, s.quantite_physique - s.quantite_reservee);
      if (qStock > 0) {
        await db.query('UPDATE stock SET quantite_reservee = quantite_reservee + $2 WHERE gtin = $1', [gtin, qStock]);
        await db.query(`INSERT INTO reservations (commande_id, gtin, quantite, source) VALUES ($1,$2,$3,'STOCK')`, [commande_id, gtin, qStock]);
        reste -= qStock;
      }
      const production = [];
      if (reste > 0) {
        const { rows: lots } = await db.query(
          `SELECT * FROM production WHERE gtin = $1 AND statut = 'EN_COURS' AND quantite > quantite_reservee
            ORDER BY date_prevue FOR UPDATE`, [gtin]);
        for (const lot of lots) {
          if (reste === 0) break;
          const q = Math.min(reste, lot.quantite - lot.quantite_reservee);
          await db.query('UPDATE production SET quantite_reservee = quantite_reservee + $2 WHERE id = $1', [lot.id, q]);
          await db.query(
            `INSERT INTO reservations (commande_id, gtin, quantite, source, production_id) VALUES ($1,$2,$3,'PRODUCTION',$4)`,
            [commande_id, gtin, q, lot.id]);
          production.push({ quantite: q, date_prevue: toDate(lot.date_prevue) });
          reste -= q;
        }
      }
      resultat.push({
        gtin,
        quantite_demandee: quantite,
        quantite_stock: qStock,
        production,
        quantite_non_couverte: reste,
        prix_unitaire: Number(s.prix_unitaire),
      });
      modifies.push(gtin);
    }
    await journaliser(db, await stockMaj(db, modifies));
    return { commande_id, deja_traitee: false, lignes: resultat };
  });
}

function toDate(d) {
  // Date SQL lue en heure locale : on la reformate sans décalage de fuseau.
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Le logisticien valide l'expédition des articles réservés en stock. */
export async function expedier(pool, commandeId) {
  return tx(pool, async (db) => {
    const { rows: [cmd] } = await db.query('SELECT * FROM commandes_erp WHERE commande_id = $1', [commandeId]);
    if (!cmd) throw new HttpError(404, 'Commande inconnue dans l\'ERP');
    const { rows: res } = await db.query(
      `SELECT * FROM reservations WHERE commande_id = $1 AND statut = 'RESERVEE' AND source = 'STOCK' ORDER BY gtin FOR UPDATE`, [commandeId]);
    if (res.length === 0) throw new HttpError(409, 'Aucun article en stock à expédier pour cette commande');
    const lignes = {};
    for (const r of res) {
      await db.query(
        'UPDATE stock SET quantite_physique = quantite_physique - $2, quantite_reservee = quantite_reservee - $2 WHERE gtin = $1',
        [r.gtin, r.quantite]);
      await db.query(`UPDATE reservations SET statut = 'EXPEDIEE' WHERE id = $1`, [r.id]);
      lignes[r.gtin] = (lignes[r.gtin] || 0) + r.quantite;
    }
    const { rows: [{ n }] } = await db.query(`SELECT nextval('bl_seq') AS n`);
    const numeroBl = `BL-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
    await db.query('INSERT INTO expeditions (numero_bl, commande_id) VALUES ($1,$2)', [numeroBl, commandeId]);
    const { rows: restants } = await db.query(
      `SELECT r.gtin, r.quantite, to_char(p.date_prevue, 'YYYY-MM-DD') AS date_prevue
         FROM reservations r JOIN production p ON p.id = r.production_id
        WHERE r.commande_id = $1 AND r.statut = 'RESERVEE'`, [commandeId]);
    const expedition = {
      commande_id: commandeId,
      boutique_id: cmd.boutique_id,
      numero_bl: numeroBl,
      lignes: Object.entries(lignes).map(([gtin, quantite]) => ({ gtin, quantite })),
      reste_a_livrer: restants,
    };
    await journaliser(db, [['EXPEDITION', expedition], ...await stockMaj(db, Object.keys(lignes))]);
    return expedition;
  });
}

/** Réception d'un lot de production à l'entrepôt : le stock potentiel devient du stock réel. */
export async function receptionner(pool, lotId) {
  return tx(pool, async (db) => {
    const { rows: [lot] } = await db.query(`SELECT * FROM production WHERE id = $1 AND statut = 'EN_COURS' FOR UPDATE`, [lotId]);
    if (!lot) throw new HttpError(404, 'Lot de production introuvable ou déjà réceptionné');
    await db.query('SELECT 1 FROM stock WHERE gtin = $1 FOR UPDATE', [lot.gtin]);
    await db.query(
      'UPDATE stock SET quantite_physique = quantite_physique + $2, quantite_reservee = quantite_reservee + $3 WHERE gtin = $1',
      [lot.gtin, lot.quantite, lot.quantite_reservee]);
    await db.query(`UPDATE reservations SET source = 'STOCK', production_id = NULL WHERE production_id = $1 AND statut = 'RESERVEE'`, [lotId]);
    await db.query(`UPDATE production SET statut = 'RECU' WHERE id = $1`, [lotId]);
    const snap = await snapshot(db, lot.gtin);
    await journaliser(db, [['STOCK_MAJ', snap]]);
    return snap;
  });
}
