// Module/entitlement schema for the 360 Platform realm, copied from the
// "Unified Authorization & Identity Migration" plan doc's own worked
// example (Phase 1 sync payload, section "Static Entitlements"):
// web_media (access/tier/search_limit) and social_media (access/role).
// Drives both the admin UI's form fields and effectiveEntitlements()'s
// merge logic in syncHandlers.js.
export const ENTITLEMENT_CATALOG = {
  web_media: {
    label: "Web Media",
    fields: [
      { key: "access", label: "Access", type: "boolean" },
      { key: "tier", label: "Tier", type: "select", options: ["basic", "standard", "premium"] },
      { key: "search_limit", label: "Monthly search limit", type: "number" },
    ],
  },
  social_media: {
    label: "Social Media",
    fields: [
      { key: "access", label: "Access", type: "boolean" },
      { key: "role", label: "Role", type: "select", options: ["member", "admin"] },
    ],
  },
};
