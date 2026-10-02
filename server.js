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
const DAY = 24 * 3600 * 1000, KEEP = 30 * DAY;
let lastSave = 0;
// ---- refuelling log: every rise of the FBox fuel counter is a refuel; a refuel ends after a quiet spell ----
const REFUEL_FILE = path.join(__dirname, 'refuels.json');
const REFUEL_GAP = (+E.REFUEL_GAP_S || 240) * 1000;      // no counter rise for this long = refuel finished
let refuels = [], openR = null, lastCounter = null, lastLevel = null;
const trackStart = Date.now();
try { refuels = JSON.parse(fs.readFileSync(REFUEL_FILE, 'utf8')); } catch (_) {}
function saveRefuels() { fs.writeFile(REFUEL_FILE, JSON.stringify(refuels), () => {}); }
function closeRefuel(level) {
  if (!openR) return;
  const litres = +(openR.counterAfter - openR.counterBefore).toFixed(2);
  if (litres > 0) {
    refuels.push({ id: openR.start, start: openR.start, end: openR.end, counterBefore: openR.counterBefore, counterAfter: openR.counterAfter, litres, levelBefore: openR.levelBefore, levelAfter: level ?? openR.levelAfter });
    refuels = refuels.slice(-2000); saveRefuels();
  }
  openR = null;
}
function trackRefuel(v) {
  const c = v.fuel_counter, L = v.fuel_l ?? null, now = Date.now();
  if (c == null) return;
  if (lastCounter == null) { lastCounter = c; lastLevel = L; return; }
  if (c > lastCounter) {
    if (!openR) openR = { start: now, counterBefore: lastCounter, levelBefore: lastLevel };
    openR.end = now; openR.counterAfter = c; openR.levelAfter = L; lastCounter = c;
  } else if (lastCounter - c > 5) {                       // counter was reset: start counting from the new value
    closeRefuel(L); lastCounter = c;
  }                                                       // a tiny dip is sensor noise: keep the highest value as baseline
  if (openR) { openR.levelAfter = L ?? openR.levelAfter; if (now - openR.end > REFUEL_GAP) closeRefuel(L); }
  else lastLevel = L;
}
// ---- fuel level log: one line every hour (on the hour): tank level, litres used since the previous line, average load ----
const FUELLOG_FILE = path.join(__dirname, 'fuellog.json');
let fuelLog = [], fuelCur = null, lastLogHour = null, prevLogLevel = null, kwSum = 0, kwN = 0;
try { fuelLog = JSON.parse(fs.readFileSync(FUELLOG_FILE, 'utf8')); } catch (_) {}
if (fuelLog.length) { const l = fuelLog[fuelLog.length - 1]; lastLogHour = Math.floor(l.t / 3600000); prevLogLevel = l.level; }
function trackFuelLevel(v) {
  const L = v.fuel_l, now = Date.now();
  if (L == null || !isFinite(L)) return;
  fuelCur = L;
  kwSum += gens.reduce((a, g) => a + (v[g.id + '.kw'] || 0), 0); kwN++;
  const hr = Math.floor(now / 3600000);
  if (hr === lastLogHour) return;
  fuelLog.push({ t: now, level: +L.toFixed(1), drop: prevLogLevel == null ? null : +(prevLogLevel - L).toFixed(1), kw: +(kwSum / kwN).toFixed(1) });     // drop: litres used since the previous line (negative = the level went up, refuelling)
  fuelLog = fuelLog.slice(-5000); fs.writeFile(FUELLOG_FILE, JSON.stringify(fuelLog), () => {});
  lastLogHour = hr; prevLogLevel = L; kwSum = 0; kwN = 0;
}
const gens = cfg.generators;

// Every point that will be read, with the FBox variable name and group it lives in.
const allPoints = [];
for (const g of gens) {
  for (const p of cfg.points) allPoints.push({ key: g.id + '.' + p.key, name: (g.names || {})[p.key] || p.name, group: g.group, div: p.div || 1 });
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

const num = v => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const t = String(v).trim().toLowerCase();
  if (t === 'true' || t === 'on') return 1;
  if (t === 'false' || t === 'off') return 0;
  return Number(t);
};

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
      if (row && row.status === 0 && row.value !== null && row.value !== '') values[p.key] = num(row.value) / (p.div || 1);     // the API sends 1 decimal place as a whole number (2364 = 236.4)
    }
  }
  if (!Object.keys(values).length && firstErr) throw new Error(firstErr);
  return { values, conn };
}

