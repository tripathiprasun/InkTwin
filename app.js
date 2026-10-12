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
    d.innerHTML = '<img alt=""><div class="sel"></div>'; d.firstChild.alt = `Page ${box.children.length + 1}`; box.appendChild(d); }
  return box.children[n]; }
async function run(opts = {}) {
  if (state.busy || !state.profile) return;
  const text = $("text").value; if (!text.trim()) return done("Type some text first.", "err");
  const fresh = !opts.only;
  if (fresh) { state.adjust = {}; state.sel.clear(); state.dirty.clear(); state.pages = []; state.seed = null; $("pages").innerHTML = ""; }
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
          if (m.img) { pg.img = m.img; el.firstChild.src = "data:image/jpeg;base64," + m.img; }
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

// ---- letter editor: select glyphs, nudge, re-render only the touched pages ----
$("adjmode").onclick = () => { state.adjOn = !state.adjOn; $("pages").classList.toggle("adj", state.adjOn); $("adj").hidden = !state.adjOn;
  $("adjmode").classList.toggle("on", state.adjOn); if (!state.adjOn) { state.sel.clear(); drawSel(); } };
function drawSel() { [...$("pages").children].forEach((el, n) => { const g = (state.pages[n] || {}).glyphs || [];
  el.lastChild.innerHTML = g.filter((q) => state.sel.has(q[0])).map((q) =>
    `<i style="left:${q[1] / PW * 100}%;top:${q[2] / PH * 100}%;width:${q[3] / PW * 100}%;height:${q[4] / PH * 100}%"></i>`).join(""); }); }
let drag = null;
const ptr = (e, r) => [(e.clientX - r.left) / r.width * PW, (e.clientY - r.top) / r.height * PH];
$("pages").addEventListener("pointerdown", (e) => { if (!state.adjOn) return; const pg = e.target.closest(".pg"); if (!pg) return;
  const r = pg.getBoundingClientRect(), p = ptr(e, r); drag = { pg, n: +pg.dataset.n, r, p0: p, p1: p, band: null }; pg.setPointerCapture(e.pointerId); e.preventDefault(); });
$("pages").addEventListener("pointermove", (e) => { if (!drag) return; drag.p1 = ptr(e, drag.r);
  if (!drag.band) { drag.band = document.createElement("div"); drag.band.className = "band"; drag.pg.appendChild(drag.band); }
  const [a, b] = [drag.p0, drag.p1], s = drag.band.style;
  s.left = Math.min(a[0], b[0]) / PW * 100 + "%"; s.top = Math.min(a[1], b[1]) / PH * 100 + "%";
  s.width = Math.abs(a[0] - b[0]) / PW * 100 + "%"; s.height = Math.abs(a[1] - b[1]) / PH * 100 + "%"; });
$("pages").addEventListener("pointerup", (e) => { if (!drag) return; const { n, p0, p1, band } = drag; if (band) band.remove(); drag = null;
  const g = (state.pages[n] || {}).glyphs || [], add = e.shiftKey;
  if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 6) { let best = null, ba = 1e9;
    for (const q of g) if (p0[0] >= q[1] - 3 && p0[0] <= q[1] + q[3] + 3 && p0[1] >= q[2] - 3 && p0[1] <= q[2] + q[4] + 3 && q[3] * q[4] < ba) { best = q; ba = q[3] * q[4]; }
    if (!add) state.sel.clear(); if (best) { state.sel.has(best[0]) && add ? state.sel.delete(best[0]) : state.sel.add(best[0]); }
  } else { const x0 = Math.min(p0[0], p1[0]), x1 = Math.max(p0[0], p1[0]), y0 = Math.min(p0[1], p1[1]), y1 = Math.max(p0[1], p1[1]);
    if (!add) state.sel.clear(); for (const q of g) { const cx = q[1] + q[3] / 2, cy = q[2] + q[4] / 2; if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) state.sel.add(q[0]); } }
  drawSel(); });
function nudge(dx, dy, rot, sc) { if (!state.sel.size) return done("Select some letters first.", "err");
  state.pages.forEach((pg, n) => { for (const q of pg.glyphs || []) if (state.sel.has(q[0])) {
    const a = state.adjust[q[0]] || (state.adjust[q[0]] = [0, 0, 0, 1]); a[0] += dx; a[1] += dy; a[2] += rot; a[3] *= sc; q[1] += dx; q[2] += dy; state.dirty.add(n); } });
  drawSel(); clearTimeout(state.adjT); state.adjT = setTimeout(applyAdjust, 600); }
async function applyAdjust() { if (state.busy) { state.adjT = setTimeout(applyAdjust, 400); return; }
  const only = [...state.dirty]; state.dirty.clear(); if (only.length) await run({ only }); }
$("adj").onclick = (e) => { const b = e.target.closest("button"); if (!b) return;
  if (b.id === "adjreset") { state.pages.forEach((pg, n) => { for (const q of pg.glyphs || []) if (state.sel.has(q[0]) && state.adjust[q[0]]) { delete state.adjust[q[0]]; state.dirty.add(n); } });
    clearTimeout(state.adjT); state.adjT = setTimeout(applyAdjust, 300); } else if (b.dataset.a) nudge(...b.dataset.a.split(",").map(Number)); };
document.addEventListener("keydown", (e) => { if (!state.adjOn || !state.sel.size || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const k = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key], s = e.shiftKey ? 8 : 2;
  if (k) { nudge(k[0] * s, k[1] * s, 0, 1); e.preventDefault(); } else if (e.key === "Escape") { state.sel.clear(); drawSel(); } });

// ---- downloads ----
function saveAs(href, name) { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
const jpegBytes = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
$("dlpng").onclick = async () => { for (let i = 0; i < state.pages.length; i++) { const im = await loadImg("data:image/jpeg;base64," + state.pages[i].img);
  const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext("2d").drawImage(im, 0, 0);
  saveAs(c.toDataURL("image/png"), `inktwin-page-${i + 1}.png`); await new Promise((r) => setTimeout(r, 300)); } };
$("dlpdf").onclick = () => { const url = URL.createObjectURL(makePdf(state.pages.map((p) => ({ bytes: jpegBytes(p.img), w: PW, h: PH }))));
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
async function scanAll() { status("Scanning…", "busy"); await new Promise((r) => setTimeout(r, 30)); const out = [];
  for (const p of state.pages) { out.push(scanCanvas(await loadImg("data:image/jpeg;base64," + p.img), $("scanmode").value)); await new Promise((r) => setTimeout(r, 0)); }
  done("Scan ready", "ok"); return out; }
$("scanjpg").onclick = async () => { const cs = await scanAll(); cs.forEach((c, i) => setTimeout(() => saveAs(c.toDataURL("image/jpeg", .85), `inktwin-scan-${i + 1}.jpg`), i * 300)); };
$("scanpdf").onclick = async () => { const cs = await scanAll(), jp = [];
  for (const c of cs) { const bl = await new Promise((r) => c.toBlob(r, "image/jpeg", .85)); jp.push({ bytes: new Uint8Array(await bl.arrayBuffer()), w: c.width, h: c.height }); }
  const url = URL.createObjectURL(makePdf(jp)); saveAs(url, "inktwin-scan.pdf"); setTimeout(() => URL.revokeObjectURL(url), 8000); };

try { const p = JSON.parse(localStorage.getItem("inktwin.profile") || "null"); if (p && p.glyphs) { state.profile = p; showProfile(); } } catch {}
