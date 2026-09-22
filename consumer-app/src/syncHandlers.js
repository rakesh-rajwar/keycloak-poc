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

async function syncCustomer(orgId, deleted) {
  if (deleted) {
    db.remove("customers", "kcOrgId", orgId);
    return `customer ${orgId} removed`;
  }
  const org = await keycloakAdmin.getOrganization(orgId);
  if (!org) {
    db.remove("customers", "kcOrgId", orgId);
    return `customer ${orgId} not found upstream, removed locally`;
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
    return `workspace ${groupId} removed`;
  }
  const group = await keycloakAdmin.getOrganizationGroup(orgId, groupId);
  if (!group) {
    db.remove("workspaces", "kcGroupId", groupId);
    return `workspace ${groupId} not found upstream, removed locally`;
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