// ---------- Bridge mode: values pushed from the FBox Manager page ----------
const INGEST = E.INGEST_TOKEN || cfg.ingestToken || '';
const pushed = {};                          // group -> { t, vals: { name: value } }
const STALE = 120000;
function readPush() {
  const values = {}; let newest = 0;
  for (const p of allPoints) {
    const g = pushed[p.group]; if (!g) continue;
    newest = Math.max(newest, g.t);
    if (Date.now() - g.t > STALE) continue;
    const v = g.vals[p.name]; if (v === undefined || v === null || v === '') continue;
    const n = num(v); if (!isNaN(n)) values[p.key] = n;
  }
  if (!newest) throw new Error('Waiting for the first data from the FBox bridge.');
  if (Date.now() - newest > STALE) throw new Error('The FBox bridge stopped sending data ' + Math.max(1, Math.round((Date.now() - newest) / 60000)) + ' min ago. Check that FBox Manager is open and logged in on the host computer.');
  return { values, conn: 'online' };
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

// ---------- Fuel level alarm + phone notification (ntfy.sh app) ----------
// Set NTFY_TOPIC (a long, hard-to-guess name) in the environment to turn phone notifications on.
const NTFY_TOPIC = E.NTFY_TOPIC || '', NTFY_SERVER = (E.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const ALARM_FILE = path.join(__dirname, 'alarm.json');
let alarmL = Number(E.LOW_FUEL_L) || 800, alarmActive = false, alarmLastSent = 0, testLastSent = 0;
try { const a = JSON.parse(fs.readFileSync(ALARM_FILE, 'utf8')); if (a && a.litres >= 0) alarmL = a.litres; } catch (_) {}
async function notifyPhone(title, message, priority, tags) {
  if (!NTFY_TOPIC) return false;
  try {
    const r = await fetch(NTFY_SERVER + '/' + encodeURIComponent(NTFY_TOPIC), { method: 'POST', headers: { Title: title, Priority: priority || 'default', Tags: tags || 'bell' }, body: message });
    if (!r.ok) console.error('ntfy status', r.status);
    return r.ok;
  } catch (e) { console.error('ntfy', e.message); return false; }
}
function checkFuelAlarm(v) {                         // one message when the level drops below the alarm level, a reminder every 3 h while it stays low
  const L = v && v.fuel_l, now = Date.now();
  if (L == null || !isFinite(L) || !(alarmL > 0)) return;
  if (L < alarmL) {
    if (!alarmActive || now - alarmLastSent > 3 * 3600e3) {
      alarmActive = true; alarmLastSent = now;
      notifyPhone('LOW FUEL - Al Dhour', 'Diesel level is ' + Math.round(L) + ' L, below the alarm level of ' + Math.round(alarmL) + ' L.', 'urgent', 'rotating_light,fuelpump');
    }
  } else if (L >= alarmL + 50) alarmActive = false;
}
// the free Render plan sleeps when nobody visits; while notifications are on, visit our own address so the alarm keeps being checked
if (NTFY_TOPIC && E.RENDER_EXTERNAL_URL) setInterval(() => { fetch(E.RENDER_EXTERNAL_URL + '/api/status').catch(() => {}); }, 10 * 60 * 1000);

// ---------- Poll loop ----------
let polling = false;
async function poll() {
  if (polling) return; polling = true;
  try {
    const { values, conn } = cfg.mode === 'fbox' ? await readFBox() : cfg.mode === 'push' ? readPush() : readDemo();
    gens.forEach(g => {                     // HRS + MIN + SEC -> decimal hours
      const h = g.id + '.hours';
      if (values[h] != null) values[h] += (values[g.id + '.min'] || 0) / 60 + (values[g.id + '.sec'] || 0) / 3600;
    });
    state = { conn, updated: Date.now(), values, error: null };
    trackRefuel(values); trackFuelLevel(values); checkFuelAlarm(values);
    const last = history[history.length - 1];
    if (!last || Date.now() - last.t >= 60000) {
      const pt = { t: Date.now(), fuel: values.fuel_l ?? null };
      gens.forEach(g => pt[g.id] = values[g.id + '.kw'] ?? null);
      const ks = gens.map(g => pt[g.id]).filter(x => x != null);
      pt.total = ks.length ? +ks.reduce((a, b) => a + b, 0).toFixed(2) : null;
      history.push(pt);
      history = history.filter(h => Date.now() - h.t < KEEP);
      if (Date.now() - lastSave > 300000) { lastSave = Date.now(); fs.writeFile(HIST_FILE, JSON.stringify(history), () => {}); }
    }
  } catch (e) {
    state.error = e.message; state.conn = 'error';
    console.error(new Date().toISOString(), e.message);
  }
  polling = false;
}
poll(); setInterval(poll, Math.max(8, cfg.pollSeconds) * 1000);

// ---------- Web server ----------
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const CORS = { 'Access-Control-Allow-Origin': 'https://fbox360.com', 'Access-Control-Allow-Headers': 'Content-Type, X-Token', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/api/ingest') {           // protected by its own secret token, not the page password
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method !== 'POST' || !INGEST || req.headers['x-token'] !== INGEST) { res.writeHead(403, CORS); return res.end('Forbidden'); }
    let body = ''; req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        for (const [g, vals] of Object.entries(j.groups || {})) pushed[g] = { t: Date.now(), vals };
        res.writeHead(200, CORS); res.end('ok'); poll();
      } catch (e) { res.writeHead(400, CORS); res.end('Bad data'); }
    });
    return;
  }
  if (cfg.sharePassword) {
    const h = req.headers.authorization || '';
    const pass = Buffer.from(h.split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
    if (pass !== cfg.sharePassword) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Power house"' }); return res.end('Password required');
    }
  }
  const url = req.url.split('?')[0];
  if (url === '/api/fuellog' || url === '/api/fuellog.csv') {
    const list = [...fuelLog].reverse();
    if (url.endsWith('.csv')) {
      const f = t => new Date(t + 3 * 3600000).toISOString().slice(0, 19).replace('T', ' ');   // Lebanon time
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="fuel-level-log.csv"' });
      return res.end(['Date and time,Tank level (L),Used since previous line (L; negative = level went up),Average load (kW)', ...list.map(r => [f(r.t), r.level, r.drop ?? '', r.kw].join(','))].join('\r\n') + '\r\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ now: Date.now(), since: trackStart, level: fuelCur, total: fuelLog.length, list: list.slice(0, 300) }));
  }
  if (url === '/api/refuels' || url === '/api/refuels.csv') {
    const list = [...refuels].reverse();
    if (url.endsWith('.csv')) {
      const f = t => new Date(t + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ');   // Lebanon time, for the spreadsheet copy
      const rows = list.map(r => [f(r.start), f(r.end), r.counterBefore, r.counterAfter, r.litres, r.levelBefore ?? '', r.levelAfter ?? ''].join(','));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="refuelling-log.csv"' });
      return res.end(['Start,End,Counter before,Counter after,Litres added,Tank before (L),Tank after (L)', ...rows].join('\r\n') + '\r\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ now: Date.now(), counter: lastCounter, since: trackStart, open: openR && openR.counterAfter != null ? { ...openR, litres: +(openR.counterAfter - openR.counterBefore).toFixed(2) } : null, list }));
  }
  if (url === '/api/history') {          // downsampled history for the trend charts, plus min/max/avg over the raw samples
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const to = Math.min(Date.now(), +q.get('to') || Date.now());
    const from = Math.max(to - KEEP, +q.get('from') || to - DAY);
    const keys = ['fuel', ...gens.map(g => g.id), 'total'];
    const rows = history.filter(h => h.t >= from && h.t <= to);
    const size = Math.max(60000, Math.ceil((to - from) / 300)), bk = new Map(), stats = {};
    keys.forEach(k => stats[k] = { min: null, max: null, avg: null, n: 0 });
    for (const h of rows) {
      const i = Math.floor((h.t - from) / size); let b = bk.get(i);
      if (!b) bk.set(i, b = { t: 0, n: 0, s: {}, c: {} });
      b.t += h.t; b.n++;
      for (const k of keys) if (h[k] != null) {
        b.s[k] = (b.s[k] || 0) + h[k]; b.c[k] = (b.c[k] || 0) + 1;
        const st = stats[k]; st.min = st.min == null ? h[k] : Math.min(st.min, h[k]); st.max = st.max == null ? h[k] : Math.max(st.max, h[k]);
        st.avg = (st.avg || 0) + h[k]; st.n++;
      }
    }
    keys.forEach(k => { if (stats[k].n) stats[k].avg /= stats[k].n; });
    const points = [...bk.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => {
      const p = { t: Math.round(b.t / b.n) };
      keys.forEach(k => p[k] = b.c[k] ? +(b.s[k] / b.c[k]).toFixed(2) : null);
      return p;
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ from, to, size, since: history.length ? history[0].t : null, points, stats }));
  }
  if (url === '/api/alarm' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body), H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (j.test) {
          if (Date.now() - testLastSent < 20000) { res.writeHead(429, H); return res.end(JSON.stringify({ error: 'wait' })); }
          testLastSent = Date.now();
          const ok = await notifyPhone('Test - Al Dhour', 'Phone notifications are working.', 'default', 'white_check_mark');
          res.writeHead(200, H); return res.end(JSON.stringify({ ok, push: !!NTFY_TOPIC }));
        }
        const n = Number(j.litres);
        if (!isFinite(n) || n < 0 || n > 100000) { res.writeHead(400, H); return res.end(JSON.stringify({ error: 'bad value' })); }
        alarmL = n; fs.writeFile(ALARM_FILE, JSON.stringify({ litres: n }), () => {});
        checkFuelAlarm(state.values);
        res.writeHead(200, H); res.end(JSON.stringify({ litres: alarmL }));
      } catch (e) { res.writeHead(400); res.end('Bad data'); }
    });
    return;
  }
  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const s = cfg.site;
    return res.end(JSON.stringify({
      site: { name: s.name, tankLitres: s.tankLitres || null, ratedKva: s.ratedKva || null, lowFuelHours: s.lowFuelHours ?? 12, details: s.details },
      generators: gens.map(({ id, label, ratedKva }) => ({ id, label, ratedKva: ratedKva || null })),
      decimals: Object.fromEntries([...cfg.points.map(p => [p.key, p.decimals ?? 0]), ...(cfg.shared || []).map(p => [p.key, p.decimals ?? 0])]),
      demo: cfg.mode !== 'fbox' && cfg.mode !== 'push', now: Date.now(), pollSeconds: cfg.pollSeconds,
      alarm: { litres: alarmL, push: !!NTFY_TOPIC, active: alarmActive }, conn: state.conn, error: state.error, updated: state.updated, values: state.values, history: history.filter(h => Date.now() - h.t < DAY)
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
