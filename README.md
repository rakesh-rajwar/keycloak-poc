# Phase 1 PoC — Keycloak as Out-of-Band Source of Truth

Proof of concept for **Phase 1** of [Centralizing Identity, Memberships & Authorization with Keycloak](https://onclusive.atlassian.net/wiki/spaces/Applicatio/pages/5590646787).

Phase 1 scope, from the proposal:

- Users keep authenticating against **Auth0** — nothing about login changes.
- **Ops** uses the **Keycloak Admin UI** (or REST API) to manually create Organizations, set subscription/plan attributes, and manage user memberships.
- Keycloak fires **Admin Event Webhooks** on every change.
- **Downstream consumer apps** listen for those webhooks and keep their own local DB tables in sync — no direct DB writes from Keycloak, no app rewrite required.

This PoC stands up that whole loop end to end so you can watch it happen.

## Stack

| service | role |
|---|---|
| `postgres` | Keycloak's backing store |
| `keycloak` | Keycloak 26.6.3 + the [`keycloak-events`](https://github.com/p2-inc/keycloak-events) extension (built from source at `v0.62`, the release matching this Keycloak version — real HTTP webhook delivery for admin events), Organizations enabled (GA since 26.0), `onclusive-poc` realm pre-imported |
| `consumer-app` | Stand-in for a "legacy downstream app." Receives webhook calls, resolves the change against the Keycloak Admin REST API, and upserts its own local tables (`customers`, `workspaces`, `users`, `userWorkspaces`) — this is the thing Phase 1 is actually validating |

## Data model: mirrors GUM (`claim`), not a generic example

Onclusive already has a real, working system for this — [`shared-services/claim`](../shared-services/claim) ("GUM" — Global User Management) — with its own MySQL tables and a webhook fan-out engine (`src/utils/event-fanout.ts`). Rather than invent placeholder entities, this PoC's Keycloak model mirrors GUM's real hierarchy 1:1, so it doubles as a concrete answer to "how would this hierarchy actually work in Keycloak":

| GUM (`claim`) entity | Keycloak equivalent used here |
|---|---|
| `customers` (businessName, salesforceId, isActive, inactiveReason) | Native **Organization** — `businessName`→`name`, `isActive`→**Keycloak's own `enabled` field** (not a custom attribute — see below), `salesforceId`/`contract` as `attributes` (verified live: Organizations accept arbitrary string-array attributes) |
| `contracts` (1:1 per customer — name, dates, featureSets/permissions/baseLimits) | No native Keycloak entity, so flattened onto the customer Organization as one `contract` JSON-string attribute |
| `workspaces` (customerId FK, isDefault, featureOverrides) | **Organization-scoped Group** — Keycloak 26.6+'s `/organizations/{orgId}/groups`, a structural match for `workspaces.customerId` (replaces an earlier, less faithful design that linked a plain top-level group back to an org via attribute) |
| `userWorkspaces` (M:N users↔workspaces) | Membership in the organization-scoped group. **Caveat found by testing**: Keycloak requires the user to already be a plain Organization member before they can be added to one of its groups (`"User is not member of the organization"` if not) — GUM itself has no users↔customers table, so that prerequisite membership is pure Keycloak plumbing with nothing to sync; `syncHandlers.js` explicitly no-ops it |
| `features`, `contractFeatures`, `contractTemplates` | Out of scope — app-side reference/catalog data, not identity data. The consumer-app instead computes `enabledFeatures` per `userWorkspace` by reading the customer's `contract.featureSets`, filtered by the workspace's own `featureOverrides` — the same relationship GUM's schema comment describes ("Override inherited Contract features") |

This answers one of the proposal doc's open questions with a concrete design — see [Proposed webhook payload / linkage schema](#proposed-webhook-payload--linkage-schema) below.

### Why `isActive` uses Keycloak's native `enabled`, not a custom attribute

Deliberate choice: prefer native Keycloak fields over custom attributes wherever one actually fits, rather than reinventing storage Keycloak already provides. `isActive` is stored as-is on the Organization's built-in `enabled` boolean rather than an `attributes.isActive` string.

One nuance worth being explicit about: this is **not** semantically identical to what `isActive` means in GUM today. GUM's `isActive` is a *computed* state — `checkAndUpdateAccountActivation()` derives it from five criteria (valid contract, contract reaches an enabled feature, has a workspace, has a user, etc.), auto-deactivates on failure, and only ever re-activates via an explicit manual check. Keycloak's `enabled` is just a flat admin on/off switch with no derivation logic behind it. This PoC doesn't reproduce GUM's activation-derivation rules (same scoping call as the reachability gap below) — `enabled` is simply the closest native field to point `isActive` at, not a re-implementation of the business rule.

### `enabledFeatures` recomputation on contract/override changes

`enabledFeatures` is recomputed for every affected `userWorkspace` whenever the customer's `contract` attribute changes (`ORGANIZATION` update → `recomputeEnabledFeaturesForCustomer()`) or a workspace's `featureOverrides` changes (`ORGANIZATION_GROUP` update → `recomputeEnabledFeaturesForWorkspace()`), not just at the moment a membership is created. Verified live both directions: changing a contract's `featureSets` updates every existing membership under that customer in the same webhook round-trip, and clearing a workspace's `featureOverrides` does the same for every membership in that workspace.

This is a **bounded, on-demand recompute** — it re-derives the affected rows already stored locally — not GUM's full reachability-diffing engine (`event-fanout.ts`), which additionally diffs before/after snapshots to fire precise per-user `created`/`updated`/`deleted` events to *downstream apps*. This PoC's consumer-app updates its own table silently; it doesn't re-emit anything onward. A real Phase 1 implementation serving multiple downstream apps still needs that diffing/re-emission layer — this only fixes the "is the data itself stale" half of the gap, not the "does anyone get told about it" half.

## Run it

```bash
docker compose up --build -d
```

First build compiles the `keycloak-events` extension from source against the matching Keycloak version (~1-2 minutes); after that it's cached.

Wait for Keycloak to report healthy (`docker compose ps`), then register the webhook subscription (the extension's config isn't part of a standard realm export, so it's wired up via a REST call):

```bash
./scripts/register-webhook.sh
```

Open the downstream app's live view: **http://localhost:4000** — this table is empty until Keycloak fires events.

Now either:

- **Click through it yourself**: open the Keycloak Admin UI at **http://localhost:8080** (`admin` / `admin`), realm `onclusive-poc` → Organizations → create one (leave "Enabled" on), add `salesforceId`/`contract` attributes, create a group under it (a workspace), add a user as an org member first, then to the group — or
- **Run the scripted version** of the same steps:

  ```bash
  ./scripts/demo.sh
  ```

Watch http://localhost:4000 update within a couple seconds of each change — that's the webhook firing and the consumer-app syncing its local tables, with zero direct DB access and zero app-specific Keycloak polling.

Raw event log (useful for debugging payload shape): `curl -s localhost:4000/events | jq`
Current local-table state: `curl -s localhost:4000/state | jq`

`scripts/demo.sh` creates "Acme Corp" by a fixed alias, so it's only idempotent against a fresh realm. To reset everything (Keycloak data, the extension's webhook registration, and the consumer-app's local tables) and start over: `docker compose down -v && docker compose up --build -d`, then re-run `register-webhook.sh` and `demo.sh`.

## Proposed webhook payload / linkage schema

Answering the doc's question 2 ("what standard JSON payload schema should Keycloak emit via webhooks for app local sync?"): this PoC doesn't invent a new payload — it uses Keycloak's **native admin event shape** (`resourceType`, `operationType`, `resourcePath`, `representation`, plus the `keycloak-events` extension's HMAC signature header) and treats the event as a *change notification*, not a full snapshot. The consumer-app always re-fetches the authoritative object from the Admin REST API rather than trusting embedded event data (except to resolve an id missing from a collection-POST event's `resourcePath` — see below), which sidesteps versioning/drift issues if the event body's shape changes across Keycloak upgrades.

Two real gaps in Keycloak's own event shape, found only by triggering each event live and reading `/events`, that any consumer needs to handle:
- **CREATE events on a collection endpoint have no id in `resourcePath`.** `POST /organizations/{orgId}/members` and `POST /organizations/{orgId}/groups` both fire events whose `resourcePath` stops at the collection name. The added member's id has to come from `event.details.username` (then a lookup); the created group's id from parsing `event.representation`. Every other verb (UPDATE/DELETE, and CREATE on a nested resource like `.../groups/{id}/members/{userId}`) does include the full id chain in `resourcePath`. `syncHandlers.js`'s `pathSegments()` + these two fallbacks are the reusable pattern here.
- GUM's own webhook schema (`webhooks-v1.ts`) is a much stronger design worth comparing against: versioned (`schemaVersion`), a closed `EventType` enum (`customer.created`, `workspace.updated`, `grant.deleted`, …), stable `ids` keyed by GUM's own entity names, and a `changes: {field: {from, to}}` diff on updates. Keycloak's raw admin events give you none of that — just "something changed at this path." If Phase 1 downstream apps are expected to consume a *stable* contract long-term, wrapping Keycloak's raw events in a GUM-shaped envelope (translate `resourceType`+`operationType` → a GUM-style `event` enum) is worth more than exposing Keycloak's native event shape directly.

## Known PoC simplifications (do not carry into production)

- `admin`/`admin` Keycloak bootstrap credentials, and `poc-webhook-consumer-secret` / `poc-shared-webhook-secret` in plaintext in `docker-compose.yml`.
- The `webhook-consumer` service account is granted the `realm-admin` composite role for simplicity. Scope this down to `view-users`, `view-realm`, `view-organizations` for real use.
- `WEBHOOK_VERIFY=true` by default, confirmed working against a live instance (`X-Keycloak-Signature: <hex HMAC-SHA256>` of the raw body — see `consumer-app/src/server.js`). Still PoC-grade: the shared secret is a plaintext demo value, not pulled from a vault.
- consumer-app's "local DB" is a JSON file, not a real RDBMS — swap `src/db.js` for Postgres/MySQL in a real downstream app; the sync *logic* (`syncHandlers.js`) is what's meant to be reusable.
- No retry/dead-letter handling if the consumer-app is down when a webhook fires — Phase 1 in production needs at-least-once delivery semantics or a periodic reconciliation job as a backstop.

## Repo layout

```
docker-compose.yml
keycloak/
  Dockerfile              # base Keycloak + keycloak-events webhook extension
  import/onclusive-poc-realm.json   # realm, organizationsEnabled, service account client
consumer-app/
  src/server.js           # webhook receiver + /state + /events + dashboard
  src/syncHandlers.js      # per-resourceType sync logic, GUM-shaped (the reusable part)
  src/keycloakAdmin.js     # Admin REST client (client-credentials)
  src/db.js                # local "table" storage (JSON file, swap for real DB)
  src/dashboard.js         # live HTML view of the synced tables
scripts/
  demo.sh                  # scripts the "ops admin" actions via REST, GUM-shaped
  register-webhook.sh      # registers consumer-app as a webhook subscriber
```
