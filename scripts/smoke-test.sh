#!/usr/bin/env bash
# Test de bout en bout de l'écosystème (mode AUTH_MODE=dev).
# Usage : bash scripts/smoke-test.sh   (après docker compose up -d)
set -euo pipefail
GW=${GATEWAY:-http://localhost:8080}
ERP=${ERP:-http://localhost:8090}
B1=${BOUTIQUE_1:-http://localhost:7001}
ok=0; ko=0
verifier() { if [ "$2" = "$3" ]; then echo "  OK  $1"; ok=$((ok+1)); else echo "  KO  $1 (attendu : $3, obtenu : $2)"; ko=$((ko+1)); fi; }

echo "Attente de la plateforme..."
for i in $(seq 1 60); do curl -sf "$GW/health" >/dev/null && break; sleep 2; done
for i in $(seq 1 30); do [ "$(curl -s -H 'Authorization: Bearer dev-B001' "$GW/api/v1/produits" | jq 'length' 2>/dev/null || echo 0)" -gt 0 ] && break; sleep 2; done

echo "1. Sécurité"
verifier "requête sans jeton refusée" "$(curl -s -o /dev/null -w '%{http_code}' "$GW/api/v1/produits")" 401
verifier "commercial ne peut pas commander" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer dev-commercial' "$GW/api/v1/commandes")" 403
verifier "boutique sans accès aux statistiques" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer dev-B001' "$GW/api/v1/stats/boutiques")" 403

echo "2. Catalogue"
verifier "12 articles au catalogue" "$(curl -s -H 'Authorization: Bearer dev-B001' "$GW/api/v1/produits" | jq 'length')" 12

echo "3. Réservation sans doublon (3 commandes simultanées de 6 boardshorts taille 34, stock = 6)"
GTIN=3760123450066
avant=$(curl -s "$ERP/stock/$GTIN" | jq '.stock_disponible')
for b in B001 B002 B003; do
  curl -s -X POST "$GW/api/v1/commandes" -H "Authorization: Bearer dev-$b" -H "Idempotency-Key: smoke-$b-$RANDOM$RANDOM" \
    -H 'Content-Type: application/json' -d "{\"lignes\":[{\"gtin\":\"$GTIN\",\"quantite\":6}]}" > "/tmp/smoke-$b.json" &
done; wait
total=$(cat /tmp/smoke-B00*.json | jq -s 'map(.lignes[0].quantite_stock) | add')
verifier "stock attribué = stock disponible ($avant)" "$total" "$avant"
verifier "stock disponible restant = 0" "$(curl -s "$ERP/stock/$GTIN" | jq '.stock_disponible')" 0

echo "4. Idempotence"
c1=$(curl -s -X POST "$GW/api/v1/commandes" -H 'Authorization: Bearer dev-B001' -H 'Idempotency-Key: smoke-idem' -H 'Content-Type: application/json' -d '{"lignes":[{"gtin":"3760123450080","quantite":1}]}' | jq -r .id)
c2=$(curl -s -X POST "$GW/api/v1/commandes" -H 'Authorization: Bearer dev-B001' -H 'Idempotency-Key: smoke-idem' -H 'Content-Type: application/json' -d '{"lignes":[{"gtin":"3760123450080","quantite":1}]}' | jq -r .id)
verifier "même clé = même commande" "$c1" "$c2"

echo "5. Expédition et notification de la boutique"
cmd=$(curl -s -X POST "$B1/commander" -H 'Content-Type: application/json' -d '{"lignes":[{"gtin":"3760123450073","quantite":3}]}' | jq -r .id)
sleep 2
curl -s -X POST "$ERP/expeditions" -H 'Content-Type: application/json' -d "{\"commande_id\":\"$cmd\"}" > /dev/null
for i in $(seq 1 15); do [ "$(curl -s "$B1/etat" | jq '.stock_local["3760123450073"] // 0')" = "3" ] && break; sleep 1; done
verifier "statut de la commande = EXPEDIEE" "$(curl -s -H 'Authorization: Bearer dev-B001' "$GW/api/v1/commandes/$cmd" | jq -r .statut)" EXPEDIEE
verifier "stock local de la boutique mis à jour par webhook" "$(curl -s "$B1/etat" | jq '.stock_local["3760123450073"]')" 3

echo "6. Statistiques commerciales"
verifier "statistiques disponibles" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer dev-commercial' "$GW/api/v1/stats/references")" 200

echo; echo "Résultat : $ok OK, $ko KO"
[ "$ko" -eq 0 ]
