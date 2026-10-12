// Backend URL (Render).
const API = "https://inktwin-api.onrender.com";
const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PW = 1240, PH = 1754;
const $ = (id) => document.getElementById(id);
const state = { profile: null, mood: "normal", pages: [], seed: null, adjust: {}, sel: new Set(), dirty: new Set(), adjOn: false,
  busy: false, timer: null, adding: false, mode: "sheet", sig: null, max: 60000 };

function show(id) { for (const s of document.querySelectorAll(".step")) s.hidden = s.id !== id; }
function status(msg, kind = "") { const s = $("status"); s.textContent = msg; s.className = "status " + kind; }
async function post(path, body) {
  let r;
  try { r = await fetch(API + path, { method: "POST", body }); }
  catch { throw new Error("Can't reach the server. It may be waking up — wait 30 seconds and retry."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
function stages(list) { let i = 0; status(list[0], "busy"); clearInterval(state.timer);
  state.timer = setInterval(() => { if (i < list.length - 1) status(list[++i], "busy"); }, 1800); }
function done(msg, kind) { clearInterval(state.timer); status(msg, kind); }
const persist = () => { try { localStorage.setItem("inktwin.profile", JSON.stringify(state.profile)); } catch {} };
const count = () => ($("count").textContent = `${$("text").value.length.toLocaleString()} / ${state.max.toLocaleString()}`);

fetch(API + "/api/health").then((r) => r.json()).then((j) => { if (j.max_text) { state.max = j.max_text; $("text").maxLength = j.max_text; count(); } }).catch(() => {});
$("tpl").href = API + "/api/template";
fetch(API + "/api/prompt").then((r) => r.json()).then((j) => { $("lines").innerHTML = "";
  j.lines.forEach((t, i) => { const d = document.createElement("div"); d.className = "ln";
    const b = document.createElement("b"); b.textContent = i + 1; const s = document.createElement("span"); s.textContent = t; d.append(b, s); $("lines").appendChild(d); });
}).catch(() => { $("lines").textContent = "Can't reach the server to load the lines. Try again in a moment."; });

$("modes").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.mode = b.dataset.m;
  document.querySelectorAll("#modes button").forEach((x) => x.classList.toggle("on", x === b));
  $("m-sheet").hidden = state.mode !== "sheet"; $("m-free").hidden = state.mode !== "free"; };

// ---- calibration upload ----
function pickFile() {
  if (!$("consent").checked) { if (state.adding) show("s-upload"); return done("Confirm you have permission to use this handwriting, then upload.", "err"); }
  $("file").click();
}
$("pick").onclick = () => { state.adding = false; pickFile(); };
$("addmore").onclick = () => { state.adding = true; pickFile(); };
$("file").onchange = async () => {
  const files = [...$("file").files].slice(0, 4); if (!files.length) return;
  $("fname").textContent = files.map((f) => f.name).join(", ");
  const fd = new FormData(); files.forEach((f) => fd.append("samples", f)); fd.append("consent", "true"); fd.append("mode", state.mode);
  $("pick").disabled = true; stages(["Processing sample…", "Detecting handwriting…", "Matching letters…", "Building profile…"]);
  try {
    const { profile, report } = await post("/api/profile", fd);
    if (state.adding && state.profile) for (const [c, l] of Object.entries(profile.glyphs)) state.profile.glyphs[c] = [...(state.profile.glyphs[c] || []), ...l].slice(0, 9);
    else state.profile = profile;
    persist(); showProfile();
    done(report && report.total ? `Complete — matched ${report.matched} of ${report.total} words` : "Complete", "ok");
  } catch (e) { done(e.message, "err"); }
  $("pick").disabled = false; $("file").value = "";
};
function showProfile() {
  const p = state.profile, g = p.glyphs, n = Object.values(g).reduce((a, l) => a + l.length, 0);
  $("pstats").textContent = `${Object.keys(g).length} characters, ${n} letter variants. Slant ${p.slant.toFixed(1)}°, stroke ${p.stroke_width.toFixed(1)} px.`;
  const miss = [...CHARS].filter((c) => !g[c]);
  $("pmiss").textContent = miss.length ? `Not captured: ${miss.join(" ")} (a missing upper/lowercase letter borrows its twin; other characters are skipped). Add another photo to fill gaps.` : "Every character captured.";
  const sh = $("sheet"); sh.innerHTML = "";
  for (const ch of CHARS) (g[ch] || []).forEach((gl, i) => { const im = new Image(); im.src = "data:image/png;base64," + gl.png; im.alt = ch;
    im.title = `${ch} — click to remove`; im.dataset.c = ch; im.dataset.i = i; sh.appendChild(im); });
  show("s-profile");
}
$("sheet").onclick = (e) => { const im = e.target.closest("img"); if (!im) return;
  const l = state.profile.glyphs[im.dataset.c]; l.splice(+im.dataset.i, 1); if (!l.length) delete state.profile.glyphs[im.dataset.c]; persist(); showProfile(); };
$("redo").onclick = () => { state.profile = null; state.adding = false; show("s-upload"); status(""); };
$("newprofile").onclick = $("redo").onclick;
$("toWrite").onclick = () => { show("s-write"); status(""); count(); };
$("text").oninput = count;
$("edit").onclick = () => { $("result").hidden = true; $("editorBox").hidden = false; };

// ---- formatting toolbar ----
const ta = $("text");
function wrapSel(a, b = a) { const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  ta.value = v.slice(0, s) + a + v.slice(s, e) + b + v.slice(e); ta.focus(); ta.setSelectionRange(s + a.length, e + a.length); count(); }
function linePrefix(p) { const ls = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1, st = ta.selectionStart;
  ta.value = ta.value.slice(0, ls) + p + ta.value.slice(ls); ta.focus(); ta.setSelectionRange(st + p.length, st + p.length); count(); }
$("fmt").onclick = (e) => { const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.p) linePrefix(b.dataset.p); else if (b.dataset.w) wrapSel(b.dataset.w);
  else if (b.id === "ftab") { const s = ta.selectionStart; ta.setRangeText("\n|Name|Value|\n|---|---|\n|Row 1|Data|\n|Row 2|Data|\n", s, s, "end"); ta.focus(); count(); } };
$("fcol").onchange = () => { if ($("fcol").value) wrapSel(`{{${$("fcol").value}|`, "}}"); $("fcol").value = ""; };

// ---- generation (streamed page by page) ----
function settings() { return { variation: $("variation").value / 100, mood: state.mood, paper: $("paper").value, pen: $("pen").value,
  signature: state.sig, sig_pos: $("sigpos").value }; }
function pageEl(n) { const box = $("pages");
  while (box.children.length <= n) { const d = document.createElement("div"); d.className = "pg"; d.dataset.n = box.children.length;
    d.innerHTML = '<img alt="" draggable="false"><div class="sel"></div>'; d.firstChild.alt = `Page ${box.children.length + 1}`; box.appendChild(d); }
  return box.children[n]; }
async function run(opts = {}) {
  if (state.busy || !state.profile) return;
  const text = $("text").value; if (!text.trim()) return done("Type some text first.", "err");
  const fresh = !opts.only;
  if (fresh) { state.hist = []; state.redo = []; state.selPage = null; updUndo(); updInsp(); state.adjust = {}; state.sel.clear(); state.dirty.clear(); state.pages = []; state.seed = null; $("pages").innerHTML = ""; }
  state.busy = true; $("gen").disabled = $("regen").disabled = true;
  const st0 = { ...settings(), adjust: state.adjust, only: opts.only || null };
  const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });
  let meta = null, tries = 0; status(opts.only ? "Updating page…" : "Generating…", "busy");
  while (!meta) {
    const ctl = new AbortController(); let wd; const arm = () => { clearTimeout(wd); wd = setTimeout(() => ctl.abort(), 45000); };
    try {
      const seed = fresh ? (state.seed ?? ($("seed").value.trim() || null)) : state.seed;
      const from = fresh && state.pages.length ? state.pages.length : null; // resume after a dropped connection
      arm();
      const res = await fetch(API + "/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ profile: state.profile, text, settings: { ...st0, seed, from } }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw fatal(j.error || `Request failed (${res.status})`); }
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) { const { value, done: dn } = await rd.read(); if (dn) break; arm(); buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
          const m = JSON.parse(line); if (m.error) throw fatal(m.error);
          if (m.done) { meta = m; continue; }
          if (Object.keys(m).length === 1 && "seed" in m) { state.seed = m.seed; continue; }
          if (typeof m.n !== "number") throw fatal("The server is running an older version of InkTwin. Redeploy the backend (backend/app.py and backend/engine.py) on Render.");
          const el = pageEl(m.n), pg = (state.pages[m.n] ||= {});
          if (m.img) { pg.img = m.img; if (fresh) pg.base = m.img; el.firstChild.src = "data:image/jpeg;base64," + m.img; el.style.setProperty("--pg", `url(data:image/jpeg;base64,${m.img})`); }
          pg.glyphs = m.glyphs; $("editorBox").hidden = true; $("result").hidden = false; applyZoom(); drawSel();
          if (!opts.only) status(`Writing page ${m.n + 1}…`, "busy"); } }
      if (!meta) throw new Error("stream ended early");
    } catch (e) {
      if (e.fatal) { done(e.message, "err"); break; }
      if (opts.only || ++tries > 8 || !state.seed) { done("Lost connection to the server. Wait a moment and press Regenerate.", "err"); break; }
      status(`Connection dropped — resuming at page ${state.pages.length + 1}…`, "busy"); await new Promise((r) => setTimeout(r, 2500));
    } finally { clearTimeout(wd); }
  }
  if (meta) { state.seed = meta.seed; let t = `Complete — ${state.pages.length} page${state.pages.length > 1 ? "s" : ""}`;
    if (meta.missing.length) t += `, skipped unsupported characters: ${meta.missing.join(" ")}`;
    if (meta.truncated) t += " — stopped at the page limit"; done(t, "ok"); }
  state.busy = false; $("gen").disabled = $("regen").disabled = false;
}
$("gen").onclick = () => run(); $("regen").onclick = () => run();
let deb; const live = () => { if ($("result").hidden) return; clearTimeout(deb); deb = setTimeout(() => run(), 700); };
["variation", "paper", "pen", "seed", "sigpos"].forEach((id) => $(id).addEventListener("change", live));
$("mood").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.mood = b.dataset.v;
  document.querySelectorAll("#mood button").forEach((x) => x.classList.toggle("on", x === b)); live(); };
