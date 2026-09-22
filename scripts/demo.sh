#!/usr/bin/env bash
# Scripts the actions an Ops person would otherwise click through in the
# Keycloak Admin UI for Phase 1: create an Organization, set subscription
# attributes on a group, create a user, add them to the org, and assign a role.
# Each step fires an Admin Event -> webhook -> consumer-app local sync.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

TOKEN=$(get_admin_token)
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

echo "==> 1. Create organization: Acme Corp"
curl -sf -D /tmp/org_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations" "${AUTH[@]}" \
  -d '{"name":"Acme Corp","alias":"acme-corp","enabled":true,"domains":[{"name":"acme.example.com","verified":false}]}'
ORG_ID=$(id_from_location /tmp/org_headers)
echo "    organization id: $ORG_ID"

echo "==> 2. Look up the /subscriptions parent group"
SUB_PARENT_ID=$(curl -sf "$KC_URL/admin/realms/$REALM/group-by-path/subscriptions" "${AUTH[@]}" | jq -r .id)
echo "    parent group id: $SUB_PARENT_ID"

echo "==> 3. Create subscription group acme-corp-pro under /subscriptions, linked to the org via attribute"
curl -sf -D /tmp/group_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/groups/$SUB_PARENT_ID/children" "${AUTH[@]}" \
  -d "{\"name\":\"acme-corp-pro\",\"attributes\":{\"organization_id\":[\"$ORG_ID\"],\"plan\":[\"pro\"],\"seats\":[\"50\"]}}"
GROUP_ID=$(id_from_location /tmp/group_headers)
echo "    group id: $GROUP_ID"

echo "==> 4. Create user jane.doe"
curl -sf -D /tmp/user_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" \
  -d '{"username":"jane.doe","email":"jane.doe@acme.example.com","enabled":true,"firstName":"Jane","lastName":"Doe"}'
USER_ID=$(id_from_location /tmp/user_headers)
echo "    user id: $USER_ID"

echo "==> 5. Add jane.doe as a member of Acme Corp"
curl -sf -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/members" "${AUTH[@]}" \
  -d "\"$USER_ID\""

echo "==> 6. Add jane.doe to the acme-corp-pro subscription group"
curl -sf -X PUT "$KC_URL/admin/realms/$REALM/users/$USER_ID/groups/$GROUP_ID" "${AUTH[@]}"

echo "==> 7. Assign realm role org-admin to jane.doe"
ROLE_JSON=$(curl -sf "$KC_URL/admin/realms/$REALM/roles/org-admin" "${AUTH[@]}")
curl -sf -X POST "$KC_URL/admin/realms/$REALM/users/$USER_ID/role-mappings/realm" "${AUTH[@]}" \
  -d "[$ROLE_JSON]"

echo
echo "Done. Watch it land in the downstream app at http://localhost:4000"
