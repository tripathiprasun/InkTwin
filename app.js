// Set this to your Render URL before deploying the frontend (see README).
const API = "https://inktwin-api.onrender.com";
const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?'-:;()/@&$%+=";
const $ = (id) => document.getElementById(id);
const state = { profile: null, mood: "normal", pages: [], pdf: null, busy: false, timer: null, adding: false, mode: "sheet", sig: null };

function show(id) { for (const s of document.querySelectorAll(".step")) s.hidden = s.id !== id; }
function status(msg, kind = "") { const s = $("status"); s.textContent = msg; s.className = "status " + kind; }
async function post(path, body) {
  let r;
  try { r = await fetch(API + path, { method: "POST", body, headers: body instanceof FormData ? {} : { "Content-Type": "application/json" } }); }
  catch { throw new Error("Can't reach the server. Is the backend running and is API set correctly?"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
function stages(list) {
  let i = 0; status(list[0], "busy"); clearInterval(state.timer);
  state.timer = setInterval(() => { if (i < list.length - 1) status(list[++i], "busy"); }, 1800);
}
function done(msg, kind) { clearInterval(state.timer); status(msg, kind); }
const persist = () => { try { localStorage.setItem("inktwin.profile", JSON.stringify(state.profile)); } catch {} };

$("tpl").href = API + "/api/template";
fetch(API + "/api/prompt").then((r) => r.json()).then((j) => {
  $("lines").innerHTML = "";
  j.lines.forEach((t, i) => { const d = document.createElement("div"); d.className = "ln";
    const b = document.createElement("b"); b.textContent = i + 1; const s = document.createElement("span"); s.textContent = t;
    d.append(b, s); $("lines").appendChild(d); });
}).catch(() => { $("lines").textContent = "Can't reach the server to load the lines. Check the API address."; });

function pickFile() {
  if (!$("consent").checked) { if (state.adding) show("s-upload"); return done("Confirm you have permission to use this handwriting, then upload.", "err"); }
  $("file").click();
}
$("pick").onclick = () => { state.adding = false; pickFile(); };
$("addmore").onclick = () => { state.adding = true; pickFile(); };
$("file").onchange = async () => {
  const files = [...$("file").files].slice(0, 4);
  if (!files.length) return;
  $("fname").textContent = files.map((f) => f.name).join(", ");
  const fd = new FormData(); files.forEach((f) => fd.append("samples", f));
  fd.append("consent", "true"); fd.append("mode", state.mode);
  $("pick").disabled = true;
  stages(["Processing sample…", "Detecting handwriting…", "Matching letters…", "Building profile…"]);
  try {
    const { profile, report } = await post("/api/profile", fd);
    if (state.adding && state.profile) {
      for (const [c, l] of Object.entries(profile.glyphs)) state.profile.glyphs[c] = [...(state.profile.glyphs[c] || []), ...l].slice(0, 9);
    } else state.profile = profile;
    persist(); showProfile();
    done(report && report.total ? `Complete — matched ${report.matched} of ${report.total} words` : "Complete", "ok");
  } catch (e) { done(e.message, "err"); }
  $("pick").disabled = false; $("file").value = "";
};
function showProfile() {
  const p = state.profile, g = p.glyphs;
  const n = Object.values(g).reduce((a, l) => a + l.length, 0);
  $("pstats").textContent = `${Object.keys(g).length} characters, ${n} letter variants. Slant ${p.slant.toFixed(1)}°, stroke ${p.stroke_width.toFixed(1)} px.`;
  const miss = [...CHARS].filter((c) => !g[c]);
  $("pmiss").textContent = miss.length ? `Not captured: ${miss.join(" ")} (a missing upper/lowercase letter borrows its twin; other characters are skipped). Add another photo to fill gaps.` : "Every character captured.";
  const sh = $("sheet"); sh.innerHTML = "";
  for (const ch of CHARS) (g[ch] || []).forEach((gl, i) => {
    const im = new Image(); im.src = "data:image/png;base64," + gl.png; im.alt = ch; im.title = `${ch} — click to remove`;
    im.dataset.c = ch; im.dataset.i = i; sh.appendChild(im);
  });
  show("s-profile");
}
$("sheet").onclick = (e) => {
  const im = e.target.closest("img"); if (!im) return;
  const l = state.profile.glyphs[im.dataset.c]; l.splice(+im.dataset.i, 1);
  if (!l.length) delete state.profile.glyphs[im.dataset.c];
  persist(); showProfile();
};
$("redo").onclick = () => { state.profile = null; state.adding = false; show("s-upload"); status(""); };
$("newprofile").onclick = $("redo").onclick;
$("toWrite").onclick = () => { show("s-write"); status(""); count(); };
const count = () => ($("count").textContent = `${$("text").value.length.toLocaleString()} / 12,000`);
$("text").oninput = count;
$("edit").onclick = () => { $("result").hidden = true; $("editorBox").hidden = false; };

function settings() {
  return { variation: $("variation").value / 100, mood: state.mood, paper: $("paper").value, pen: $("pen").value, seed: $("seed").value.trim() || null, signature: state.sig, sig_pos: $("sigpos").value };
}
async function generate() {
  if (state.busy || !state.profile) return;
  const text = $("text").value;
  if (!text.trim()) return done("Type some text first.", "err");
  state.busy = true; $("gen").disabled = $("regen").disabled = true; $("pages").classList.add("busy");
  stages(["Generating…", "Inking the page…"]);
  try {
    const r = await post("/api/generate", JSON.stringify({ profile: state.profile, text, settings: settings() }));
    state.pages = r.pages; state.pdf = r.pdf; $("pages").innerHTML = "";
    r.pages.forEach((b, i) => { const im = new Image(); im.src = "data:image/png;base64," + b; im.alt = `Page ${i + 1}`; $("pages").appendChild(im); });
    applyZoom(); $("editorBox").hidden = true; $("result").hidden = false;
    let m = "Complete";
    if (r.missing.length) m += ` — skipped unsupported characters: ${r.missing.join(" ")}`;
    if (r.truncated) m += " — text was cut at 10 pages";
    done(m, "ok");
  } catch (e) { done(e.message, "err"); }
  state.busy = false; $("gen").disabled = $("regen").disabled = false; $("pages").classList.remove("busy");
}
$("gen").onclick = generate; $("regen").onclick = generate;
let deb; const live = () => { if ($("result").hidden) return; clearTimeout(deb); deb = setTimeout(generate, 700); };
["variation", "paper", "pen", "seed", "sigpos"].forEach((id) => $(id).addEventListener("change", live));
$("mood").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.mood = b.dataset.v;
  document.querySelectorAll("#mood button").forEach((x) => x.classList.toggle("on", x === b)); live(); };
function applyZoom() { for (const im of $("pages").children) im.style.width = $("zoom").value + "%"; }
$("zoom").oninput = applyZoom;

function saveAs(href, name) { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
$("dlpng").onclick = () => state.pages.forEach((b, i) => setTimeout(() => saveAs("data:image/png;base64," + b, `inktwin-page-${i + 1}.png`), i * 300));
$("dlpdf").onclick = () => {
  const bin = atob(state.pdf), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([u], { type: "application/pdf" })); saveAs(url, "inktwin.pdf"); setTimeout(() => URL.revokeObjectURL(url), 5000);
};
try { const p = JSON.parse(localStorage.getItem("inktwin.profile") || "null"); if (p && p.glyphs) { state.profile = p; showProfile(); } } catch {}

// ---- calibration mode tabs ----
$("modes").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.mode = b.dataset.m;
  document.querySelectorAll("#modes button").forEach((x) => x.classList.toggle("on", x === b));
  $("m-sheet").hidden = state.mode !== "sheet"; $("m-free").hidden = state.mode !== "free"; };

// ---- signature pad (drawn by the user, used as-is) ----
const cv = $("sigcv"), cx = cv.getContext("2d"); let drawing = false, last = null, inked = false;
cx.lineCap = "round"; cx.lineJoin = "round"; cx.lineWidth = 4; cx.strokeStyle = "#000";
const pt = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
cv.onpointerdown = (e) => { drawing = true; last = pt(e); cv.setPointerCapture(e.pointerId); };
cv.onpointermove = (e) => { if (!drawing) return; const p = pt(e); cx.beginPath(); cx.moveTo(...last); cx.lineTo(...p); cx.stroke(); last = p; inked = true; };
cv.onpointerup = cv.onpointercancel = () => { drawing = false; };
$("sigbtn").onclick = () => $("sigdlg").showModal();
$("sigcancel").onclick = () => $("sigdlg").close();
$("sigclear").onclick = () => { cx.clearRect(0, 0, cv.width, cv.height); inked = false; };
$("sigsave").onclick = () => {
  if (!$("sigok").checked) return done("Confirm the signature is your own.", "err");
  if (!inked) return done("Draw your signature first.", "err");
  const d = cx.getImageData(0, 0, cv.width, cv.height).data; let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 12) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const c = document.createElement("canvas"); c.width = x1 - x0 + 8; c.height = y1 - y0 + 8;
  c.getContext("2d").drawImage(cv, x0 - 4, y0 - 4, c.width, c.height, 0, 0, c.width, c.height);
  state.sig = c.toDataURL("image/png"); $("sigprev").src = state.sig; $("sigprev").hidden = $("sigrm").hidden = false;
  $("sigdlg").close(); done("Signature added", "ok"); live();
};
$("sigrm").onclick = () => { state.sig = null; $("sigprev").hidden = $("sigrm").hidden = true; live(); };

