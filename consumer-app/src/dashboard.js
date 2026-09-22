export const dashboardHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Downstream App - Local DB (synced from Keycloak webhooks)</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; background: #0b0f14; color: #e6edf3; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1rem; margin-top: 2rem; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #21262d; font-size: .9rem; }
  th { color: #8b949e; font-weight: 500; }
  .empty { color: #6e7681; font-style: italic; padding: .5rem 0; }
  .status-ok { color: #3fb950; }
  .status-error { color: #f85149; }
  .status-rejected { color: #d29922; }
  .status-ignored { color: #6e7681; }
  code { background: #161b22; padding: .1rem .3rem; border-radius: 3px; }
  .badge { display:inline-block; padding: .1rem .5rem; border-radius: 999px; background:#1f2937; font-size:.75rem; }
</style>
</head>
<body>
<h1>Phase 1 PoC &mdash; downstream consumer-app local tables</h1>
<p>This page shows <em>only</em> data written by this app's webhook handler. Nothing here is edited directly &mdash; it exists purely because Keycloak fired an Admin Event Webhook. Refreshes every 3s.</p>

<h2>Organizations</h2>
<table id="organizations"></table>

<h2>Subscriptions</h2>
<table id="subscriptions"></table>

<h2>Users</h2>
<table id="users"></table>

<h2>Memberships</h2>
<table id="memberships"></table>

<h2>Recent webhook events</h2>
<table id="events"></table>

<script>
function renderTable(el, rows, columns) {
  if (!rows.length) { el.innerHTML = '<tr><td class="empty">no rows yet</td></tr>'; return; }
  const head = '<tr>' + columns.map(c => '<th>' + c + '</th>').join('') + '</tr>';
  const body = rows.map(r => '<tr>' + columns.map(c => '<td>' + fmt(r[c]) + '</td>').join('') + '</tr>').join('');
  el.innerHTML = head + body;
}
function fmt(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
async function refresh() {
  const state = await fetch('/state').then(r => r.json());
  const events = await fetch('/events').then(r => r.json());
  renderTable(document.getElementById('organizations'), state.organizations, ['name', 'alias', 'domain', 'enabled', 'kcOrgId', 'updatedAt']);
  renderTable(document.getElementById('subscriptions'), state.subscriptions, ['organizationId', 'plan', 'seats', 'path', 'updatedAt']);
  renderTable(document.getElementById('users'), state.users, ['username', 'email', 'kcUserId', 'updatedAt']);
  renderTable(document.getElementById('memberships'), state.memberships, ['organizationId', 'username', 'roles', 'updatedAt']);
  const evRows = events.slice(0, 25).map(e => ({
    receivedAt: e.receivedAt,
    resourceType: e.resourceType,
    operationType: e.operationType,
    status: e.syncStatus,
    detail: e.detail,
  }));
  renderTable(document.getElementById('events'), evRows, ['receivedAt', 'resourceType', 'operationType', 'status', 'detail']);
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
