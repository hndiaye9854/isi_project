// Jeu de données de démonstration : articles de surfwear, stock et production en cours.
const ARTICLES = [
  ['3760123450011', 'TS-LOGO-M-BLC', 'T-shirt logo vague', 'T-shirts', 'M', 'Blanc', 14.5, 120, [[200, 21]]],
  ['3760123450028', 'TS-LOGO-L-BLC', 'T-shirt logo vague', 'T-shirts', 'L', 'Blanc', 14.5, 80, [[150, 21]]],
  ['3760123450035', 'SW-HOOD-M-NAV', 'Sweat à capuche Hossegor', 'Sweats', 'M', 'Marine', 32.0, 40, [[60, 28]]],
  ['3760123450042', 'SW-HOOD-L-NAV', 'Sweat à capuche Hossegor', 'Sweats', 'L', 'Marine', 32.0, 12, [[60, 28]]],
  ['3760123450059', 'BS-PRO-32-TUR', 'Boardshort Pro', 'Boardshorts', '32', 'Turquoise', 27.0, 25, [[100, 35]]],
  ['3760123450066', 'BS-PRO-34-TUR', 'Boardshort Pro', 'Boardshorts', '34', 'Turquoise', 27.0, 6, [[100, 35]]],
  ['3760123450073', 'LY-SPRING-M', 'Lycra anti-UV manches longues', 'Lycras', 'M', 'Noir', 21.0, 30, []],
  ['3760123450080', 'CS-BEANIE-UNI', 'Bonnet Côte Basque', 'Accessoires', 'TU', 'Gris', 9.0, 60, []],
  ['3760123450097', 'AC-WAX-TROP', 'Wax eau tropicale', 'Accessoires', 'TU', null, 2.5, 5, [[50, 14]]],
  ['3760123450103', 'AC-LEASH-7', 'Leash 7 pieds', 'Accessoires', '7ft', 'Noir', 18.0, 15, [[40, 21]]],
  ['3760123450110', 'CP-TRUCK-UNI', 'Casquette trucker', 'Accessoires', 'TU', 'Sable', 12.0, 0, [[80, 10]]],
  ['3760123450127', 'PO-WATERPROOF', 'Pochette étanche', 'Accessoires', 'TU', 'Jaune', 8.0, 0, []],
];

export async function seed(pool, logger) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM articles');
  if (rows[0].n > 0) return;
  for (const [gtin, ref, lib, cat, taille, couleur, prix, stock, prod] of ARTICLES) {
    await pool.query('INSERT INTO articles VALUES ($1,$2,$3,$4,$5,$6,$7)', [gtin, ref, lib, cat, taille, couleur, prix]);
    await pool.query('INSERT INTO stock (gtin, quantite_physique) VALUES ($1,$2)', [gtin, stock]);
    for (const [q, jours] of prod) {
      await pool.query('INSERT INTO production (gtin, quantite, date_prevue) VALUES ($1,$2, CURRENT_DATE + $3::int)', [gtin, q, jours]);
    }
  }
  logger.info({ articles: ARTICLES.length }, 'Données de démonstration chargées dans l\'ERP');
}
