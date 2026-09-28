#!/usr/bin/env node
//
// Seeds two more customers on top of demo.sh's ACME Corporation, in the
// 360 Platform data model: entitlements (web_media/social_media,
// per-module access/tier/search_limit/role) + legacyMapping (Phase 0's
// Legacy Mapping Dictionary), both flattened onto the customer
// Organization as attributes, plus workspaces for internal sub-teams and
// invited external agencies.
//
// Usage: node scripts/seed.js   (KC_URL/REALM/ADMIN_USER/ADMIN_PASS env
// vars override the same defaults as scripts/lib.sh)

const KC_URL = process.env.KC_URL || "http://localhost:8080";
const REALM = process.env.REALM || "360-platform";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

async function getToken() {
  const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: ADMIN_USER,
      password: ADMIN_PASS,
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${KC_URL}/admin/realms/${REALM}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  const location = res.headers.get("location");
  if (location) return location.split("/").pop();
  if (res.status === 204) return null;
  return res.json();
}

const SEED = [
  {
    businessName: "Globex Media Group",
    alias: "globex-media-group",
    legacyMapping: {
      master_account_id: "ACC-55871",
      master_account_name: "Globex Media Group",
      legacy_app_mappings: { mention_pro: "W-204", mentions_cm: "S-119" },
    },
    entitlements: {
      web_media: { access: true, tier: "basic", search_limit: 25 },
      social_media: { access: false },
    },
    workspaces: [
      {
        name: "Comms",
        isDefault: true,
        users: [{ username: "ravi.desai", email: "ravi.desai@globex.example.com", firstName: "Ravi", lastName: "Desai" }],
      },
    ],
  },
  {
    businessName: "Initech Communications",
    alias: "initech-communications",
    legacyMapping: {
      master_account_id: "ACC-70144",
      master_account_name: "Initech Communications",
      legacy_app_mappings: { mention_pro: "W-330", mentions_cm: "S-641", prmanager: "B-905" },
    },
    entitlements: {
      web_media: { access: true, tier: "premium", search_limit: 500 },
      social_media: { access: true, role: "admin" },
    },
    workspaces: [
      {
        name: "PR",
        isDefault: true,
        users: [{ username: "megan.oconnor", email: "megan.oconnor@initech.example.com", firstName: "Megan", lastName: "O'Connor" }],
      },
      {
        name: "Compliance",
        featureOverrides: { social_media: { access: false } },
        users: [{ username: "derek.wallace", email: "derek.wallace@initech.example.com", firstName: "Derek", lastName: "Wallace" }],
      },
      {
        name: "External PR Agency",
        isExternal: true,
        featureOverrides: { web_media: { tier: "standard", search_limit: 50 }, social_media: { access: false } },
        users: [{ username: "hana.kobayashi", email: "hana.kobayashi@partner-agency.example.com", firstName: "Hana", lastName: "Kobayashi" }],
      },
    ],
  },
];

async function main() {
  const token = await getToken();

  for (const customer of SEED) {
    console.log(`\n== ${customer.businessName} ==`);
    const orgId = await api(token, "POST", "/organizations", {
      name: customer.businessName,
      alias: customer.alias,
      enabled: true,
      attributes: {
        legacyMapping: [JSON.stringify(customer.legacyMapping)],
        entitlements: [JSON.stringify(customer.entitlements)],
      },
    });
    console.log(`  customer id: ${orgId}`);

    for (const ws of customer.workspaces) {
      const attributes = { isDefault: [String(!!ws.isDefault)] };
      if (ws.isExternal) attributes.isExternal = ["true"];
      if (ws.featureOverrides) attributes.featureOverrides = [JSON.stringify(ws.featureOverrides)];
      const groupId = await api(token, "POST", `/organizations/${orgId}/groups`, {
        name: ws.name,
        attributes,
      });
      console.log(`  workspace "${ws.name}": ${groupId}`);

      for (const user of ws.users) {
        const userId = await api(token, "POST", "/users", {
          username: user.username,
          email: user.email,
          enabled: true,
          firstName: user.firstName,
          lastName: user.lastName,
        });
        await api(token, "POST", `/organizations/${orgId}/members`, userId);
        await api(token, "PUT", `/organizations/${orgId}/groups/${groupId}/members/${userId}`);
        console.log(`    user "${user.username}": ${userId}`);
      }
    }
  }

  console.log("\nSeed complete. Watch it land at http://localhost:4000");
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
