// Power house monitor: polls the Flexem FBox cloud API and serves a shareable dashboard.
// Requires Node 18+. No npm packages needed.  Run:  node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
// Hosting: secrets and switches can come from environment variables instead of config.json
const E = process.env;
if (E.MODE) cfg.mode = E.MODE;
if (E.PORT) cfg.port = Number(E.PORT);
if (E.SHARE_PASSWORD) cfg.sharePassword = E.SHARE_PASSWORD;
if (E.FBOX_CLIENT_ID) cfg.fbox.auth.clientId = E.FBOX_CLIENT_ID;
if (E.FBOX_CLIENT_SECRET) cfg.fbox.auth.clientSecret = E.FBOX_CLIENT_SECRET;
if (E.FBOX_USERNAME) cfg.fbox.auth.username = E.FBOX_USERNAME;
if (E.FBOX_PASSWORD) cfg.fbox.auth.password = E.FBOX_PASSWORD;
if (E.FBOX_AUTH_METHOD) cfg.fbox.auth.method = E.FBOX_AUTH_METHOD;
const HIST_FILE = path.join(__dirname, 'history.json');
const DAY = 24 * 3600 * 1000;
const gens = cfg.generators;

// Every point that will be read, with the FBox variable name and group it lives in.
const allPoints = [];
for (const g of gens) {
  for (const p of cfg.points) allPoints.push({ key: g.id + '.' + p.key, name: (g.names || {})[p.key] || p.name, group: g.group });
  if (g.status) allPoints.push({ key: g.id + '.status', name: g.status.name, group: g.status.group });
}
for (const p of cfg.shared || []) allPoints.push(p);

let state = { conn: 'starting', updated: null, values: {}, error: null };
let history = [];
try { history = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch (_) {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- FBox cloud ----------
let tok = null, tokExp = 0;
async function getToken() {
  if (tok && Date.now() < tokExp - 60000) return tok;
  const a = cfg.fbox.auth;
  const form = { client_id: a.clientId, client_secret: a.clientSecret };
  if (a.method === 'password') {           // developer account issued by Flexem sales
    Object.assign(form, { grant_type: 'password', username: a.username, password: a.password, scope: 'openid offline_access fbox email profile' });
  } else {                                 // developer account created in FBox Manager
    Object.assign(form, { grant_type: 'client_credentials', scope: 'fbox' });
  }
  const r = await fetch(cfg.fbox.host.replace(/\/$/, '') + '/idserver/core/connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form)
  });
  if (!r.ok) throw new Error('FBox login failed (' + r.status + '): ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  tok = j.access_token; tokExp = Date.now() + (j.expires_in || 7200) * 1000;
  return tok;
}

const num = v => typeof v === 'boolean' ? (v ? 1 : 0) : (v === 'true' ? 1 : v === 'false' ? 0 : Number(v));

async function readFBox() {
  const f = cfg.fbox, t = await getToken();
  const base = f.host.replace(/\/$/, '') + '/api/v2/';
  const url = f.boxNo ? base + 'dmon/value/get?boxNo=' + encodeURIComponent(f.boxNo) : base + 'box/' + f.boxId + '/dmon/value/get';
  // Names repeat across groups (GEN 1 and GEN 2 both have "L1 - N"), so read one group per request.
  const groups = [...new Set(allPoints.map(p => p.group))];
  const values = {}; let conn = 'offline', firstErr = null;
  for (let n = 0; n < groups.length; n++) {
    if (n) await sleep(1200);              // FBox limits calls to about 1 per second
    const pts = allPoints.filter(p => p.group === groups[n]);
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ names: pts.map(p => p.name), groupnames: pts.map(() => groups[n]), timeOut: null })
    });
    if (r.status === 429) throw new Error('FBox rate limit hit, raise pollSeconds');
    if (r.status === 401) { tok = null; throw new Error('FBox token rejected, will retry'); }
    if (!r.ok) { firstErr = firstErr || 'FBox read failed for "' + groups[n] + '" (' + r.status + ' ' + (r.headers.get('X-FBox-Code') || '') + ')'; continue; }
    const rows = await r.json();
    if (rows[0] && rows[0].connState === 1) conn = 'online';
    for (const p of pts) {
      const row = rows.find(x => x.name === p.name);
      if (row && row.status === 0 && row.value !== null && row.value !== '') values[p.key] = num(row.value);
    }
  }
  if (!Object.keys(values).length && firstErr) throw new Error(firstErr);
  return { values, conn };
}