// ---- scanned copy (CamScanner-style), done in the browser ----
const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
function scanCanvas(im, mode) {
  const w = im.naturalWidth, h = im.naturalHeight, mk = (W, H) => { const c = document.createElement("canvas"); c.width = W; c.height = H; return c; };
  const c = mk(w, h), x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0);
  const sw = Math.ceil(w / 8), sh = Math.ceil(h / 8), s = mk(sw, sh), sx = s.getContext("2d"); sx.drawImage(im, 0, 0, sw, sh);
  const sd = sx.getImageData(0, 0, sw, sh), o = sx.createImageData(sw, sh);
  for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) { // shadow map: brightest nearby paper
    for (let k = 0; k < 3; k++) { let m = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const X = Math.min(sw - 1, Math.max(0, xx + dx)), Y = Math.min(sh - 1, Math.max(0, yy + dy)), v = sd.data[(Y * sw + X) * 4 + k]; if (v > m) m = v; }
      o.data[(yy * sw + xx) * 4 + k] = m; }
    o.data[(yy * sw + xx) * 4 + 3] = 255; }
  sx.putImageData(o, 0, 0);
  const b = mk(w, h), bx = b.getContext("2d"); bx.imageSmoothingQuality = "high"; bx.drawImage(s, 0, 0, w, h);
  const D = x.getImageData(0, 0, w, h), d = D.data, B = bx.getImageData(0, 0, w, h).data;
  const lo = mode === "magic" ? .38 : .3, hi = mode === "magic" ? .96 : .93, cl = (v) => Math.max(0, Math.min(1, v));
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / Math.max(B[i], 1), g = d[i + 1] / Math.max(B[i + 1], 1), bl = d[i + 2] / Math.max(B[i + 2], 1), L = .299 * r + .587 * g + .114 * bl;
    let R, G, Bb;
    if (mode === "bw") R = G = Bb = cl((L - .4) / .25);
    else if (mode === "gray") R = G = Bb = cl((L - lo) / (hi - lo));
    else { R = cl((r - lo) / (hi - lo)); G = cl((g - lo) / (hi - lo)); Bb = cl((bl - lo) / (hi - lo));
      const gl = .299 * R + .587 * G + .114 * Bb; R = cl(gl + (R - gl) * 1.2); G = cl(gl + (G - gl) * 1.2); Bb = cl(gl + (Bb - gl) * 1.2); }
    d[i] = R * 255; d[i + 1] = G * 255; d[i + 2] = Bb * 255;
  }
  x.putImageData(D, 0, 0); return c;
}
async function scanAll() {
  status("Scanning…", "busy"); await new Promise((r) => setTimeout(r, 30)); const out = [];
  for (const p of state.pages) out.push(scanCanvas(await loadImg("data:image/png;base64," + p), $("scanmode").value));
  done("Scan ready", "ok"); return out;
}
function makePdf(jp) { // minimal PDF writer: one A4 page per JPEG
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
$("scanjpg").onclick = async () => { const cs = await scanAll(); cs.forEach((c, i) => setTimeout(() => saveAs(c.toDataURL("image/jpeg", .85), `inktwin-scan-${i + 1}.jpg`), i * 300)); };
$("scanpdf").onclick = async () => {
  const cs = await scanAll(), jp = [];
  for (const c of cs) { const bl = await new Promise((r) => c.toBlob(r, "image/jpeg", .85)); jp.push({ bytes: new Uint8Array(await bl.arrayBuffer()), w: c.width, h: c.height }); }
  const url = URL.createObjectURL(makePdf(jp)); saveAs(url, "inktwin-scan.pdf"); setTimeout(() => URL.revokeObjectURL(url), 5000);
};