function applyZoom() { for (const el of $("pages").children) el.style.width = $("zoom").value + "%"; }
$("zoom").oninput = applyZoom;

// ---- advanced letter editor: click / drag / rotate / resize / replace, undo-redo, live ghost preview ----
const Q = { ID: 0, X: 1, Y: 2, W: 3, H: 4, CH: 5, WORD: 6, VI: 7, NV: 8 };
Object.assign(state, { hist: [], redo: [], gran: "letter", selPage: null, lastT: 0 });
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gmap() { const m = new Map(); state.pages.forEach((pg, n) => (pg.glyphs || []).forEach((q) => m.set(q[Q.ID], { q, n }))); return m; }
function selGlyphs() { const m = gmap(); return [...state.sel].map((id) => m.get(id)).filter(Boolean).sort((a, b) => a.q[0] - b.q[0]); }
function centroid(gs) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const { q } of gs) { x0 = Math.min(x0, q[1]); y0 = Math.min(y0, q[2]); x1 = Math.max(x1, q[1] + q[3]); y1 = Math.max(y1, q[2] + q[4]); }
  return [(x0 + x1) / 2, (y0 + y1) / 2]; }
function newCenter(q, T) { const vx = q[1] + q[3] / 2 - T.cx, vy = q[2] + q[4] / 2 - T.cy, r = T.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [T.cx + T.sc * (vx * c - vy * s) + T.dx, T.cy + T.sc * (vx * s + vy * c) + T.dy]; }
const box = (x, y, w, h, cls, extra = "") => `<i class="${cls}" style="left:${x / PW * 100}%;top:${y / PH * 100}%;width:${w / PW * 100}%;height:${h / PH * 100}%;${extra}"></i>`;
function drawSel(T) {
  const gs = selGlyphs();
  [...$("pages").children].forEach((el, n) => {
    const L = el.lastChild; L.innerHTML = ""; if (state.selPage !== n) return;
    const mine = gs.filter((g) => g.n === n); if (!mine.length) return;
    const [cx, cy] = centroid(mine), Tm = T && { cx, cy, ...T };
    let h = "", x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const { q } of mine) { let x = q[1], y = q[2], w = q[3], hh = q[4];
      if (Tm) { h += box(x, y, w, hh, "hole"); const [nx, ny] = newCenter(q, Tm); w *= Tm.sc; hh *= Tm.sc; x = nx - w / 2; y = ny - hh / 2;
        h += box(x, y, w, hh, "gh", `background-size:${PW / q[3] * 100}% ${PH / q[4] * 100}%;background-position:${q[1] / (PW - q[3]) * 100}% ${q[2] / (PH - q[4]) * 100}%;transform:rotate(${Tm.rot}deg)`); }
      h += box(x, y, w, hh, "box"); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + hh); }
    h += box(x0, y0, x1 - x0, y1 - y0, "grp");
    h += `<b class="hnd rot" data-h="rot" style="left:${(x0 + x1) / 2 / PW * 100}%;top:${y0 / PH * 100}%;margin-top:-20px"></b><b class="hnd size" data-h="size" style="left:${x1 / PW * 100}%;top:${y1 / PH * 100}%"></b>`;
    L.innerHTML = h; }); }
