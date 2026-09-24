// Stand-in for GUM's `features` table (parent/child hierarchy, `key`,
// `displayOnly`). GUM's actual feature catalog is app-side reference data
// this PoC deliberately doesn't reproduce (see README) - this is just
// enough of a fixture to drive the same checkbox UX against our demo data.
export const FEATURE_CATALOG = [
  {
    key: "mentions",
    name: "Mentions",
    children: [{ key: "mentions.cm", name: "Coverage Monitoring" }],
  },
  {
    key: "analyst",
    name: "Analyst",
  },
];
