#!/usr/bin/env bash
# Registers a webhook subscriber on the onclusive-poc realm using the
# keycloak-events (phasetwo) extension's REST API.
#
# This is additive, not a single slot - each call creates a new, independent
# subscription (verified live: GET .../realms/{realm}/webhooks returns a
# list, registering a second URL leaves the first untouched). Run it once
# per consumer app that needs to receive Keycloak's admin events.
#
# Usage:
#   ./register-webhook.sh                                    # registers consumer-app with its defaults
#   ./register-webhook.sh <URL> <SECRET> [EVENT_TYPES]        # registers any other consumer
#
# EVENT_TYPES is a comma-separated list (default "*" = everything), e.g.
#   ./register-webhook.sh http://audit-app:6000/hook audit-secret ORGANIZATION,ORGANIZATION_MEMBERSHIP
#
# To see what's currently registered:
#   curl -s "$KC_URL/realms/$REALM/webhooks" -H "Authorization: Bearer $TOKEN" | jq
# To remove one:
#   curl -X DELETE "$KC_URL/realms/$REALM/webhooks/<id>" -H "Authorization: Bearer $TOKEN"
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage:
  ./register-webhook.sh                               registers consumer-app with its defaults
  ./register-webhook.sh <URL> <SECRET> [EVENT_TYPES]   registers any other consumer

EVENT_TYPES is a comma-separated list (default "*" = everything), e.g.
  ./register-webhook.sh http://audit-app:6000/hook audit-secret ORGANIZATION,ORGANIZATION_MEMBERSHIP

Each call adds a new independent subscription - it does not replace any existing one.
USAGE
  exit 0
fi

WEBHOOK_URL="${1:-${WEBHOOK_URL:-http://consumer-app:4000/webhooks/keycloak}}"
WEBHOOK_SECRET="${2:-${WEBHOOK_SECRET:-poc-shared-webhook-secret}}"
WEBHOOK_EVENT_TYPES="${3:-${WEBHOOK_EVENT_TYPES:-*}}"

# "a,b,c" -> ["a","b","c"]
IFS=',' read -ra TYPES_ARR <<< "$WEBHOOK_EVENT_TYPES"
EVENT_TYPES_JSON=$(printf '"%s",' "${TYPES_ARR[@]}")
EVENT_TYPES_JSON="[${EVENT_TYPES_JSON%,}]"

TOKEN=$(get_admin_token)

echo "Registering webhook -> $WEBHOOK_URL (eventTypes: $EVENT_TYPES_JSON)"
HTTP_CODE=$(curl -s -o /tmp/register-webhook-resp.json -w '%{http_code}' \
  -X POST "$KC_URL/realms/$REALM/webhooks" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"enabled\":\"true\",\"url\":\"$WEBHOOK_URL\",\"secret\":\"$WEBHOOK_SECRET\",\"eventTypes\":$EVENT_TYPES_JSON}")

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