function updInsp() { const gs = selGlyphs(); $("insp").hidden = !gs.length; if (!gs.length) return;
  $("selinfo").textContent = gs.length === 1 ? `“${gs[0].q[Q.CH]}” · style ${gs[0].q[Q.VI] + 1}/${gs[0].q[Q.NV]}` : `${gs.length} letters: “${gs.map((g) => g.q[Q.CH]).join("").slice(0, 24)}”`;
  $("repl").value = ""; $("repl").placeholder = gs.length === 1 ? "Replace with…" : `Type ${gs.length} characters…`; }
function updUndo() { $("undo").disabled = !state.hist.length; $("redo").disabled = !state.redo.length;
  const n = Object.keys(state.adjust).length; $("adjinfo").textContent = n ? `${n} letter${n > 1 ? "s" : ""} edited` : "No edits yet"; }
function pushHist(coalesce) { const now = Date.now();
  if (!(coalesce && now - state.lastT < 800)) { state.hist.push(clone(state.adjust)); if (state.hist.length > 200) state.hist.shift(); state.redo = []; } state.lastT = now; }
const ensure = (id) => state.adjust[id] || (state.adjust[id] = [0, 0, 0, 1, -1, ""]);
function schedule(ms = 450) { clearTimeout(state.adjT); state.adjT = setTimeout(applyAdjust, ms); }
function after() { updUndo(); drawSel(); updInsp(); schedule(); }
function markPages(ids) { const m = gmap(); ids.forEach((id) => { const g = m.get(+id); if (g) state.dirty.add(g.n); }); }
async function applyAdjust() { if (state.busy) { schedule(300); return; } const only = [...state.dirty]; state.dirty.clear(); if (only.length) { await run({ only }); updInsp(); } }
async function flushEdits() { clearTimeout(state.adjT); while (state.busy) await sleep(150); const only = [...state.dirty]; state.dirty.clear(); if (only.length) await run({ only }); }
function commitT(T, coalesce) {
  const gs = selGlyphs(); if (!gs.length) return done("Click a letter first.", "err");
  pushHist(coalesce); const [cx, cy] = centroid(gs), Tm = { cx, cy, ...T };
  for (const { q, n } of gs) { const [nx, ny] = newCenter(q, Tm), a = ensure(q[0]);
    a[0] += nx - (q[1] + q[3] / 2); a[1] += ny - (q[2] + q[4] / 2); a[2] += T.rot; a[3] *= T.sc;
    q[3] *= T.sc; q[4] *= T.sc; q[1] = nx - q[3] / 2; q[2] = ny - q[4] / 2; state.dirty.add(n); }
  after(); }
