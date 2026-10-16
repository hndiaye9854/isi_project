// Test de bout en bout du serveur MCP, avec le client MCP officiel (comme le ferait un assistant IA).
// Usage : node scripts/mcp-test.mjs   (après docker compose up -d ; jetons via scripts/jeton.sh, AUTH_MODE dev par défaut)
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const PASSERELLE = process.env.GATEWAY || 'http://localhost:8080';
const URL_MCP = new URL('/mcp', PASSERELLE);
let ok = 0;
let ko = 0;
const verifier = (nom, obtenu, attendu) => {
  if (obtenu === attendu) { ok++; console.log(`  OK  ${nom}`); } else { ko++; console.log(`  KO  ${nom} (attendu : ${attendu}, obtenu : ${obtenu})`); }
};

const jeton = (qui) => execFileSync('bash', [new URL('./jeton.sh', import.meta.url).pathname, qui, '--imprimer', '--mcp'], {
  env: { ...process.env, AUTH_MODE: process.env.AUTH_MODE || 'dev' },
}).toString().trim();

// Mode de négociation du client : 'legacy' (protocole 2025) ou 'auto' (protocole 2026-07-28 si le serveur le parle).
let mode = 'legacy';
async function connecter(qui) {
  const client = new Client({ name: 'test-surfwear', version: '1.0.0' }, { versionNegotiation: { mode } });
  const headers = qui ? { Authorization: `Bearer ${jeton(qui)}` } : {};
  await client.connect(new StreamableHTTPClientTransport(URL_MCP, { requestInit: { headers } }));
  return client;
}
const lire = (resultat) => JSON.parse(resultat.content[0].text);

for (mode of ['legacy', 'auto']) {
  console.log(`\n=== Client MCP en mode ${mode} ===`);
  console.log('1. Découverte et sécurité');
  const meta = await (await fetch(new URL('/.well-known/oauth-protected-resource/mcp', PASSERELLE))).json();
  verifier('métadonnées OAuth publiques (RFC 9728)', meta.resource, URL_MCP.href);
  let refuse = false;
  try { await (await connecter(null)).listTools(); } catch { refuse = true; }
  verifier('connexion sans jeton refusée', refuse, true);

  console.log('2. Boutique B001');
  const b1 = await connecter('B001');
  console.log(`     serveur : ${b1.getServerVersion()?.title}`);
  const outilsB1 = (await b1.listTools()).tools.map((t) => t.name);
  verifier('outil passer_commande proposé à une boutique', outilsB1.includes('passer_commande'), true);
  verifier('outil references_en_tension caché à une boutique', outilsB1.includes('references_en_tension'), false);
  const catalogue = await b1.readResource({ uri: 'surfwear://catalogue' });
  verifier('ressource catalogue : 12 articles', JSON.parse(catalogue.contents[0].text).length, 12);
  verifier('prompt reassort_hebdomadaire disponible', (await b1.listPrompts()).prompts.some((p) => p.name === 'reassort_hebdomadaire'), true);
  const dispo = lire(await b1.callTool({ name: 'verifier_disponibilite', arguments: { gtin: '3760123450080', quantite: 1 } }));
  verifier('verifier_disponibilite répond', dispo.quantite_demandee, 1);

  const lignes = [{ gtin: '3760123450080', quantite: 1 }];
  const simulation = lire(await b1.callTool({ name: 'preparer_commande', arguments: { lignes } }));
  verifier('preparer_commande est une simulation', simulation.simulation, true);
  const cle = `mcp-test-${randomUUID()}`;
  const c1 = lire(await b1.callTool({ name: 'passer_commande', arguments: { lignes, cle_idempotence: cle } }));
  const c2 = lire(await b1.callTool({ name: 'passer_commande', arguments: { lignes, cle_idempotence: cle } }));
  verifier('passer_commande : commande de la boutique B001', c1.boutique_id, 'B001');
  verifier('même clé d\'idempotence = même commande', c2.id, c1.id);
  verifier('montant égal à la simulation', c1.montant_total, simulation.montant_estime_ht);
  verifier('suivre_commande', lire(await b1.callTool({ name: 'suivre_commande', arguments: { id: c1.id } })).id, c1.id);

  console.log('3. Cloisonnement et rôles');
  const b2 = await connecter('B002');
  const autre = await b2.callTool({ name: 'suivre_commande', arguments: { id: c1.id } });
  verifier('B002 ne voit pas la commande de B001', autre.isError, true);
  const commercial = await connecter('COMMERCIAL');
  const outilsCom = (await commercial.listTools()).tools.map((t) => t.name);
  verifier('outil passer_commande caché au commercial', outilsCom.includes('passer_commande'), false);
  const tensions = await commercial.callTool({ name: 'references_en_tension', arguments: {} });
  verifier('references_en_tension pour le commercial', Array.isArray(lire(tensions)), true);

  await Promise.all([b1.close(), b2.close(), commercial.close()]);
}
console.log(`\nRésultat MCP : ${ok} OK, ${ko} KO`);
process.exit(ko ? 1 : 0);
