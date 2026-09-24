import { db } from "./db.js";
import { keycloakAdmin } from "./keycloakAdmin.js";

// Mirrors GUM's (claim) real hierarchy: customers -> workspaces ->
// userWorkspaces <- users, with a customer's 1:1 contract flattened onto
// the Keycloak Organization as a `contract` JSON attribute (Keycloak has
// no native contract entity). See README "Data model" for the full mapping.

const nowIso = () => new Date().toISOString();

function pathSegments(resourcePath) {
  const parts = (resourcePath || "").split("/").filter(Boolean);
  const segments = {};
  for (let i = 0; i < parts.length; i += 2) segments[parts[i]] = parts[i + 1];
  return segments;
}

function parseContract(org) {
  const raw = org.attributes?.contract?.[0];
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
    salesforceId: attrs.salesforceId?.[0] || null,
    isActive: org.enabled, // native Keycloak field, not a custom attribute - see README
    contract: parseContract(org),
    updatedAt: nowIso(),
  });
  const recomputed = recomputeEnabledFeaturesForCustomer(orgId);
  return `customer "${org.name}" synced` + (recomputed ? `, recomputed enabledFeatures for ${recomputed} membership(s)` : "");
}

// Keycloak requires org membership as a prerequisite for org-group
// membership, but GUM has no users<->customers table (only
// users<->workspaces via userWorkspaces) - there's nothing to sync here.
// The USER handler below keeps the users catalog current regardless.
function ignoreOrganizationMembership(orgId) {
  return `organization membership under customer ${orgId} is Keycloak plumbing only, no GUM equivalent - ignored`;
}

// Effective feature set for a workspace: the customer's contract
// featureSets, minus any keys explicitly turned off in the workspace's own
// featureOverrides - same relationship as workspaces.featureOverrides in
// the real schema ("Override inherited Contract features").
function effectiveFeatures(contract, featureOverrides) {
  const base = contract?.featureSets || [];
  if (!featureOverrides) return base;
  return base.filter((key) => featureOverrides[key] !== false);
}

// Re-derives enabledFeatures for every already-synced userWorkspace under a
// customer, so a contract change (new/removed featureSets) propagates to
// existing memberships instead of only affecting ones created afterward.
// Bounded, on-demand recomputation - not GUM's full reachability-diffing
// engine (event-fanout.ts), just enough to stop the staleness the README
// used to call out as a known gap.
function recomputeEnabledFeaturesForCustomer(orgId) {
  const customer = db.find("customers", "kcOrgId", orgId);
  const affected = db.all("userWorkspaces").filter((uw) => uw.customerId === orgId);
  for (const uw of affected) {
    const workspace = db.find("workspaces", "kcGroupId", uw.workspaceId);
    const enabledFeatures = effectiveFeatures(customer?.contract, workspace?.featureOverrides);
    db.upsert("userWorkspaces", "id", { ...uw, enabledFeatures, updatedAt: nowIso() });
  }
  return affected.length;
}

// Same idea, scoped to one workspace - covers a featureOverrides change.
function recomputeEnabledFeaturesForWorkspace(groupId) {
  const workspace = db.find("workspaces", "kcGroupId", groupId);
  const customer = db.find("customers", "kcOrgId", workspace?.customerId);
  const affected = db.all("userWorkspaces").filter((uw) => uw.workspaceId === groupId);
  for (const uw of affected) {
    const enabledFeatures = effectiveFeatures(customer?.contract, workspace?.featureOverrides);
    db.upsert("userWorkspaces", "id", { ...uw, enabledFeatures, updatedAt: nowIso() });
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
  let featureOverrides = null;
  if (attrs.featureOverrides?.[0]) {
    try {
      featureOverrides = JSON.parse(attrs.featureOverrides[0]);
    } catch {
      featureOverrides = null;
    }
  }
  db.upsert("workspaces", "kcGroupId", {
    kcGroupId: group.id,
    customerId: orgId,
    businessName: group.name,
    isDefault: attrs.isDefault?.[0] === "true",
    featureOverrides,
    updatedAt: nowIso(),
  });
  const recomputed = recomputeEnabledFeaturesForWorkspace(group.id);
  return `workspace "${group.name}" synced for customer ${orgId}` + (recomputed ? `, recomputed enabledFeatures for ${recomputed} membership(s)` : "");
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
  const enabledFeatures = effectiveFeatures(customer?.contract, workspace?.featureOverrides);

  db.upsert("userWorkspaces", "id", {
    id,
    workspaceId: groupId,
    customerId: orgId,
    userId,
    email: user.email,
    enabledFeatures,
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
export async function resyncAll() {
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
    const contract = parseContract(org);
    customers.push({
      kcOrgId: org.id,
      businessName: org.name,
      alias: org.alias,
      salesforceId: attrs.salesforceId?.[0] || null,
      isActive: org.enabled,
      contract,
      updatedAt: nowIso(),
    });

    const groupSummaries = (await keycloakAdmin.getOrganizationGroups(org.id)) || [];
    for (const groupSummary of groupSummaries) {
      const group = (await keycloakAdmin.getOrganizationGroup(org.id, groupSummary.id)) || groupSummary;
      const gAttrs = group.attributes || {};
      let featureOverrides = null;
      if (gAttrs.featureOverrides?.[0]) {
        try {
          featureOverrides = JSON.parse(gAttrs.featureOverrides[0]);
        } catch {
          featureOverrides = null;
        }
      }
      workspaces.push({
        kcGroupId: group.id,
        customerId: org.id,
        businessName: group.name,
        isDefault: gAttrs.isDefault?.[0] === "true",
        featureOverrides,
        updatedAt: nowIso(),
      });

      const enabledFeatures = effectiveFeatures(contract, featureOverrides);
      const members = (await keycloakAdmin.getOrganizationGroupMembers(org.id, group.id)) || [];
      for (const user of members) {
        usersById.set(user.id, {
          kcUserId: user.id,
          email: user.email || null,
          name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username,
          updatedAt: nowIso(),
        });
        userWorkspaces.push({
          id: `${group.id}:${user.id}`,
          workspaceId: group.id,
          customerId: org.id,
          userId: user.id,
          email: user.email,
          enabledFeatures,
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
