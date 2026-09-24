import { FEATURE_CATALOG } from "./featureCatalog.js";

// Mirrors claim's contract-features-edit.eta parent/child checkbox UX:
// single-child parents toggle in lockstep, multi-child parents require at
// least one enabled child, unchecking a parent disables (and unchecks) its
// children. Deliberately does NOT reproduce claim's impact-preview modal
// (contracts/:id/features/preview) - that needs the reachability engine
// (event-fanout.ts) this PoC scopes out; this just saves directly.
export const adminFormHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Edit customer contract features</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; background: #0b0f14; color: #e6edf3; max-width: 640px; }
  h1 { font-size: 1.25rem; }
  p.hint { color: #8b949e; font-size: .9rem; }
  select { width: 100%; padding: .5rem; margin: .5rem 0 1.5rem; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; }
  .parent { margin-bottom: 1rem; }
  .parent > label { font-weight: 600; }
  .children { margin-left: 1.5rem; margin-top: .4rem; }
  label.checkbox { display: block; margin-bottom: .3rem; cursor: pointer; }
  label.checkbox.disabled { color: #6e7681; cursor: not-allowed; }
  button { background: #1f6feb; color: white; border: none; padding: .5rem 1.2rem; border-radius: 4px; cursor: pointer; font-size: .9rem; }
  button:hover { background: #2a7ae2; }
  #alert { margin: 1rem 0; padding: .6rem .9rem; border-radius: 4px; display: none; }
  #alert.error { display: block; background: #3d1418; color: #f85149; border: 1px solid #5a1a20; }
  #alert.success { display: block; background: #12261a; color: #3fb950; border: 1px solid #1b3a26; }
  a { color: #58a6ff; }
</style>
</head>
<body>
<h1>Edit customer contract features</h1>
<p class="hint">Translates checkbox selection into the customer Organization's <code>contract.featureSets</code> attribute. Saved through the Keycloak Admin API, same as the rest of this PoC - the change flows back into <a href="/">the dashboard</a> via the normal webhook sync (~2s), including recomputing enabledFeatures for every affected workspace membership.</p>

<label for="customer-select">Customer</label>
<select id="customer-select"></select>

<div id="alert"></div>
<form id="feature-form"></form>
<button id="save-btn" type="button">Save</button>

<script>
const CATALOG = ${JSON.stringify(FEATURE_CATALOG)};
let customers = [];

function renderCatalog(enabledKeys) {
  const enabled = new Set(enabledKeys || []);
  const form = document.getElementById('feature-form');
  form.innerHTML = CATALOG.map(parent => {
    const hasChildren = parent.children && parent.children.length > 0;
    const singleChild = hasChildren && parent.children.length === 1;
    const parentOn = enabled.has(parent.key);
    const childrenHtml = hasChildren ? '<div class="children">' + parent.children.map(child => {
      const childOn = enabled.has(child.key);
      return '<label class="checkbox' + (parentOn ? '' : ' disabled') + '">' +
        '<input type="checkbox" class="child-toggle" data-parent-key="' + parent.key + '" data-key="' + child.key + '"' +
        (childOn ? ' checked' : '') + (parentOn ? '' : ' disabled') + '> ' + child.name + '</label>';
    }).join('') + '</div>' : '';
    return '<div class="parent" data-key="' + parent.key + '" data-single-child="' + singleChild + '">' +
      '<label class="checkbox"><input type="checkbox" class="parent-toggle" data-key="' + parent.key + '"' +
      (parentOn ? ' checked' : '') + '> ' + parent.name + '</label>' + childrenHtml + '</div>';
  }).join('');

  form.querySelectorAll('.parent-toggle').forEach(el => el.addEventListener('change', onParentToggle));
  form.querySelectorAll('.child-toggle').forEach(el => el.addEventListener('change', onChildToggle));
}

function onParentToggle(e) {
  const key = e.target.dataset.key;
  const parentRow = document.querySelector('.parent[data-key="' + key + '"]');
  const singleChild = parentRow.dataset.singleChild === 'true';
  parentRow.querySelectorAll('.child-toggle').forEach(childEl => {
    childEl.disabled = !e.target.checked;
    childEl.closest('label').classList.toggle('disabled', !e.target.checked);
    if (!e.target.checked) childEl.checked = false;
    else if (singleChild) childEl.checked = true;
  });
}

function onChildToggle(e) {
  const parentKey = e.target.dataset.parentKey;
  const parentRow = document.querySelector('.parent[data-key="' + parentKey + '"]');
  if (parentRow.dataset.singleChild === 'true' && !e.target.checked) {
    parentRow.querySelector('.parent-toggle').checked = false;
    onParentToggle({ target: parentRow.querySelector('.parent-toggle') });
  }
}

function readSelection() {
  const selected = [];
  document.querySelectorAll('.parent-toggle:checked').forEach(el => selected.push(el.dataset.key));
  document.querySelectorAll('.child-toggle:checked:not(:disabled)').forEach(el => selected.push(el.dataset.key));
  return selected;
}

function validate() {
  for (const parent of CATALOG) {
    if (!parent.children || parent.children.length <= 1) continue;
    const parentEl = document.querySelector('.parent-toggle[data-key="' + parent.key + '"]');
    if (!parentEl.checked) continue;
    const anyChild = document.querySelectorAll('.child-toggle[data-parent-key="' + parent.key + '"]:checked').length > 0;
    if (!anyChild) return parent.name + ' requires at least one enabled sub-feature.';
  }
  return null;
}

function showAlert(kind, text) {
  const el = document.getElementById('alert');
  el.className = kind;
  el.textContent = text;
}

async function loadCustomers() {
  const state = await fetch('/state').then(r => r.json());
  customers = state.customers;
  const select = document.getElementById('customer-select');
  select.innerHTML = customers.map(c => '<option value="' + c.kcOrgId + '">' + c.businessName + '</option>').join('');
  onCustomerChange();
}

function onCustomerChange() {
  const orgId = document.getElementById('customer-select').value;
  const customer = customers.find(c => c.kcOrgId === orgId);
  renderCatalog(customer?.contract?.featureSets || []);
  showAlert('', '');
  document.getElementById('alert').className = '';
}

document.getElementById('customer-select').addEventListener('change', onCustomerChange);

document.getElementById('save-btn').addEventListener('click', async () => {
  const error = validate();
  if (error) { showAlert('error', error); return; }
  const orgId = document.getElementById('customer-select').value;
  const enabled = readSelection();
  const res = await fetch('/admin/customers/' + orgId + '/contract-features', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    showAlert('error', body.error || 'Save failed');
    return;
  }
  showAlert('success', 'Saved. Reloading customer list in ~2s once the webhook sync lands...');
  setTimeout(loadCustomers, 2000);
});

loadCustomers();
</script>
</body>
</html>`;
