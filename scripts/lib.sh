KC_URL="${KC_URL:-http://localhost:8080}"
REALM="${REALM:-onclusive-poc}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin}"

get_admin_token() {
  curl -sf -X POST "$KC_URL/realms/master/protocol/openid-connect/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "username=$ADMIN_USER" \
    -d "password=$ADMIN_PASS" \
    -d 'grant_type=password' \
    -d 'client_id=admin-cli' | jq -r .access_token
}

# extracts the trailing id from a Location response header captured with `curl -D -`
id_from_location() {
  grep -i '^location:' "$1" | tr -d '\r' | sed -E 's#.*/##'
}