// ---------- Demo data (same names and units as the real box) ----------
let demoFuel = 2410, demoRun = 0;
function readDemo() {
  demoFuel -= 0.011;
  const j = (b, s) => b + (Math.random() - 0.5) * s;
  const v = { fuel_l: demoFuel, fuel_counter: 17120, edl: 0 };
  gens.forEach((g, n) => {
    const on = n === 0, set = (k, x) => v[g.id + '.' + k] = on ? x : 0;
    set('v1', j(233, 3)); set('v2', j(236, 3)); set('v3', j(233, 3));
    set('i1', j(134, 6)); set('i2', j(141, 6)); set('i3', j(172, 6));
    set('freq', j(50, 0.2)); set('kw', j(102, 4));
    v[g.id + '.status'] = on ? 1 : 0;
    v[g.id + '.hours'] = 1818 + n * 640; v[g.id + '.min'] = on ? 19 : 0; v[g.id + '.sec'] = on ? new Date().getSeconds() : 0;
  });
  return { conn: 'online', values: v };
}

// ---------- Poll loop ----------
let polling = false;
async function poll() {
  if (polling) return; polling = true;
  try {
    const { values, conn } = cfg.mode === 'fbox' ? await readFBox() : readDemo();
    gens.forEach(g => {                     // HRS + MIN + SEC -> decimal hours
      const h = g.id + '.hours';
      if (values[h] != null) values[h] += (values[g.id + '.min'] || 0) / 60 + (values[g.id + '.sec'] || 0) / 3600;
    });
    state = { conn, updated: Date.now(), values, error: null };
    const last = history[history.length - 1];
    if (!last || Date.now() - last.t >= 60000) {
      const pt = { t: Date.now(), fuel: values.fuel_l ?? null };
      gens.forEach(g => pt[g.id] = values[g.id + '.kw'] ?? null);
      history.push(pt);
      history = history.filter(h => Date.now() - h.t < DAY);
      fs.writeFile(HIST_FILE, JSON.stringify(history), () => {});
    }
  } catch (e) {
    state.error = e.message; state.conn = 'error';
    console.error(new Date().toISOString(), e.message);
  }
  polling = false;
}
poll(); setInterval(poll, Math.max(8, cfg.pollSeconds) * 1000);

// ---------- Web server ----------
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  if (cfg.sharePassword) {
    const h = req.headers.authorization || '';
    const pass = Buffer.from(h.split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
    if (pass !== cfg.sharePassword) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Power house"' }); return res.end('Password required');
    }
  }
  const url = req.url.split('?')[0];
  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const s = cfg.site;
    return res.end(JSON.stringify({
      site: { name: s.name, tankLitres: s.tankLitres || null, ratedKva: s.ratedKva || null, lowFuelHours: s.lowFuelHours ?? 12, details: s.details },
      generators: gens.map(({ id, label }) => ({ id, label })),
      decimals: Object.fromEntries([...cfg.points.map(p => [p.key, p.decimals ?? 0]), ...(cfg.shared || []).map(p => [p.key, p.decimals ?? 0])]),
      demo: cfg.mode !== 'fbox', now: Date.now(), pollSeconds: cfg.pollSeconds,
      conn: state.conn, error: state.error, updated: state.updated, values: state.values, history
    }));
  }
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(cfg.port, () => console.log('Dashboard on http://localhost:' + cfg.port + '  (mode: ' + cfg.mode + ')'));
