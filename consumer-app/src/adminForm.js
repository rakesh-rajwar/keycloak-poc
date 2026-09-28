import { ENTITLEMENT_CATALOG } from "./entitlementCatalog.js";

// Stand-in for the plan doc's "Customer Admin Portal in 360 Shell"
// (Phase 1, point 4) - same architecture the doc describes (a UI backed
// by the Keycloak Admin REST API via service-account credentials), just
// living in consumer-app for now instead of an actual 360 Micro-Frontend
// Shell, which doesn't exist here. Two sections mirror the doc's two
// tiers: "global" = customer-level static entitlements (Keycloak's
// source of truth), "sub-group" = workspace-level restrictions on top of
// them (internal sub-teams or invited external agencies).
export const adminFormHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>360 Platform - Customer Admin Portal</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; background: #0b0f14; color: #e6edf3; max-width: 720px; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1rem; margin-top: 2.5rem; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; border-top: 1px solid #21262d; padding-top: 1.5rem; }
  p.hint { color: #8b949e; font-size: .9rem; }
  select, input[type=number] { padding: .4rem; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; }
  select#customer-select, select#workspace-select { width: 100%; padding: .5rem; margin: .5rem 0 1rem; }
  .module { margin-bottom: 1.2rem; border: 1px solid #21262d; border-radius: 6px; padding: .8rem 1rem; }
  .module > h3 { margin: 0 0 .6rem; font-size: .95rem; }
  .field-row { display: flex; align-items: center; gap: .6rem; margin-bottom: .5rem; font-size: .9rem; }
  .field-row label { min-width: 160px; color: #8b949e; }
  button { background: #1f6feb; color: white; border: none; padding: .5rem 1.2rem; border-radius: 4px; cursor: pointer; font-size: .9rem; margin-top: .5rem; }
  button:hover { background: #2a7ae2; }
  #global-alert, #override-alert { margin: 1rem 0; padding: .6rem .9rem; border-radius: 4px; display: none; }
  .error { display: block !important; background: #3d1418; color: #f85149; border: 1px solid #5a1a20; }
  .success { display: block !important; background: #12261a; color: #3fb950; border: 1px solid #1b3a26; }
  a { color: #58a6ff; }
  code { background: #161b22; padding: .1rem .3rem; border-radius: 3px; }
</style>
</head>
<body>
<h1>360 Platform - Customer Admin Portal</h1>
<p class="hint">Calls the Keycloak Admin REST API via <code>webhook-consumer</code>'s service-account credentials, same as the plan doc's Phase 1 point 4. Changes flow back through the normal webhook sync (~2s) - watch <a href="/">the dashboard</a>.</p>

<h2>Global entitlements (customer level)</h2>
<label for="customer-select">Customer</label>
<select id="customer-select"></select>
<div id="global-form"></div>
<div id="global-alert"></div>
<button id="global-save-btn">Save entitlements</button>

<h2>Sub-group overrides (workspace level)</h2>
<p class="hint">Restricts an internal sub-team or invited external agency below the customer's global entitlements. Leave a field on "(inherit)" to use the customer's value as-is.</p>
<label for="workspace-select">Workspace</label>
<select id="workspace-select"></select>
<div id="override-form"></div>
<div id="override-alert"></div>
<button id="override-save-btn">Save overrides</button>

<script>
const CATALOG = ${JSON.stringify(ENTITLEMENT_CATALOG)};
let state = { customers: [], workspaces: [] };

function fieldInputHtml(module, field, value, withInherit) {
  const name = module + "__" + field.key;
  if (field.type === "boolean") {
    if (withInherit) {
      const v = value === true ? "true" : value === false ? "false" : "";
      return '<select name="' + name + '" data-type="boolean">' +
        '<option value=""' + (v === "" ? " selected" : "") + '>(inherit)</option>' +
        '<option value="true"' + (v === "true" ? " selected" : "") + '>Allowed</option>' +
        '<option value="false"' + (v === "false" ? " selected" : "") + '>Blocked</option></select>';
    }
    return '<input type="checkbox" name="' + name + '" data-type="boolean"' + (value ? " checked" : "") + '>';
  }
  if (field.type === "select") {
    const opts = (withInherit ? ["(inherit)"] : []).concat(field.options);
    return '<select name="' + name + '" data-type="select">' + opts.map(o => {
      const v = o === "(inherit)" ? "" : o;
      const selected = (withInherit ? (value || "") === v : value === v) ? " selected" : "";
      return '<option value="' + v + '"' + selected + '>' + o + '</option>';
    }).join('') + '</select>';
  }
  if (field.type === "number") {
    return '<input type="number" name="' + name + '" data-type="number" value="' + (value ?? "") + '" placeholder="' + (withInherit ? "(inherit)" : "0") + '">';
  }
  return '';
}

function renderCatalogForm(containerId, values, withInherit) {
  const container = document.getElementById(containerId);
  container.innerHTML = Object.entries(CATALOG).map(([moduleKey, module]) => {
    const moduleValues = values?.[moduleKey] || {};
    const rows = module.fields.map(field =>
      '<div class="field-row"><label>' + field.label + '</label>' + fieldInputHtml(moduleKey, field, moduleValues[field.key], withInherit) + '</div>'
    ).join('');
    return '<div class="module" data-module="' + moduleKey + '"><h3>' + module.label + '</h3>' + rows + '</div>';
  }).join('');
}

function readCatalogForm(containerId, skipEmpty) {
  const container = document.getElementById(containerId);
  const result = {};
  container.querySelectorAll('.module').forEach(moduleEl => {
    const moduleKey = moduleEl.dataset.module;
    const moduleResult = {};
    moduleEl.querySelectorAll('[data-type]').forEach(el => {
      const field = el.name.split('__')[1];
      if (el.dataset.type === 'boolean' && el.tagName === 'INPUT') {
        moduleResult[field] = el.checked;
      } else if (el.dataset.type === 'boolean' || el.dataset.type === 'select') {
        if (el.value !== '' || !skipEmpty) {
          if (el.value !== '') moduleResult[field] = el.dataset.type === 'boolean' ? el.value === 'true' : el.value;
        }
      } else if (el.dataset.type === 'number') {
        if (el.value !== '') moduleResult[field] = Number(el.value);
      }
    });
    if (!skipEmpty || Object.keys(moduleResult).length > 0) result[moduleKey] = moduleResult;
  });
  return result;
}

function showAlert(id, kind, text) {
  const el = document.getElementById(id);
  el.className = kind;
  el.textContent = text;
}

async function loadState() {
  state = await fetch('/state').then(r => r.json());

  const custSelect = document.getElementById('customer-select');
  const prevCust = custSelect.value;
  custSelect.innerHTML = state.customers.map(c => '<option value="' + c.kcOrgId + '">' + c.businessName + '</option>').join('');
  if (prevCust) custSelect.value = prevCust;
  onCustomerChange();

  const wsSelect = document.getElementById('workspace-select');
  const prevWs = wsSelect.value;
  wsSelect.innerHTML = state.workspaces.map(w => {
    const customer = state.customers.find(c => c.kcOrgId === w.customerId);
    const label = (customer?.businessName || '?') + ' / ' + w.businessName + (w.isExternal ? ' (external)' : '');
    return '<option value="' + w.kcGroupId + '">' + label + '</option>';
  }).join('');
  if (prevWs) wsSelect.value = prevWs;
  onWorkspaceChange();
}

function onCustomerChange() {
  const orgId = document.getElementById('customer-select').value;
  const customer = state.customers.find(c => c.kcOrgId === orgId);
  renderCatalogForm('global-form', customer?.entitlements, false);
  document.getElementById('global-alert').className = '';
}

function onWorkspaceChange() {
  const groupId = document.getElementById('workspace-select').value;
  const workspace = state.workspaces.find(w => w.kcGroupId === groupId);
  renderCatalogForm('override-form', workspace?.featureOverrides, true);
  document.getElementById('override-alert').className = '';
}

document.getElementById('customer-select').addEventListener('change', onCustomerChange);
document.getElementById('workspace-select').addEventListener('change', onWorkspaceChange);

document.getElementById('global-save-btn').addEventListener('click', async () => {
  const orgId = document.getElementById('customer-select').value;
  const entitlements = readCatalogForm('global-form', false);
  const res = await fetch('/admin/customers/' + orgId + '/entitlements', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entitlements }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); showAlert('global-alert', 'error', b.error || 'Save failed'); return; }
  showAlert('global-alert', 'success', 'Saved. Refreshing in ~2s once the webhook sync lands...');
  setTimeout(loadState, 2000);
});

document.getElementById('override-save-btn').addEventListener('click', async () => {
  const groupId = document.getElementById('workspace-select').value;
  const workspace = state.workspaces.find(w => w.kcGroupId === groupId);
  const featureOverrides = readCatalogForm('override-form', true);
  const res = await fetch('/admin/workspaces/' + workspace.customerId + '/' + groupId + '/overrides', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureOverrides }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); showAlert('override-alert', 'error', b.error || 'Save failed'); return; }
  showAlert('override-alert', 'success', 'Saved. Refreshing in ~2s once the webhook sync lands...');
  setTimeout(loadState, 2000);
});

loadState();
</script>
</body>
</html>`;
