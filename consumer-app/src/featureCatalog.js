// Stand-in for GUM's `features` table (parent/child hierarchy, `key`,
// `displayOnly`). GUM's actual feature catalog is app-side reference data
// this PoC deliberately doesn't reproduce as a real table (see README) -
// but the keys/names/grouping below are copied from claim's own
// prisma/seed.js FEATURE_CATALOG, not invented, so seed data and this
// checkbox UI reflect real product features rather than placeholders.
export const FEATURE_CATALOG = [
  {
    key: "mentions",
    name: "Mentions",
    children: [
      { key: "mentions.cm", name: "Critical Mention (US)" },
      { key: "mentions.360", name: "360 (EU)" },
    ],
  },
  {
    key: "contacts",
    name: "Contacts",
    children: [{ key: "contacts.prmanager", name: "PR Manager" }],
  },
  {
    key: "review",
    name: "Review",
    children: [{ key: "review.rep", name: "Reputation" }],
  },
  {
    key: "analytics",
    name: "Measure",
    children: [
      { key: "geo", name: "GEO" },
      { key: "analytics-basic", name: "Analytics (Basic)" },
      { key: "analytics-premium", name: "Analytics (Premium)" },
    ],
  },
];
