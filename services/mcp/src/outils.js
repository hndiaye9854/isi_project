import { randomUUID } from 'node:crypto';
import { requireScopes } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

/**
 * Outils, ressource et prompt exposés aux assistants IA.
 * Chaque outil appelle un service interne avec l'identité posée par la passerelle (X-Boutique-Id), comme le ferait
 * l'API REST, et exige la même permission Auth0 que la route REST correspondante.
 */

const gtin = z.string().regex(/^\d{8,14}$/).describe('Code article GTIN (EAN-13, standard GS1), ex. 3760123450097');
const lignes = z.array(z.object({
  gtin,
  quantite: z.number().int().positive().max(10000).describe('Nombre de pièces'),
})).min(1).max(50);

const texte = (donnees) => ({ content: [{ type: 'text', text: JSON.stringify(donnees, null, 2) }] });
const erreur = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

// Un appel en échec (stock épuisé, commande introuvable...) devient un résultat d'erreur lisible par l'assistant.
const proteger = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return erreur(err.message || 'Erreur inattendue');
  }
};

function resumeArticle(a) {
  const d = a.disponibilite || {};
  return {
    gtin: a.gtin, reference: a.reference, libelle: a.libelle, categorie: a.categorie, taille: a.taille, couleur: a.couleur,
    prix_unitaire_ht: a.prix_unitaire, stock_disponible: d.stock_disponible, stock_potentiel: d.stock_potentiel,
    prochaine_livraison: d.prochaine_livraison,
  };
}

/**
 * @param {import('@modelcontextprotocol/server').McpServer} serveur
 * @param {{ appel: Function, urls: Record<string, string>, boutique: string | null, permissions: string[] }} contexte
 */
