import { db } from "./db.js";
import { keycloakAdmin } from "./keycloakAdmin.js";

const nowIso = () => new Date().toISOString();

function pathSegments(resourcePath) {
  const parts = (resourcePath || "").split("/").filter(Boolean);
  const segments = {};
  for (let i = 0; i < parts.length; i += 2) segments[parts[i]] = parts[i + 1];
  return segments;
}

async function syncOrganization(orgId, deleted) {
  if (deleted) {
    db.remove("organizations", "kcOrgId", orgId);
    return `organization ${orgId} removed`;
  }
  const org = await keycloakAdmin.getOrganization(orgId);
  if (!org) {
    db.remove("organizations", "kcOrgId", orgId);
    return `organization ${orgId} not found upstream, removed locally`;
  }
  db.upsert("organizations", "kcOrgId", {
    kcOrgId: org.id,
    name: org.name,
    alias: org.alias,
    domain: org.domains?.[0]?.name || null,
    enabled: org.enabled,
    updatedAt: nowIso(),
  });
  return `organization "${org.name}" synced`;
}

async function syncOrganizationMembership(orgId, userId, deleted) {
  if (deleted) {
    db.remove("memberships", "id", `${orgId}:${userId}`);
    return `membership ${userId} removed from org ${orgId}`;
  }
  const user = await keycloakAdmin.getUser(userId);
  if (!user) return `user ${userId} not found upstream, skipped`;

  db.upsert("users", "kcUserId", {
    kcUserId: user.id,
    username: user.username,
    email: user.email || null,
    updatedAt: nowIso(),
  });

  const roleMappings = (await keycloakAdmin.getUserRealmRoles(userId)) || [];
  db.upsert("memberships", "id", {
    id: `${orgId}:${userId}`,
    organizationId: orgId,
    userId,
    username: user.username,
    roles: roleMappings.map((r) => r.name),
    updatedAt: nowIso(),
  });
  return `membership synced: ${user.username} -> org ${orgId}`;
}

async function syncGroup(groupId, deleted) {
  if (deleted) {
    db.remove("subscriptions", "kcGroupId", groupId);
    return `subscription group ${groupId} removed`;
  }
  const group = await keycloakAdmin.getGroup(groupId);
  if (!group) {
    db.remove("subscriptions", "kcGroupId", groupId);
    return `group ${groupId} not found upstream, removed locally`;
  }
  if (!group.path?.startsWith("/subscriptions/")) {
    return `group "${group.path}" is not a subscription group, ignored`;
  }
  const attrs = group.attributes || {};
  const organizationId = attrs.organization_id?.[0] || null;
  if (!organizationId) {
    return `subscription group "${group.path}" has no organization_id attribute, skipped`;
  }
  db.upsert("subscriptions", "kcGroupId", {
    kcGroupId: group.id,
    organizationId,
    plan: attrs.plan?.[0] || group.name,
    seats: attrs.seats?.[0] ? Number(attrs.seats[0]) : null,
    path: group.path,
    updatedAt: nowIso(),
  });
  return `subscription "${group.path}" synced for org ${organizationId}`;
}

async function refreshUserRoles(userId) {
  const roleMappings = (await keycloakAdmin.getUserRealmRoles(userId)) || [];
  const roleNames = roleMappings.map((r) => r.name);
  const memberships = db.all("memberships").filter((m) => m.userId === userId);
  for (const m of memberships) {
    db.upsert("memberships", "id", { ...m, roles: roleNames, updatedAt: nowIso() });
  }
  return `roles refreshed for user ${userId}: [${roleNames.join(", ")}]`;
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
    username: user.username,
    email: user.email || null,
    updatedAt: nowIso(),
  });
  return `user "${user.username}" synced`;
}

export async function handleAdminEvent(event) {
  const { resourceType, operationType, resourcePath } = event;
  const deleted = operationType === "DELETE";
  const segments = pathSegments(resourcePath);

  switch (resourceType) {
    case "ORGANIZATION":
      return syncOrganization(segments.organizations, deleted);

    case "ORGANIZATION_MEMBERSHIP": {
      // Keycloak's CREATE event for this resource is a POST to the members
      // *collection*, so resourcePath has no trailing user id — resolve it
      // from event.details.username instead. DELETE targets the specific
      // member resource, so the id is present in the path as usual.
      let userId = segments.members;
      if (!userId && event.details?.username) {
        const user = await keycloakAdmin.getUserByUsername(event.details.username);
        userId = user?.id;
      }
      if (!userId) return `could not resolve member for org ${segments.organizations}, skipped`;
      return syncOrganizationMembership(segments.organizations, userId, deleted);
    }

    case "GROUP":
      return syncGroup(segments.groups, deleted);

    case "GROUP_MEMBERSHIP":
      // resourcePath: users/{userId}/groups/{groupId}
      if (segments.groups) await syncGroup(segments.groups, false);
      return `group membership change for user ${segments.users} observed`;

    case "USER":
      return syncUser(segments.users, deleted);

    case "REALM_ROLE_MAPPING":
      if (resourcePath?.endsWith("/role-mappings/realm") && segments.users) {
        return refreshUserRoles(segments.users);
      }
      return `unhandled realm role mapping path: ${resourcePath}`;

    default:
      return `ignored resourceType=${resourceType} path=${resourcePath}`;
  }
}
