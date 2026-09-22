const BASE_URL = process.env.KEYCLOAK_BASE_URL || "http://keycloak:8080";
const REALM = process.env.KEYCLOAK_REALM || "onclusive-poc";
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || "webhook-consumer";
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || "";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const res = await fetch(`${BASE_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to obtain admin token: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  cachedToken = body.access_token;
  cachedTokenExpiresAt = Date.now() + (body.expires_in - 10) * 1000;
  return cachedToken;
}

async function adminFetch(path) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}/admin/realms/${REALM}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Admin API GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getUserByUsername(username) {
  const results = await adminFetch(`/users?username=${encodeURIComponent(username)}&exact=true`);
  return results?.[0] || null;
}

export const keycloakAdmin = {
  getOrganization: (orgId) => adminFetch(`/organizations/${orgId}`),
  getGroup: (groupId) => adminFetch(`/groups/${groupId}`),
  getGroupMembers: (groupId) => adminFetch(`/groups/${groupId}/members`),
  getUser: (userId) => adminFetch(`/users/${userId}`),
  getUserByUsername,
  getUserRealmRoles: (userId) => adminFetch(`/users/${userId}/role-mappings/realm`),
};
