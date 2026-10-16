#!/usr/bin/env bash
# Test de bout en bout de l'écosystème (jetons du faux fournisseur mock-oauth2, AUTH_MODE=dev).
# Usage : bash scripts/smoke-test.sh   (après docker compose up -d)
set -euo pipefail
GW=${GATEWAY:-http://localhost:8080}
ERP=${ERP:-http://localhost:8090}
B1=${BOUTIQUE_1:-http://localhost:7001}
ok=0; ko=0
JETON() { AUTH_MODE=${AUTH_MODE:-dev} bash "$(dirname "$0")/jeton.sh" "$1" --imprimer; }
verifier() { if [ "$2" = "$3" ]; then echo "  OK  $1"; ok=$((ok+1)); else echo "  KO  $1 (attendu : $3, obtenu : $2)"; ko=$((ko+1)); fi; }

echo "Attente de la plateforme..."
for i in $(seq 1 60); do curl -sf "$GW/__health" >/dev/null && break; sleep 2; done
for i in $(seq 1 30); do T_B1=$(JETON B001 2>/dev/null) && break; sleep 2; done
T_B2=$(JETON B002); T_B3=$(JETON B003); T_COM=$(JETON COMMERCIAL)
for i in $(seq 1 30); do [ "$(curl -s -H "Authorization: Bearer $T_B1" "$GW/api/v1/produits" | jq 'length' 2>/dev/null || echo 0)" -gt 0 ] && break; sleep 2; done

echo "1. Sécurité"
verifier "requête sans jeton refusée" "$(curl -s -o /dev/null -w '%{http_code}' "$GW/api/v1/produits")" 401
verifier "commercial ne peut pas commander" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $T_COM" "$GW/api/v1/commandes")" 403
verifier "boutique sans accès aux statistiques" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_B1" "$GW/api/v1/stats/boutiques")" 403

echo "2. Catalogue"
verifier "12 articles au catalogue" "$(curl -s -H "Authorization: Bearer $T_B1" "$GW/api/v1/produits" | jq 'length')" 12

echo "3. Réservation sans doublon (3 commandes simultanées de 6 boardshorts taille 34, stock = 6)"
GTIN=3760123450066
avant=$(curl -s "$ERP/stock/$GTIN" | jq '.stock_disponible')
for b in B001 B002 B003; do
  tok=$(JETON $b)
  curl -s -X POST "$GW/api/v1/commandes" -H "Authorization: Bearer $tok" -H "Idempotency-Key: smoke-$b-$RANDOM$RANDOM" \
    -H 'Content-Type: application/json' -d "{\"lignes\":[{\"gtin\":\"$GTIN\",\"quantite\":6}]}" > "/tmp/smoke-$b.json" &
done; wait
total=$(cat /tmp/smoke-B00*.json | jq -s 'map(.lignes[0].quantite_stock) | add')
verifier "stock attribué = stock disponible ($avant)" "$total" "$avant"
verifier "stock disponible restant = 0" "$(curl -s "$ERP/stock/$GTIN" | jq '.stock_disponible')" 0

echo "4. Idempotence"
c1=$(curl -s -X POST "$GW/api/v1/commandes" -H "Authorization: Bearer $T_B1" -H 'Idempotency-Key: smoke-idem' -H 'Content-Type: application/json' -d '{"lignes":[{"gtin":"3760123450080","quantite":1}]}' | jq -r .id)
c2=$(curl -s -X POST "$GW/api/v1/commandes" -H "Authorization: Bearer $T_B1" -H 'Idempotency-Key: smoke-idem' -H 'Content-Type: application/json' -d '{"lignes":[{"gtin":"3760123450080","quantite":1}]}' | jq -r .id)
verifier "même clé = même commande" "$c1" "$c2"

echo "5. Expédition et notification de la boutique"
local_avant=$(curl -s "$B1/etat" | jq '.stock_local["3760123450073"] // 0')
cmd=$(curl -s -X POST "$B1/commander" -H 'Content-Type: application/json' -d '{"lignes":[{"gtin":"3760123450073","quantite":3}]}' | jq -r .id)
sleep 2
curl -s -X POST "$ERP/expeditions" -H 'Content-Type: application/json' -d "{\"commande_id\":\"$cmd\"}" > /dev/null
for i in $(seq 1 20); do [ "$(curl -s "$B1/etat" | jq '.stock_local["3760123450073"] // 0')" = "$((local_avant + 3))" ] && break; sleep 1; done
for i in $(seq 1 10); do [ "$(curl -s -H "Authorization: Bearer $T_B1" "$GW/api/v1/commandes/$cmd" | jq -r .statut)" = "EXPEDIEE" ] && break; sleep 1; done
verifier "statut de la commande = EXPEDIEE" "$(curl -s -H "Authorization: Bearer $T_B1" "$GW/api/v1/commandes/$cmd" | jq -r .statut)" EXPEDIEE
verifier "stock local de la boutique mis à jour par webhook (+3)" "$(curl -s "$B1/etat" | jq '.stock_local["3760123450073"]')" "$((local_avant + 3))"

verifier "une autre boutique ne voit pas cette commande" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_B2" "$GW/api/v1/commandes/$cmd")" 404
verifier "en-tête X-Boutique-Id forgé ignoré" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_B2" -H 'X-Boutique-Id: B001' "$GW/api/v1/commandes/$cmd")" 404

echo "6. Statistiques commerciales"
verifier "statistiques disponibles" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T_COM" "$GW/api/v1/stats/references")" 200

echo; echo "Résultat : $ok OK, $ko KO"
[ "$ko" -eq 0 ]