export function enregistrer(serveur, { appel, urls, boutique, permissions }) {
  const autorise = (p) => permissions.includes(p);
  const exigerBoutique = () => {
    if (!boutique) throw new Error('Ce profil n\'est rattaché à aucune boutique : action réservée aux boutiques.');
  };

  if (autorise('read:catalogue')) {
    serveur.registerTool('rechercher_produits', {
      title: 'Rechercher dans le catalogue',
      description: 'Liste les articles du catalogue Surfwear avec leur prix et leur disponibilité (stock réel et production à venir). '
        + 'Filtre facultatif par catégorie (T-shirts, Sweats, Boardshorts, Lycras, Accessoires) ou par texte (libellé, référence, taille, couleur).',
      inputSchema: z.object({
        categorie: z.string().optional().describe('Catégorie exacte, ex. Boardshorts'),
        texte: z.string().optional().describe('Texte à chercher, ex. "boardshort 34" ou "wax"'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('read:catalogue'),
    }, proteger(async ({ categorie, texte: recherche }) => {
      const produits = await appel(`${urls.catalogue}/produits${categorie ? `?categorie=${encodeURIComponent(categorie)}` : ''}`);
      const mots = (recherche || '').toLowerCase().split(/\s+/).filter(Boolean);
      const retenus = produits.filter((p) => {
        const fiche = [p.libelle, p.reference, p.taille, p.couleur, p.categorie].join(' ').toLowerCase();
        return mots.every((m) => fiche.includes(m));
      });
      return texte({ nombre: retenus.length, articles: retenus.map(resumeArticle) });
    }));

    serveur.registerTool('verifier_disponibilite', {
      title: 'Vérifier la disponibilité d\'un article',
      description: 'Pour une quantité donnée, indique ce qui est livrable tout de suite (stock réel), ce qui le sera plus tard '
        + '(production en cours, avec la date prévue) et ce qui n\'est pas disponible. Ne réserve rien.',
      inputSchema: z.object({ gtin, quantite: z.number().int().positive().max(10000).default(1) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('read:catalogue'),
    }, proteger(async ({ gtin: code, quantite }) => texte(await appel(`${urls.catalogue}/disponibilites/${code}?quantite=${quantite}`))));

    serveur.registerTool('preparer_commande', {
      title: 'Préparer une commande (simulation)',
      description: 'Simule une commande sans rien réserver : pour chaque ligne, disponibilité immédiate, livraisons futures et montant estimé. '
        + 'À utiliser avant passer_commande pour montrer le résultat à l\'utilisateur et obtenir son accord.',
      inputSchema: z.object({ lignes }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('read:catalogue'),
    }, proteger(async ({ lignes: demande }) => {
      const resultat = [];
      let montant = 0;
      for (const { gtin: code, quantite } of demande) {
        const [article, dispo] = await Promise.all([
          appel(`${urls.catalogue}/produits/${code}`),
          appel(`${urls.catalogue}/disponibilites/${code}?quantite=${quantite}`),
        ]);
        const plusTard = dispo.livrable_plus_tard.reduce((t, l) => t + l.quantite, 0);
        const ligne = (dispo.livrable_immediatement + plusTard) * (article.prix_unitaire || 0);
        montant += ligne;
        resultat.push({
          gtin: code, reference: article.reference, libelle: article.libelle, quantite_demandee: quantite,
          livrable_immediatement: dispo.livrable_immediatement, livrable_plus_tard: dispo.livrable_plus_tard,
          non_disponible: dispo.non_disponible, montant_estime_ht: Math.round(ligne * 100) / 100,
        });
      }
      return texte({ simulation: true, lignes: resultat, montant_estime_ht: Math.round(montant * 100) / 100 });
    }));

    serveur.registerResource('catalogue', 'surfwear://catalogue', {
      title: 'Catalogue Surfwear',
      description: 'Tous les articles avec prix et disponibilité',
      mimeType: 'application/json',
    }, async (uri) => {
      const produits = await appel(`${urls.catalogue}/produits`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(produits.map(resumeArticle), null, 2) }] };
    });
  }

  if (autorise('write:commandes')) {
    serveur.registerTool('passer_commande', {
      title: 'Passer une commande',
      description: 'Passe une commande ferme pour la boutique : le stock est réservé immédiatement dans l\'ERP. '
        + 'Demander toujours la confirmation explicite de l\'utilisateur avant d\'appeler cet outil (après preparer_commande). '
        + 'La même cle_idempotence renvoie la même commande sans doublon.',
      inputSchema: z.object({
        lignes,
        reference_boutique: z.string().max(64).optional().describe('Référence interne de la boutique, ex. BIA-0412'),
        cle_idempotence: z.string().max(100).optional().describe('Identifiant unique de la demande (généré si absent)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('write:commandes'),
    }, proteger(async ({ lignes: demande, reference_boutique, cle_idempotence }) => {
      exigerBoutique();
      const commande = await appel(`${urls.commandes}/commandes`, {
        method: 'POST',
        timeoutMs: 8000,
        headers: { 'Idempotency-Key': cle_idempotence || randomUUID() },
        body: { lignes: demande, ...(reference_boutique ? { reference_boutique } : {}) },
      });
      return texte(commande);
    }));
  }

  if (autorise('read:commandes')) {
    serveur.registerTool('lister_commandes', {
      title: 'Lister les commandes de la boutique',
      description: 'Les 100 dernières commandes de la boutique, filtrables par statut '
        + '(RECUE, EN_ATTENTE_ERP, RESERVEE, RESERVEE_PARTIELLEMENT, EXPEDIEE_PARTIELLEMENT, EXPEDIEE).',
      inputSchema: z.object({ statut: z.string().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('read:commandes'),
    }, proteger(async ({ statut }) => {
      exigerBoutique();
      const commandes = await appel(`${urls.commandes}/commandes${statut ? `?statut=${encodeURIComponent(statut)}` : ''}`);
      return texte(commandes.map((c) => ({
        id: c.id, statut: c.statut, reference_boutique: c.reference_boutique, montant_total: c.montant_total,
        numero_bl: c.numero_bl, cree_le: c.cree_le, lignes: c.lignes.length,
      })));
    }));

    serveur.registerTool('suivre_commande', {
      title: 'Suivre une commande',
      description: 'Détail d\'une commande : statut, lignes réservées sur stock ou sur production (avec date prévue), bon de livraison.',
      inputSchema: z.object({ id: z.string().uuid().describe('Identifiant de la commande') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('read:commandes'),
    }, proteger(async ({ id }) => {
      exigerBoutique();
      return texte(await appel(`${urls.commandes}/commandes/${id}`));
    }));
  }

  if (autorise('read:stats')) {
    serveur.registerTool('references_en_tension', {
      title: 'Références en tension',
      description: 'Pour les commerciaux : références dont la demande dépasse le stock (pièces en attente de production ou non couvertes), '
        + 'pour anticiper la production.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: requireScopes('read:stats'),
    }, proteger(async () => {
      const [tensions, produits] = await Promise.all([
        appel(`${urls.analytics}/stats/tensions`),
        autorise('read:catalogue') ? appel(`${urls.catalogue}/produits`) : Promise.resolve([]),
      ]);
      const parGtin = Object.fromEntries(produits.map((p) => [p.gtin, p]));
      return texte(tensions.map((t) => ({ ...t, reference: parGtin[t.gtin]?.reference, libelle: parGtin[t.gtin]?.libelle })));
    }));
  }

  if (autorise('read:catalogue') && autorise('write:commandes')) {
    serveur.registerPrompt('reassort_hebdomadaire', {
      title: 'Préparer le réassort de la semaine',
      description: 'Guide l\'assistant pour proposer une commande de réassort et la passer après accord',
      argsSchema: z.object({
        besoins: z.string().describe('Ce dont la boutique a besoin, ex. "boardshorts tailles 32 et 34, wax pour le week-end"'),
      }),
    }, ({ besoins }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Je gère une boutique cliente de Surfwear. Besoins de la semaine : ${besoins}.\n`
            + '1. Trouve les articles correspondants avec rechercher_produits.\n'
            + '2. Propose des quantités et lance preparer_commande pour me montrer ce qui est livrable tout de suite, plus tard (avec la date) ou pas du tout, et le montant.\n'
            + '3. Attends ma confirmation explicite avant d\'appeler passer_commande.',
        },
      }],
    }));
  }
}
