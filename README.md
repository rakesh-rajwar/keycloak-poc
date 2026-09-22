# Phase 1 PoC — Keycloak as Out-of-Band Source of Truth

Proof of concept for **Phase 1** of [Centralizing Identity, Memberships & Authorization with Keycloak](https://onclusive.atlassian.net/wiki/spaces/Applicatio/pages/5590646787).

Phase 1 scope, from the proposal:

- Users keep authenticating against **Auth0** — nothing about login changes.
- **Ops** uses the **Keycloak Admin UI** (or REST API) to manually create Organizations, set subscription/plan attributes, and manage user memberships & roles.
- Keycloak fires **Admin Event Webhooks** on every change.
- **Downstream consumer apps** listen for those webhooks and keep their own local DB tables in sync — no direct DB writes from Keycloak, no app rewrite required.

This PoC stands up that whole loop end to end so you can watch it happen.

## Stack

| service | role |
|---|---|
| `postgres` | Keycloak's backing store |
| `keycloak` | Keycloak 26.6.3 + the [`keycloak-events`](https://github.com/p2-inc/keycloak-events) extension (built from source at `v0.62`, the release matching this Keycloak version — real HTTP webhook delivery for admin events), Organizations enabled (GA since 26.0), `onclusive-poc` realm pre-imported |
| `consumer-app` | Stand-in for a "legacy downstream app." Receives webhook calls, resolves the change against the Keycloak Admin REST API, and upserts its own local tables (`organizations`, `subscriptions`, `users`, `memberships`) — this is the thing Phase 1 is actually validating |

## Data model used in this PoC

- **Organization** → Keycloak's native `Organization` entity (`/admin/realms/{realm}/organizations`).
- **Subscription / plan** → a Keycloak **Group** under `/subscriptions/*`, carrying attributes `organization_id`, `plan`, `seats`. Groups don't nest under Organizations natively in Keycloak, so the link is attribute-based — the consumer-app resolves it by reading `organization_id` off the group.
- **User Membership & Roles** → Organization membership (`/organizations/{id}/members`) plus realm role mappings (`org-admin`, `org-member`).

This answers one of the doc's open questions with a concrete proposal — see [Proposed webhook payload / linkage schema](#proposed-webhook-payload--linkage-schema) below.

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

- **Click through it yourself**: open the Keycloak Admin UI at **http://localhost:8080** (`admin` / `admin`), realm `onclusive-poc`, and create an Organization, a group under `/subscriptions` with `organization_id`/`plan`/`seats` attributes, a user, add them to the org, assign a role — or
- **Run the scripted version** of the same steps:

  ```bash
  ./scripts/demo.sh
  ```

Watch http://localhost:4000 update within a couple seconds of each change — that's the webhook firing and the consumer-app syncing its local tables, with zero direct DB access and zero app-specific Keycloak polling.

Raw event log (useful for debugging payload shape): `curl -s localhost:4000/events | jq`
Current local-table state: `curl -s localhost:4000/state | jq`

`scripts/demo.sh` creates "Acme Corp" by a fixed alias, so it's only idempotent against a fresh realm. To reset everything (Keycloak data, the extension's webhook registration, and the consumer-app's local tables) and start over: `docker compose down -v && docker compose up --build -d`, then re-run `register-webhook.sh` and `demo.sh`.

## Proposed webhook payload / linkage schema

Answering the doc's question 2 ("what standard JSON payload schema should Keycloak emit via webhooks for app local sync?"): this PoC doesn't invent a new payload — it uses Keycloak's **native admin event shape** (`resourceType`, `operationType`, `resourcePath`, plus the `keycloak-events` extension's HMAC signature header) and treats the event as a *change notification*, not a full snapshot. The consumer-app always re-fetches the authoritative object from the Admin REST API rather than trusting embedded event data, which sidesteps versioning/drift issues if the event body's shape changes across Keycloak upgrades. The one schema convention this PoC *does* introduce, because Keycloak has no native concept of it, is the **group ↔ organization link**: any group representing a subscription must live under `/subscriptions/*` and carry an `organization_id` attribute pointing at the owning Organization's UUID. That convention — not a payload format — is the thing worth ratifying org-wide before other apps build sync logic against it.

## Known PoC simplifications (do not carry into production)

- `admin`/`admin` Keycloak bootstrap credentials, and `poc-webhook-consumer-secret` / `poc-shared-webhook-secret` in plaintext in `docker-compose.yml`.
- The `webhook-consumer` service account is granted the `realm-admin` composite role for simplicity. Scope this down to `view-users`, `query-groups`, `view-realm`, `view-organizations` for real use.
- `WEBHOOK_VERIFY=true` by default, confirmed working against a live instance (`X-Keycloak-Signature: <hex HMAC-SHA256>` of the raw body — see `consumer-app/src/server.js`). Still PoC-grade: the shared secret is a plaintext demo value, not pulled from a vault.
- consumer-app's "local DB" is a JSON file, not a real RDBMS — swap `src/db.js` for Postgres/MySQL in a real downstream app; the sync *logic* (`syncHandlers.js`) is what's meant to be reusable.
- No retry/dead-letter handling if the consumer-app is down when a webhook fires — Phase 1 in production needs at-least-once delivery semantics or a periodic reconciliation job as a backstop.

## Repo layout

```
docker-compose.yml
keycloak/
  Dockerfile              # base Keycloak + keycloak-events webhook extension
  import/onclusive-poc-realm.json   # realm, roles, /subscriptions group, service account client
consumer-app/
  src/server.js           # webhook receiver + /state + /events + dashboard
  src/syncHandlers.js      # per-resourceType sync logic (the reusable part)
  src/keycloakAdmin.js     # Admin REST client (client-credentials)
  src/db.js                # local "table" storage (JSON file, swap for real DB)
  src/dashboard.js         # live HTML view of the synced tables
scripts/
  demo.sh                  # scripts the "ops admin" actions via REST
  register-webhook.sh      # registers consumer-app as a webhook subscriber
```
