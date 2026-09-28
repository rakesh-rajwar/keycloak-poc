#!/usr/bin/env bash
# Seeds ACME Corporation using the plan doc's own worked example verbatim:
# the Legacy Mapping Dictionary from "Phase 0: Account & Sub-Group
# Discovery" (ACC-90210, mention_pro/mentions_cm/prmanager) and the
# entitlements shape from "Phase 1"'s USER_ENTITLEMENT_UPDATED payload
# (web_media: access/tier/search_limit, social_media: access/role).
#
# Two internal sub-teams (Marketing, Legal - the doc's own example) plus
# one external PR agency workspace, restricted via featureOverrides -
# standing in for the doc's "Invite external PR agencies by email and
# assign them restricted module access" (Phase 1 point 4). This PoC adds
# the agency as a regular org+workspace member rather than exercising
# Keycloak's native invite-by-email flow (POST .../members/invite-user,
# confirmed to exist and work - it just needs realm SMTP configured to
# actually deliver the email, which this stack doesn't set up).
#
# Each step fires an Admin Event -> webhook -> consumer-app local sync.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

TOKEN=$(get_admin_token)
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

LEGACY_MAPPING='{"master_account_id":"ACC-90210","master_account_name":"ACME Corporation","legacy_app_mappings":{"mention_pro":"W-101","mentions_cm":"S-502","prmanager":"B-882"}}'
LEGACY_MAPPING_ESC=$(printf '%s' "$LEGACY_MAPPING" | sed 's/"/\\"/g')

ENTITLEMENTS='{"web_media":{"access":true,"tier":"standard","search_limit":100},"social_media":{"access":true,"role":"admin"}}'
ENTITLEMENTS_ESC=$(printf '%s' "$ENTITLEMENTS" | sed 's/"/\\"/g')

echo "==> 1. Create customer (Organization): ACME Corporation"
curl -sf -D /tmp/org_headers -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations" "${AUTH[@]}" \
  -d "{\"name\":\"ACME Corporation\",\"alias\":\"acme-corporation\",\"enabled\":true,\"attributes\":{\"legacyMapping\":[\"$LEGACY_MAPPING_ESC\"],\"entitlements\":[\"$ENTITLEMENTS_ESC\"]}}"
ORG_ID=$(id_from_location /tmp/org_headers)
echo "    customer id: $ORG_ID"

echo "==> 2. Create workspace Marketing (internal sub-team, full entitlements)"
curl -sf -D /tmp/g1 -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups" "${AUTH[@]}" \
  -d '{"name":"Marketing","attributes":{"isDefault":["true"]}}'
MARKETING_ID=$(id_from_location /tmp/g1)
echo "    workspace id: $MARKETING_ID"

echo "==> 3. Create workspace Legal (internal sub-team, social_media blocked)"
curl -sf -D /tmp/g2 -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups" "${AUTH[@]}" \
  -d '{"name":"Legal","attributes":{"featureOverrides":["{\"social_media\":{\"access\":false}}"]}}'
LEGAL_ID=$(id_from_location /tmp/g2)
echo "    workspace id: $LEGAL_ID"

echo "==> 4. Create workspace External PR Agency (restricted: basic tier, no social_media)"
curl -sf -D /tmp/g3 -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups" "${AUTH[@]}" \
  -d '{"name":"External PR Agency","attributes":{"isExternal":["true"],"featureOverrides":["{\"web_media\":{\"tier\":\"basic\",\"search_limit\":20},\"social_media\":{\"access\":false}}"]}}'
AGENCY_ID=$(id_from_location /tmp/g3)
echo "    workspace id: $AGENCY_ID"

echo "==> 5. Create users"
curl -sf -D /tmp/u1 -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" \
  -d '{"username":"nina.brooks","email":"nina.brooks@acme.example.com","enabled":true,"firstName":"Nina","lastName":"Brooks"}'
USER1_ID=$(id_from_location /tmp/u1)
curl -sf -D /tmp/u2 -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" \
  -d '{"username":"owen.clarke","email":"owen.clarke@acme.example.com","enabled":true,"firstName":"Owen","lastName":"Clarke"}'
USER2_ID=$(id_from_location /tmp/u2)
curl -sf -D /tmp/u3 -o /dev/null -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" \
  -d '{"username":"priya.nair","email":"priya.nair@partner-agency.example.com","enabled":true,"firstName":"Priya","lastName":"Nair"}'
USER3_ID=$(id_from_location /tmp/u3)
echo "    users: $USER1_ID (Marketing), $USER2_ID (Legal), $USER3_ID (agency)"

echo "==> 6. Add all as organization members (Keycloak requires this before org-group membership)"
curl -sf -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/members" "${AUTH[@]}" -d "\"$USER1_ID\""
curl -sf -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/members" "${AUTH[@]}" -d "\"$USER2_ID\""
curl -sf -X POST "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/members" "${AUTH[@]}" -d "\"$USER3_ID\""

echo "==> 7. Assign to workspaces"
curl -sf -X PUT "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups/$MARKETING_ID/members/$USER1_ID" "${AUTH[@]}"
curl -sf -X PUT "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups/$LEGAL_ID/members/$USER2_ID" "${AUTH[@]}"
curl -sf -X PUT "$KC_URL/admin/realms/$REALM/organizations/$ORG_ID/groups/$AGENCY_ID/members/$USER3_ID" "${AUTH[@]}"

echo
echo "Done. Watch it land in the downstream app at http://localhost:4000"