function undoRedo(from, to) { if (!state[from].length) return; state[to].push(clone(state.adjust)); const prev = state[from].pop();
  const ids = new Set([...Object.keys(state.adjust), ...Object.keys(prev)].filter((k) => JSON.stringify(state.adjust[k]) !== JSON.stringify(prev[k])));
  state.adjust = prev; markPages(ids); updUndo(); schedule(120); }
$("undo").onclick = () => undoRedo("hist", "redo"); $("redo").onclick = () => undoRedo("redo", "hist");
function cycle(d) { const gs = selGlyphs(); if (!gs.length) return; pushHist();
  for (const { q, n } of gs) { if (q[Q.NV] < 2) continue; const a = ensure(q[0]); a[4] = (q[Q.VI] + d + q[Q.NV]) % q[Q.NV]; q[Q.VI] = a[4]; state.dirty.add(n); } after(); }
$("varprev").onclick = () => cycle(-1); $("varnext").onclick = () => cycle(1);
$("repl").onchange = () => { const gs = selGlyphs(), t = [...$("repl").value]; if (!gs.length || !t.length) return;
  if (t.length !== gs.length || t.some((c) => !CHARS.includes(c))) return done(`Type exactly ${gs.length} supported character${gs.length > 1 ? "s" : ""}.`, "err");
  pushHist(); gs.forEach(({ q, n }, i) => { const a = ensure(q[0]); a[5] = t[i]; a[4] = -1; q[Q.CH] = t[i]; state.dirty.add(n); }); after(); };
