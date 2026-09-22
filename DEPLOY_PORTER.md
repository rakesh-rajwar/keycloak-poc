# Deploying this PoC to Porter (demo only)

Two apps, no database service — Keycloak's `start-dev` falls back to its
embedded dev-file store automatically when `KC_DB`/`KC_DB_URL` aren't set,
so there's nothing extra to provision. consumer-app's "DB" is already just
a JSON file (`src/db.js`), so it needs nothing either.

**Data is ephemeral** on both apps — a redeploy/restart resets Keycloak's
realm data back to the imported baseline and wipes consumer-app's synced
tables. Fine for a demo; re-run `scripts/demo.sh` after any redeploy.

## 1. Create the two apps

From the repo root, once `porter` is authed against your new project/cluster:

```bash
porter create web --app keycloak-poc-idp \
  --dockerfile ./keycloak/Dockerfile \
  --path ./keycloak

porter create web --app keycloak-poc-consumer \
  --dockerfile ./consumer-app/Dockerfile \
  --path ./consumer-app
```

Each `porter create` builds and deploys immediately; note the public HTTPS
URL Porter assigns to each (visible in `porter app list` or the dashboard) —
you'll need both below.

## 2. Configure `keycloak-poc-idp` env vars (dashboard or `porter update`)

```
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=admin
KC_HOSTNAME_STRICT=false
KC_HTTP_ENABLED=true
KC_HEALTH_ENABLED=true
```

Deliberately **omit** `KC_DB`/`KC_DB_URL`/`KC_DB_USERNAME`/`KC_DB_PASSWORD`
— that's what triggers the embedded dev store. Set the container's start
command / port to match `docker-compose.yml`: `start-dev --import-realm`,
port `8080`.

## 3. Configure `keycloak-poc-consumer` env vars

```
PORT=4000
KEYCLOAK_BASE_URL=<keycloak-poc-idp's public URL from step 1>
KEYCLOAK_REALM=onclusive-poc
KEYCLOAK_CLIENT_ID=webhook-consumer
KEYCLOAK_CLIENT_SECRET=poc-webhook-consumer-secret
WEBHOOK_SECRET=poc-shared-webhook-secret
WEBHOOK_VERIFY=true
DB_PATH=/data/consumer-app-db.json
```

Port `4000`.

## 4. Register the webhook (once, pointed at the public consumer-app URL)

Same as local, but `WEBHOOK_URL` now needs the real public address instead of
the docker-compose-internal `http://consumer-app:4000/...`:

```bash
KC_URL=<keycloak-poc-idp's public URL> \
WEBHOOK_URL=<keycloak-poc-consumer's public URL>/webhooks/keycloak \
  ./scripts/register-webhook.sh
```

## 5. Run the demo

```bash
KC_URL=<keycloak-poc-idp's public URL> ./scripts/demo.sh
```

Then open `<keycloak-poc-consumer's public URL>` for the live dashboard.

## Known gaps vs. local docker-compose

- **No persistence.** Local uses named volumes (`pgdata`, `consumerdata`); this setup has neither. A restart loses all demo data — re-run step 5.
- **Credentials are still the same PoC-grade plaintext values** (`admin`/`admin`, `poc-webhook-consumer-secret`, `poc-shared-webhook-secret`) — now reachable over the public internet, not just `localhost`. Fine for a short-lived demo link you tear down after; not something to leave running.
- If you'd rather have real persistence, swap Keycloak's env vars back to the `KC_DB=postgres` block from `docker-compose.yml` and attach a Porter-managed Postgres add-on instead of skipping it — everything else in this doc stays the same.
