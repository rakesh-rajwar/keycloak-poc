import { db } from "./db.js";
import { keycloakAdmin } from "./keycloakAdmin.js";

// 360 Platform realm data model, per the "Unified Authorization & Identity
// Migration" plan doc: customers -> workspaces (internal sub-teams or
// invited external agencies) -> userWorkspaces <- users. A customer's
// static entitlements (Phase 1's "Static Entitlements (Centralized in
// Keycloak)") are flattened onto the Organization as an `entitlements`
// JSON attribute; its Legacy Mapping Dictionary (Phase 0) as a separate
// `legacyMapping` attribute. Neither has a native Keycloak entity.
//
// Per the doc's core architectural split, dynamic usage counters
// (Phase 3's "Dynamic Usage Metering (Maintained in Local App DBs)") are
// NEVER derived from or written to Keycloak - they live only in the
// `usage` field on a userWorkspace row, mutated solely by
// /admin/user-workspaces/:id/simulate-usage. Every function here that
// upserts a userWorkspace preserves that field by spreading the existing
// row rather than replacing it wholesale.

const nowIso = () => new Date().toISOString();

function pathSegments(resourcePath) {
  const parts = (resourcePath || "").split("/").filter(Boolean);
  const segments = {};
  for (let i = 0; i < parts.length; i += 2) segments[parts[i]] = parts[i + 1];
  return segments;
}

