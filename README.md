# 360 Platform PoC — Keycloak as Unified Identity & Authorization Master

Proof of concept for the **"Unified Authorization & Identity Migration"** plan: Keycloak as the centralized customer/workspace/user hierarchy and authorization master, Auth0 staying in place for login (that migration is explicitly Phase 4, out of scope here), with static entitlements synced out to downstream apps via Admin Event Webhooks.

- Users keep authenticating against **Auth0** — nothing about login changes (Phase 1-3 of the plan).
- **Ops** (or, later, customers themselves via a portal) uses the **Keycloak Admin API** to create customers, set entitlements, and manage sub-team/agency workspaces.
- Keycloak fires **Admin Event Webhooks** on every change.
- **Downstream consumer apps** listen for those webhooks and keep their own local DB tables in sync — no direct DB writes from Keycloak, no app rewrite required.

This PoC stands up that whole loop end to end, seeded with the plan doc's own worked examples, so you can watch it happen.

## Stack

| service | role |
|---|---|
| `postgres` | Keycloak's backing store |
| `keycloak` | Keycloak 26.6.3 + the [`keycloak-events`](https://github.com/p2-inc/keycloak-events) extension (built from source at `v0.62`, the release matching this Keycloak version — real HTTP webhook delivery for admin events), Organizations enabled (GA since 26.0), realm `360-platform` pre-imported |
| `consumer-app` | Stand-in for a "legacy downstream app" (the plan doc's Phase 1 point 3, "Legacy Application Sync Handlers"). Receives webhook calls, resolves the change against the Keycloak Admin REST API, and upserts its own local tables — this is the thing the plan is actually validating. Also hosts a small **Customer Admin Portal** (`/admin`), standing in for the doc's Phase 1 point 4 ("Build Customer Admin Portal in 360 Shell") until an actual 360 Micro-Frontend Shell exists |

## Data model: the plan doc's own vocabulary and worked examples, not invented ones

| Plan doc concept | Keycloak equivalent used here |
|---|---|
| Customer (Phase 0's "Organization/Tenant record") | Native **Organization** — `businessName`→`name`, `isActive`→Keycloak's own `enabled` field (a native field, not a custom attribute — verified: Organizations accept arbitrary string-array attributes for everything else) |
| **Legacy Mapping Dictionary** (Phase 0, point 3) | An `legacyMapping` JSON attribute on the Organization, holding `master_account_id`/`master_account_name`/`legacy_app_mappings` verbatim from the doc's own example |
| **Static Entitlements** (Phase 1/3's core architectural split — "Centralized in Keycloak") | An `entitlements` JSON attribute on the Organization: `{ web_media: {access,tier,search_limit}, social_media: {access,role} }`, the doc's own `USER_ENTITLEMENT_UPDATED` payload shape |
| Internal sub-team / invited external agency (Phase 0 point 4, Phase 1 point 4) | **Organization-scoped Group** (Keycloak 26.6+'s `/organizations/{orgId}/groups`) — `isExternal` attribute distinguishes an invited agency from an internal sub-team; `featureOverrides` restricts it below the customer's entitlements |
| **Dynamic Usage Metering** (Phase 3 — "Maintained in Local App DBs", *never* centralized) | A `usage` field on each `userWorkspace` row, mutated **only** by `POST /admin/user-workspaces/:id/simulate-usage` — never read from or written to Keycloak. See "The static/dynamic split" below |
| User↔workspace membership | Membership in the organization-scoped group. **Caveat found by testing**: Keycloak requires the user to already be a plain Organization member before they can be added to one of its groups (`"User is not member of the organization"` if not) — there's no local table for that prerequisite membership itself, `syncHandlers.js` explicitly no-ops it |

### The static/dynamic split (Phase 3's core architectural concept)

The plan doc is explicit about why this split exists: *"To avoid severe database write-locks and latency bottlenecks in the central identity provider"* — static entitlements (plan caps like `search_limit: 100`) live in Keycloak; the actual usage counter (`current_month_searches: 42`) must never round-trip through it. This PoC enforces that as code, not just policy: every function in `syncHandlers.js` that recomputes `entitlements` explicitly preserves the sibling `usage` field by spreading the existing row rather than overwriting it — verified live, including through a full `resyncAll()` wipe-and-rebuild, which is the case most likely to accidentally clobber it.

### Why `isActive` uses Keycloak's native `enabled`, not a custom attribute

Deliberate choice: prefer native Keycloak fields over custom attributes wherever one actually fits. `isActive` is stored as-is on the Organization's built-in `enabled` boolean.

### `entitlements` recomputation on customer/workspace changes

Effective `entitlements` on a `userWorkspace` are recomputed whenever the customer's `entitlements` attribute changes (`ORGANIZATION` update) or a workspace's `featureOverrides` changes (`ORGANIZATION_GROUP` update), not just at the moment a membership is created — a per-module shallow merge (`{...customerModule, ...workspaceOverrideModule}`), so a workspace can restrict `access`, downgrade `tier`, or lower `search_limit` independently per module. Verified live both directions.

This is a **bounded, on-demand recompute** — it re-derives the affected rows already stored locally, it doesn't re-emit anything to *other* downstream apps. A real implementation serving multiple consumers still needs a diffing/re-emission layer on top of this.

## Run it

```bash
docker compose up --build -d
```

First build compiles the `keycloak-events` extension from source against the matching Keycloak version (~1-2 minutes); after that it's cached.

Wait for Keycloak to report healthy (`docker compose ps`), then register the webhook subscription (the extension's config isn't part of a standard realm export, so it's wired up via a REST call):

```bash
./scripts/register-webhook.sh
```

Registration is REST-only — confirmed there's no Admin Console page for it (only the *event listener* toggle in Realm Settings → Events has a UI; the actual subscription URL/secret does not). It's additive, not a single slot: `./scripts/register-webhook.sh <url> <secret> [eventTypes]` adds a second (or third...) independent consumer without touching the first. `eventTypes` is comma-separated, default `*`.

Seed the plan doc's worked examples:

```bash
./scripts/demo.sh       # ACME Corporation - the doc's own Legacy Mapping Dictionary example verbatim,
                         # plus Marketing/Legal sub-teams and one restricted external PR agency
node scripts/seed.js    # two more customers with different entitlement mixes, for variety
```

Then:

| What | URL |
|---|---|
| Keycloak Admin Console | http://localhost:8080 (`admin`/`admin`, realm `360-platform`) |
| Downstream app's live view | http://localhost:4000 |
| Customer Admin Portal | http://localhost:4000/admin |

Watch http://localhost:4000 update within a couple seconds of each change — that's the webhook firing and the consumer-app syncing its local tables, with zero direct DB access and zero app-specific Keycloak polling.

### Customer Admin Portal: global entitlements + sub-group overrides

Keycloak's own Attributes tab (both for Organizations and Groups) is a fixed generic key/value text editor — no config or theming hook exists to render a specific attribute as anything richer. `/admin` is a small purpose-built form instead, with two sections matching the plan doc's two tiers:

- **Global entitlements (customer level)** — pick a customer, set `access`/`tier`/`search_limit` for Web Media and `access`/`role` for Social Media, save. PATCHes the Organization's `entitlements` attribute via the Admin REST API.
- **Sub-group overrides (workspace level)** — pick a workspace, override any field below the customer's global value (a 3-state control: "(inherit)" / explicit value), save. PATCHes the org-scoped Group's `featureOverrides` attribute.

Both flow back through the normal webhook sync (~2s), same as every other change in this PoC — including the `entitlements` recomputation for every affected `userWorkspace`, verified live by editing a `search_limit` and confirming it propagated to the affected user's row.

**Invite external PR agencies by email** (the plan doc's Phase 1 point 4): Keycloak Organizations has this natively — `POST /admin/realms/{realm}/organizations/{orgId}/members/invite-user` (email, firstName, lastName). Confirmed live: the endpoint is real and processes correctly (`org.keycloak.organization.admin.resource.OrganizationInvitationResource.inviteUser`), it only fails because this stack's dev Keycloak has no SMTP server configured to actually deliver the email. This PoC's seed data adds external agency members directly (same mechanic as any other member) rather than exercising the real invite-email flow, which would need a mail server (e.g. Mailpit) added to the stack — a reasonable next increment, not yet built.

### `POST /admin/resync` / the dashboard's "Full resync" button

Found live: deleting an Organization in Keycloak does **not** fire separate `ORGANIZATION_GROUP`/`ORGANIZATION_GROUP_MEMBERSHIP` delete events for its child org-groups — they just vanish upstream. `syncHandlers.js` cascades those deletes locally when it does see an `ORGANIZATION`/`ORGANIZATION_GROUP` delete event, but anything already orphaned before that (or from a missed webhook delivery) needs a repair path. `resyncAll()` walks every Organization → its org-groups → their members currently in Keycloak and rebuilds every table from scratch (wipe-and-rebuild, not additive upserts), **except** each `userWorkspace`'s `usage` counter, which is explicitly carried over — verified live through an actual resync.

One non-obvious wrinkle it has to work around: Keycloak's **list** endpoints (`/organizations`, `/organizations/{id}/groups`) return abbreviated representations with no `attributes` field at all — the full `entitlements`/`legacyMapping`/`featureOverrides` data only comes back from the single-entity detail GET, so a full resync means one extra fetch per org and per group.

Raw event log (useful for debugging payload shape): `curl -s localhost:4000/events | jq`
Current local-table state: `curl -s localhost:4000/state | jq`

`scripts/demo.sh` creates "ACME Corporation" by a fixed alias, so it's only idempotent against a fresh realm. To reset everything and start over: `docker compose down -v && docker compose up --build -d`, then re-run `register-webhook.sh`, `demo.sh`, and `seed.js`.

## Webhook payload / linkage schema

This PoC's webhooks use Keycloak's **native admin event shape** (`resourceType`, `operationType`, `resourcePath`, `representation`, plus the `keycloak-events` extension's HMAC signature header), not the plan doc's proposed `USER_ENTITLEMENT_UPDATED` envelope — the consumer-app always re-fetches the authoritative object from the Admin REST API rather than trusting embedded event data.

Two real gaps in Keycloak's own event shape, found only by triggering each event live and reading `/events`:
- **CREATE events on a collection endpoint have no id in `resourcePath`.** `POST /organizations/{orgId}/members` and `POST /organizations/{orgId}/groups` both fire events whose `resourcePath` stops at the collection name. The added member's id has to come from `event.details.username` (then a lookup); the created group's id from parsing `event.representation`. `syncHandlers.js`'s `pathSegments()` + these two fallbacks are the reusable pattern.
- **If downstream apps need a stable, versioned contract**, translating Keycloak's raw events into the plan doc's own `USER_ENTITLEMENT_UPDATED` shape (`eventType`, `timestamp`, `userId`, `accountId`, `entitlements`) at the point they leave `consumer-app` — rather than each app parsing Keycloak's native shape itself — is a real, buildable next increment this PoC doesn't yet do.

## Known PoC simplifications (do not carry into production)

- `admin`/`admin` Keycloak bootstrap credentials, and plaintext demo secrets in `docker-compose.yml`.
- The `webhook-consumer` service account is granted the `realm-admin` composite role for simplicity. Scope this down to `view-users`, `view-realm`, `view-organizations` for real use.
- `WEBHOOK_VERIFY=true` by default, confirmed working against a live instance (`X-Keycloak-Signature: <hex HMAC-SHA256>` of the raw body).
- consumer-app's "local DB" is a JSON file, not a real RDBMS — swap `src/db.js` for Postgres/MySQL in a real downstream app; the sync *logic* (`syncHandlers.js`) is what's meant to be reusable.
- No retry/dead-letter handling if the consumer-app is down when a webhook fires.
- `/admin` (the Customer Admin Portal) has **no authentication at all** — anyone who can reach consumer-app can edit any customer's entitlements. A real portal needs the roles the plan doc itself doesn't specify yet either.
- Invite-by-email is confirmed to work at the Keycloak API level but isn't exercised end-to-end here (no SMTP server in the stack).
- Phase 0 (reconciliation across real legacy app databases), Phase 2 (real Salesforce sync), and Phase 4 (real Auth0 bulk migration) are **not** attempted — each needs a real external system this PoC has no access to; simulating them with fake data wouldn't validate anything.

## Repo layout

```
docker-compose.yml
keycloak/
  Dockerfile              # base Keycloak + keycloak-events webhook extension
  import/360-platform-realm.json   # realm, organizationsEnabled, service account client
consumer-app/
  src/server.js             # webhook receiver + /state + /events + dashboard + admin routes
  src/syncHandlers.js        # per-resourceType sync logic, static/dynamic split (the reusable part)
  src/keycloakAdmin.js       # Admin REST client (client-credentials)
  src/db.js                  # local "table" storage (JSON file, swap for real DB)
  src/dashboard.js           # live HTML view of the synced tables + usage simulator
  src/adminForm.js           # /admin - Customer Admin Portal (global entitlements + sub-group overrides)
  src/entitlementCatalog.js  # web_media/social_media module+field schema, from the plan doc's own example
scripts/
  demo.sh                    # seeds ACME Corporation per the plan doc's worked example
  seed.js                    # adds 2 more varied customers/workspaces/users
  register-webhook.sh        # registers consumer-app (or any other app) as a webhook subscriber
```
