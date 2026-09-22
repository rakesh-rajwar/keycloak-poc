#!/usr/bin/env bash
# Registers the consumer-app as a webhook subscriber on the onclusive-poc realm
# using the keycloak-events (phasetwo) extension's REST API.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

WEBHOOK_URL="${WEBHOOK_URL:-http://consumer-app:4000/webhooks/keycloak}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-poc-shared-webhook-secret}"

TOKEN=$(get_admin_token)

echo "Registering webhook -> $WEBHOOK_URL"
HTTP_CODE=$(curl -s -o /tmp/register-webhook-resp.json -w '%{http_code}' \
  -X POST "$KC_URL/realms/$REALM/webhooks" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"enabled\":\"true\",\"url\":\"$WEBHOOK_URL\",\"secret\":\"$WEBHOOK_SECRET\",\"eventTypes\":[\"*\"]}")

echo "HTTP $HTTP_CODE"
cat /tmp/register-webhook-resp.json
echo

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  echo
  echo "Webhook registration did not return 2xx." >&2
  echo "Check that:" >&2
  echo "  1. Realm Settings > Events > Event Listeners includes 'ext-event-webhook' (should be set by realm import)." >&2
  echo "  2. The keycloak-events extension REST path matches this Keycloak version — inspect container logs:" >&2
  echo "     docker compose logs keycloak | grep -i webhook" >&2
  exit 1
fi
