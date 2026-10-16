#!/usr/bin/env bash
# Démonstration commentée du prototype (à lancer après docker compose up -d).
set -euo pipefail
GW=http://localhost:8080; ERP=http://localhost:8090
TOKEN_B1=${TOKEN_B1:-$(bash "$(dirname "$0")/jeton.sh" B001 --imprimer)}
pause() { echo; read -rp "Appuyez sur Entrée pour continuer..." _; echo; }
titre() { echo; echo "=== $1 ==="; }

titre "1. Le responsable de la boutique de Biarritz consulte la disponibilité du wax (24h/24)"
curl -s -H "Authorization: Bearer $TOKEN_B1" "$GW/api/v1/disponibilites/3760123450097?quantite=4" | jq
pause

titre "2. Trois boutiques commandent 4 wax en même temps (il n'y en a que 5 en stock)"
for p in 7001 7002 7003; do
  curl -s -X POST localhost:$p/commander -H 'Content-Type: application/json' \
    -d '{"lignes":[{"gtin":"3760123450097","quantite":4}]}' > /tmp/demo_$p.json &
done; wait
for p in 7001 7002 7003; do
  jq -r '"\(.boutique_id) : \(.statut), \(.lignes[0].quantite_stock) en stock, \(.lignes[0].quantite_production) en production pour le \(.lignes[0].date_prevue // "-")"' /tmp/demo_$p.json
done
echo "-> Le stock est réservé dans l'ERP au moment de la commande : aucune double réservation."
pause

# On expédie la commande d'une boutique qui a obtenu du stock.
port=""; for p in 7001 7002 7003; do [ "$(jq '.lignes[0].quantite_stock' /tmp/demo_$p.json)" -gt 0 ] && { port=$p; break; }; done
if [ -z "$port" ]; then echo "Plus de wax en stock : relancez avec une base neuve (docker compose down -v && docker compose up -d)."; exit 0; fi
titre "3. Le logisticien prépare le colis de $(jq -r .boutique_id /tmp/demo_$port.json) et valide l'expédition dans l'ERP"
cmd=$(jq -r .id /tmp/demo_$port.json)
curl -s -X POST "$ERP/expeditions" -H 'Content-Type: application/json' -d "{\"commande_id\":\"$cmd\"}" | jq
sleep 3
titre "4. Le logiciel de la boutique a reçu le bon de livraison par webhook"
curl -s localhost:$port/etat | jq '{stock_local, derniers_evenements: [.evenements[] | .type]}'
echo "-> Plus de ressaisie : le stock local est mis à jour automatiquement. Mails visibles sur http://localhost:8025"
pause

titre "5. Le commercial consulte les références en tension pour anticiper la production"
curl -s -H "Authorization: Bearer ${TOKEN_COMMERCIAL:-$(bash "$(dirname "$0")/jeton.sh" COMMERCIAL --imprimer)}" "$GW/api/v1/stats/tensions" | jq
