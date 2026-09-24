#!/usr/bin/env node
//
// Seeds multiple customers/workspaces/users via the Admin REST API, same
// mechanism scripts/demo.sh uses for its single "Acme Corp" walkthrough.
// This is additive - run demo.sh first (or not), this just adds more.
//
// Feature keys come from claim's own prisma/seed.js FEATURE_CATALOG (see
// consumer-app/src/featureCatalog.js), not invented. Workspace shapes
// deliberately include the multi-workspace-per-customer cases worth
// demonstrating: a single-workspace customer, a customer with an internal
// team workspace on a feature-restricted subset, and a PR-agency-style
// customer with several client-isolated workspaces (workspaces' own
// schema comment: "isolate data and hold users under a customer (for PR
// agencies, etc.)").
//
// Usage: node scripts/seed.js   (KC_URL/REALM/ADMIN_USER/ADMIN_PASS env
// vars override the same defaults as scripts/lib.sh)

const KC_URL = process.env.KC_URL || "http://localhost:8080";
const REALM = process.env.REALM || "onclusive-poc";
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
    businessName: "Globex Corporation",
    alias: "globex-corp",
    salesforceId: "SF-20002",
    contract: {
      name: "Globex - Starter",
      startDate: "2026-02-01",
      endDate: "2026-12-31",
      featureSets: ["mentions", "mentions.cm"],
    },
    workspaces: [
      {
        name: "globex-default",
        isDefault: true,
        users: [{ username: "alice.walker", email: "alice.walker@globex.example.com", firstName: "Alice", lastName: "Walker" }],
      },
    ],
  },
  {
    businessName: "Initech",
    alias: "initech",
    salesforceId: "SF-30003",
    contract: {
      name: "Initech - Enterprise",
      startDate: "2026-01-01",
      endDate: "2027-01-01",
      featureSets: [
        "mentions", "mentions.cm", "mentions.360",
        "contacts.prmanager", "review.rep",
        "geo", "analytics-basic", "analytics-premium",
      ],
    },
    workspaces: [
      {
        name: "initech-default",
        isDefault: true,
        users: [{ username: "bob.chen", email: "bob.chen@initech.example.com", firstName: "Bob", lastName: "Chen" }],
      },
      {
        name: "initech-finance",
        // Internal team with a narrower slice of the full contract.
        featureOverrides: { "review.rep": false, "analytics-premium": false },
        users: [{ username: "carol.diaz", email: "carol.diaz@initech.example.com", firstName: "Carol", lastName: "Diaz" }],
      },
    ],
  },
  {
    businessName: "Umbrella PR Agency",
    alias: "umbrella-pr",
    salesforceId: "SF-40004",
    contract: {
      name: "Umbrella - Agency",
      startDate: "2026-03-01",
      endDate: "2026-12-31",
      featureSets: ["mentions", "mentions.cm", "contacts.prmanager", "analytics-basic"],
    },
    // Agency holding several sub-clients, each isolated in its own
    // workspace - the exact case workspaces.featureOverrides exists for.
    workspaces: [
      {
        name: "umbrella-client-northwind",
        isDefault: true,
        users: [{ username: "dave.osei", email: "dave.osei@umbrella.example.com", firstName: "Dave", lastName: "Osei" }],
      },
      {
        name: "umbrella-client-wayne",
        featureOverrides: { "contacts.prmanager": false },
        users: [{ username: "erin.oyelaran", email: "erin.oyelaran@umbrella.example.com", firstName: "Erin", lastName: "Oyelaran" }],
      },
      {
        name: "umbrella-client-stark",
        featureOverrides: { "analytics-basic": false },
        users: [{ username: "frank.lin", email: "frank.lin@umbrella.example.com", firstName: "Frank", lastName: "Lin" }],
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
      domains: [],
      attributes: {
        salesforceId: [customer.salesforceId],
        contract: [JSON.stringify(customer.contract)],
      },
    });
    console.log(`  customer id: ${orgId}`);

    for (const ws of customer.workspaces) {
      const attributes = { isDefault: [String(!!ws.isDefault)] };
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
