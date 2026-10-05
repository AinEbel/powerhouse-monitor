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
  if (t === 'true' || t === 'on' || t === 'running' || t === 'onload' || t === 'closed') return 1;
  if (t === 'false' || t === 'off' || t === 'stop' || t === 'stopped' || t === 'open') return 0;
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
// WhatsApp (free CallMeBot service): set WA_PHONE (your number with country code, digits only) and WA_APIKEY in the environment.
const WA_PHONE = E.WA_PHONE || '', WA_APIKEY = E.WA_APIKEY || '', WA_SERVER = E.WA_SERVER || 'https://api.callmebot.com/whatsapp.php';
// Email (free Resend service, https://resend.com): set RESEND_API_KEY and EMAIL_TO (the address you signed up to Resend with).
const RESEND_KEY = E.RESEND_API_KEY || '', EMAIL_TO = E.EMAIL_TO || '', EMAIL_FROM = E.EMAIL_FROM || 'Al Dhour <onboarding@resend.dev>', EMAIL_REPEAT_S = Number(E.EMAIL_REPEAT_S) || 900;
let emailLast = 0;
const PUSH_ON = !!(NTFY_TOPIC || (WA_PHONE && WA_APIKEY) || (RESEND_KEY && EMAIL_TO));
const ALARM_FILE = path.join(__dirname, 'alarm.json');
let alarmL = Number(E.LOW_FUEL_L) || 800, alarmActive = false, alarmLastSent = 0, testLastSent = 0;
try { const a = JSON.parse(fs.readFileSync(ALARM_FILE, 'utf8')); if (a && a.litres >= 0) alarmL = a.litres; } catch (_) {}
async function notifyPhone(title, message, priority, tags, sendEmail) {
  let ok = false;
  if (sendEmail && RESEND_KEY && EMAIL_TO) {
    try {
      const r = await fetch(E.RESEND_URL || 'https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: EMAIL_FROM, to: [EMAIL_TO], subject: title, text: message }) });
      if (!r.ok) console.error('email status', r.status, (await r.text()).slice(0, 200));
      ok = ok || r.ok;
    } catch (e) { console.error('email', e.message); }
  }
  if (NTFY_TOPIC) {
    try {
      const r = await fetch(NTFY_SERVER + '/' + encodeURIComponent(NTFY_TOPIC), { method: 'POST', headers: { Title: title, Priority: priority || 'default', Tags: tags || 'bell' }, body: message });
      if (!r.ok) console.error('ntfy status', r.status);
      ok = ok || r.ok;
    } catch (e) { console.error('ntfy', e.message); }
  }
  if (WA_PHONE && WA_APIKEY) {
    try {
      const r = await fetch(WA_SERVER + '?phone=' + encodeURIComponent(WA_PHONE) + '&apikey=' + encodeURIComponent(WA_APIKEY) + '&text=' + encodeURIComponent(title + ': ' + message));
      if (!r.ok) console.error('whatsapp status', r.status);
      ok = ok || r.ok;
    } catch (e) { console.error('whatsapp', e.message); }
  }
  return ok;
}
function checkFuelAlarm(v) {                         // one message when the level drops below the alarm level, repeats every ALARM_REPEAT_S seconds (default 10) while it stays low
  const L = v && v.fuel_l, now = Date.now();
  if (L == null || !isFinite(L) || !(alarmL > 0)) return;
  if (L < alarmL) {
    if (!alarmActive || now - alarmLastSent >= (Number(E.ALARM_REPEAT_S) || 10) * 1000) {
      alarmActive = true; alarmLastSent = now;
      const emailDue = now - emailLast >= EMAIL_REPEAT_S * 1000; if (emailDue) emailLast = now;   // email at most every 15 min, other alerts every 10 s
      notifyPhone('AL DHOUR POWER PLANT - LOW FUEL ALARM', 'Diesel level is ' + Math.round(L) + ' L, below the alarm level of ' + Math.round(alarmL) + ' L.', 'urgent', 'rotating_light,fuelpump', emailDue);
    }
  } else if (L >= alarmL + 50) alarmActive = false;
}
// the free Render plan sleeps when nobody visits; while notifications are on, visit our own address so the alarm keeps being checked
if (E.RENDER_EXTERNAL_URL) setInterval(() => { fetch(E.RENDER_EXTERNAL_URL + '/api/status').catch(() => {}); }, 10 * 60 * 1000);

// ---------- Fuel used today, counted minute by minute; the total starts again at 00:00 Lebanon time ----------
// Each minute: used = drop in tank level. A minute in which the refuelling counter rises (or the level jumps up by more than 20 L)
// is a refuel minute: the litres added are not counted as use and the use of that minute is estimated from the load instead.
const CONS_FILE = path.join(__dirname, 'consumption.json'), LPKW_S = 0.278;
let cons = { day: null, since: null, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null }, cLast = null, cKw = 0, cKwN = 0, cRecent = [], eLast = null;
try { const j = JSON.parse(fs.readFileSync(CONS_FILE, 'utf8')); if (j && j.day) cons = j; } catch (_) {}
const BZ = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function bparts(t) { const p = {}; for (const x of BZ.formatToParts(new Date(t))) p[x.type] = x.value; return { day: p.year + '-' + p.month + '-' + p.day, hour: +p.hour }; }
// Monthly kWh. The kWh of every day is saved. On the 1st-4th of a month the box shows the finished total of the previous month (time to read it);
// at 00:00 on the 5th it switches to the running total of the new month, which already contains that month's days 1-4 (Lebanon time).
const MON_FILE = path.join(__dirname, 'month.json');
let mon = { daily: {}, fuel: {} }, monSaved = 0;
try { const j = JSON.parse(fs.readFileSync(MON_FILE, 'utf8')); if (j && j.daily) mon = j; } catch (_) {}
mon.fuel = mon.fuel || {};                       // litres of fuel used per day, for the monthly consumption
function periodStart(day) { let [y, m, d] = day.split('-').map(Number); if (d < 5) { m--; if (m < 1) { m = 12; y--; } } return y + '-' + String(m).padStart(2, '0') + '-05'; }
function monthTotal() {
  let [y, m, d] = bparts(Date.now()).day.split('-').map(Number);
  const sum = mk => { let kwh = 0, days = 0, litres = 0; for (const [k, v] of Object.entries(mon.daily)) if (k.startsWith(mk)) { kwh += v; days++; } for (const [k, v] of Object.entries(mon.fuel)) if (k.startsWith(mk)) litres += v; return { kwh: Math.round(kwh), litres: Math.round(litres), days }; };
  const cur = y + '-' + String(m).padStart(2, '0'), pm = m < 2 ? 12 : m - 1, prev = (m < 2 ? y - 1 : y) + '-' + String(pm).padStart(2, '0');
  if (d < 5) { const p = sum(prev); if (p.days) return { month: prev, final: true, ...p }; }   // days 1-4: show last month's finished total, if there is data for it (time to read it)
  return { month: cur, final: false, ...sum(cur) };                                                 // otherwise the running total of the current month (days 1-4 included)
}
// Power read at the AIN EBEL busbar = every source added up: generator + generator + solar.
// Until the solar meter is connected, solar is estimated from the generators' power factor (solar adds kW only, no kVAr):
// PF 0.98 = no solar, PF 0.66 = 50 kW. This is the same rule as in the page (public/index.html).
const SOLAR_KWP = 50, SOLAR_PF0 = 0.98, SOLAR_PF1 = 0.66;
function solarKw(v) {
  if (v['solar.kw'] != null) return v['solar.kw'] > 0 ? v['solar.kw'] : 0;
  let tot = 0, kva = 0, running = 0;
  for (const g of gens) {
    const kw = v[g.id + '.kw'], st = v[g.id + '.status'], on = st != null ? st === 1 : kw != null && kw > 1;
    if (kw != null) tot += kw;
    if (!on) continue; running++;
    const vv = [1, 2, 3].map(p => v[g.id + '.v' + p]), ii = [1, 2, 3].map(p => v[g.id + '.i' + p]);
    if (vv.every(x => x != null) && ii.every(x => x != null)) kva += vv.reduce((a, x, i) => a + x * ii[i], 0) / 1000;
  }
  if (!running || kva <= 1) return 0;
  const est = Math.max(0, Math.min(SOLAR_KWP, SOLAR_KWP * (SOLAR_PF0 - Math.min(1, tot / kva)) / (SOLAR_PF0 - SOLAR_PF1)));
  return est < 2 ? 0 : est;
}
function trackToday(v) {
  const L = v.fuel_l, c = v.fuel_counter, now = Date.now();
  const kwNow = gens.reduce((a, g) => a + (v[g.id + '.kw'] || 0), 0) + solarKw(v);     // energy produced: kW added up over time (generators + solar)
  { const dk = bparts(now).day;                          // kWh produced is kept for every day, so any day range can be added up
    if (eLast && now - eLast.t < 120e3) mon.daily[dk] = (mon.daily[dk] || 0) + (kwNow + eLast.kw) / 2 * (now - eLast.t) / 3600e3;
    if (now - monSaved > 60e3) { monSaved = now; const old = Object.keys(mon.daily).sort().slice(0, -120); old.forEach(k => delete mon.daily[k]); Object.keys(mon.fuel).sort().slice(0, -120).forEach(k => delete mon.fuel[k]); fs.writeFile(MON_FILE, JSON.stringify(mon), () => {}); } }
  if (cons.day) {
    if (eLast && now - eLast.t < 120e3) { const e = (kwNow + eLast.kw) / 2 * (now - eLast.t) / 3600e3; cons.kwh = (cons.kwh || 0) + e; cons.kwhH = cons.kwhH || {}; const hr = bparts(now).hour; cons.kwhH[hr] = (cons.kwhH[hr] || 0) + e; }
  }
  eLast = { t: now, kw: kwNow };
  if (L == null || !isFinite(L)) return;
  cKw += gens.reduce((a, g) => a + (v[g.id + '.kw'] || 0), 0); cKwN++;
  const m = Math.floor(now / 60000), b = bparts(now);
  if (!cLast) { cLast = { m, t: now, level: L, counter: c }; if (!cons.day) cons = { day: b.day, since: now, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null }; return; }
  if (m === cLast.m) return;
  if (b.day !== cons.day) cons = { day: b.day, since: now, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: { day: cons.day, since: cons.since, total: Math.round(cons.total), refuelled: Math.round(cons.refuelled), kwh: Math.round(cons.kwh || 0) } };
  const dt = (now - cLast.t) / 3600e3, kwAvg = cKwN ? cKw / cKwN : 0, rise = L - cLast.level;
  const cd = c != null && cLast.counter != null ? Math.max(0, c - cLast.counter) : 0;
  let used, added = 0;
  if (cd > 0 || rise > 20) { added = cd > 0 ? cd : rise; used = kwAvg * LPKW_S * dt; }
  else used = Math.max(0, -rise);
  mon.fuel[b.day] = (mon.fuel[b.day] || 0) + used;
  cons.total += used; cons.refuelled += added; cons.hours[b.hour] = (cons.hours[b.hour] || 0) + used;
  cRecent.push({ t: now, used }); cRecent = cRecent.filter(x => x.t > now - 600e3);
  cLast = { m, t: now, level: L, counter: c }; cKw = 0; cKwN = 0;
  fs.writeFile(CONS_FILE, JSON.stringify(cons), () => {});
}
function fuelToday() {
  const now = Date.now(), cur = bparts(now), r = cRecent.reduce((a, x) => a + x.used, 0), span = cRecent.length ? Math.max(60e3, now - cRecent[0].t + 60e3) : 0;
  const kh = cons.kwhH || {}, hs = [...new Set([...Object.keys(cons.hours), ...Object.keys(kh)])].map(Number).sort((a, b) => a - b);
  return { day: cons.day, since: cons.since, total: Math.round(cons.total), refuelled: Math.round(cons.refuelled), curHour: cur.hour, kwh: Math.round(cons.kwh || 0), month: monthTotal(),
    hours: hs.map(h => ({ h, used: Math.round(cons.hours[h] || 0), kwh: Math.round(kh[h] || 0) })),
    rate: span ? +(r / (span / 3600e3)).toFixed(1) : null, prev: cons.prev };
}
// ---------- Who is online: every open page asks for /api/status?v=<random id> every few seconds ----------
const viewers = new Map();
function onlineCount() {
  const now = Date.now(); let n = 0;
  for (const [id, t] of viewers) { if (now - t > 60000) viewers.delete(id); else if (now - t < 20000) n++; }
  return n;
}

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
    trackRefuel(values); trackFuelLevel(values); trackToday(values); checkFuelAlarm(values);
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
// ---------- AL MAHFARA (second FBox: read only, own state, never touches the Al Dhour counters) ----------
const MH_BOX = E.MAHFARA_BOXNO || '300223051481';
let mh = { conn: 'starting', updated: null, values: {}, error: null }, mhHist = [], mhBusy = false;
const MH_READS = [
  { group: 'PWR STATUS', pts: [['edl', 'EDL'], ['solar.status', 'SOLAR'], ['m1.status', 'GEN 1'], ['m2.status', 'GEN 2']] },
  ...[['SOLAR METER', 'solar'], ['GEN1 METER', 'm1'], ['GEN2 METER', 'm2']].map(([group, id]) => ({ group, pts: [['v1', 'L1'], ['v2', 'L2'], ['v3', 'L3'], ['freq', 'HZ'], ['i1', 'A1'], ['i2', 'A2'], ['i3', 'A3'], ['kw', 'KW']].map(([k, n]) => [id + '.' + k, n]) })),
  { group: 'TIME RUNNING', pts: [['m1.hrs', 'GEN1 HRS'], ['m1.mn', 'GEN1 MN'], ['m2.hrs', 'GEN2 HRS'], ['m2.mn', 'GEN2 MN']] },
  { group: 'FUEL LEVEL', pts: [['fuel_l', 'Fuel Level']] }
];
function mhScale(key, x) {                       // the cloud sends each float with its decimals baked in: volts and Hz x100, amps x1e6, kW x1e5 (checked against the Manager page)
  const k = key.split('.').pop();
  if (/^v[123]$/.test(k) || k === 'freq') return x / 100;
  if (/^i[123]$/.test(k)) return x / 1e6;
  if (k === 'kw') return x / 1e5;
  return x;
}
async function mhPoll() {
  if (cfg.mode !== 'fbox' || mhBusy) return;
  mhBusy = true;
  for (let i = 0; polling && i < 60; i++) await sleep(500);     // wait for the Al Dhour read to finish: the FBox allows about 1 call per second
  if (polling) { mhBusy = false; return; }
  polling = true;
  try {
    const t = await getToken(), url = cfg.fbox.host.replace(/\/$/, '') + '/api/v2/dmon/value/get?boxNo=' + encodeURIComponent(MH_BOX);
    const values = {}; let conn = 'offline', firstErr = null;
    for (let n = 0; n < MH_READS.length; n++) {
      if (n) await sleep(1200);
      const g = MH_READS[n];
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ names: g.pts.map(p => p[1]), groupnames: g.pts.map(() => g.group), timeOut: null }) });
      if (r.status === 429) throw new Error('FBox rate limit hit');
      if (r.status === 401) { tok = null; throw new Error('FBox token rejected, will retry'); }
      if (!r.ok) { firstErr = firstErr || 'AL MAHFARA read failed for "' + g.group + '" (' + r.status + ')'; continue; }
      const rows = await r.json();
      if (rows[0] && rows[0].connState === 1) conn = 'online';
      for (const [key, name] of g.pts) { const row = rows.find(x => x.name === name); if (row && row.status === 0 && row.value !== null && row.value !== '') { const x = num(row.value); if (!isNaN(x)) values[key] = mhScale(key, x); } }
    }
    if (!Object.keys(values).length && firstErr) throw new Error(firstErr);
    ['m1', 'm2'].forEach(id => { if (values[id + '.hrs'] != null) values[id + '.hours'] = values[id + '.hrs'] + (values[id + '.mn'] || 0) / 60; });
    mh = { conn, updated: Date.now(), values, error: null };
    mhTrack(values);
    const last = mhHist[mhHist.length - 1];
    if (!last || Date.now() - last.t >= 60000) {
      const pt = { t: Date.now(), fuel: values.fuel_l ?? null, m1: values['m1.kw'] ?? null, m2: values['m2.kw'] ?? null };
      pt.total = +((pt.m1 || 0) + (pt.m2 || 0)).toFixed(2);
      mhHist.push(pt); mhHist = mhHist.filter(h => Date.now() - h.t < DAY);
    }
  } catch (e) { mh.error = e.message; mh.conn = 'error'; console.error(new Date().toISOString(), 'mahfara', e.message); }
  polling = false; mhBusy = false;
}
// ---- AL MAHFARA counters: same rules as Al Dhour (daily kWh and fuel reset at 00:00 Beirut, monthly totals kept), own files ----
const MH_CONS_FILE = path.join(__dirname, 'mh_consumption.json'), MH_MON_FILE = path.join(__dirname, 'mh_month.json');
let mcons = { day: null, since: null, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null }, mmon = { daily: {}, fuel: {} }, mcLast = null, mcKw = 0, mcKwN = 0, mcRecent = [], meLast = null, mmSaved = 0;
try { const j = JSON.parse(fs.readFileSync(MH_CONS_FILE, 'utf8')); if (j && j.day) mcons = j; } catch (_) {}
try { const j = JSON.parse(fs.readFileSync(MH_MON_FILE, 'utf8')); if (j && j.daily) mmon = j; } catch (_) {}
mmon.fuel = mmon.fuel || {};
function mhMonthTotal() {
  let [y, m, d] = bparts(Date.now()).day.split('-').map(Number);
  const sum = mk => { let kwh = 0, days = 0, litres = 0; for (const [k, v] of Object.entries(mmon.daily)) if (k.startsWith(mk)) { kwh += v; days++; } for (const [k, v] of Object.entries(mmon.fuel)) if (k.startsWith(mk)) litres += v; return { kwh: Math.round(kwh), litres: Math.round(litres), days }; };
  const cur = y + '-' + String(m).padStart(2, '0'), pm = m < 2 ? 12 : m - 1, prev = (m < 2 ? y - 1 : y) + '-' + String(pm).padStart(2, '0');
  if (d < 5) { const p = sum(prev); if (p.days) return { month: prev, final: true, ...p }; }
  return { month: cur, final: false, ...sum(cur) };
}
function mhTrack(v) {
  const L = v.fuel_l, now = Date.now(), gk = (v['m1.kw'] || 0) + (v['m2.kw'] || 0);
  const kwNow = gk + Math.max(0, v['solar.kw'] || 0);          // energy produced = generators + solar, added up over time
  { const dk = bparts(now).day;
    if (meLast && now - meLast.t < 120e3) mmon.daily[dk] = (mmon.daily[dk] || 0) + (kwNow + meLast.kw) / 2 * (now - meLast.t) / 3600e3;
    if (now - mmSaved > 60e3) { mmSaved = now; Object.keys(mmon.daily).sort().slice(0, -120).forEach(k => delete mmon.daily[k]); Object.keys(mmon.fuel).sort().slice(0, -120).forEach(k => delete mmon.fuel[k]); fs.writeFile(MH_MON_FILE, JSON.stringify(mmon), () => {}); } }
  if (mcons.day && meLast && now - meLast.t < 120e3) { const e = (kwNow + meLast.kw) / 2 * (now - meLast.t) / 3600e3; mcons.kwh = (mcons.kwh || 0) + e; mcons.kwhH = mcons.kwhH || {}; const hr = bparts(now).hour; mcons.kwhH[hr] = (mcons.kwhH[hr] || 0) + e; }
  meLast = { t: now, kw: kwNow };
  if (L == null || !isFinite(L)) return;
  mcKw += gk; mcKwN++;
  const m = Math.floor(now / 60000), b = bparts(now);
  if (!mcLast) { mcLast = { m, t: now, level: L }; if (!mcons.day) mcons = { day: b.day, since: now, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null }; return; }
  if (m === mcLast.m) return;
  if (b.day !== mcons.day) mcons = { day: b.day, since: now, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: { day: mcons.day, since: mcons.since, total: Math.round(mcons.total), refuelled: Math.round(mcons.refuelled), kwh: Math.round(mcons.kwh || 0) } };
  const dt = (now - mcLast.t) / 3600e3, kwAvg = mcKwN ? mcKw / mcKwN : 0, rise = L - mcLast.level;
  let used, added = 0;
  if (rise > 20) { added = rise; used = kwAvg * LPKW_S * dt; }       // level jumped up: a refuel, the use of that minute is estimated from the load
  else used = Math.max(0, -rise);
  mmon.fuel[b.day] = (mmon.fuel[b.day] || 0) + used;
  mcons.total += used; mcons.refuelled += added; mcons.hours[b.hour] = (mcons.hours[b.hour] || 0) + used;
  mcRecent.push({ t: now, used }); mcRecent = mcRecent.filter(x => x.t > now - 600e3);
  mcLast = { m, t: now, level: L }; mcKw = 0; mcKwN = 0;
  fs.writeFile(MH_CONS_FILE, JSON.stringify(mcons), () => {});
}
function mhFuelToday() {
  const now = Date.now(), cur = bparts(now), r = mcRecent.reduce((a, x) => a + x.used, 0), span = mcRecent.length ? Math.max(60e3, now - mcRecent[0].t + 60e3) : 0;
  const kh = mcons.kwhH || {}, hs = [...new Set([...Object.keys(mcons.hours), ...Object.keys(kh)])].map(Number).sort((a, b) => a - b);
  return { day: mcons.day, since: mcons.since, total: Math.round(mcons.total), refuelled: Math.round(mcons.refuelled), curHour: cur.hour, kwh: Math.round(mcons.kwh || 0), month: mhMonthTotal(),
    hours: hs.map(h => ({ h, used: Math.round(mcons.hours[h] || 0), kwh: Math.round(kh[h] || 0) })),
    rate: span ? +(r / (span / 3600e3)).toFixed(1) : null, prev: mcons.prev };
}
setTimeout(() => { mhPoll(); setInterval(mhPoll, 20000); }, 15000);

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
  // Backup / restore of the counters (kWh today, monthly kWh, fuel used today), so a new version of the page can be put online without losing them.
  // Restore is accepted only in the first 15 minutes after a start, and only keeps the larger value of every day, so it can never lower a count.
  if (url === '/api/backup') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ t: Date.now(), cons, mon })); }
  if (url === '/api/restore' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 5e5) req.destroy(); });
    req.on('end', () => {
      const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      try {
        if (process.uptime() > 900) { res.writeHead(403, H); return res.end(JSON.stringify({ error: 'only right after a start' })); }
        const j = JSON.parse(body), out = {};
        if (j.mon && j.mon.daily) { for (const [k, v] of Object.entries(j.mon.daily)) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mon.daily[k] = Math.max(mon.daily[k] || 0, +v); out.days = Object.keys(mon.daily).length; for (const [k, v] of Object.entries((j.mon && j.mon.fuel) || {})) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mon.fuel[k] = Math.max(mon.fuel[k] || 0, +v); fs.writeFile(MON_FILE, JSON.stringify(mon), () => {}); }
        const c = j.cons;
        if (c && c.day && c.day === cons.day) {                                      // same day: keep the bigger counts, and the earlier start
          cons.total = Math.max(cons.total, +c.total || 0); cons.refuelled = Math.max(cons.refuelled, +c.refuelled || 0); cons.kwh = Math.max(cons.kwh || 0, +c.kwh || 0);
          if (c.since && c.since < cons.since) cons.since = c.since;
          for (const [h, v] of Object.entries(c.hours || {})) cons.hours[h] = Math.max(cons.hours[h] || 0, +v || 0);
          cons.kwhH = cons.kwhH || {}; for (const [h, v] of Object.entries(c.kwhH || {})) cons.kwhH[h] = Math.max(cons.kwhH[h] || 0, +v || 0);
          if (c.prev && !cons.prev) cons.prev = c.prev;
          fs.writeFile(CONS_FILE, JSON.stringify(cons), () => {}); out.today = true;
        }
        res.writeHead(200, H); return res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) { res.writeHead(400, H); return res.end(JSON.stringify({ error: 'bad data' })); }
    });
    return;
  }
  if (url === '/api/alarm' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body), H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (j.test) {
          if (Date.now() - testLastSent < 20000) { res.writeHead(429, H); return res.end(JSON.stringify({ error: 'wait' })); }
          testLastSent = Date.now();
          const ok = await notifyPhone('AL DHOUR POWER PLANT - TEST', 'Alert notifications are working.', 'default', 'white_check_mark', true);
          res.writeHead(200, H); return res.end(JSON.stringify({ ok, push: PUSH_ON }));
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
  if (url === '/api/mahfara/backup') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ t: Date.now(), cons: mcons, mon: mmon })); }
  if (url === '/api/mahfara/restore' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 5e5) req.destroy(); });
    req.on('end', () => {
      const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      try {
        if (process.uptime() > 900) { res.writeHead(403, H); return res.end(JSON.stringify({ error: 'only right after a start' })); }
        const j = JSON.parse(body), out = {};
        if (j.mon && j.mon.daily) { for (const [k, v] of Object.entries(j.mon.daily)) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mmon.daily[k] = Math.max(mmon.daily[k] || 0, +v); out.days = Object.keys(mmon.daily).length; for (const [k, v] of Object.entries(j.mon.fuel || {})) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mmon.fuel[k] = Math.max(mmon.fuel[k] || 0, +v); fs.writeFile(MH_MON_FILE, JSON.stringify(mmon), () => {}); }
        const c = j.cons;
        if (c && c.day && c.day === mcons.day) {
          mcons.total = Math.max(mcons.total, +c.total || 0); mcons.refuelled = Math.max(mcons.refuelled, +c.refuelled || 0); mcons.kwh = Math.max(mcons.kwh || 0, +c.kwh || 0);
          if (c.since && c.since < mcons.since) mcons.since = c.since;
          for (const [h, v] of Object.entries(c.hours || {})) mcons.hours[h] = Math.max(mcons.hours[h] || 0, +v || 0);
          mcons.kwhH = mcons.kwhH || {}; for (const [h, v] of Object.entries(c.kwhH || {})) mcons.kwhH[h] = Math.max(mcons.kwhH[h] || 0, +v || 0);
          if (c.prev && !mcons.prev) mcons.prev = c.prev;
          fs.writeFile(MH_CONS_FILE, JSON.stringify(mcons), () => {}); out.today = true;
        }
        res.writeHead(200, H); return res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) { res.writeHead(400, H); return res.end(JSON.stringify({ error: 'bad data' })); }
    });
    return;
  }
  if (url === '/api/mahfara/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const ok = cfg.mode === 'fbox';
    return res.end(JSON.stringify({ ok, conn: ok ? mh.conn : 'stale', error: mh.error, updated: mh.updated, values: mh.values, history: mhHist, fuelToday: mhFuelToday(), now: Date.now() }));
  }
  if (url === '/api/status') {
    const vid = (new URL(req.url, 'http://x').searchParams.get('v') || '');
    if (/^[a-z0-9]{6,24}$/.test(vid)) viewers.set(vid, Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const s = cfg.site;
    return res.end(JSON.stringify({
      site: { name: s.name, tankLitres: s.tankLitres || null, ratedKva: s.ratedKva || null, lowFuelHours: s.lowFuelHours ?? 12, details: s.details },
      generators: gens.map(({ id, label, ratedKva }) => ({ id, label, ratedKva: ratedKva || null })),
      decimals: Object.fromEntries([...cfg.points.map(p => [p.key, p.decimals ?? 0]), ...(cfg.shared || []).map(p => [p.key, p.decimals ?? 0])]),
      demo: cfg.mode !== 'fbox' && cfg.mode !== 'push', now: Date.now(), pollSeconds: cfg.pollSeconds,
      online: onlineCount(), fuelToday: fuelToday(), alarm: { litres: alarmL, push: PUSH_ON, active: alarmActive }, conn: state.conn, error: state.error, updated: state.updated, values: state.values, history: history.filter(h => Date.now() - h.t < DAY)
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
