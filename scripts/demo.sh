#!/usr/bin/env bash
# Scripts the actions an Ops person would otherwise click through in the
# Keycloak Admin UI, shaped to match GUM's (claim) real hierarchy:
# customer (Organization) -> workspace (organization-scoped Group) -> user.
# The customer's 1:1 contract has no native Keycloak entity, so it's
# flattened onto the organization as a JSON attribute.
# Each step fires an Admin Event -> webhook -> consumer-app local sync.
#
# Creates two workspaces under Acme Corp (not just one) so this walkthrough
# alone already demonstrates per-workspace featureOverrides, same as
# scripts/seed.js's other customers.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

TOKEN=$(get_admin_token)
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

# Feature keys from claim's real prisma/seed.js FEATURE_CATALOG (see
# consumer-app/src/featureCatalog.js) - not invented.
CONTRACT_JSON='{"name":"Acme Corp - Pro","startDate":"2026-01-01","endDate":"2026-12-31","featureSets":["mentions","mentions.cm","mentions.360","contacts.prmanager"]}'
CONTRACT_ESCAPED=$(printf '%s' "$CONTRACT_JSON" | sed 's/"/\\"/g')

echo "==> 1. Create customer (Organization): Acme Corp, with its contract as an attribute"
curl -sf -D /tmp/org_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations" "${AUTH[@]}" \
  -d "{\"name\":\"Acme Corp\",\"alias\":\"acme-corp\",\"enabled\":true,\"domains\":[{\"name\":\"acme.example.com\",\"verified\":false}],\"attributes\":{\"salesforceId\":[\"SF-12345\"],\"contract\":[\"$CONTRACT_ESCAPED\"]}}"
ORG_ID=$(id_from_location /tmp/org_headers)
echo "    customer id: $ORG_ID"

echo "==> 2. Create workspace acme-corp-default (unrestricted - full contract)"
curl -sf -D /tmp/group_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups" "${AUTH[@]}" \
  -d '{"name":"acme-corp-default","attributes":{"isDefault":["true"]}}'
GROUP_ID=$(id_from_location /tmp/group_headers)
echo "    workspace id: $GROUP_ID"

echo "==> 3. Create workspace acme-corp-priority (restricted via featureOverrides)"
curl -sf -D /tmp/group2_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups" "${AUTH[@]}" \
  -d '{"name":"acme-corp-priority","attributes":{"featureOverrides":["{\"mentions.360\":false}"]}}'
GROUP2_ID=$(id_from_location /tmp/group2_headers)
echo "    workspace id: $GROUP2_ID"

echo "==> 4. Create user jane.doe"
curl -sf -D /tmp/user_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" \
  -d '{"username":"jane.doe","email":"jane.doe@acme.example.com","enabled":true,"firstName":"Jane","lastName":"Doe"}'
USER_ID=$(id_from_location /tmp/user_headers)
echo "    user id: $USER_ID"

echo "==> 5. Create user michael.reyes"
curl -sf -D /tmp/user2_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" \
  -d '{"username":"michael.reyes","email":"michael.reyes@acme.example.com","enabled":true,"firstName":"Michael","lastName":"Reyes"}'
USER2_ID=$(id_from_location /tmp/user2_headers)
echo "    user id: $USER2_ID"

echo "==> 6. Add both users as organization members (Keycloak requires this before org-group membership)"
curl -sf -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/members" "${AUTH[@]}" -d "\"$USER_ID\""
curl -sf -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/members" "${AUTH[@]}" -d "\"$USER2_ID\""

echo "==> 7. Add jane.doe to acme-corp-default, michael.reyes to acme-corp-priority"
curl -sf -X PUT "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups/$GROUP_ID/members/$USER_ID" "${AUTH[@]}"
curl -sf -X PUT "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups/$GROUP2_ID/members/$USER2_ID" "${AUTH[@]}"

echo
echo "Done. Watch it land in the downstream app at http://localhost:4000"
