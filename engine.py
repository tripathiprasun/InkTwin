"""InkTwin engine: calibration template -> glyph extraction -> profile -> procedural rendering.

A learned stroke model can later replace `render_*` (see README "Extending with ML").
"""
import io, os, re, base64, math
import numpy as np
import cv2
from PIL import Image, ImageOps, ImageDraw, ImageFont

CHARS = list("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")  # every keyboard character
CAP = {"I": "cap i", "l": "low L", "O": "cap o", "0": "zero", "1": "one", "|": "bar", "`": "tick", "'": "apost", '"': "quote",
       ",": "comma", ".": "dot", "-": "dash", "_": "under", "~": "tilde", "^": "caret", "\\": "bkslsh", "/": "slash",
       ":": "colon", ";": "semi", "*": "star", "#": "hash", "<": "less", ">": "more", "{": "brace", "}": "brace",
       "[": "brckt", "]": "brckt", "(": "paren", ")": "paren", "!": "bang", "?": "query", "@": "at", "&": "and",
       "$": "dollar", "%": "pct", "+": "plus", "=": "equals"}
CHARSET = set(CHARS)

# ---- template geometry (shared by template generator and extractor) ----
W, H = 1800, 2546
GROUPS, REPS, LBL, CELL = 5, 3, 40, 100
X0, Y0, BASE = (W - GROUPS * (LBL + REPS * CELL)) // 2, 250, 68
MARK = [(70, 70), (W - 70, 70), (70, H - 70), (W - 70, H - 70)]  # TL TR BL BR centres


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except Exception:
        return ImageFont.load_default()


def make_template() -> bytes:
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)
    for cx, cy in MARK:
        d.rectangle((cx - 30, cy - 30, cx + 30, cy + 30), fill=0)
    d.text((140, 62), "InkTwin calibration sheet", fill=60, font=_font(40))
    for n_, t_ in enumerate(["Write the big character on the left of each group once in each of its 3 boxes, the way you normally write it.",
                             "Sit letters on the dashed line (g j p q y may dip below). Stay inside the box. Dark pen, normal size.",
                             "The small word under a character clears up look-alikes. Leave a box empty if you slip. Keep all 4 black squares visible.",
                             "Only use handwriting you have permission to use."]):
        d.text((140, 118 + n_ * 30), t_, fill=100, font=_font(21))
    for i, ch in enumerate(CHARS):
        r, c = divmod(i, GROUPS)
        gx, gy = X0 + c * (LBL + REPS * CELL), Y0 + r * CELL
        d.text((gx + 10, gy + 22), ch, fill=90, font=_font(34))
        d.text((gx + 3, gy + 72), CAP.get(ch, ''), fill=110, font=_font(12))
        for k in range(REPS):
            cx = gx + LBL + k * CELL
            d.rectangle((cx, gy, cx + CELL, gy + CELL), outline=200)
            for x in range(cx + 4, cx + CELL - 4, 10):
                d.line((x, gy + BASE, x + 5, gy + BASE), fill=215)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


# ---- image loading / perspective correction ----
def load_image(data: bytes):
    try:
        im = Image.open(io.BytesIO(data))
        fmt = im.format
    except Exception:
        raise ValueError("That file isn't a readable image.")
    if fmt not in ("JPEG", "PNG", "WEBP"):
        raise ValueError("Use a JPG, PNG or WEBP image.")
    if im.width * im.height > 40_000_000:
        raise ValueError("Image is too large (over 40 megapixels). Resize it and retry.")
    if min(im.size) < 800:
        raise ValueError("Image is too small. Use at least 800 px on the short side.")
    if fmt == "JPEG":
        im.draft("L", (3200, 3200))
    im = ImageOps.exif_transpose(im).convert("L")
    im.thumbnail((3200, 3200))
    return np.array(im)