function parseJsonAttr(attrs, key) {
  const raw = attrs?.[key]?.[0];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Deleting an Organization in Keycloak does not fire separate
// ORGANIZATION_GROUP/ORGANIZATION_GROUP_MEMBERSHIP DELETE events for its
// child org-groups - they just vanish upstream. Without this, deleting a
// customer left orphaned rows behind in workspaces/userWorkspaces (found
// live: re-seeding a deleted customer produced duplicate stale rows
// alongside the fresh ones). Mirrors the cascade Keycloak itself performs.
function cascadeDeleteCustomer(orgId) {
  db.removeWhere("workspaces", (w) => w.customerId === orgId);
  db.removeWhere("userWorkspaces", (uw) => uw.customerId === orgId);
}

async function syncCustomer(orgId, deleted) {
  if (deleted) {
    db.remove("customers", "kcOrgId", orgId);
    cascadeDeleteCustomer(orgId);
    return `customer ${orgId} removed (cascaded to its workspaces/memberships)`;
  }
  const org = await keycloakAdmin.getOrganization(orgId);
  if (!org) {
    db.remove("customers", "kcOrgId", orgId);
    cascadeDeleteCustomer(orgId);
    return `customer ${orgId} not found upstream, removed locally (cascaded)`;
  }
  const attrs = org.attributes || {};
  db.upsert("customers", "kcOrgId", {
    kcOrgId: org.id,
    businessName: org.name,
    alias: org.alias,
    isActive: org.enabled, // native Keycloak field, not a custom attribute - see README
    legacyMapping: parseJsonAttr(attrs, "legacyMapping"),
    entitlements: parseJsonAttr(attrs, "entitlements"),
    updatedAt: nowIso(),
  });
  const recomputed = recomputeEntitlementsForCustomer(orgId);
  return `customer "${org.name}" synced` + (recomputed ? `, recomputed entitlements for ${recomputed} membership(s)` : "");
}

// Keycloak requires org membership as a prerequisite for org-group
// membership, but there's no users<->customers table in this model (only
// users<->workspaces via userWorkspaces) - nothing to sync here. The USER
// handler below keeps the users catalog current regardless.
function ignoreOrganizationMembership(orgId) {
  return `organization membership under customer ${orgId} is Keycloak plumbing only, no local equivalent - ignored`;
}

// Effective entitlements for a workspace: the customer's static
// entitlements, per-module-per-field overridden by whatever the
// workspace's own featureOverrides sets (e.g. a restricted sub-team
// losing web_media entirely, or downgraded to a lower tier) - a
// shallow-per-module merge, not a flat array filter, since entitlements
// now carry sub-fields (tier, search_limit, role) rather than being a
// plain on/off feature key.
function effectiveEntitlements(entitlements, featureOverrides) {
  if (!entitlements) return {};
  if (!featureOverrides) return entitlements;
  const result = {};
  for (const [module, value] of Object.entries(entitlements)) {
    result[module] = { ...value, ...(featureOverrides[module] || {}) };
  }
  return result;
}

function upsertUserWorkspaceEntitlements(uw, entitlements) {
  // Preserve usage (the dynamic, local-only counter) - never touched here.
  db.upsert("userWorkspaces", "id", { ...uw, entitlements, updatedAt: nowIso() });
}

// Re-derives entitlements for every already-synced userWorkspace under a
// customer, so an entitlements change propagates to existing memberships
// instead of only affecting ones created afterward. Bounded, on-demand
// recomputation - not a full reachability-diffing engine, just enough to
// avoid the staleness a previous version of this PoC had as a known gap.
function recomputeEntitlementsForCustomer(orgId) {
  const customer = db.find("customers", "kcOrgId", orgId);
  const affected = db.all("userWorkspaces").filter((uw) => uw.customerId === orgId);
  for (const uw of affected) {
    const workspace = db.find("workspaces", "kcGroupId", uw.workspaceId);
    upsertUserWorkspaceEntitlements(uw, effectiveEntitlements(customer?.entitlements, workspace?.featureOverrides));
  }
  return affected.length;
}

// Same idea, scoped to one workspace - covers a featureOverrides change.
function recomputeEntitlementsForWorkspace(groupId) {
  const workspace = db.find("workspaces", "kcGroupId", groupId);
  const customer = db.find("customers", "kcOrgId", workspace?.customerId);
  const affected = db.all("userWorkspaces").filter((uw) => uw.workspaceId === groupId);
  for (const uw of affected) {
    upsertUserWorkspaceEntitlements(uw, effectiveEntitlements(customer?.entitlements, workspace?.featureOverrides));
  }
  return affected.length;
}

async function resolveWorkspaceId(orgId, groupId, event) {
  if (groupId) return groupId;
  try {
    return JSON.parse(event.representation)?.id || null;
  } catch {
    return null;
  }
}

async function syncWorkspace(orgId, groupId, deleted) {
  if (deleted) {
    db.remove("workspaces", "kcGroupId", groupId);
    db.removeWhere("userWorkspaces", (uw) => uw.workspaceId === groupId);
    return `workspace ${groupId} removed (cascaded to its memberships)`;
  }
  const group = await keycloakAdmin.getOrganizationGroup(orgId, groupId);
  if (!group) {
    db.remove("workspaces", "kcGroupId", groupId);
    db.removeWhere("userWorkspaces", (uw) => uw.workspaceId === groupId);
    return `workspace ${groupId} not found upstream, removed locally (cascaded)`;
  }
  const attrs = group.attributes || {};
  db.upsert("workspaces", "kcGroupId", {
    kcGroupId: group.id,
    customerId: orgId,
    businessName: group.name,
    isDefault: attrs.isDefault?.[0] === "true",
    isExternal: attrs.isExternal?.[0] === "true",
    featureOverrides: parseJsonAttr(attrs, "featureOverrides"),
    updatedAt: nowIso(),
  });
  const recomputed = recomputeEntitlementsForWorkspace(group.id);
  return `workspace "${group.name}" synced for customer ${orgId}` + (recomputed ? `, recomputed entitlements for ${recomputed} membership(s)` : "");
}

async function syncUserWorkspace(orgId, groupId, userId, deleted) {
  const id = `${groupId}:${userId}`;
  if (deleted) {
    db.remove("userWorkspaces", "id", id);
    return `userWorkspace ${id} removed`;
  }
  const user = await keycloakAdmin.getUser(userId);
  if (!user) return `user ${userId} not found upstream, skipped`;

  db.upsert("users", "kcUserId", {
    kcUserId: user.id,
    email: user.email || null,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username,
    updatedAt: nowIso(),
  });

  const customer = db.find("customers", "kcOrgId", orgId);
  const workspace = db.find("workspaces", "kcGroupId", groupId);
  const entitlements = effectiveEntitlements(customer?.entitlements, workspace?.featureOverrides);
  const existing = db.find("userWorkspaces", "id", id);

  db.upsert("userWorkspaces", "id", {
    id,
    workspaceId: groupId,
    customerId: orgId,
    userId,
    email: user.email,
    entitlements,
    // Dynamic, local-only - seeded once on first sync, never derived from
    // Keycloak, never overwritten by a later static-side resync.
    usage: existing?.usage ?? { current_month_searches: 0 },
    updatedAt: nowIso(),
  });
  return `userWorkspace synced: ${user.email} -> workspace ${groupId}`;
}

async function syncUser(userId, deleted) {
  if (deleted) {
    db.remove("users", "kcUserId", userId);
    return `user ${userId} removed`;
  }
  const user = await keycloakAdmin.getUser(userId);
  if (!user) return `user ${userId} not found upstream, skipped`;
  db.upsert("users", "kcUserId", {
    kcUserId: user.id,
    email: user.email || null,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username,
    updatedAt: nowIso(),
  });
  return `user "${user.email}" synced`;
}

// Full reconciliation: walks every Organization -> its org-groups -> their
// members currently in Keycloak and rebuilds customers/workspaces/users/
// userWorkspaces from scratch (wipe-and-rebuild, via db.replaceAll - not
// additive upserts), discarding any local row that no longer has a
// matching upstream entity. Exists because Keycloak doesn't fire cascade
// DELETE events for an org-group's children when its parent Organization
// is deleted (see cascadeDeleteCustomer) - this is the repair tool for
// whatever that (or a missed webhook delivery) has already left behind.
// Preserves each userWorkspace's `usage` counter across the rebuild - it's
// local-only dynamic state, a resync of Keycloak's static data must never
// touch it.
export async function resyncAll() {
  const previousUsageById = new Map(db.all("userWorkspaces").map((uw) => [uw.id, uw.usage]));

  const customers = [];
  const workspaces = [];
  const usersById = new Map();
  const userWorkspaces = [];

  // The list endpoints (organizations, organizations/{id}/groups) return
  // abbreviated representations with no `attributes` field at all -
  // verified live. Only the single-entity detail GET has it, so each org
  // and each group needs a follow-up detail fetch.
  const orgSummaries = (await keycloakAdmin.listOrganizations()) || [];
  for (const orgSummary of orgSummaries) {
    const org = (await keycloakAdmin.getOrganization(orgSummary.id)) || orgSummary;
    const attrs = org.attributes || {};
    const entitlements = parseJsonAttr(attrs, "entitlements");
    customers.push({
      kcOrgId: org.id,
      businessName: org.name,
      alias: org.alias,
      isActive: org.enabled,
      legacyMapping: parseJsonAttr(attrs, "legacyMapping"),
      entitlements,
      updatedAt: nowIso(),
    });

    const groupSummaries = (await keycloakAdmin.getOrganizationGroups(org.id)) || [];
    for (const groupSummary of groupSummaries) {
      const group = (await keycloakAdmin.getOrganizationGroup(org.id, groupSummary.id)) || groupSummary;
      const gAttrs = group.attributes || {};
      const featureOverrides = parseJsonAttr(gAttrs, "featureOverrides");
      workspaces.push({
        kcGroupId: group.id,
        customerId: org.id,
        businessName: group.name,
        isDefault: gAttrs.isDefault?.[0] === "true",
        isExternal: gAttrs.isExternal?.[0] === "true",
        featureOverrides,
        updatedAt: nowIso(),
      });

      const effective = effectiveEntitlements(entitlements, featureOverrides);
      const members = (await keycloakAdmin.getOrganizationGroupMembers(org.id, group.id)) || [];
      for (const user of members) {
        usersById.set(user.id, {
          kcUserId: user.id,
          email: user.email || null,
          name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username,
          updatedAt: nowIso(),
        });
        const id = `${group.id}:${user.id}`;
        userWorkspaces.push({
          id,
          workspaceId: group.id,
          customerId: org.id,
          userId: user.id,
          email: user.email,
          entitlements: effective,
          usage: previousUsageById.get(id) ?? { current_month_searches: 0 },
          updatedAt: nowIso(),
        });
      }
    }
  }

  db.replaceAll({
    customers,
    workspaces,
    users: [...usersById.values()],
    userWorkspaces,
  });

  return {
    customers: customers.length,
    workspaces: workspaces.length,
    users: usersById.size,
    userWorkspaces: userWorkspaces.length,
  };
}

export async function handleAdminEvent(event) {
  const { resourceType, operationType, resourcePath } = event;
  const deleted = operationType === "DELETE";
  const segments = pathSegments(resourcePath);

  switch (resourceType) {
    case "ORGANIZATION":
      return syncCustomer(segments.organizations, deleted);

    case "ORGANIZATION_MEMBERSHIP":
      return ignoreOrganizationMembership(segments.organizations);

    case "ORGANIZATION_GROUP": {
      const groupId = await resolveWorkspaceId(segments.organizations, segments.groups, event);
      if (!groupId) return `could not resolve workspace id under customer ${segments.organizations}, skipped`;
      return syncWorkspace(segments.organizations, groupId, deleted);
    }

    case "ORGANIZATION_GROUP_MEMBERSHIP":
      return syncUserWorkspace(segments.organizations, segments.groups, segments.members, deleted);

    case "USER":
      return syncUser(segments.users, deleted);

    default:
      return `ignored resourceType=${resourceType} path=${resourcePath}`;
  }
}
