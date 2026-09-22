#!/usr/bin/env bash
# Scripts the actions an Ops person would otherwise click through in the
# Keycloak Admin UI, shaped to match GUM's (claim) real hierarchy:
# customer (Organization) -> workspace (organization-scoped Group) -> user.
# The customer's 1:1 contract has no native Keycloak entity, so it's
# flattened onto the organization as a JSON attribute.
# Each step fires an Admin Event -> webhook -> consumer-app local sync.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

TOKEN=$(get_admin_token)
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

CONTRACT_JSON='{"name":"Acme Corp - Pro","startDate":"2026-01-01","endDate":"2026-12-31","featureSets":["mentions","mentions.cm","analyst"]}'
CONTRACT_ESCAPED=$(printf '%s' "$CONTRACT_JSON" | sed 's/"/\\"/g')

echo "==> 1. Create customer (Organization): Acme Corp, with its contract as an attribute"
curl -sf -D /tmp/org_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations" "${AUTH[@]}" \
  -d "{\"name\":\"Acme Corp\",\"alias\":\"acme-corp\",\"enabled\":true,\"domains\":[{\"name\":\"acme.example.com\",\"verified\":false}],\"attributes\":{\"salesforceId\":[\"SF-12345\"],\"isActive\":[\"true\"],\"contract\":[\"$CONTRACT_ESCAPED\"]}}"
ORG_ID=$(id_from_location /tmp/org_headers)
echo "    customer id: $ORG_ID"

echo "==> 2. Create workspace as an organization-scoped group under Acme Corp"
curl -sf -D /tmp/group_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups" "${AUTH[@]}" \
  -d '{"name":"acme-corp-default","attributes":{"isDefault":["true"]}}'
GROUP_ID=$(id_from_location /tmp/group_headers)
echo "    workspace id: $GROUP_ID"

echo "==> 3. Create user jane.doe"
curl -sf -D /tmp/user_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" \
  -d '{"username":"jane.doe","email":"jane.doe@acme.example.com","enabled":true,"firstName":"Jane","lastName":"Doe"}'
USER_ID=$(id_from_location /tmp/user_headers)
echo "    user id: $USER_ID"

echo "==> 4. Add jane.doe as an organization member (Keycloak requires this before org-group membership)"
curl -sf -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/members" "${AUTH[@]}" \
  -d "\"$USER_ID\""

echo "==> 5. Add jane.doe to the acme-corp-default workspace"
curl -sf -X PUT "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups/$GROUP_ID/members/$USER_ID" "${AUTH[@]}"

echo
echo "Done. Watch it land in the downstream app at http://localhost:4000"
