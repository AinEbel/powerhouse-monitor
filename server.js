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
// The Al Dhour solar power meter is read like the generator meters: same readings, its own FBox group.
const SOLAR = cfg.solar || null, SOLAR_KEYS = ['v1', 'v2', 'v3', 'i1', 'i2', 'i3', 'freq', 'kw'];
if (SOLAR) for (const p of cfg.points) if (SOLAR_KEYS.includes(p.key)) allPoints.push({ key: 'solar.' + p.key, name: (SOLAR.names || {})[p.key] || p.name, group: SOLAR.group, div: p.div || 1 });

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
  if (SOLAR) { const sk = Math.max(0, j(32, 6)); ['v1', 'v2', 'v3'].forEach(k => v['solar.' + k] = j(233, 3)); ['i1', 'i2', 'i3'].forEach(k => v['solar.' + k] = sk * 1000 / 3 / 233); v['solar.freq'] = j(50, 0.2); v['solar.kw'] = sk; }
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
// Solar production, running total: kW of the solar added up over time. NEVER reset (not daily, not monthly), it only keeps adding.
const SOL_FILE = path.join(__dirname, 'solar_total.json');
let sol = { kwh: 0, since: null }, solLast = null, solSaved = 0;
try { const j = JSON.parse(fs.readFileSync(SOL_FILE, 'utf8')); if (j && isFinite(j.kwh)) sol = { kwh: +j.kwh, since: j.since || null }; } catch (_) {}
mon.fuel = mon.fuel || {};                       // litres of fuel used per day, for the monthly consumption
mon.solar = mon.solar || {};                     // solar kWh per day
function periodStart(day) { let [y, m, d] = day.split('-').map(Number); if (d < 5) { m--; if (m < 1) { m = 12; y--; } } return y + '-' + String(m).padStart(2, '0') + '-05'; }
function monthTotal() {
  let [y, m, d] = bparts(Date.now()).day.split('-').map(Number);
  const sum = mk => { let kwh = 0, days = 0, litres = 0; for (const [k, v] of Object.entries(mon.daily)) if (k.startsWith(mk)) { kwh += v; days++; } for (const [k, v] of Object.entries(mon.fuel)) if (k.startsWith(mk)) litres += v; return { kwh: Math.round(kwh), litres: Math.round(litres), days }; };
  const cur = y + '-' + String(m).padStart(2, '0'), pm = m < 2 ? 12 : m - 1, prev = (m < 2 ? y - 1 : y) + '-' + String(pm).padStart(2, '0');
  if (d < 5) { const p = sum(prev); if (p.days) return { month: prev, final: true, ...p }; }   // days 1-4: show last month's finished total, if there is data for it (time to read it)
  return { month: cur, final: false, ...sum(cur) };                                                 // otherwise the running total of the current month (days 1-4 included)
}
// Power read at the AIN EBEL busbar = every source added up: generator + generator + solar.
// Solar kW is read from the solar power meter (no estimate: no reading = 0 kW).
function solarKw(v) { const k = v['solar.kw']; return k != null && isFinite(k) && k > 0 ? k : 0; }
function trackToday(v) {
  const L = v.fuel_l, c = v.fuel_counter, now = Date.now();
  const skw = solarKw(v), kwNow = gens.reduce((a, g) => a + (v[g.id + '.kw'] || 0), 0) + skw;     // energy produced: kW added up over time (generators + solar)
  { if (!sol.since) sol.since = now;
    if (solLast && now - solLast.t < 120e3) { const e = (skw + solLast.kw) / 2 * (now - solLast.t) / 3600e3, dk = bparts(now).day; sol.kwh += e; mon.solar[dk] = (mon.solar[dk] || 0) + e; }   // running total (never reset) + solar kWh of each day (Lebanon time, so it starts again at 00:00)
    solLast = { t: now, kw: skw };
    if (now - solSaved > 60e3) { solSaved = now; fs.writeFile(SOL_FILE, JSON.stringify(sol), () => {}); } }
  { const dk = bparts(now).day;                          // kWh produced is kept for every day, so any day range can be added up
    if (eLast && now - eLast.t < 120e3) mon.daily[dk] = (mon.daily[dk] || 0) + (kwNow + eLast.kw) / 2 * (now - eLast.t) / 3600e3;
    if (now - monSaved > 60e3) { monSaved = now; const old = Object.keys(mon.daily).sort().slice(0, -120); old.forEach(k => delete mon.daily[k]); Object.keys(mon.fuel).sort().slice(0, -120).forEach(k => delete mon.fuel[k]); Object.keys(mon.solar).sort().slice(0, -120).forEach(k => delete mon.solar[k]); fs.writeFile(MON_FILE, JSON.stringify(mon), () => {}); } }
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
// Fuel per generator, worked out from its own kW: 0.28 litres for every kWh it produces (GEN_LPKWH can change it).
// Kept for every month (Lebanon time; a month starts again at 00:00 on the 1st, finished months are kept) and a total that is NEVER reset.
const GF_FILE = path.join(__dirname, 'gen_fuel.json'), GEN_LPKWH = +E.GEN_LPKWH || 0.28;
let gf = {}, gfLast = {}, gfSaved = 0;
try { const j = JSON.parse(fs.readFileSync(GF_FILE, 'utf8')); if (j && typeof j === 'object') gf = j; } catch (_) {}
function gfOf(id) { return gf[id] = gf[id] || { total: 0, months: {}, since: null }; }
function trackGenFuel(v) {
  const now = Date.now(), mk = bparts(now).day.slice(0, 7);
  for (const g of gens) {
    const kw = Math.max(0, +v[g.id + '.kw'] || 0), r = gfOf(g.id), l = gfLast[g.id];
    if (!r.since) r.since = now;
    if (l && now - l.t < 120e3) { const L = (kw + l.kw) / 2 * (now - l.t) / 3600e3 * GEN_LPKWH; r.total += L; r.months[mk] = (r.months[mk] || 0) + L; }
    gfLast[g.id] = { t: now, kw };
  }
  if (now - gfSaved > 60e3) { gfSaved = now; fs.writeFile(GF_FILE, JSON.stringify(gf), () => {}); }
}
// AL MAHFARA generators: the same counting, but completely separate from Al Dhour (own file, own counters, own backup part).
const MH_GF_FILE = path.join(__dirname, 'mh_gen_fuel.json'), MH_GF = [{ id: 'm1', key: 'm1' }, { id: 'm2', key: 'm2' }];
let mgf = {}, mgfLast = {}, mgfSaved = 0;
try { const j = JSON.parse(fs.readFileSync(MH_GF_FILE, 'utf8')); if (j && typeof j === 'object') mgf = j; } catch (_) {}
function mgfOf(id) { return mgf[id] = mgf[id] || { total: 0, months: {}, since: null }; }
function mhMergeGenFuel(j) {                                // keep the bigger value, so a count can never go down
  if (!j || typeof j !== 'object') return 0;
  let n = 0;
  for (const [id, x] of Object.entries(j)) {
    if (!x || !MH_GF.some(g => g.id === id)) continue;
    const r = mgfOf(id); n++;
    if (isFinite(x.total) && x.total >= 0) r.total = Math.max(r.total, +x.total);
    for (const [k, v] of Object.entries(x.months || {})) if (/^\d{4}-\d\d$/.test(k) && isFinite(v) && v >= 0) r.months[k] = Math.max(r.months[k] || 0, +v);
    if (x.since && (!r.since || x.since < r.since)) r.since = +x.since;
  }
  fs.writeFileSync(MH_GF_FILE, JSON.stringify(mgf));
  return n;
}
function mhTrackGenFuel(v) {
  const now = Date.now(), mk = bparts(now).day.slice(0, 7);
  for (const g of MH_GF) {
    const kw = Math.max(0, +v[g.key + '.kw'] || 0), r = mgfOf(g.id), l = mgfLast[g.id];
    if (!r.since) r.since = now;
    if (l && now - l.t < 120e3) { const L = (kw + l.kw) / 2 * (now - l.t) / 3600e3 * GEN_LPKWH; r.total += L; r.months[mk] = (r.months[mk] || 0) + L; }
    mgfLast[g.id] = { t: now, kw };
  }
  if (now - mgfSaved > 60e3) { mgfSaved = now; fs.writeFile(MH_GF_FILE, JSON.stringify(mgf), () => {}); }
}
function mhGenFuel(v) {
  const [y, m] = bparts(Date.now()).day.split('-').map(Number), cur = y + '-' + String(m).padStart(2, '0'), prev = (m < 2 ? y - 1 : y) + '-' + String(m < 2 ? 12 : m - 1).padStart(2, '0');
  return { lpkwh: GEN_LPKWH, month: cur, lastMonth: prev, gens: Object.fromEntries(MH_GF.map(g => { const r = mgfOf(g.id), kw = Math.max(0, +(v || {})[g.key + '.kw'] || 0);
    return [g.key, { lph: +(kw * GEN_LPKWH).toFixed(1), month: +(r.months[cur] || 0).toFixed(1), lastMonth: r.months[prev] != null ? +r.months[prev].toFixed(1) : null, total: +r.total.toFixed(1), since: r.since }]; })) };
}
// Estimated savings from the solar (each site from its own counters): every solar kWh is a kWh the generators did not have to make.
// Fuel saved = solar kWh x GEN_LPKWH (0.28 L/kWh, the same rate as the generator fuel); CO2 saved = litres x 2.68 kg (burning 1 L of diesel).
// Read only from the solar counters already recorded; nothing new is stored.
const CO2_KG_PER_L = +E.CO2_KG_PER_L || 2.68;
function solarSave(daily = mon.solar, total = sol.kwh) {
  const day = bparts(Date.now()).day, mk = day.slice(0, 7);
  let month = 0; for (const [k, v] of Object.entries(daily || {})) if (k.startsWith(mk)) month += v;
  const one = kwh => ({ kwh: +kwh.toFixed(1), litres: +(kwh * GEN_LPKWH).toFixed(1), co2: +(kwh * GEN_LPKWH * CO2_KG_PER_L).toFixed(1) });
  return { lpkwh: GEN_LPKWH, co2PerL: CO2_KG_PER_L, month: mk, today: one((daily || {})[day] || 0), mon: one(month), total: one(total) };
}
function genFuel(v) {
  const [y, m] = bparts(Date.now()).day.split('-').map(Number), cur = y + '-' + String(m).padStart(2, '0'), prev = (m < 2 ? y - 1 : y) + '-' + String(m < 2 ? 12 : m - 1).padStart(2, '0');
  return { lpkwh: GEN_LPKWH, month: cur, lastMonth: prev, gens: Object.fromEntries(gens.map(g => { const r = gfOf(g.id), kw = Math.max(0, +(v || {})[g.id + '.kw'] || 0);
    return [g.id, { lph: +(kw * GEN_LPKWH).toFixed(1), month: +(r.months[cur] || 0).toFixed(1), lastMonth: r.months[prev] != null ? +r.months[prev].toFixed(1) : null, total: +r.total.toFixed(1), since: r.since }]; })) };
}
function mergeGenFuel(j) {                                  // restore / hand-over: keep the bigger value, so a count can never go down
  if (!j || typeof j !== 'object') return 0;
  let n = 0;
  for (const [id, x] of Object.entries(j)) {
    if (!x || !gens.some(g => g.id === id)) continue;
    const r = gfOf(id); n++;
    if (isFinite(x.total) && x.total >= 0) r.total = Math.max(r.total, +x.total);
    for (const [k, v] of Object.entries(x.months || {})) if (/^\d{4}-\d\d$/.test(k) && isFinite(v) && v >= 0) r.months[k] = Math.max(r.months[k] || 0, +v);
    if (x.since && (!r.since || x.since < r.since)) r.since = +x.since;
  }
  return n;
}
// ---------- Hourly data logger (Excel download) ----------
// One line per hour (Lebanon time): average kW of each generator and the solar, fuel used by each generator in that hour
// (its kWh x GEN_LPKWH), the refuelling counter and the litres in the tank at the end of the hour. Kept forever: never reset, never trimmed (about 1.3 MB a year).
const DLOG_FILE = path.join(__dirname, 'data_log.json');
let dlog = [], dAcc = null;
try { const j = JSON.parse(fs.readFileSync(DLOG_FILE, 'utf8')); if (Array.isArray(j)) dlog = j; } catch (_) {}
const hourStart = t => Math.floor(t / 3600e3) * 3600e3;            // Lebanon is a whole number of hours from UTC, so hours line up
function dlogAdd(row) { const i = dlog.findIndex(r => r.t === row.t); if (i >= 0) return false; dlog.push(row); dlog.sort((a, b) => a.t - b.t); return true; }
function dlogClose(a) {
  const n = a.n || 1, row = { t: a.h };
  for (const g of gens) { row[g.id] = +(a.kw[g.id] / n).toFixed(1); row[g.id + 'Kwh'] = +a.kwh[g.id].toFixed(1); row[g.id + 'L'] = +(a.kwh[g.id] * GEN_LPKWH).toFixed(1); }
  row.solar = +(a.kw.solar / n).toFixed(1); row.solarKwh = +a.kwh.solar.toFixed(1); row.counter = a.counter; row.tank = a.tank; { const c = tempFor(a.h); row.temp = c != null ? c : wNow && Date.now() - wNow.t < 3 * 3600e3 ? wNow.c : null; }
  dlogAdd(row); fs.writeFile(DLOG_FILE, JSON.stringify(dlog), () => {});
}
function trackDataLog(v) {
  const now = Date.now(), h = hourStart(now), kw = { solar: solarKw(v) }; for (const g of gens) kw[g.id] = Math.max(0, +v[g.id + '.kw'] || 0);
  if (dAcc && dAcc.h !== h) { dlogClose(dAcc); dAcc = null; }
  if (!dAcc) { dAcc = { h, n: 0, kw: {}, kwh: {}, last: null }; for (const k in kw) { dAcc.kw[k] = 0; dAcc.kwh[k] = 0; } }
  dAcc.n++; for (const k in kw) dAcc.kw[k] += kw[k];
  if (dAcc.last && now - dAcc.last.t < 120e3) for (const k in kw) dAcc.kwh[k] += (kw[k] + dAcc.last.kw[k]) / 2 * (now - dAcc.last.t) / 3600e3;
  dAcc.last = { t: now, kw };
  if (v.fuel_counter != null && isFinite(v.fuel_counter)) dAcc.counter = +v.fuel_counter;
  if (v.fuel_l != null && isFinite(v.fuel_l)) dAcc.tank = Math.round(v.fuel_l);
}
// AL MAHFARA hourly log: the same lines, completely separate (own file mh_data_log.json, own rows). Kept forever, never trimmed.
// No refuelling counter is read from the AL MAHFARA FBox, so that column is left out.
const MH_DLOG_FILE = path.join(__dirname, 'mh_data_log.json');
let mdlog = [], mdAcc = null;
try { const j = JSON.parse(fs.readFileSync(MH_DLOG_FILE, 'utf8')); if (Array.isArray(j)) mdlog = j; } catch (_) {}
const MH_LOG_GENS = ['m1', 'm2'];
function mdlogAdd(row) { if (mdlog.some(r => r.t === row.t)) return false; mdlog.push(row); mdlog.sort((a, b) => a.t - b.t); return true; }
function mdlogClose(a) {
  const n = a.n || 1, row = { t: a.h };
  for (const id of MH_LOG_GENS) { row[id] = +(a.kw[id] / n).toFixed(1); row[id + 'Kwh'] = +a.kwh[id].toFixed(1); row[id + 'L'] = +(a.kwh[id] * GEN_LPKWH).toFixed(1); }
  row.solar = +(a.kw.solar / n).toFixed(1); row.solarKwh = +a.kwh.solar.toFixed(1); row.tank = a.tank; { const c = tempFor(a.h); row.temp = c != null ? c : wNow && Date.now() - wNow.t < 3 * 3600e3 ? wNow.c : null; }
  mdlogAdd(row); fs.writeFile(MH_DLOG_FILE, JSON.stringify(mdlog), () => {});
}
function mhTrackDataLog(v) {
  const now = Date.now(), h = hourStart(now), kw = { solar: Math.max(0, +v['solar.kw'] || 0) }; for (const id of MH_LOG_GENS) kw[id] = Math.max(0, +v[id + '.kw'] || 0);
  if (mdAcc && mdAcc.h !== h) { mdlogClose(mdAcc); mdAcc = null; }
  if (!mdAcc) { mdAcc = { h, n: 0, kw: {}, kwh: {}, last: null }; for (const k in kw) { mdAcc.kw[k] = 0; mdAcc.kwh[k] = 0; } }
  mdAcc.n++; for (const k in kw) mdAcc.kw[k] += kw[k];
  if (mdAcc.last && now - mdAcc.last.t < 120e3) for (const k in kw) mdAcc.kwh[k] += (kw[k] + mdAcc.last.kw[k]) / 2 * (now - mdAcc.last.t) / 3600e3;
  mdAcc.last = { t: now, kw };
  if (v.fuel_l != null && isFinite(v.fuel_l)) mdAcc.tank = Math.round(v.fuel_l);
}
// First start with an empty AL MAHFARA log: fill it from the AL MAHFARA chart samples (one a minute, last 24 hours).
function mdlogFromHistory() {
  if (mdlog.length || !mhHist.length) return;
  const by = new Map();
  for (const p of mhHist) { const h = hourStart(p.t); if (h >= hourStart(Date.now())) continue; if (!by.has(h)) by.set(h, []); by.get(h).push(p); }
  for (const [h, ps] of by) {
    const row = { t: h, backfill: true };
    for (const id of MH_LOG_GENS) { const k = ps.map(p => p[id]).filter(x => x != null); row[id] = k.length ? +(k.reduce((a, b) => a + b, 0) / k.length).toFixed(1) : null; row[id + 'L'] = row[id] == null ? null : +(row[id] * ps.length / 60 * GEN_LPKWH).toFixed(1); }
    row.solar = null; row.solarKwh = null; const lf = [...ps].reverse().find(p => p.fuel != null); row.tank = lf ? Math.round(lf.fuel) : null;
    mdlog.push(row);
  }
  mdlog.sort((a, b) => a.t - b.t); if (mdlog.length) fs.writeFile(MH_DLOG_FILE, JSON.stringify(mdlog), () => {});
}
function mhMergeDataLog(list) { let n = 0; if (Array.isArray(list)) for (const r of list) if (r && isFinite(r.t)) { if (mdlogAdd(r)) n++; else if (r.temp != null) { const o = mdlog.find(x => x.t === r.t); if (o && o.temp == null) o.temp = r.temp; } } return n; }
// Outside temperature (no sensor on the FBox): free hourly weather data from open-meteo.com for the site's location.
// Every 30 minutes the last days are read and each logged hour that has no temperature yet gets one (nothing is ever replaced).
const W_LAT = +(E.WEATHER_LAT || (cfg.site.lat ?? 33.1104)), W_LON = +(E.WEATHER_LON || (cfg.site.lon ?? 35.4013)), W_URL = E.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast';
let wHours = new Map(), wNow = null, wErr = null;
async function weatherPoll() {
  if (E.WEATHER === 'off') return;
  try {
    const days = [...dlog, ...mdlog].some(r => r.temp == null && Date.now() - r.t < 92 * DAY) ? 92 : 2;
    const r = await fetch(W_URL + '?latitude=' + W_LAT + '&longitude=' + W_LON + '&hourly=temperature_2m&current=temperature_2m&past_days=' + days + '&forecast_days=1&timeformat=unixtime&timezone=GMT', { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('weather answered ' + r.status);
    const j = await r.json(), t = j.hourly && j.hourly.time, v = j.hourly && j.hourly.temperature_2m;
    if (!Array.isArray(t) || !Array.isArray(v)) throw new Error('weather: no hourly data');
    t.forEach((x, i) => { if (v[i] != null && isFinite(v[i])) wHours.set(x * 1000, +v[i]); });
    if (j.current && isFinite(j.current.temperature_2m)) wNow = { t: Date.now(), c: +j.current.temperature_2m };
    let n = 0, mn = 0;
    for (const row of dlog) if (row.temp == null) { const c = tempFor(row.t); if (c != null) { row.temp = c; n++; } }
    for (const row of mdlog) if (row.temp == null) { const c = tempFor(row.t); if (c != null) { row.temp = c; mn++; } }
    if (n) fs.writeFile(DLOG_FILE, JSON.stringify(dlog), () => {});
    if (mn) fs.writeFile(MH_DLOG_FILE, JSON.stringify(mdlog), () => {});
    wErr = null;
  } catch (e) { wErr = e.message; console.error('weather', e.message); }
}
// The log hour 14:00 covers 14:00-15:00: use the average of the readings at 14:00 and 15:00 (or whichever exists).
function tempFor(h) { const a = wHours.get(h), b = wHours.get(h + 3600e3), x = [a, b].filter(z => z != null); return x.length ? Math.round(x.reduce((p, q) => p + q, 0) / x.length * 10) / 10 : null; }
setTimeout(() => { weatherPoll(); setInterval(weatherPoll, 30 * 60000); }, 20000);
// First start with an empty log: fill it from the chart samples already recorded (one a minute, last 30 days). No refuelling counter in those.
function dlogFromHistory() {
  if (dlog.length || !history.length) return;
  const by = new Map();
  for (const p of history) { const h = hourStart(p.t); if (h >= hourStart(Date.now())) continue; if (!by.has(h)) by.set(h, []); by.get(h).push(p); }
  for (const [h, ps] of by) {
    const row = { t: h, backfill: true };
    for (const g of gens) { const k = ps.map(p => p[g.id]).filter(x => x != null); row[g.id] = k.length ? +(k.reduce((a, b) => a + b, 0) / k.length).toFixed(1) : null; row[g.id + 'L'] = row[g.id] == null ? null : +(row[g.id] * ps.length / 60 * GEN_LPKWH).toFixed(1); }
    const sk = ps.map(p => p.solar).filter(x => x != null); row.solar = sk.length ? +(sk.reduce((a, b) => a + b, 0) / sk.length).toFixed(1) : null; row.solarKwh = row.solar == null ? null : +(row.solar * ps.length / 60).toFixed(1);
    row.counter = null; const lf = [...ps].reverse().find(p => p.fuel != null); row.tank = lf ? Math.round(lf.fuel) : null;
    dlog.push(row);
  }
  dlog.sort((a, b) => a.t - b.t); fs.writeFile(DLOG_FILE, JSON.stringify(dlog), () => {});
}
function mergeDataLog(list) { let n = 0; if (Array.isArray(list)) for (const r of list) if (r && isFinite(r.t)) { if (dlogAdd(r)) n++; else if (r.temp != null) { const o = dlog.find(x => x.t === r.t); if (o && o.temp == null) o.temp = r.temp; } } return n; }
// A real .xlsx file, built without extra packages: a zip (stored, no compression) of the few XML parts Excel needs.
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(files) {
  const parts = [], cen = []; let off = 0;
  for (const [name, text] of files) {
    const d = Buffer.from(text, 'utf8'), nm = Buffer.from(name), crc = crc32(d), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, d); cen.push(c, nm); off += 30 + nm.length + d.length;
  }
  const cd = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
function xlsx(rows, widths, o) {
  o = o || {};
  const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheet = rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => { const ref = col(ci) + (ri + 1), rn = ri + 1, st = rn === o.title ? ' s="3"' : (o.head || []).includes(rn) ? ' s="2"' : rn === o.total ? ' s="4"' : ri === 1 ? ' s="5"' : ' s="6"';
    return (v == null || v === '') && !(o.head || []).includes(rn) ? '' : v == null || v === '' ? '<c r="' + ref + '"' + st + '/>' : typeof v === 'number' && isFinite(v) ? '<c r="' + ref + '"' + st + '><v>' + v + '</v></c>' : '<c r="' + ref + '" t="inlineStr"' + st + '><is><t>' + esc(v) + '</t></is></c>'; }).join('') + '</row>').join('');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hourly log" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="16"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2B343B"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF3C4"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD0D6DB"/></left><right style="thin"><color rgb="FFD0D6DB"/></right><top style="thin"><color rgb="FFD0D6DB"/></top><bottom style="thin"><color rgb="FFD0D6DB"/></bottom></border></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="7"><xf/><xf fontId="1" applyFont="1"/><xf fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf fontId="3" applyFont="1"/><xf fontId="1" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf fontId="4" applyFont="1"/><xf borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="4" topLeftCell="C5" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols><sheetData>' + sheet + '</sheetData>' + (o.merges && o.merges.length ? '<mergeCells count="' + o.merges.length + '">' + o.merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>']
  ]);
}
// Each power house has its own log (own file, own rows); the same columns and pages are built from it.
const LOG_SITES = {
  aldhour: { name: 'AL DHOUR POWER HOUSE', slug: 'al-dhour', counter: true, gens: () => gens.map(g => g.id), rows: () => dlog, tank: () => cfg.site.tankLitres },
  mahfara: { name: 'AL MAHFARA POWER HOUSE', slug: 'al-mahfara', counter: false, gens: () => ['m1', 'm2'], rows: () => mdlog, tank: () => MH_TANK_L }
};
// Set LOG_PASSWORD on Render to ask for a password before the Excel file is given (the live page stays open). Not set = open to everyone.
const LOG_PASSWORD = E.LOG_PASSWORD || '';
function beirutMidnight(d) { const u = Date.parse(d + 'T00:00:00Z'); for (const o of [2, 3, 4, 1]) { const t = u - o * 3600e3, b = bparts(t); if (b.day === d && b.hour === 0) return t; } return u - 2 * 3600e3; }
const BZM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Columns of the data log. ?cols=a,b,c picks some of them (the page has a tick box for each); none given = all.
function dataLogCols(S) {
  const kwhOf = (r, id) => r[id + 'Kwh'] != null ? r[id + 'Kwh'] : r[id + 'L'] != null ? r[id + 'L'] / GEN_LPKWH : null;
  const c = [];
  S.gens().forEach((id, i) => { const n = i + 1, G = 'Gen' + n;
    c.push({ k: 'g' + n + 'kw', grp: G, label: G + ' kW', get: r => r[id] },
           { k: 'g' + n + 'kwh', grp: G, label: G + ' kWh', get: r => kwhOf(r, id), sum: true },
           { k: 'g' + n + 'fuel', grp: G, label: G + ' FL', get: r => r[id + 'L'], sum: true }); });
  c.push({ k: 'skw', grp: 'Solar', label: 'Solar kW', get: r => r.solar },
         { k: 'skwh', grp: 'Solar', label: 'Solar kWh', get: r => r.solarKwh, sum: true },
         { k: 'sfs', grp: 'Solar saving', label: 'Fuel saved L', get: r => r.solarKwh == null ? null : r.solarKwh * GEN_LPKWH, sum: true },
         { k: 'sco2', grp: 'Solar saving', label: 'CO₂ saved kg', get: r => r.solarKwh == null ? null : r.solarKwh * GEN_LPKWH * CO2_KG_PER_L, sum: true },
         { k: 'tkwh', grp: 'Total', label: 'Total kWh', get: r => { let t = 0, a = false; for (const id of S.gens()) { const v = kwhOf(r, id); if (v != null) { t += v; a = true; } } if (r.solarKwh != null) { t += r.solarKwh; a = true; } return a ? t : null; }, sum: true },
         { k: 'temp', grp: 'Weather', label: 'Out °C', get: r => r.temp });
  if (S.counter) c.push({ k: 'counter', grp: 'Tank', label: 'Refuel counter', get: r => r.counter });
  c.push({ k: 'tank', grp: 'Tank', label: 'Tank L', get: r => r.tank });
  return c;
}
function dataLogRows(S, from, to, pick) {
  const f = t => { const p = {}; for (const x of BZM.formatToParts(new Date(t))) p[x.type] = x.value; return [p.year + '-' + p.month + '-' + p.day, p.hour + ':' + p.minute]; };   // Lebanon time (summer and winter)
  const r1 = x => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10, all = dataLogCols(S);
  const cols = pick && pick.length ? all.filter(c => pick.includes(c.k)) : all, sum = {}, rows = [];
  for (const r of S.rows()) if (r.t >= from && r.t <= to) {
    const [d, h] = f(r.t);
    rows.push({ d, h, star: !!r.backfill, v: cols.map(c => { const x = r1(c.get(r)); if (c.sum && x != null) sum[c.k] = (sum[c.k] || 0) + x; return x; }) });
  }
  return { site: S.name, cols, rows, total: cols.map(c => c.sum ? r1(sum[c.k] || 0) : null),
    note: 'Generator fuel = generator kWh × ' + GEN_LPKWH + ' L/kWh. Hours marked * were rebuilt from the chart data (no refuelling counter reading).' };
}
function dataLogXlsx(S, from, to, pick, period) {
  const d = dataLogRows(S, from, to, pick), cols = d.cols.length + 2, tk = S.tank();
  const cap = tk ? ' · Tank capacity ' + tk.toLocaleString('en-US') + ' L' : '';
  const rows = [[d.site], ['Hourly data log · ' + period + cap], [], ['Date', 'Hour', ...d.cols.map(c => c.label)],
    ...d.rows.map(r => [r.d, r.h, ...r.v]), ['TOTAL', d.rows.length + ' h', ...d.total]];
  return xlsx(rows, [12, 8, ...d.cols.map(c => Math.max(10, c.label.length + 3))], { title: 1, head: [4], total: rows.length, cols });
}
// The same log as a page to read in the browser: pick the readings to show, search a date or hour, Print / Save as PDF.
function dataLogHtml(S, from, to, pick, period, qs) {
  const d = dataLogRows(S, from, to, dataLogCols(S).map(c => c.k)), tk = S.tank(), on = new Set(pick && pick.length ? pick : d.cols.map(c => c.k));
  const esc = x => x == null ? '' : String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), n = x => x == null ? '–' : typeof x === 'number' ? x.toLocaleString('en-US', { maximumFractionDigits: 1 }) : esc(x);
  const groups = []; for (const c of d.cols) { const g = groups[groups.length - 1]; if (g && g.name === c.grp) g.cols.push(c); else groups.push({ name: c.grp, cols: [c] }); }
  const cards = d.cols.filter(c => c.sum).map(c => `<div class="card" data-k="${c.k}"><span>${esc(c.label)}</span><b>${n(d.total[d.cols.indexOf(c)])}</b></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.site)} - data log</title><style>
*{box-sizing:border-box}body{font:14px/1.45 "Segoe UI",Arial,Helvetica,sans-serif;margin:0;color:#1d2328;background:#f4f6f8}
header{background:#1d2328;color:#fff;padding:18px 24px;border-bottom:4px solid #ffc21a}header h1{margin:0;font-size:24px;letter-spacing:.06em}header p{margin:4px 0 0;color:#c7d0d6}
main{padding:16px 24px}.cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}.card{background:#fff;border:1px solid #dde3e8;border-top:3px solid #ffc21a;border-radius:6px;padding:10px 14px;min-width:150px;text-align:center}
.card span{display:block;font-size:11px;letter-spacing:.08em;color:#6b7a85;font-weight:700}.card b{display:block;font-size:22px}.card i{font-style:normal;font-size:12px;color:#6b7a85}
.bar{display:flex;gap:10px 18px;flex-wrap:wrap;align-items:center;background:#fff;border:1px solid #dde3e8;border-radius:6px;padding:10px 14px;margin-bottom:12px}
.bar input[type=search]{font-size:15px;padding:7px 10px;border:1px solid #b9c3ca;border-radius:4px;min-width:230px}.bar button{font-size:15px;padding:8px 16px;border:0;border-radius:4px;background:#ffc21a;font-weight:700;cursor:pointer;margin-left:auto}
.picks{display:flex;flex-wrap:wrap;gap:10px;width:100%}.picks fieldset{border:1px solid #dde3e8;border-radius:6px;margin:0;padding:4px 8px 8px;background:#fafbfc}.picks legend{font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:0 4px;color:#1d2328}.opts{display:flex;gap:4px}.picks label{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:64px;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap}.picks label:hover{background:#fff6d6}.picks input{width:18px;height:18px;accent-color:#d99a00;cursor:pointer;margin:0}
.wrap{overflow:auto;max-height:calc(100vh - 290px);background:#fff;border:1px solid #dde3e8;border-radius:6px}
table{border-collapse:collapse;width:100%}th,td{padding:5px 10px;font-size:13px;text-align:center;white-space:nowrap;border-bottom:1px solid #e6eaee}
thead th{background:#2b343b;color:#fff;font-weight:600;position:sticky;z-index:1}thead th{top:0;font-size:12.5px}
th.g,td.g{border-left:2px solid #c9d1d7}tbody tr:nth-child(even) td{background:#f7f9fa}tbody tr:hover td{background:#fff6d6}td.d{font-weight:600}
tfoot td{font-weight:700;background:#fff3c4;position:sticky;bottom:0;border-top:2px solid #ffc21a}.note{color:#6b7a85;font-size:12px;margin-top:8px}.off{display:none}
@media print{body{background:#fff;font-size:9px}header{padding:6px 0;background:#fff;color:#000;border-bottom:2px solid #000}header p{color:#333}main{padding:6px 0}.bar{display:none}.wrap{max-height:none;overflow:visible;border:0}
thead th,tfoot td{position:static}thead th{background:#ddd!important;color:#000}th,td{padding:2px 5px}.card{padding:4px 8px;min-width:0}.card b{font-size:13px}@page{size:A4 landscape;margin:8mm}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><header><h1>${esc(d.site)}</h1><p>Hourly data log · ${esc(period)} · ${d.rows.length} hours${tk ? ' · Tank capacity ' + tk.toLocaleString('en-US') + ' L' : ''}</p></header><main>
<div class="cards">${cards}</div>
<div class="bar"><div class="picks">${groups.map(g => `<fieldset><legend>${esc(g.name)}</legend><div class="opts">${g.cols.map(c => `<label><span>${esc(c.label)}</span><input type="checkbox" data-k="${c.k}"${on.has(c.k) ? ' checked' : ''}></label>`).join('')}</div></fieldset>`).join('')}</div>
<input type="search" id="q" placeholder="Search a date or hour, e.g. 2026-11-05 14:00"><span id="c"></span><button onclick="print()">Print / Save as PDF</button></div>
<div class="wrap"><table><thead><tr><th>Date</th><th>Hour</th>${d.cols.map((c, i) => `<th data-k="${c.k}"${i === 0 || d.cols[i - 1].grp !== c.grp ? ' class="g"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody id="b">${d.rows.map(r => `<tr><td class="d">${r.d}</td><td>${r.h}</td>${r.v.map((v, i) => `<td data-k="${d.cols[i].k}"${i === 0 || d.cols[i - 1].grp !== d.cols[i].grp ? ' class="g"' : ''}>${n(v)}</td>`).join('')}</tr>`).join('')}</tbody>
<tfoot><tr><td>TOTAL</td><td>${d.rows.length} h</td>${d.total.map((v, i) => `<td data-k="${d.cols[i].k}"${i === 0 || d.cols[i - 1].grp !== d.cols[i].grp ? ' class="g"' : ''}>${v == null ? '' : n(v)}</td>`).join('')}</tr></tfoot></table></div>
</main>
<script>
const boxes=[...document.querySelectorAll('.picks input')],rs=[...document.getElementById('b').rows],q=document.getElementById('q'),c=document.getElementById('c');
function cols(){const on=new Set(boxes.filter(b=>b.checked).map(b=>b.dataset.k));document.querySelectorAll('[data-k]').forEach(e=>{if(e.tagName!=='INPUT')e.classList.toggle('off',!on.has(e.dataset.k));});
}
boxes.forEach(b=>b.onchange=cols);cols();
q.oninput=()=>{const s=q.value.trim().toLowerCase();let k=0;for(const r of rs){const ok=!s||(r.cells[0].textContent+' '+r.cells[1].textContent).toLowerCase().includes(s);r.style.display=ok?'':'none';if(ok)k++;}c.textContent=s?k+' of '+rs.length+' hours':'';};
</script></body></html>`;
}
// KWH/L can be started again by hand (tap on the KWH/L box): only the ratio's starting point moves, kWh today and fuel today are never touched.
// The starting point lives in the day's counters (c.rb), so it is saved and backed up with them and is dropped at 00:00 with the day.
function ratioOf(c) { return c.rb ? { since: c.rb.ts, kwh: +((c.kwh || 0) - c.rb.kwh).toFixed(3), fuel: +(c.total - c.rb.fuel).toFixed(3) } : null; }
function fuelToday() {
  const now = Date.now(), cur = bparts(now), r = cRecent.reduce((a, x) => a + x.used, 0), span = cRecent.length ? Math.max(60e3, now - cRecent[0].t + 60e3) : 0;
  const kh = cons.kwhH || {}, hs = [...new Set([...Object.keys(cons.hours), ...Object.keys(kh)])].map(Number).sort((a, b) => a - b);
  return { day: cons.day, since: cons.since, total: Math.round(cons.total), refuelled: Math.round(cons.refuelled), curHour: cur.hour, kwh: Math.round(cons.kwh || 0), solarToday: +(mon.solar[bparts(now).day] || 0).toFixed(1), month: monthTotal(),
    hours: hs.map(h => ({ h, used: Math.round(cons.hours[h] || 0), kwh: Math.round(kh[h] || 0) })),
    rate: span ? +(r / (span / 3600e3)).toFixed(1) : null, prev: cons.prev, ratio: ratioOf(cons) };
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
    trackRefuel(values); trackFuelLevel(values); trackToday(values); trackGenFuel(values); trackDataLog(values); checkFuelAlarm(values);
    const last = history[history.length - 1];
    if (!last || Date.now() - last.t >= 60000) {
      const pt = { t: Date.now(), fuel: values.fuel_l ?? null };
      gens.forEach(g => pt[g.id] = values[g.id + '.kw'] ?? null);
      if (SOLAR) pt.solar = values['solar.kw'] ?? null;
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
  const k = key.split('.').pop(), sol = key.startsWith('solar.');   // the solar meter is set up with fewer decimals than the generator meters: amps x1e3, kW x1e2 (checked against the Manager: 34.274 A, 17.21 kW)
  if (/^v[123]$/.test(k) || k === 'freq') return x / 100;
  if (/^i[123]$/.test(k)) return x / (sol ? 1e3 : 1e6);
  if (k === 'kw') return x / (sol ? 1e2 : 1e5);
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
    mhTrack(values); mhTrackGenFuel(values); mhTrackDataLog(values);
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
let mcBuf = [];                                    // last 3 minute readings of the tank level: only used when all 3 agree (see mhTrack)
const MH_TANK_L = +E.MAHFARA_TANK_L || 4000, MH_STABLE_L = +E.MAHFARA_STABLE_L || 20;
let mcons = { day: null, since: null, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null }, mmon = { daily: {}, fuel: {} }, mcLast = null, mcKw = 0, mcKwN = 0, mcRecent = [], meLast = null, mmSaved = 0;
try { const j = JSON.parse(fs.readFileSync(MH_CONS_FILE, 'utf8')); if (j && j.day) mcons = j; } catch (_) {}
try { const j = JSON.parse(fs.readFileSync(MH_MON_FILE, 'utf8')); if (j && j.daily) mmon = j; } catch (_) {}
mmon.fuel = mmon.fuel || {}; mmon.solar = mmon.solar || {};      // solar kWh per day (kept, never trimmed)
// AL MAHFARA solar production, running total of the real solar meter kW added up over time. NEVER reset (not daily, not monthly).
const MH_SOL_FILE = path.join(__dirname, 'mh_solar_total.json');
let msol = { kwh: 0, since: null }, msolLast = null, msolSaved = 0;
try { const j = JSON.parse(fs.readFileSync(MH_SOL_FILE, 'utf8')); if (j && isFinite(j.kwh)) msol = { kwh: +j.kwh, since: j.since || null }; } catch (_) {}
function mhMonthTotal() {
  let [y, m, d] = bparts(Date.now()).day.split('-').map(Number);
  const sum = mk => { let kwh = 0, days = 0, litres = 0; for (const [k, v] of Object.entries(mmon.daily)) if (k.startsWith(mk)) { kwh += v; days++; } for (const [k, v] of Object.entries(mmon.fuel)) if (k.startsWith(mk)) litres += v; return { kwh: Math.round(kwh), litres: Math.round(litres), days }; };
  const cur = y + '-' + String(m).padStart(2, '0'), pm = m < 2 ? 12 : m - 1, prev = (m < 2 ? y - 1 : y) + '-' + String(pm).padStart(2, '0');
  if (d < 5) { const p = sum(prev); if (p.days) return { month: prev, final: true, ...p }; }
  return { month: cur, final: false, ...sum(cur) };
}
function mhTrack(v) {
  const L = v.fuel_l, now = Date.now(), gk = (v['m1.kw'] || 0) + (v['m2.kw'] || 0);
  const skw = Math.max(0, v['solar.kw'] || 0), kwNow = gk + skw;          // energy produced = generators + solar, added up over time
  { if (!msol.since) msol.since = now;
    if (msolLast && now - msolLast.t < 120e3) { const e = (skw + msolLast.kw) / 2 * (now - msolLast.t) / 3600e3, dk = bparts(now).day; msol.kwh += e; mmon.solar[dk] = (mmon.solar[dk] || 0) + e; }
    msolLast = { t: now, kw: skw };
    if (now - msolSaved > 60e3) { msolSaved = now; fs.writeFile(MH_SOL_FILE, JSON.stringify(msol), () => {}); } }
  { const dk = bparts(now).day;
    if (meLast && now - meLast.t < 120e3) mmon.daily[dk] = (mmon.daily[dk] || 0) + (kwNow + meLast.kw) / 2 * (now - meLast.t) / 3600e3;
    if (now - mmSaved > 60e3) { mmSaved = now; Object.keys(mmon.daily).sort().slice(0, -120).forEach(k => delete mmon.daily[k]); Object.keys(mmon.fuel).sort().slice(0, -120).forEach(k => delete mmon.fuel[k]); fs.writeFile(MH_MON_FILE, JSON.stringify(mmon), () => {}); } }
  if (mcons.day && meLast && now - meLast.t < 120e3) { const e = (kwNow + meLast.kw) / 2 * (now - meLast.t) / 3600e3; mcons.kwh = (mcons.kwh || 0) + e; mcons.kwhH = mcons.kwhH || {}; const hr = bparts(now).hour; mcons.kwhH[hr] = (mcons.kwhH[hr] || 0) + e; }
  meLast = { t: now, kw: kwNow };
  if (L == null || !isFinite(L)) return;
  mcKw += gk; mcKwN++;
  const m = Math.floor(now / 60000), b = bparts(now);
  if (!mcLast) { mcBuf = [L]; mcLast = { m, t: now, level: null }; if (!mcons.day) mcons = { day: b.day, since: now, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null }; return; }
  if (m === mcLast.m) return;
  if (b.day !== mcons.day) mcons = { day: b.day, since: now, total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: { day: mcons.day, since: mcons.since, total: Math.round(mcons.total), refuelled: Math.round(mcons.refuelled), kwh: Math.round(mcons.kwh || 0) } };
  mcBuf.push(L); if (mcBuf.length > 5) mcBuf.shift();
  // The level sensor sometimes sends nonsense for a minute or two (84, 65318, 680 between readings of 978). A level is only used once the
  // last 3 minute readings agree within MH_STABLE_L and lie inside the tank (a change of more than 50 L: the last 5); until then nothing is
  // counted, and the change is counted later in one go.
  const agree = n => mcBuf.length >= n && mcBuf.slice(-n).every(x => x >= 0 && x <= MH_TANK_L) && Math.max(...mcBuf.slice(-n)) - Math.min(...mcBuf.slice(-n)) <= MH_STABLE_L;
  if (!agree(3)) { mcLast.m = m; return; }
  const Le = [...mcBuf.slice(-3)].sort((x, y) => x - y)[1];                     // median of the 3 agreeing readings
  if (mcLast.level == null) { mcLast = { m, t: now, level: Le }; mcKw = 0; mcKwN = 0; return; }   // first good level after a start: nothing to compare with yet
  if (Math.abs(Le - mcLast.level) > 50 && !agree(5)) { mcLast.m = m; return; }
  const dt = (now - mcLast.t) / 3600e3, kwAvg = mcKwN ? mcKw / mcKwN : 0, rise = Le - mcLast.level;
  let used = 0, added = 0, lvl = mcLast.level;
  if (rise > 20) { added = rise; used = kwAvg * LPKW_S * dt; lvl = Le; }       // level jumped up and stayed: a refuel, the use of that minute is estimated from the load
  else if (rise < 0) { used = -rise; lvl = Le; }                                 // only a new lowest level counts as use, so a level that wobbles up and down adds nothing
  mmon.fuel[b.day] = (mmon.fuel[b.day] || 0) + used;
  mcons.total += used; mcons.refuelled += added; mcons.hours[b.hour] = (mcons.hours[b.hour] || 0) + used;
  mcRecent.push({ t: now, used }); mcRecent = mcRecent.filter(x => x.t > now - 600e3);
  mcLast = { m, t: now, level: lvl }; mcKw = 0; mcKwN = 0;
  fs.writeFile(MH_CONS_FILE, JSON.stringify(mcons), () => {});
}
function mhFuelToday() {
  const now = Date.now(), cur = bparts(now), r = mcRecent.reduce((a, x) => a + x.used, 0), span = mcRecent.length ? Math.max(60e3, now - mcRecent[0].t + 60e3) : 0;
  const kh = mcons.kwhH || {}, hs = [...new Set([...Object.keys(mcons.hours), ...Object.keys(kh)])].map(Number).sort((a, b) => a - b);
  return { day: mcons.day, since: mcons.since, total: Math.round(mcons.total), refuelled: Math.round(mcons.refuelled), curHour: cur.hour, kwh: Math.round(mcons.kwh || 0), month: mhMonthTotal(),
    hours: hs.map(h => ({ h, used: Math.round(mcons.hours[h] || 0), kwh: Math.round(kh[h] || 0) })),
    rate: span ? +(r / (span / 3600e3)).toFixed(1) : null, prev: mcons.prev, ratio: ratioOf(mcons) };
}
setTimeout(() => { mhPoll(); setInterval(mhPoll, 20000); }, 15000);

// ---------- Keeping the recorded data across a new version / restart ----------
// Every merge below only ADDS what is missing or keeps the larger count: it can never lower or delete anything already recorded.
function mergeCounters(j) {
  if (!j) return null;
  const out = {};
  if (j.mon && j.mon.daily) { for (const [k, v] of Object.entries(j.mon.daily)) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mon.daily[k] = Math.max(mon.daily[k] || 0, +v); out.days = Object.keys(mon.daily).length; for (const [k, v] of Object.entries((j.mon && j.mon.fuel) || {})) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mon.fuel[k] = Math.max(mon.fuel[k] || 0, +v); for (const [k, v] of Object.entries(j.mon.solar || {})) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mon.solar[k] = Math.max(mon.solar[k] || 0, +v); fs.writeFile(MON_FILE, JSON.stringify(mon), () => {}); }
  if (j.sol && isFinite(j.sol.kwh) && j.sol.kwh >= 0) { sol.kwh = Math.max(sol.kwh, +j.sol.kwh); if (j.sol.since && (!sol.since || j.sol.since < sol.since)) sol.since = +j.sol.since; fs.writeFile(SOL_FILE, JSON.stringify(sol), () => {}); out.solar = Math.round(sol.kwh); }
  const c = j.cons;
  if (c && c.day && !cons.day && c.day === bparts(Date.now()).day) cons = { day: c.day, since: c.since || Date.now(), total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null };   // fresh start, nothing counted yet today: take the day over
  if (c && c.day && c.day === cons.day) {                                      // same day: keep the bigger counts, and the earlier start
    cons.total = Math.max(cons.total, +c.total || 0); cons.refuelled = Math.max(cons.refuelled, +c.refuelled || 0); cons.kwh = Math.max(cons.kwh || 0, +c.kwh || 0);
    if (c.since && c.since < cons.since) cons.since = c.since;
    for (const [h, v] of Object.entries(c.hours || {})) cons.hours[h] = Math.max(cons.hours[h] || 0, +v || 0);
    cons.kwhH = cons.kwhH || {}; for (const [h, v] of Object.entries(c.kwhH || {})) cons.kwhH[h] = Math.max(cons.kwhH[h] || 0, +v || 0);
    if (c.prev && !cons.prev) cons.prev = c.prev;
    if (c.rb && !cons.rb && isFinite(c.rb.kwh) && isFinite(c.rb.fuel)) cons.rb = { ts: +c.rb.ts, kwh: +c.rb.kwh, fuel: +c.rb.fuel };
    fs.writeFile(CONS_FILE, JSON.stringify(cons), () => {}); out.today = true;
  }
  return out;
}
function mhMergeCounters(j) {
  if (!j) return null;
  const out = {};
  if (j.mon && j.mon.daily) { for (const [k, v] of Object.entries(j.mon.daily)) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mmon.daily[k] = Math.max(mmon.daily[k] || 0, +v); out.days = Object.keys(mmon.daily).length; for (const [k, v] of Object.entries(j.mon.fuel || {})) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mmon.fuel[k] = Math.max(mmon.fuel[k] || 0, +v); for (const [k, v] of Object.entries(j.mon.solar || {})) if (/^\d{4}-\d\d-\d\d$/.test(k) && isFinite(v) && v >= 0) mmon.solar[k] = Math.max(mmon.solar[k] || 0, +v); fs.writeFile(MH_MON_FILE, JSON.stringify(mmon), () => {}); }
  if (j.sol && isFinite(j.sol.kwh) && j.sol.kwh >= 0) { msol.kwh = Math.max(msol.kwh, +j.sol.kwh); if (j.sol.since && (!msol.since || j.sol.since < msol.since)) msol.since = +j.sol.since; fs.writeFile(MH_SOL_FILE, JSON.stringify(msol), () => {}); out.solar = Math.round(msol.kwh); }
  const c = j.cons;
  if (c && c.day && !mcons.day && c.day === bparts(Date.now()).day) mcons = { day: c.day, since: c.since || Date.now(), total: 0, refuelled: 0, hours: {}, kwh: 0, kwhH: {}, prev: null };
  if (c && c.day && c.day === mcons.day) {
    mcons.total = Math.max(mcons.total, +c.total || 0); mcons.refuelled = Math.max(mcons.refuelled, +c.refuelled || 0); mcons.kwh = Math.max(mcons.kwh || 0, +c.kwh || 0);
    if (c.since && c.since < mcons.since) mcons.since = c.since;
    for (const [h, v] of Object.entries(c.hours || {})) mcons.hours[h] = Math.max(mcons.hours[h] || 0, +v || 0);
    mcons.kwhH = mcons.kwhH || {}; for (const [h, v] of Object.entries(c.kwhH || {})) mcons.kwhH[h] = Math.max(mcons.kwhH[h] || 0, +v || 0);
    if (c.prev && !mcons.prev) mcons.prev = c.prev;
    if (c.rb && !mcons.rb && isFinite(c.rb.kwh) && isFinite(c.rb.fuel)) mcons.rb = { ts: +c.rb.ts, kwh: +c.rb.kwh, fuel: +c.rb.fuel };
    fs.writeFile(MH_CONS_FILE, JSON.stringify(mcons), () => {}); out.today = true;
  }
  return out;
}
const okT = t => isFinite(t) && t > 1.5e12 && t < Date.now() + 864e5;
function mergeList(cur, add, key, keep) {                 // union of two lists by key, sorted by time
  const m = new Map(cur.map(x => [key(x), x]));
  for (const x of add || []) if (x && okT(x.t ?? x.start) && !m.has(key(x))) m.set(key(x), x);
  return [...m.values()].sort((a, b) => (a.t ?? a.start) - (b.t ?? b.start)).slice(-keep);
}
function mergeAll(j) {
  const out = {};
  if (!j || typeof j !== 'object') return out;
  if (j.cons || j.mon || j.sol) Object.assign(out, mergeCounters(j));
  if (j.gf) out.genFuel = mergeGenFuel(j.gf);
  if (j.dlog) { out.dataLog = mergeDataLog(j.dlog); fs.writeFileSync(DLOG_FILE, JSON.stringify(dlog)); }
  if (Array.isArray(j.refuels)) {
    const n = refuels.length;
    refuels = mergeList(refuels, j.refuels.filter(r => r && isFinite(r.litres) && r.litres > 0).map(r => ({ ...r, id: r.id ?? r.start })), r => r.id ?? r.start, 2000);
    fs.writeFileSync(REFUEL_FILE, JSON.stringify(refuels)); out.refuels = refuels.length - n;
  }
  if (Array.isArray(j.fuelLog)) {                          // one line per hour: keep the line we already have for an hour
    const n = fuelLog.length;
    fuelLog = mergeList(fuelLog, j.fuelLog.filter(r => r && isFinite(r.level)), r => Math.floor(r.t / 3600000), 5000);
    fs.writeFileSync(FUELLOG_FILE, JSON.stringify(fuelLog)); out.fuelLog = fuelLog.length - n;
    const l = fuelLog[fuelLog.length - 1]; if (l && Math.floor(l.t / 3600000) >= (lastLogHour ?? 0)) { lastLogHour = Math.floor(l.t / 3600000); prevLogLevel = l.level; }
  }
  if (Array.isArray(j.history)) {                          // chart samples, one a minute
    const n = history.length;
    history = mergeList(history, j.history, h => Math.floor(h.t / 60000), Infinity).filter(h => Date.now() - h.t < KEEP);
    fs.writeFileSync(HIST_FILE, JSON.stringify(history)); out.history = history.length - n;
  }
  if (j.alarm != null && isFinite(j.alarm) && j.alarm >= 0 && !fs.existsSync(ALARM_FILE)) { alarmL = +j.alarm; fs.writeFileSync(ALARM_FILE, JSON.stringify({ litres: alarmL })); out.alarm = alarmL; }
  if (j.mh) {
    out.mh = mhMergeCounters(j.mh) || {};
    if (j.mh.gf) out.mh.genFuel = mhMergeGenFuel(j.mh.gf);
    if (j.mh.dlog) { out.mh.dataLog = mhMergeDataLog(j.mh.dlog); fs.writeFileSync(MH_DLOG_FILE, JSON.stringify(mdlog)); }
    if (Array.isArray(j.mh.hist)) { const n = mhHist.length; mhHist = mergeList(mhHist, j.mh.hist, h => Math.floor(h.t / 60000), Infinity).filter(h => Date.now() - h.t < DAY); out.mh.hist = mhHist.length - n; }
  }
  // the counter files are written straight away, so a restart right after this keeps everything
  fs.writeFileSync(CONS_FILE, JSON.stringify(cons)); fs.writeFileSync(MON_FILE, JSON.stringify(mon)); fs.writeFileSync(SOL_FILE, JSON.stringify(sol)); fs.writeFileSync(GF_FILE, JSON.stringify(gf));
  fs.writeFileSync(MH_CONS_FILE, JSON.stringify(mcons)); fs.writeFileSync(MH_MON_FILE, JSON.stringify(mmon)); fs.writeFileSync(MH_SOL_FILE, JSON.stringify(msol));
  return out;
}
// Everything that is recorded, in one file (Al Dhour and Al Mahfara). The next version reads this from the running one before it goes online.
function exportAll() {
  return { v: 2, t: Date.now(), cons, mon, sol, gf, dlog, refuels, fuelLog, history, alarm: alarmL, mh: { cons: mcons, mon: mmon, sol: msol, gf: mgf, dlog: mdlog, hist: mhHist } };
}
// Hand-over on Render: a new version is started next to the running one and only gets the visitors once it listens on its port.
// So before listening, it copies all the recorded data from the running version through the public address.
// Works with the old version too (it has no /api/export, so its separate pages are read instead).
const HANDOVER_URL = (E.HANDOVER_URL || E.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
let handover = { url: HANDOVER_URL || null, done: false, ok: false, at: null, from: null, got: null, error: null };
async function getOld(p, type) {
  const h = cfg.sharePassword ? { Authorization: 'Basic ' + Buffer.from('x:' + cfg.sharePassword).toString('base64') } : {};
  const r = await fetch(HANDOVER_URL + p + (p.includes('?') ? '&' : '?') + 'handover=' + Date.now(), { headers: h, signal: AbortSignal.timeout(25000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(p + ' answered ' + r.status);
  return type === 'text' ? r.text() : r.json();
}
function parseFuelCsv(t) {                                 // the old version gives the full fuel log only as a spreadsheet file, in Lebanon time (UTC+3)
  return String(t).split(/\r?\n/).slice(1).filter(Boolean).map(l => { const [d, level, drop, kw] = l.split(','); return { t: Date.parse(d.replace(' ', 'T') + 'Z') - 3 * 3600000, level: +level, drop: drop === '' ? null : +drop, kw: +kw }; }).filter(r => okT(r.t) && isFinite(r.level));
}
async function takeOver() {
  if (!HANDOVER_URL || E.HANDOVER === 'off' || cfg.mode === 'demo') return;
  const t0 = Date.now();
  try {
    let j = await getOld('/api/export');
    if (j && j.v >= 2) handover.from = 'export';
    else {                                                 // the old version: read each page
      handover.from = 'old pages';
      const b = await getOld('/api/backup'); if (!b || !b.cons) throw new Error('no counters from the running version');
      j = { ...b, mh: (await getOld('/api/mahfara/backup')) || {} };
      const rf = await getOld('/api/refuels'); j.refuels = rf && rf.list || [];
      const fl = await getOld('/api/fuellog.csv', 'text'); j.fuelLog = fl ? parseFuelCsv(fl) : [];
      const st = await getOld('/api/status'); if (st && st.alarm) j.alarm = st.alarm.litres;
      const ms = await getOld('/api/mahfara/status'); if (ms && Array.isArray(ms.history)) j.mh.hist = ms.history;
      // charts: the old version only gives them in pieces; a 5 hour piece comes back at one point a minute, the way they are stored
      const first = await getOld('/api/history?from=' + (Date.now() - KEEP) + '&to=' + Date.now());
      const start = Math.max(Date.now() - KEEP, first && first.since || Date.now()), W = 300 * 60000, wins = [];
      for (let a = start; a < Date.now(); a += W) wins.push(a);
      j.history = [];
      for (let i = 0; i < wins.length; i += 4) {
        const parts = await Promise.all(wins.slice(i, i + 4).map(a => getOld('/api/history?from=' + a + '&to=' + Math.min(Date.now(), a + W - 1))));
        for (const p of parts) if (p && Array.isArray(p.points)) j.history.push(...p.points);
        if (Date.now() - t0 > 240e3) throw new Error('took too long, charts only partly copied');
      }
    }
    handover.got = mergeAll(j); handover.ok = true;
  } catch (e) { handover.error = e.message; console.error('handover', e.message); }
  handover.done = true; handover.at = Date.now();
  console.log('handover', JSON.stringify(handover));
}

// ---------- Web server ----------
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const CORS = { 'Access-Control-Allow-Origin': 'https://fbox360.com', 'Access-Control-Allow-Headers': 'Content-Type, X-Token', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const server = http.createServer((req, res) => {
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
  if (url === '/api/datalog.xlsx' || url === '/api/datalog.html' || url === '/api/mahfara/datalog.xlsx' || url === '/api/mahfara/datalog.html') {
    const S = url.startsWith('/api/mahfara/') ? LOG_SITES.mahfara : LOG_SITES.aldhour;       // hourly data log as an Excel file; ?from=YYYY-MM-DD&to=YYYY-MM-DD (Lebanon days, both included)
    const q = new URL(req.url, 'http://x').searchParams, H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (LOG_PASSWORD && (req.headers['x-log-key'] || q.get('key') || '') !== LOG_PASSWORD) { res.writeHead(401, H); return res.end(JSON.stringify({ error: 'password' })); }
    const day = /^\d{4}-\d\d-\d\d$/, f = q.get('from'), t = q.get('to');
    const from = f && day.test(f) ? beirutMidnight(f) : 0, to = t && day.test(t) ? beirutMidnight(t) + DAY - 1 : Date.now();
    const pick = (q.get('cols') || '').split(',').filter(Boolean), period = (f ? 'From ' + f : 'From the start') + (t ? ' to ' + t : ' to now');
    if (url.endsWith('.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(dataLogHtml(S, from, to, pick, period)); }
    const name = S.slug + '-hourly-log' + (f ? '-' + f : '') + (t ? '-to-' + t : '') + '.xlsx';
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '"' });
    return res.end(dataLogXlsx(S, from, to, pick, period));
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
    const keys = ['fuel', ...gens.map(g => g.id), ...(SOLAR ? ['solar'] : []), 'total'];
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
  // Restore is accepted only in the first 60 minutes after a start, and only adds what is missing or keeps the larger value, so it can never lower a count.
  // It takes the old backup file or the full file from /api/export (counters, refuels, fuel log, charts).
  if (url === '/api/export') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="al-dhour-all-data.json"' }); return res.end(JSON.stringify(exportAll())); }
  if (url === '/api/handover') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(handover)); }
  if (url === '/api/backup') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ t: Date.now(), cons, mon, sol, gf })); }
  if (url === '/api/restore' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 3e7) req.destroy(); });
    req.on('end', () => {
      const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      try {
        if (process.uptime() > 3600) { res.writeHead(403, H); return res.end(JSON.stringify({ error: 'only right after a start' })); }
        const out = mergeAll(JSON.parse(body));
        res.writeHead(200, H); return res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) { res.writeHead(400, H); return res.end(JSON.stringify({ error: 'bad data' })); }
    });
    return;
  }
  if ((url === '/api/ratio-reset' || url === '/api/mahfara/ratio-reset') && req.method === 'POST') {     // KWH/L starts again from now; nothing else changes
    const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, mhS = url.startsWith('/api/mahfara/'), c = mhS ? mcons : cons;
    if (!c.day) { res.writeHead(409, H); return res.end(JSON.stringify({ error: 'no data yet today' })); }
    c.rb = { ts: Date.now(), kwh: c.kwh || 0, fuel: c.total };
    fs.writeFile(mhS ? MH_CONS_FILE : CONS_FILE, JSON.stringify(c), () => {});
    res.writeHead(200, H); return res.end(JSON.stringify({ ok: true, ratio: ratioOf(c) }));
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
  if (url === '/api/mahfara/backup') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ t: Date.now(), cons: mcons, mon: mmon, sol: msol, gf: mgf })); }
  if (url === '/api/mahfara/restore' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 3e7) req.destroy(); });
    req.on('end', () => {
      const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      try {
        if (process.uptime() > 3600) { res.writeHead(403, H); return res.end(JSON.stringify({ error: 'only right after a start' })); }
        const out = mergeAll({ mh: JSON.parse(body) }).mh || {};
        res.writeHead(200, H); return res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) { res.writeHead(400, H); return res.end(JSON.stringify({ error: 'bad data' })); }
    });
    return;
  }
  if (url === '/api/mahfara/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const ok = cfg.mode === 'fbox';
    return res.end(JSON.stringify({ ok, conn: ok ? mh.conn : 'stale', error: mh.error, updated: mh.updated, values: mh.values, history: mhHist, fuelToday: mhFuelToday(), solarSave: solarSave(mmon.solar, msol.kwh), genFuel: mhGenFuel(mh.values), solarTotal: { kwh: +msol.kwh.toFixed(2), since: msol.since, kw: +Math.max(0, mh.values['solar.kw'] || 0).toFixed(1) }, now: Date.now() }));
  }
  if (url === '/api/status') {
    const vid = (new URL(req.url, 'http://x').searchParams.get('v') || '');
    if (/^[a-z0-9]{6,24}$/.test(vid)) viewers.set(vid, Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const s = cfg.site;
    return res.end(JSON.stringify({
      site: { name: s.name, tankLitres: s.tankLitres || null, ratedKva: s.ratedKva || null, lowFuelHours: s.lowFuelHours ?? 12, details: s.details },
      generators: gens.map(({ id, label, ratedKva }) => ({ id, label, ratedKva: ratedKva || null })), solar: SOLAR ? { id: SOLAR.id, label: SOLAR.label, kwp: SOLAR.kwp || null } : null,
      decimals: Object.fromEntries([...cfg.points.map(p => [p.key, p.decimals ?? 0]), ...(cfg.shared || []).map(p => [p.key, p.decimals ?? 0])]),
      demo: cfg.mode !== 'fbox' && cfg.mode !== 'push', now: Date.now(), pollSeconds: cfg.pollSeconds,
      online: onlineCount(), solarTotal: { kwh: +sol.kwh.toFixed(2), since: sol.since, kw: +solarKw(state.values || {}).toFixed(1) }, solarSave: solarSave(), fuelToday: fuelToday(), genFuel: genFuel(state.values), outside: wNow ? { c: wNow.c, t: wNow.t } : null, alarm: { litres: alarmL, push: PUSH_ON, active: alarmActive }, conn: state.conn, error: state.error, updated: state.updated, values: state.values, history: history.filter(h => Date.now() - h.t < DAY)
    }));
  }
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
takeOver().finally(() => { dlogFromHistory(); mdlogFromHistory(); server.listen(cfg.port, () => console.log('Dashboard on http://localhost:' + cfg.port + '  (mode: ' + cfg.mode + ')')); });