def find_corners(gray):
    h, w = gray.shape
    _, thr = cv2.threshold(cv2.GaussianBlur(gray, (5, 5), 0), 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    pts = []
    for qy in (0, 1):
        for qx in (0, 1):
            oy, ox = qy * h // 2, qx * w // 2
            cs, _ = cv2.findContours(thr[oy:oy + h // 2, ox:ox + w // 2], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            best, ba = None, 0
            for c in cs:
                x, y, cw, ch = cv2.boundingRect(c)
                a = cv2.contourArea(c)
                if a < 0.0002 * w * h or not 0.7 < cw / ch < 1.4 or a / (cw * ch) < 0.8:
                    continue
                if a > ba:
                    ba, best = a, (ox + x + cw / 2, oy + y + ch / 2)
            if best is None:
                raise ValueError("Couldn't find the four black corner squares. Keep the whole sheet in frame, "
                                 "upright (portrait), flat and evenly lit.")
            pts.append(best)
    return np.float32(pts)


def warp(gray):
    M = cv2.getPerspectiveTransform(find_corners(gray), np.float32(MARK))
    return cv2.warpPerspective(gray, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=255)


# ---- glyph extraction ----
def _png_b64(a):
    buf = io.BytesIO()
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L").save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def extract_sample(data: bytes):
    g = warp(load_image(data)).astype(np.float32)
    bg = cv2.GaussianBlur(cv2.dilate(cv2.resize(g, (W // 4, H // 4), interpolation=cv2.INTER_AREA),
                                     np.ones((9, 9), np.uint8)), (0, 0), 6)
    norm = np.clip(g / np.maximum(cv2.resize(bg, (W, H)), 1), 0, 1.2)
    alpha = np.clip((0.8 - norm) / 0.5, 0, 1)  # soft ink amount: keeps pressure + edges
    alpha[alpha < 0.1] = 0
    out = {}
    for i, ch in enumerate(CHARS):
        r, c = divmod(i, GROUPS)
        gx, gy = X0 + c * (LBL + REPS * CELL), Y0 + r * CELL
        for k in range(REPS):
            cx = gx + LBL + k * CELL
            crop = alpha[gy + 6:gy + CELL - 6, cx + 6:cx + CELL - 6]
            n, lab, st, _ = cv2.connectedComponentsWithStats((crop > 0.3).astype(np.uint8), connectivity=8)
            keep = [j for j in range(1, n) if st[j, cv2.CC_STAT_AREA] >= 8]
            if not keep:
                continue
            mask = cv2.dilate(np.isin(lab, keep).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
            ys, xs = np.where(mask)
            y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
            ga = (crop * mask)[y0:y1 + 1, x0:x1 + 1]
            if ga.shape[0] < 4 or ga.shape[1] < 2:
                continue
            base = BASE - 6
            binm = (ga > 0.3).astype(np.uint8)
            cs, _ = cv2.findContours(binm, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
            per = sum(cv2.arcLength(q, True) for q in cs)
            M = cv2.moments(ga)
            out.setdefault(ch, []).append(dict(
                png=_png_b64(ga), w=int(ga.shape[1]), h=int(ga.shape[0]),
                top=float(base - y0), bot=float(y1 + 1 - base),
                sw=float(2 * binm.sum() / max(per, 1)),
                pr=float(ga[binm > 0].mean()) if binm.any() else 0.7,
                sl=float(math.degrees(math.atan(-M["mu11"] / M["mu02"]))) if M["mu02"] > 1e-6 else 0.0))
    return out


# ---- profile ----
def build_profile(samples, min_chars=40):
    glyphs = {}
    for s in samples:
        for ch, lst in s.items():
            glyphs.setdefault(ch, []).extend(lst)
    glyphs = {ch: lst[:9] for ch, lst in glyphs.items()}
    if len(glyphs) < min_chars:
        raise ValueError(f"Only {len(glyphs)} of {len(CHARS)} characters were readable. "
                         "Fill in more boxes, write darker, and retake the photo.")

    def vals(chars, key):
        return [g[key] for c in chars for g in glyphs.get(c, [])]

    def med(chars, key, dflt):
        v = vals(chars, key)
        return float(np.median(v)) if v else dflt

    xhl = "acemnorsuvwxz"
    xh = med(xhl, "top", 30.0)
    per_letter = [np.std([g["top"] for g in glyphs[c]]) for c in xhl if len(glyphs.get(c, [])) > 1]
    allg = [g for l in glyphs.values() for g in l]
    return dict(
        version=1, chars_found=len(glyphs), variants=len(allg), x_height=xh,
        ascender_ratio=med("bdfhkl", "top", xh * 1.8) / xh,
        descender_ratio=med("gjpqy", "bot", xh * 0.7) / xh,
        cap_ratio=med("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "top", xh * 1.7) / xh,
        slant=med("bdhklt1", "sl", 0.0),
        stroke_width=float(np.median([g["sw"] for g in allg])),
        pressure_mean=float(np.mean([g["pr"] for g in allg])),
        pressure_var=float(np.std([g["pr"] for g in allg])),
        size_variance=float(np.mean(per_letter) / xh) if per_letter else 0.05,
        baseline_variance=float(np.std(vals(xhl, "bot")) / xh) if vals(xhl, "bot") else 0.04,
        char_spacing=0.14, word_spacing=0.75,
        glyphs={c: [{k: g[k] for k in ("png", "w", "h", "top")} for g in l] for c, l in glyphs.items()},
    )


def _decode(profile):
    out = {}
    for ch, lst in profile["glyphs"].items():
        if len(ch) != 1 or ch not in CHARSET or not isinstance(lst, list):
            continue
        v = []
        for g in lst[:12]:
            try:
                im = Image.open(io.BytesIO(base64.b64decode(g["png"]))).convert("L")
                if im.width > 200 or im.height > 200:
                    continue
                v.append(dict(a=np.asarray(im, np.float32) / 255, top=float(g["top"])))
            except Exception:
                continue
        if v:
            out[ch] = v
    return out


# ---- paper ----
PW, PH, PITCH = 1240, 1754, 54
MAX_PAGES = int(os.getenv("MAX_PAGES", "30"))
PENS = dict(ballpoint=dict(color=(28, 44, 128), op=.92, gain=1.0, blur=.45, bleed=.12),
            gel=dict(color=(14, 14, 24), op=.98, gain=1.25, blur=.7, bleed=.30),
            pencil=dict(color=(72, 72, 78), op=.80, gain=.95, blur=.6, bleed=.10))
MOODS = dict(neat=.6, normal=1.0, rushed=1.5, messy=2.1)


PITCHES = dict(classmate=46, notebook=50, lined=54, graph=54, exam=54, blank=54)


def layout(kind):
    p = PITCHES.get(kind, 54)
    top = {"graph": 189, "exam": 320, "classmate": 190}.get(kind, 180)
    ys = list(range(top, PH - 100, p))
    off = 3 if kind == "graph" else max(5, round(p * .14))
    left = {"notebook": 185, "classmate": 152}.get(kind, 130)
    return dict(pitch=p, left=left, right=PW - 90, base=[y - off for y in ys], ys=ys, top=top)


def draw_paper(kind, rng, tex=1.0, light=1.0):
    L = layout(kind)
    white = (254, 254, 254) if kind == "blank" else (245, 246, 244) if kind == "classmate" else (250, 249, 246)
    im = Image.new("RGB", (PW, PH), white)
    d = ImageDraw.Draw(im)
    for _ in range(220):  # paper fibres
        x, y, l, t = int(rng.integers(0, PW)), int(rng.integers(0, PH)), int(rng.integers(6, 22)), rng.uniform(0, 6.28)
        c = int(255 - (255 - int(rng.integers(222, 238))) * tex)
        d.line([(x, y), (x + l * math.cos(t), y + l * math.sin(t))], fill=(c, c, c - 2), width=1)
    if kind in ("lined", "notebook", "exam", "classmate"):
        lc = (128, 168, 214) if kind == "classmate" else (172, 192, 222)
        for y in L["ys"]:
            j = int(rng.integers(-6, 7))  # printing variation from line to line
            d.line([(0, y), (PW, y)], fill=(lc[0] + j, lc[1] + j, lc[2] + j), width=2)
    if kind == "classmate":  # double red margin + red header rule, like a school exercise book
        for x in (112, 119):
            d.line([(x, 0), (x, PH)], fill=(208, 84, 100), width=1)
        d.line([(0, 118), (PW, 118)], fill=(208, 84, 100), width=1)
    if kind == "graph":
        for y in range(81, PH, 27):
            d.line([(0, y), (PW, y)], fill=(178, 212, 196), width=1)
        for x in range(27, PW, 27):
            d.line([(x, 0), (x, PH)], fill=(178, 212, 196), width=1)
    if kind == "notebook":  # spiral-bound: punched holes + single red margin
        d.line([(150, 0), (150, PH)], fill=(226, 150, 150), width=2)
        for cy in range(70, PH - 40, 92):
            d.ellipse((30, cy - 10, 50, cy + 10), fill=(112, 118, 130))
            d.ellipse((32, cy - 7, 48, cy + 9), fill=(222, 224, 228))
    if kind == "exam":
        d.rectangle((110, 70, PW - 90, 250), outline=(90, 90, 90), width=2)
        f = _font(24)
        d.text((130, 105), "Name", fill=(110, 110, 110), font=f)
        d.line([(210, 130), (700, 130)], fill=(110, 110, 110))
        d.text((730, 105), "Date", fill=(110, 110, 110), font=f)
        d.line([(800, 130), (PW - 110, 130)], fill=(110, 110, 110))
        d.text((130, 175), "Class", fill=(110, 110, 110), font=f)
        d.line([(210, 200), (700, 200)], fill=(110, 110, 110))
    a = np.asarray(im, np.float32)
    n = cv2.GaussianBlur(rng.standard_normal((PH, PW), dtype=np.float32), (0, 0), 1.1)
    n /= n.std() + 1e-6
    lf = cv2.resize(rng.normal(0, 1, (9, 7)).astype(np.float32), (PW, PH), interpolation=cv2.INTER_CUBIC)
    vig = 1 - light * (1 - _vig())
    return a * (1 + tex * (0.018 * n + 0.012 * lf))[..., None] * vig[..., None], L


def load_signature(v):
    """Signature drawn by the user in the browser (transparent PNG). Used as-is; never generated or stored."""
    try:
        if not isinstance(v, str) or not v.startswith("data:image/png;base64,") or len(v) > 400_000:
            return None
        im = Image.open(io.BytesIO(base64.b64decode(v.split(",", 1)[1])))
        if im.format != "PNG" or im.width > 1200 or im.height > 600:
            return None
        al = np.asarray(im.convert("RGBA").split()[3], np.float32) / 255
        ys, xs = np.where(al > .05)
        if len(ys) < 30:
            return None
        return al[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy()
    except Exception:
        return None


# ---- rendering: styled layout, ink layers, page realism ----
from functools import lru_cache


@lru_cache(maxsize=1)
def _vig():
    yy, xx = np.mgrid[0:PH, 0:PW].astype(np.float32)
    return 1 - 0.07 * ((xx / PW - .5) ** 2 + (yy / PH - .5) ** 2)


@lru_cache(maxsize=1)
def _mesh():
    return np.meshgrid(np.arange(PW, dtype=np.float32), np.arange(PH, dtype=np.float32))


PALETTE = dict(r=(196, 32, 44), b=(30, 60, 175), g=(22, 120, 70), k=(16, 16, 22))
SUBS = {"\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'", "\u2013": "-", "\u2014": "-", "\u2026": "..."}
TOKC = re.compile(r"\{\{([rbgk])\|")


def finish_page(inks, paper, pen, rng, kind="", light=1.0, inkd=1.0, ink_rgb=None):
    P = PENS[pen]
    lf = 0.9 + 0.12 * cv2.resize(rng.random((12, 9)).astype(np.float32), (PW, PH), interpolation=cv2.INTER_CUBIC)
    gr = sk = None
    if pen == "pencil":
        gr = cv2.GaussianBlur(rng.random((PH, PW), dtype=np.float32), (0, 0), 0.7)
        gr = (gr - gr.min()) / (np.ptp(gr) + 1e-6)
    if pen == "ballpoint":  # faint skipping
        sk = cv2.GaussianBlur(rng.random((PH, PW), dtype=np.float32), (0, 0), 2)
        sk = np.where((sk - sk.mean()) / sk.std() > 1.9, 0.6, 1.0).astype(np.float32)
    out = paper
    for name, ink in inks.items():  # one layer per ink colour, multiplied onto the paper
        a = ink * lf
        if gr is not None:
            a = a * (0.55 + 0.6 * gr)
        if sk is not None:
            a = a * sk
        a = np.clip(np.maximum(a, P["bleed"] * cv2.GaussianBlur(a, (0, 0), 1.2)) * P["op"] * inkd, 0, 1)
        col = np.array(ink_rgb if (ink_rgb and name == "pen") else (P["color"] if pen == "pencil" or name == "pen" else PALETTE[name]), np.float32) / 255
        out = out * (1 - a[..., None] * (1 - col))
    back = np.max(list(inks.values()), axis=0) if inks else np.zeros((PH, PW), np.float32)
    xs = np.linspace(0, 1, PW, dtype=np.float32)[None, :, None]
    yv = np.linspace(0, 1, PH, dtype=np.float32)[:, None, None]
    th = rng.uniform(0, 6.28)
    out = out * 1.05 * (1 + 0.07 * light * ((xs - .5) * math.cos(th) + (yv - .5) * math.sin(th))) * (1 - 0.13 * light * np.exp(-xs / 0.06))
    if kind == "classmate":
        out = out * (1 - 0.06 * cv2.GaussianBlur(back[:, ::-1].copy(), (0, 0), 2.2)[..., None])
    gx, gy = _mesh()
    ph = rng.uniform(0, 6.28)
    out = cv2.remap(out.astype(np.float32), gx + 2.0 * np.sin(gy / PH * 3 + ph), gy + 3.0 * np.sin(gx / PW * 3.1 + ph),
                    cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    out = cv2.GaussianBlur(out, (0, 0), 0.45) + rng.standard_normal((PH, PW, 1), dtype=np.float32) * 1.2
    buf = io.BytesIO()
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(buf, "JPEG", quality=90)
    return buf.getvalue()


def stamp(ink, g, sc, x, by, ang, shear, gain, blur, bold=0):
    a = g["a"]
    h, w = a.shape
    nw, nh = max(1, round(w * sc)), max(1, round(h * sc))
    a = cv2.resize(a, (nw, nh), interpolation=cv2.INTER_AREA if sc < 1 else cv2.INTER_CUBIC)
    p = int(max(nw, nh) * 0.35) + 3
    c = np.pad(a, p)
    cx, cy = p + nw / 2, p + g["top"] * sc
    S = np.array([[1, shear, -shear * cy], [0, 1, 0], [0, 0, 1]])
    R = np.vstack([cv2.getRotationMatrix2D((cx, cy), ang, 1), [0, 0, 1]])
    c = cv2.warpAffine(c, (R @ S)[:2], (c.shape[1], c.shape[0]), flags=cv2.INTER_LINEAR)
    c = np.clip(cv2.GaussianBlur(c, (0, 0), max(.15, blur + .3 * bold)) * gain * max(.3, 1 + .35 * bold), 0, 1)
    x0, y0 = int(round(x - p)), int(round(by - cy))
    sx0, sy0 = max(0, -x0), max(0, -y0)
    ex, ey = min(c.shape[1], PW - x0), min(c.shape[0], PH - y0)
    if ex <= sx0 or ey <= sy0:
        return
    reg = ink[y0 + sy0:y0 + ey, x0 + sx0:x0 + ex]
    ink[y0 + sy0:y0 + ey, x0 + sx0:x0 + ex] = 1 - (1 - reg) * (1 - c[sy0:ey, sx0:ex])


def hand_line(ink, x0, y0, x1, y1, rng, amp, th=2):
    """Slightly wobbly pen stroke (table borders, underlines)."""
    n = max(2, int(math.hypot(x1 - x0, y1 - y0) / 28))
    pts = [(x0 + (x1 - x0) * k / n + rng.normal(0, .5 * amp), y0 + (y1 - y0) * k / n + rng.normal(0, .6 * amp)) for k in range(n + 1)]
    cv2.polylines(ink, [np.round(np.array(pts)).astype(np.int32).reshape(-1, 1, 2)], False, 1.0, th, cv2.LINE_AA)


def inline(t):
    """**bold** //italic// __underline__ {{r|red}} ^{sup} _{sub} -> [(char, (bold, italic, underline, colour, pos))]. Backslash escapes."""
    out, k, b, i, u, col, ps = [], 0, 0, 0, 0, None, 0
    while k < len(t):
        c2 = t[k:k + 2]
        if t[k] == "\\" and k + 1 < len(t) and t[k + 1] in "*/_{}#-|[>^":
            out.append((t[k + 1], (b, i, u, col, ps))); k += 2; continue
        if c2 == "**": b ^= 1; k += 2; continue
        if c2 == "//": i ^= 1; k += 2; continue
        if c2 == "__": u ^= 1; k += 2; continue
        if c2 in ("^{", "_{"): ps = 1 if c2 == "^{" else -1; k += 2; continue
        if ps and t[k] == "}": ps = 0; k += 1; continue
        m = TOKC.match(t, k)
        if m: col = m.group(1); k = m.end(); continue
        if c2 == "}}" and col: col = None; k += 2; continue
        out.append((t[k], (b, i, u, col, ps))); k += 1
    return out


def generate(profile, text, s):
    """Generator: yields ("page", n, jpeg_bytes_or_None, glyph_manifest) per page, then ("done", meta).
    Deterministic for a given seed + text + settings; `adjust` offsets individual glyphs without changing the layout."""
    used = s.get("seed")
    used = int(used) if used is not None else int(np.random.SeedSequence().entropy % (2 ** 31))
    rng = np.random.default_rng(used)
    gl = _decode(profile)
    kind, pen = s.get("paper", "classmate"), s.get("pen", "ballpoint")
    neat = float(s["neat"]) if s.get("neat") is not None else {"neat": .8, "normal": .5, "rushed": .3, "messy": .1}[s.get("mood", "normal")]
    mic = .25 + 1.5 * float(s.get("rand", s.get("variation", .5)))  # randomness: letter-by-letter jitter
    mac = 2 * (1 - neat)  # sloppiness: word/line-level wobble, drift, size creep
    drift_k, size_k, slant = float(s.get("drift", 1)), float(s.get("size", 1)), float(s.get("slant", 0))
    thick, inkd, tex, light = float(s.get("thick", 1)), float(s.get("ink", 1)), float(s.get("texture", 1)), float(s.get("light", 1))
    inkc, preview = s.get("ink_color"), s.get("preview")
    lim = min(MAX_PAGES, int(preview)) if preview else MAX_PAGES
    P = PENS[pen]
    lay = layout(kind)
    pitch, nl = lay["pitch"], len(lay["base"])
    xh = pitch * 0.40
    s0 = xh / float(profile["x_height"]) * size_k
    sv = max(float(profile.get("size_variance", .05)), .03)
    bv = max(float(profile.get("baseline_variance", .04)), .02)
    pv = min(float(profile.get("pressure_var", .1)), .25)
    wsp, csp = float(profile.get("word_spacing", .75)) * float(s.get("wordgap", 1)), float(profile.get("char_spacing", .14)) * float(s.get("spacing", 1))
    avail = lay["right"] - lay["left"]
    only, adj, frm = s.get("only"), s.get("adjust") or {}, s.get("from")
    yield ("seed", used)  # lets a client resume the exact same document after a dropped connection
    missing, last, inks, man = set(), {}, {}, []
    pages = gi = li = wg = 0
    NS = (0, 0, 0, None, 0)

    text = text.replace("\r", "").expandtabs(4)
    for k_, v_ in SUBS.items():
        text = text.replace(k_, v_)
    if '"' not in gl:
        text = text.replace('"', "''")

    def ink(name="pen"):
        if name not in inks:
            inks[name] = np.zeros((PH, PW), np.float32)
        return inks[name]

    def pick(ch, n):
        if n == 1:
            return 0
        if rng.random() < .85:
            last[ch] = int(rng.choice([i for i in range(n) if i != last.get(ch)]))
        else:
            last[ch] = int(rng.integers(n))
        return last[ch]

    def make_word(chs, mult=1.0):
        ins = []
        for ch, st in chs:
            lst = gl.get(ch) or gl.get(ch.swapcase())
            if not lst:
                if not ch.isspace():
                    missing.add(ch)
                continue
            vi = pick(ch, len(lst))
            g = lst[vi]
            sc = s0 * mult * float(np.clip(1 + rng.normal(0, sv * mic * .6), .8, 1.25))
            if rng.random() < .04 * mic:
                sc *= 1 + rng.normal(0, .08)
            if st[4]:
                sc *= .62  # super/subscript
            ins.append((g, sc, st, ch, vi))
        return ins

    def wwidth(ins, mult):
        return sum(g["a"].shape[1] * sc + xh * csp * mult for g, sc, *_ in ins)

    def words_of(chs):
        out, cur = [], []
        for c in chs:
            if c[0] == " ":
                if cur: out.append(cur); cur = []
            else:
                cur.append(c)
        if cur: out.append(cur)
        return out

    def wrap(chs, av, mult=1.0):
        lines, cur, cw, gap = [], [], 0, xh * mult * wsp
        for w in words_of(chs):
            ins = make_word(w, mult)
            if not ins:
                continue
            parts = [ins]
            if wwidth(ins, mult) > av:  # hard-split very long words
                parts, chunk = [], []
                for it in ins:
                    if wwidth(chunk + [it], mult) > av and chunk:
                        parts.append(chunk); chunk = []
                    chunk.append(it)
                parts.append(chunk)
            for part in parts:
                ww = wwidth(part, mult)
                if cur and cw + gap + ww > av:
                    lines.append((cur, cw)); cur, cw = [], 0
                cw += (gap if cur else 0) + ww
                cur.append(part)
        if cur:
            lines.append((cur, cw))
        return lines

    def place_line(words, cw, li_, mult=1.0, align="l", left=None, av=None, ul=False):
        nonlocal gi, wg
        left = lay["left"] if left is None else left
        av = avail if av is None else av
        by0 = lay["base"][li_]
        x = left + {"l": 0, "c": (av - cw) / 2, "r": av - cw}[align] + rng.normal(0, 2 * mic)
        xs0 = x
        A, ph, slope, lp = 1.5 * mac * drift_k, rng.uniform(0, 6.28), rng.normal(0, .004 * mac * drift_k), rng.normal(0, 1)
        for wi, word in enumerate(words):
            if wi:
                x += xh * mult * wsp * float(np.clip(1 + rng.normal(0, .2 * mac), .5, 1.8))
            wdy, wang, wpr = rng.normal(0, .05 * xh * mac), rng.normal(0, .6 * mac), rng.normal(0, .04 * mac)
            ux = None
            wg += 1
            for g, sc, (b_, i_, u_, c_, ps_), ch0, vi0 in word:
                prog = (x - left) / av
                drift = A * math.sin(2 * math.pi * prog / 1.3 + ph) + slope * (x - left)
                sc *= 1 - .035 * max(mac - .6, 0) * prog
                dy = rng.normal(0, bv * xh * mic * .6) + wdy + drift + lp * .3 - (ps_ and (.62 if ps_ > 0 else -.3) * xh * mult)
                ang = rng.normal(0, 1.3 * mic) + wang
                gain = float(np.clip(1 + rng.normal(0, (.06 + pv) * mic) + wpr, .6, 1.25)) * P["gain"]
                sh = rng.normal(0, .03 * mic) + (-.22 if i_ else 0) - math.tan(math.radians(slant))  # negative shear leans right
                # manual edit: [dx, dy, rotation (clockwise deg), scale, variant (-1 = as generated), replacement char ("" = none)]
                ddx, ddy, dr, ds, av_, ac_ = adj.get(str(gi), (0, 0, 0, 1, -1, ""))
                ch1, vi1 = ac_ or ch0, vi0
                lst = gl.get(ch1) or gl.get(ch1.swapcase()) or [g]
                gg = g
                if ac_ or av_ >= 0:
                    vi1 = (av_ if av_ >= 0 else (vi0 if ch1 == ch0 else 0)) % len(lst)
                    gg = lst[vi1]
                gw = g["a"].shape[1] * sc  # advance uses the generated glyph, so edits never push other letters around
                gw0, gh0, t0 = gg["a"].shape[1] * sc, gg["a"].shape[0] * sc, gg["top"] * sc
                th, dyc = math.radians(-dr), (gh0 / 2 - t0) * ds  # scale and rotate about the glyph's centre
                xn = x + ddx - gw0 * (ds - 1) / 2  # un-rotated box, centred on the glyph's visual centre
                yn = by0 + dy + ddy + (ds - 1) * (t0 - gh0 / 2)
                stamp(ink(c_ or "pen"), gg, sc * ds, xn - dyc * math.sin(th), yn + dyc * (1 - math.cos(th)), ang - dr, sh, gain, P["blur"], b_ + (thick - 1) * 2)
                man.append([gi, round(xn, 1), round(yn - gg["top"] * sc * ds, 1), round(gw0 * ds, 1), round(gh0 * ds, 1), ch1, wg, vi1, len(lst)])
                gi += 1
                if u_ and ux is None:
                    ux = (x, c_)
                x += gw + xh * csp * mult * float(np.clip(1 + rng.normal(0, .35 * mic), .1, 2))
            if ux:
                hand_line(ink(ux[1] or "pen"), ux[0], by0 + .3 * xh + wdy, x - xh * csp * mult, by0 + .3 * xh + wdy, rng, mic)
        if ul:
            hand_line(ink("pen"), xs0, by0 + .45 * xh * mult, x, by0 + .45 * xh * mult, rng, mic)

    def flush():
        nonlocal pages
        n, pages = pages, pages + 1
        data = None
        if (only is None or n in only) and (frm is None or n >= frm):
            r2 = np.random.default_rng([used, n])  # per-page stream: skipping pages never changes other pages
            paper, _ = draw_paper(kind, r2, tex, light)
            data = finish_page(inks, paper, pen, r2, kind, light, inkd, inkc)
        out = (n, data, list(man))
        inks.clear(); man.clear()
        return out

    def need(n):  # 0 fits, 1 start new page, 2 page limit reached
        return 0 if li + n <= nl else (2 if pages + 1 >= lim else 1)

    sig = s.get("signature")
    if sig is not None:  # user's own drawn signature, top of page 1
        h0, w0 = sig.shape
        ssc = min(72 / h0, 380 / w0)
        sw_ = w0 * ssc
        sx = {"left": lay["left"], "center": (PW - sw_) / 2}.get(s.get("sig_pos"), PW - 110 - sw_)
        stamp(ink(), dict(a=sig, top=h0 * .72), ssc, sx, 238 if kind == "exam" else lay["top"] - 30,
              float(rng.normal(0, 1.5)), 0.0, P["gain"], P["blur"])

    rows_in, k, truncated = text.split("\n"), 0, False
    while k < len(rows_in) and not truncated:
        body = rows_in[k].strip()
        if not body:
            li += 1; k += 1; continue
        if body.startswith("|"):  # table
            rows = []
            while k < len(rows_in) and rows_in[k].strip().startswith("|"):
                cells = [c.strip() for c in rows_in[k].strip().strip("|").split("|")]
                k += 1
                if not all(re.fullmatch(r":?-+:?", c) for c in cells):
                    rows.append(cells)
            nc = max([len(r) for r in rows] + [1]); cwd = avail / nc; first = True
            for r in rows:
                cl = [wrap(inline(r[j]) if j < len(r) else [], max(cwd - 20, 40)) for j in range(nc)]
                n = min(max([len(c) for c in cl] + [1]), nl)
                st_ = need(n)
                if st_ == 2:
                    truncated = True; break
                if st_ == 1:
                    yield ("page", *flush()); li = 0; first = True
                yt, yb, xl = lay["ys"][li] - pitch, lay["ys"][li + n - 1], lay["left"]
                tl = ink()
                if first:
                    hand_line(tl, xl, yt, xl + avail, yt, rng, mic)
                hand_line(tl, xl, yb, xl + avail, yb, rng, mic)
                for j in range(nc + 1):
                    hand_line(tl, xl + j * cwd, yt, xl + j * cwd, yb, rng, mic)
                for j, c in enumerate(cl):
                    for q, (wds, cwid) in enumerate(c[:n]):
                        place_line(wds, cwid, li + q, left=xl + j * cwd + 10, av=cwd - 20)
                li += n; first = False
            li += 1
            continue
        mult, ul, align, bullet, bold = 1.0, False, "l", False, 0
        mm = re.match(r"\[(center|right)\] ?", body)
        if mm:
            align, body = mm.group(1)[0], body[mm.end():]
        if body.startswith("## "):
            mult, bold, body = 1.25, 1, body[3:]
        elif body.startswith("# "):
            mult, bold, ul, body = 1.5, 1, True, body[2:]
        elif body.startswith("- "):
            bullet, body = True, body[2:]
        chs = inline(body)
        if bold:
            chs = [(c, (1,) + t[1:]) for c, t in chs]
        ind = 34 if bullet else 0
        wl, step = wrap(chs, avail - ind, mult), (2 if mult >= 1.5 else 1)
        if mult >= 1.5 and li > 0:
            li += 1
        for wi_, (wds, cwid) in enumerate(wl):
            st_ = need(1)
            if st_ == 2:
                truncated = True; break
            if st_ == 1:
                yield ("page", *flush()); li = 0
            if bullet and wi_ == 0:
                place_line([make_word([("-", NS)])], 8, li, left=lay["left"] + 6, av=24)
            place_line(wds, cwid, li, mult, align, lay["left"] + ind, avail - ind, ul)
            li += step
        k += 1
    if man or inks or pages == 0:
        yield ("page", *flush())
    yield ("done", dict(seed=used, missing=sorted(missing), truncated=truncated, preview=bool(preview) and truncated))


# ---- free-paper calibration: any plain paper, user copies PROMPT lines ----
PROMPT = [
    "The quick brown fox jumps over the lazy dog.",
    "Pack my box with five dozen liquor jugs.",
    "How vexingly quick daft zebras jump!",
    "Sphinx of black quartz, judge my vow.",
    "Dear Professor, I wanted to ask about the assignment.",
    "ABCDEFGHIJKLM NOPQRSTUVWXYZ",
    "0123456789 (2026) $5 & 40%",
    "Yes: a-b; it's 3+4=7, 50/50 @ noon?",
    "He said it's #1 [a] {b} <c> 5*2 a_b ~ ^ \\ |",
]
ONBASE = set("abcdehiklmnorstuvwxzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


def _glyph_dict(ga, top, bot):
    binm = (ga > 0.3).astype(np.uint8)
    cs, _ = cv2.findContours(binm, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    per = sum(cv2.arcLength(q, True) for q in cs)
    M = cv2.moments(ga)
    return dict(png=_png_b64(ga), w=int(ga.shape[1]), h=int(ga.shape[0]), top=float(top), bot=float(bot),
                sw=float(2 * binm.sum() / max(per, 1)), pr=float(ga[binm > 0].mean()) if binm.any() else .7,
                sl=float(math.degrees(math.atan(-M["mu11"] / M["mu02"]))) if M["mu02"] > 1e-6 else 0.0)


def extract_free(data: bytes):
    """Photo of the PROMPT lines on plain paper -> labelled glyphs. Returns (glyphs, (matched_words, total_words)).
    Labels come from the known text: a word is accepted only if its number of ink clusters equals its letter count."""
    g = load_image(data).astype(np.float32)
    h, w = g.shape
    bg = cv2.GaussianBlur(cv2.dilate(cv2.resize(g, (w // 4, h // 4), interpolation=cv2.INTER_AREA),
                                     np.ones((9, 9), np.uint8)), (0, 0), 6)
    norm = np.clip(g / np.maximum(cv2.resize(bg, (w, h)), 1), 0, 1.2)
    a = np.clip((0.72 - norm) / 0.45, 0, 1)
    a[a < 0.1] = 0
    rule = cv2.morphologyEx((a > 0.3).astype(np.uint8), cv2.MORPH_OPEN, np.ones((1, max(40, w // 10)), np.uint8))
    a[cv2.dilate(rule, np.ones((5, 1), np.uint8)) > 0] = 0  # erase printed ruled lines
    sm = cv2.resize((a > 0.3).astype(np.float32), (w // 4, h // 4))
    ang = max((cv2.warpAffine(sm, cv2.getRotationMatrix2D((sm.shape[1] / 2, sm.shape[0] / 2), t, 1),
                              (sm.shape[1], sm.shape[0])).sum(1).var(), t) for t in np.arange(-6, 6.1, .5))[1]
    a = cv2.warpAffine(a, cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1), (w, h))  # deskew
    n, lab, st, cen = cv2.connectedComponentsWithStats((a > 0.3).astype(np.uint8), connectivity=8)
    ok = st[:, cv2.CC_STAT_AREA] >= 8
    ok[0] = False
    rows = np.zeros(h, np.int32)
    for i in np.where(ok)[0]:
        rows[st[i, 1]:st[i, 1] + st[i, 3]] += 1
    act = rows > 0
    runs, s0 = [], None
    for y in range(h + 1):
        v = y < h and act[y]
        if v and s0 is None:
            s0 = y
        if not v and s0 is not None:
            runs.append([s0, y]); s0 = None
    runs = [r for r in runs if r[1] - r[0] >= max(4, 0.004 * h)]
    nl = len(PROMPT)
    if len(runs) < nl:
        raise ValueError(f"Found {len(runs)} lines of writing but expected {nl}. Copy every line, leave a blank row "
                         "between lines, and make sure the page fills the photo.")
    while len(runs) > nl:  # merge fragments (i-dots, stray marks) with their nearest neighbour
        i = min(range(len(runs) - 1), key=lambda k: runs[k + 1][0] - runs[k][1])
        runs[i][1] = runs[i + 1][1]; del runs[i + 1]
    raw, matched, total = [], 0, 0
    for line, (ra, rb) in zip(PROMPT, runs):
        words = line.split()
        total += len(words)
        ids = sorted([i for i in np.where(ok)[0] if ra <= cen[i][1] < rb], key=lambda i: st[i, 0])
        cl = []
        for i in ids:
            x0, y0, cw, ch = st[i, :4]
            if cl:
                c = cl[-1]
                if min(c[1], x0 + cw) - max(c[0], x0) >= 0.6 * min(cw, c[1] - c[0]):  # dots/bars of i j : ; ! ? =
                    c[0], c[1], c[2], c[3] = min(c[0], x0), max(c[1], x0 + cw), min(c[2], y0), max(c[3], y0 + ch)
                    c[4].append(i); continue
            cl.append([x0, x0 + cw, y0, y0 + ch, [i]])
        if len(cl) < len(words):
            continue
        gaps = [cl[k + 1][0] - cl[k][1] for k in range(len(cl) - 1)]
        cuts = sorted(np.argsort(gaps)[::-1][:len(words) - 1])  # we know how many words: take the widest gaps
        groups, s1 = [], 0
        for k in cuts:
            groups.append(cl[s1:k + 1]); s1 = k + 1
        groups.append(cl[s1:])
        acc = [(wd, gp) for wd, gp in zip(words, groups) if len(gp) == len(wd)]
        matched += len(acc)
        lb = [c[3] for wd, gp in acc for c, ch in zip(gp, wd) if ch in ONBASE]
        for wd, gp in acc:
            wb = [c[3] for c, ch in zip(gp, wd) if ch in ONBASE]
            base = float(np.median(wb)) if len(wb) >= 3 else (float(np.median(lb)) if lb else None)
            if base is None:
                continue
            for c, ch in zip(gp, wd):
                msk = cv2.dilate(np.isin(lab[c[2]:c[3], c[0]:c[1]], c[4]).astype(np.uint8), np.ones((3, 3), np.uint8))
                raw.append((ch, a[c[2]:c[3], c[0]:c[1]] * msk, base - c[2], c[3] - base))
    xt = [t for ch, _, t, _ in raw if ch in "acemnorsuvwxz"]
    if not xt:
        raise ValueError("No words could be matched to the text. Write separate (unjoined) letters with clear gaps "
                         "between words, one line per row, and retake the photo straight from above.")
    f = 30.0 / float(np.median(xt))  # normalise photo scale: x-height -> 30 px
    out = {}
    for ch, ga, top, bot in raw:
        ga = np.clip(cv2.resize(ga, (max(2, round(ga.shape[1] * f)), max(2, round(ga.shape[0] * f))),
                                interpolation=cv2.INTER_AREA if f < 1 else cv2.INTER_CUBIC), 0, 1)
        if ga.shape[0] >= 4 and (ga > 0.3).any():
            out.setdefault(ch, []).append(_glyph_dict(ga, top * f, bot * f))
    return out, (matched, total)