$("resetsel").onclick = () => { const gs = selGlyphs(); if (!gs.some(({ q }) => state.adjust[q[0]])) return; pushHist();
  gs.forEach(({ q, n }) => { delete state.adjust[q[0]]; state.dirty.add(n); }); after(); };
$("adjall").onclick = () => { if (!Object.keys(state.adjust).length) return; pushHist(); markPages(Object.keys(state.adjust)); state.adjust = {}; after(); };
$("insp").onclick = (e) => { const b = e.target.closest("button[data-a]"); if (!b) return; const [dx, dy, rot, sc] = b.dataset.a.split(",").map(Number); commitT({ dx, dy, rot, sc }, true); };
$("gran").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.gran = b.dataset.g; document.querySelectorAll("#gran button").forEach((x) => x.classList.toggle("on", x === b)); };
const cmp = (on) => [...$("pages").children].forEach((el, n) => { const pg = state.pages[n]; if (pg && pg.img) el.firstChild.src = "data:image/jpeg;base64," + (on && pg.base ? pg.base : pg.img); });
$("cmp").onpointerdown = () => cmp(true); ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => $("cmp").addEventListener(ev, () => cmp(false)));
$("adjmode").onclick = () => { state.adjOn = !state.adjOn; $("pages").classList.toggle("adj", state.adjOn); $("adj").hidden = !state.adjOn;
  $("adjmode").classList.toggle("on", state.adjOn); if (!state.adjOn) { state.sel.clear(); drawSel(); updInsp(); } };

function hitTest(n, p) { let best = null, ba = 1e12;
  for (const q of (state.pages[n] || {}).glyphs || []) if (p[0] >= q[1] - 3 && p[0] <= q[1] + q[3] + 3 && p[1] >= q[2] - 3 && p[1] <= q[2] + q[4] + 3 && q[3] * q[4] < ba) { best = q; ba = q[3] * q[4]; }
  return best; }
