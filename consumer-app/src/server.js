import express from "express";
import crypto from "node:crypto";
import { db } from "./db.js";
import { handleAdminEvent } from "./syncHandlers.js";
import { dashboardHtml } from "./dashboard.js";
import { adminFormHtml } from "./adminForm.js";
import { keycloakAdmin } from "./keycloakAdmin.js";

const PORT = process.env.PORT || 4000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const WEBHOOK_VERIFY = process.env.WEBHOOK_VERIFY === "true";
const SIGNATURE_HEADER = "x-keycloak-signature";

const app = express();

function verifySignature(rawBody, header) {
  if (!header || !WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  const received = header.replace(/^sha256=/, "").trim();
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

app.post("/webhooks/keycloak", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = req.body;
  const signatureHeader = req.headers[SIGNATURE_HEADER];
  const signatureValid = verifySignature(raw, signatureHeader);

  if (WEBHOOK_VERIFY && !signatureValid) {
    db.appendEvent({
      receivedAt: new Date().toISOString(),
      resourceType: "UNKNOWN",
      operationType: "UNKNOWN",
      resourcePath: null,
      syncStatus: "rejected",
      detail: "signature verification failed",
      raw: raw.toString("utf8").slice(0, 2000),
    });
    return res.status(401).json({ error: "invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    return res.status(400).json({ error: `invalid JSON: ${err.message}` });
  }

  // Respond immediately; Keycloak's webhook delivery does not need to wait on our sync work.
  res.status(204).end();

  const record = {
    receivedAt: new Date().toISOString(),
    resourceType: event.resourceType || event["event.resourceType"] || "UNKNOWN",
    operationType: event.operationType || event["event.operationType"] || "UNKNOWN",
    resourcePath: event.resourcePath || null,
    signatureValid,
    raw: JSON.stringify(event).slice(0, 4000),
  };

  try {
    const detail = await handleAdminEvent(event);
    db.appendEvent({ ...record, syncStatus: "ok", detail });
  } catch (err) {
    db.appendEvent({ ...record, syncStatus: "error", detail: err.message });
    console.error("Failed to process admin event:", err);
  }
});

app.get("/state", (_req, res) => {
  res.json({
    customers: db.all("customers"),
    workspaces: db.all("workspaces"),
    users: db.all("users"),
    userWorkspaces: db.all("userWorkspaces"),
  });
});

app.get("/events", (_req, res) => {
  res.json(db.all("webhookEvents"));
});

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.get("/", (_req, res) => {
  res.type("html").send(dashboardHtml);
});

app.get("/admin", (_req, res) => {
  res.type("html").send(adminFormHtml);
});

app.post("/admin/customers/:orgId/contract-features", express.json(), async (req, res) => {
  const { orgId } = req.params;
  const enabled = Array.isArray(req.body?.enabled) ? req.body.enabled : null;
  if (!enabled) return res.status(400).json({ error: "body must be { enabled: string[] }" });

  const org = await keycloakAdmin.getOrganization(orgId);
  if (!org) return res.status(404).json({ error: "customer not found" });

  let contract = {};
  try {
    contract = JSON.parse(org.attributes?.contract?.[0] || "{}");
  } catch {
    contract = {};
  }
  contract.featureSets = enabled;

  const attributes = { ...(org.attributes || {}) };
  attributes.contract = [JSON.stringify(contract)];

  try {
    await keycloakAdmin.updateOrganization(orgId, { ...org, attributes });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`consumer-app listening on :${PORT}`);
  console.log(`webhook verification: ${WEBHOOK_VERIFY ? "enabled" : "disabled (PoC default)"}`);
});
