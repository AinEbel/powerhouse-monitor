// E.BOX reader: logs in to the E.BOX web server as a normal (non-admin) user and reads the live values,
// so voltage, current and kWh keep being watched with nobody's laptop open.
// READ ONLY: it only calls POST api/login and GET api/eboxes. It never writes to the PLC or changes a setting.
// Set on Render: EBOX_USER and EBOX_PASS (required), EBOX_URL (default https://ebox-farah.duckdns.org/),
// EBOX_POLL_S (default 60). Nothing runs until EBOX_USER and EBOX_PASS are set.
const E = process.env;
const BASE = (E.EBOX_URL || 'https://ebox-farah.duckdns.org/').replace(/#.*$/, '').replace(/\/?$/, '/');
const USER = E.EBOX_USER || '', PASS = E.EBOX_PASS || '';
const POLL_MS = Math.max(15, Number(E.EBOX_POLL_S) || 60) * 1000, DAY = 24 * 3600 * 1000;

let cookie = '', busy = false;
const st = { on: !!(USER && PASS), conn: USER && PASS ? 'starting' : 'off', error: null, updated: null, boxes: [], history: [] };

function kindOf(w) {                       // which readings we keep: volts, amps, kWh (and kW / Hz when the screen has them)
  const u = String(w.unit || '').trim().toLowerCase(), l = String(w.label || '').toLowerCase();
  if (u === 'kwh' || u === 'mwh' || /kwh|energy/.test(l)) return 'kwh';
  if (u === 'v' || u === 'kv' || /volt/.test(l)) return 'voltage';
  if (u === 'a' || u === 'ma' || /current|amp/.test(l)) return 'current';
  if (u === 'kw' || u === 'w') return 'power';
  if (u === 'hz') return 'frequency';
  return null;
}
function setCookies(r) {
  const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  if (list.length) cookie = list.map(c => c.split(';')[0]).join('; ');
}
async function login() {
  const r = await fetch(BASE + 'api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: USER, password: PASS }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('E.BOX login refused' + (j.error ? ': ' + j.error : ' (' + r.status + ')'));
  setCookies(r);
}
async function get(p) {
  for (let i = 0; i < 2; i++) {
    if (!cookie) await login();
    const r = await fetch(BASE + 'api/' + p, { cache: 'no-store', headers: { 'X-EBOX': '1', Cookie: cookie } });
    if (r.status === 401) { cookie = ''; continue; }
    if (!r.ok) throw new Error('E.BOX read failed (' + r.status + ')');
    return r.json();
  }
  throw new Error('E.BOX keeps asking to log in again');
}
function readBox(item) {
  const e = item.ebox || {}, vals = (item.live && item.live.values) || {}, out = [];
  for (const s of e.screens || []) {
    if (s.phone_of) continue;
    for (const w of s.widgets || []) {
      const kind = kindOf(w); if (!kind || w.access === 'write') continue;
      const v = vals[w.id]; if (v == null || !isFinite(v)) continue;
      out.push({ id: w.id, kind, label: w.label || w.addr || kind, unit: w.unit || '', value: +Number(v).toFixed(w.decimals ?? 2), screen: s.name || '' });
    }
  }
  return { id: e.id, name: e.name || e.id, online: !!(item.live && item.live.values), readings: out };
}
async function poll() {
  if (!st.on || busy) return;
  busy = true;
  try {
    const list = (await get('eboxes?live=')).eboxes || [], boxes = [];
    for (const it of list) {
      const id = it.ebox && it.ebox.id; if (!id) continue;
      const full = it.live ? it : ((await get('eboxes?live=' + encodeURIComponent(id))).eboxes || []).find(x => x.ebox && x.ebox.id === id) || it;
      boxes.push(readBox(full));
    }
    Object.assign(st, { conn: 'online', error: null, updated: Date.now(), boxes });
    const last = st.history[st.history.length - 1];
    if (!last || Date.now() - last.t >= 60000) {
      const row = { t: Date.now() };
      for (const b of boxes) for (const r of b.readings) row[b.id + '.' + r.id] = r.value;
      st.history.push(row); st.history = st.history.filter(h => Date.now() - h.t < DAY);
    }
  } catch (e) { st.conn = 'error'; st.error = e.message; console.error(new Date().toISOString(), 'ebox', e.message); }
  busy = false;
}
if (st.on) { setTimeout(() => { poll(); setInterval(poll, POLL_MS); }, 5000); }

module.exports = { status: () => ({ ...st, url: BASE, pollSeconds: POLL_MS / 1000, now: Date.now() }), kindOf, readBox };