const wordIds = (n, q) => state.pages[n].glyphs.filter((g) => g[Q.WORD] === q[Q.WORD]).map((g) => g[0]);
const ptr = (e, r) => [(e.clientX - r.left) / r.width * PW, (e.clientY - r.top) / r.height * PH];
let drag = null;
$("pages").addEventListener("pointerdown", (e) => {
  if (!state.adjOn) return; const pg = e.target.closest(".pg"); if (!pg) return;
  const n = +pg.dataset.n, r = pg.getBoundingClientRect(), p = ptr(e, r), hn = e.target.closest(".hnd");
  if (hn) { const c = centroid(selGlyphs().filter((g) => g.n === n));
    drag = { mode: hn.dataset.h, n, pg, r, p0: p, c, a0: Math.atan2(p[1] - c[1], p[0] - c[0]), d0: Math.hypot(p[0] - c[0], p[1] - c[1]) || 1 };
  } else { const hit = hitTest(n, p);
    if (state.selPage !== n) { state.sel.clear(); state.selPage = n; }
    if (hit) { const ids = state.gran === "word" ? wordIds(n, hit) : [hit[0]];
      if (e.shiftKey) ids.forEach((id) => (state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id)));
      else if (!state.sel.has(hit[0])) state.sel = new Set(ids);
      drag = { mode: "move", n, pg, r, p0: p, hit, ids, shift: e.shiftKey };
    } else { if (!e.shiftKey) state.sel.clear(); drag = { mode: "band", n, pg, r, p0: p, p1: p }; } }
  pg.setPointerCapture(e.pointerId); drawSel(); updInsp(); });
$("pages").addEventListener("pointermove", (e) => { if (!drag) return; const p = ptr(e, drag.r);
  if (drag.mode === "move") { const dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1]; if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; drag.T = { dx, dy, rot: 0, sc: 1 }; drawSel(drag.T);
  } else if (drag.mode === "rot") { let a = (Math.atan2(p[1] - drag.c[1], p[0] - drag.c[0]) - drag.a0) * 180 / Math.PI; if (e.shiftKey) a = Math.round(a / 15) * 15;
    drag.T = { dx: 0, dy: 0, rot: a, sc: 1 }; drawSel(drag.T);
  } else if (drag.mode === "size") { drag.T = { dx: 0, dy: 0, rot: 0, sc: Math.min(3, Math.max(.3, Math.hypot(p[0] - drag.c[0], p[1] - drag.c[1]) / drag.d0)) }; drawSel(drag.T);
  } else { drag.p1 = p; if (!drag.band) { drag.band = document.createElement("div"); drag.band.className = "band"; drag.pg.appendChild(drag.band); }
    const [a, b] = [drag.p0, p], s = drag.band.style; s.left = Math.min(a[0], b[0]) / PW * 100 + "%"; s.top = Math.min(a[1], b[1]) / PH * 100 + "%";
    s.width = Math.abs(a[0] - b[0]) / PW * 100 + "%"; s.height = Math.abs(a[1] - b[1]) / PH * 100 + "%"; } });
$("pages").addEventListener("pointerup", () => { if (!drag) return; const d = drag; drag = null; if (d.band) d.band.remove();
  if (d.mode === "band") { const [p0, p1] = [d.p0, d.p1];
    if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) >= 6) { const x0 = Math.min(p0[0], p1[0]), x1 = Math.max(p0[0], p1[0]), y0 = Math.min(p0[1], p1[1]), y1 = Math.max(p0[1], p1[1]);
      for (const q of state.pages[d.n].glyphs || []) { const cx = q[1] + q[3] / 2, cy = q[2] + q[4] / 2; if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) state.sel.add(q[0]); } }
  } else if (d.T) commitT(d.T);
  else if (d.mode === "move" && !d.shift) state.sel = new Set(d.ids);
  drawSel(); updInsp(); });
$("pages").addEventListener("dblclick", (e) => { if (!state.adjOn) return; const pg = e.target.closest(".pg"); if (!pg) return;
  const n = +pg.dataset.n, q = hitTest(n, ptr(e, pg.getBoundingClientRect())); if (!q) return; state.sel = new Set(wordIds(n, q)); state.selPage = n; drawSel(); updInsp(); });
document.addEventListener("keydown", (e) => { if (!state.adjOn || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? undoRedo("redo", "hist") : undoRedo("hist", "redo"); return; }
  if (mod && k === "y") { e.preventDefault(); undoRedo("redo", "hist"); return; }
  if (e.key === "Escape") { state.sel.clear(); drawSel(); updInsp(); return; }
  const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
  if (d && state.sel.size) { const s = e.shiftKey ? 8 : 1.5; commitT({ dx: d[0] * s, dy: d[1] * s, rot: 0, sc: 1 }, true); e.preventDefault(); } });

// ---- downloads ----
function saveAs(href, name) { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
const jpegBytes = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
$("dlpng").onclick = async () => { await flushEdits(); for (let i = 0; i < state.pages.length; i++) { const im = await loadImg("data:image/jpeg;base64," + state.pages[i].img);
  const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext("2d").drawImage(im, 0, 0);
  saveAs(c.toDataURL("image/png"), `inktwin-page-${i + 1}.png`); await new Promise((r) => setTimeout(r, 300)); } };
$("dlpdf").onclick = async () => { await flushEdits(); const url = URL.createObjectURL(makePdf(state.pages.map((p) => ({ bytes: jpegBytes(p.img), w: PW, h: PH }))));
  saveAs(url, "inktwin.pdf"); setTimeout(() => URL.revokeObjectURL(url), 8000); };
function makePdf(jp) { // minimal PDF writer: one A4 page per JPEG, any number of pages
  const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
  const put = (v) => { const b = typeof v === "string" ? enc.encode(v) : v; parts.push(b); len += b.length; };
  const obj = (n, head, stream) => { offs[n] = len; put(`${n} 0 obj\n${head}\n`); if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); } put("endobj\n"); };
  put("%PDF-1.4\n"); obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${jp.map((_, i) => `${3 + 3 * i} 0 R`).join(" ")}] /Count ${jp.length} >>`);
  jp.forEach((p, i) => { const n = 3 + 3 * i, cs = "q 595 0 0 842 0 0 cm /Im0 Do Q";
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${cs.length} >>`, cs);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>`, p.bytes); });
  const xr = len, N = 3 + 3 * jp.length; put(`xref\n0 ${N}\n0000000000 65535 f \n`);
  for (let n = 1; n < N; n++) put(String(offs[n]).padStart(10, "0") + " 00000 n \n");
  put(`trailer\n<< /Size ${N} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`);
  return new Blob(parts, { type: "application/pdf" });
}

// ---- signature pad (drawn by the user, used as-is) ----
const cv = $("sigcv"), cx = cv.getContext("2d"); let drawing = false, last = null, inked = false;
cx.lineCap = "round"; cx.lineJoin = "round"; cx.lineWidth = 4; cx.strokeStyle = "#000";
const pt = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
cv.onpointerdown = (e) => { drawing = true; last = pt(e); cv.setPointerCapture(e.pointerId); };
cv.onpointermove = (e) => { if (!drawing) return; const p = pt(e); cx.beginPath(); cx.moveTo(...last); cx.lineTo(...p); cx.stroke(); last = p; inked = true; };
cv.onpointerup = cv.onpointercancel = () => { drawing = false; };
$("sigbtn").onclick = () => $("sigdlg").showModal(); $("sigcancel").onclick = () => $("sigdlg").close();
$("sigclear").onclick = () => { cx.clearRect(0, 0, cv.width, cv.height); inked = false; };
$("sigsave").onclick = () => {
  if (!$("sigok").checked) return done("Confirm the signature is your own.", "err");
  if (!inked) return done("Draw your signature first.", "err");
  const d = cx.getImageData(0, 0, cv.width, cv.height).data; let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 12) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const c = document.createElement("canvas"); c.width = x1 - x0 + 8; c.height = y1 - y0 + 8;
  c.getContext("2d").drawImage(cv, x0 - 4, y0 - 4, c.width, c.height, 0, 0, c.width, c.height);
  state.sig = c.toDataURL("image/png"); $("sigprev").src = state.sig; $("sigprev").hidden = $("sigrm").hidden = false; $("sigdlg").close(); done("Signature added", "ok"); live(); };
$("sigrm").onclick = () => { state.sig = null; $("sigprev").hidden = $("sigrm").hidden = true; live(); };

// ---- scanned copy (CamScanner-style), done in the browser ----
function scanCanvas(im, mode) {
  const w = im.naturalWidth, h = im.naturalHeight, mk = (W, H) => { const c = document.createElement("canvas"); c.width = W; c.height = H; return c; };
  const c = mk(w, h), x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0);
  const sw = Math.ceil(w / 8), sh = Math.ceil(h / 8), s = mk(sw, sh), sx = s.getContext("2d"); sx.drawImage(im, 0, 0, sw, sh);
  const sd = sx.getImageData(0, 0, sw, sh), o = sx.createImageData(sw, sh);
  for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) { for (let k = 0; k < 3; k++) { let m = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const X = Math.min(sw - 1, Math.max(0, xx + dx)), Y = Math.min(sh - 1, Math.max(0, yy + dy)), v = sd.data[(Y * sw + X) * 4 + k]; if (v > m) m = v; }
      o.data[(yy * sw + xx) * 4 + k] = m; } o.data[(yy * sw + xx) * 4 + 3] = 255; }
  sx.putImageData(o, 0, 0);
  const b = mk(w, h), bx = b.getContext("2d"); bx.imageSmoothingQuality = "high"; bx.drawImage(s, 0, 0, w, h);
  const D = x.getImageData(0, 0, w, h), d = D.data, B = bx.getImageData(0, 0, w, h).data;
  const lo = mode === "magic" ? .38 : .3, hi = mode === "magic" ? .96 : .93, cl = (v) => Math.max(0, Math.min(1, v));
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / Math.max(B[i], 1), g = d[i + 1] / Math.max(B[i + 1], 1), bl = d[i + 2] / Math.max(B[i + 2], 1), L = .299 * r + .587 * g + .114 * bl; let R, G, Bb;
    if (mode === "bw") R = G = Bb = cl((L - .4) / .25); else if (mode === "gray") R = G = Bb = cl((L - lo) / (hi - lo));
    else { R = cl((r - lo) / (hi - lo)); G = cl((g - lo) / (hi - lo)); Bb = cl((bl - lo) / (hi - lo)); const gl = .299 * R + .587 * G + .114 * Bb; R = cl(gl + (R - gl) * 1.2); G = cl(gl + (G - gl) * 1.2); Bb = cl(gl + (Bb - gl) * 1.2); }
    d[i] = R * 255; d[i + 1] = G * 255; d[i + 2] = Bb * 255; }
  x.putImageData(D, 0, 0); return c;
}
async function scanAll() { await flushEdits(); status("Scanning…", "busy"); await new Promise((r) => setTimeout(r, 30)); const out = [];
  for (const p of state.pages) { out.push(scanCanvas(await loadImg("data:image/jpeg;base64," + p.img), $("scanmode").value)); await new Promise((r) => setTimeout(r, 0)); }
  done("Scan ready", "ok"); return out; }
$("scanjpg").onclick = async () => { const cs = await scanAll(); cs.forEach((c, i) => setTimeout(() => saveAs(c.toDataURL("image/jpeg", .85), `inktwin-scan-${i + 1}.jpg`), i * 300)); };
$("scanpdf").onclick = async () => { const cs = await scanAll(), jp = [];
  for (const c of cs) { const bl = await new Promise((r) => c.toBlob(r, "image/jpeg", .85)); jp.push({ bytes: new Uint8Array(await bl.arrayBuffer()), w: c.width, h: c.height }); }
  const url = URL.createObjectURL(makePdf(jp)); saveAs(url, "inktwin-scan.pdf"); setTimeout(() => URL.revokeObjectURL(url), 8000); };

try { const p = JSON.parse(localStorage.getItem("inktwin.profile") || "null"); if (p && p.glyphs) { state.profile = p; showProfile(); } } catch {}
