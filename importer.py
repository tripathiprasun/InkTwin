"""Smart importer: TXT / Markdown / DOCX / PDF / OCR text -> InkTwin markup (headings, lists, tables, maths kept)."""
import io, re, zipfile, statistics, unicodedata
from collections import Counter
import xml.etree.ElementTree as ET

# ---- maths: make everything typeable on a keyboard, keep structure with ^{sup} and _{sub} ----
SUP = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻", "0123456789+-")
SUB = str.maketrans("₀₁₂₃₄₅₆₇₈₉₊₋", "0123456789+-")
GREEK = dict(zip("αβγδεζηθκλμνξρστφχψωΓΔΘΛΞΠΣΦΨΩ", "alpha beta gamma delta epsilon zeta eta theta kappa lambda mu nu xi rho sigma tau phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega".split()))
UMAP = {"×": "x", "÷": "/", "±": "+-", "∓": "-+", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "≡": "==", "∞": "inf", "π": "pi",
        "√": "sqrt", "∑": "sum", "∏": "prod", "∫": "int", "∂": "d", "∆": "Delta", "∇": "nabla", "→": "->", "⇒": "=>", "←": "<-",
        "⇔": "<=>", "↔": "<->", "°": "deg", "µ": "mu", "−": "-", "–": "-", "—": "-", "·": "*", "⋅": "*", "…": "...", "½": "1/2",
        "¼": "1/4", "¾": "3/4", "∈": "in", "∉": "not in", "∀": "for all", "∃": "exists", "⊂": "subset", "∪": "U", "∩": "n",
        "∅": "{}", "‘": "'", "’": "'", "“": '"', "”": '"', "\u00a0": " ", "•": "*", "\u200b": "", "\ufeff": ""}
UMAP.update(GREEK)
TEXN = {"leftarrow": "<-", "rightarrow": "->", "Rightarrow": "=>", "Leftrightarrow": "<=>", "infty": "inf", "times": "x", "cdot": "*",
        "div": "/", "pm": "+-", "mp": "-+", "leq": "<=", "le": "<=", "geq": ">=", "ge": ">=", "neq": "!=", "ne": "!=", "approx": "~",
        "equiv": "==", "ldots": "...", "dots": "...", "cdots": "...", "sum": "sum", "int": "int", "prod": "prod", "partial": "d",
        "nabla": "nabla", "to": "->", "in": "in", "forall": "for all", "exists": "exists", "circ": "deg", "lim": "lim",
        "sin": "sin", "cos": "cos", "tan": "tan", "log": "log", "ln": "ln", "exp": "exp", ",": " ", ";": " ", ":": " ", "!": "",
        " ": " ", "\\": " ", "{": "(", "}": ")"}
TEXN.update({v: v for v in GREEK.values()})
TEXN.update({k: " " + k + " " for k in list(GREEK.values()) + ["pi"]})


def tex(s):
    s = re.sub(r"\\(?:text|mathrm|mathbf|mathit|mathcal|operatorname|textbf)\{([^{}]*)\}", r"\1", s)
    for _ in range(4):
        s = re.sub(r"\\d?frac\{([^{}]*)\}\{([^{}]*)\}", r"(\1)/(\2)", s)
        s = re.sub(r"\\sqrt\{([^{}]*)\}", r"sqrt(\1)", s)
    s = re.sub(r"\\sqrt\s*(\w)", r"sqrt(\1)", s)
    s = re.sub(r"\\(?:left|right|big|Big|bigg|Bigg)\b\s*", "", s)
    s = re.sub(r"\\([A-Za-z]+|.)", lambda m: TEXN.get(m.group(1), "" if m.group(1).isalpha() else m.group(1)), s)
    s = re.sub(r"\^(\w)", r"^{\1}", s)
    s = re.sub(r"_(\w)", r"_{\1}", s)
    s = re.sub(r"(?<![\^_]){([^{}]*)}", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def ascii_math(s):
    s = re.sub(r"[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+", lambda m: "^{" + m.group().translate(SUP) + "}", s)
    s = re.sub(r"[₀₁₂₃₄₅₆₇₈₉₊₋]+", lambda m: "_{" + m.group().translate(SUB) + "}", s)
    for k in ("√", "∑", "∏", "∫"):
        s = s.replace(k, UMAP[k] + " ")
    for k, v in UMAP.items():
        s = s.replace(k, v)
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def esc(s):  # stop plain text from being read as InkTwin markup (URLs, ***, snake__case, {{ ...)
    return s.replace("**", "\\**").replace("//", "\\//").replace("__", "\\__").replace("{{", "\\{{")


def esc_line(l):  # escape markup characters but keep our own line prefix
    m = re.match(r"^(#{1,2} |- |\d+\. )?(.*)$", l)
    return (m.group(1) or "") + esc(m.group(2))


BUL = re.compile(r"^\s*(?:[•◦▪●■‣⁃·*+–—-])\s+")
NUM = re.compile(r"^\s*(\d{1,3})[.)]\s+")


def norm_line(l):
    if BUL.match(l):
        return "- " + BUL.sub("", l)
    m = NUM.match(l)
    return f"{m.group(1)}. " + NUM.sub("", l) if m else l


def tidy(t):
    t = re.sub(r"[ \t]+\n", "\n", t.replace("\r", "").replace("\t", "    "))
    return re.sub(r"\n{3,}", "\n\n", t).strip() + "\n"


def join_para(lines):
    out = ""
    for l in lines:
        if out.endswith("-") and not out.endswith(" -") and l[:1].islower():
            out = out[:-1] + l
        else:
            out = (out + " " + l).strip()
    return out


# ---- plain text, OCR ----
def from_text(t, kind="txt"):
    t = ascii_math(t.replace("\r", ""))
    lines = [norm_line(l.rstrip()) if kind == "ocr" or BUL.match(l) else l.rstrip() for l in t.split("\n")]
    if kind == "ocr":  # rebuild paragraphs from hard-wrapped lines, guess headings
        out, para = [], []

        def flush():
            if para:
                out.append(join_para(para)); para.clear()
        for i, l in enumerate(lines):
            s = l.strip()
            if not s:
                flush(); out.append(""); continue
            alone = (i == 0 or not lines[i - 1].strip()) and (i + 1 == len(lines) or not lines[i + 1].strip())
            more = any(x.strip() for x in lines[i + 1:])
            if alone and more and len(s.split()) <= 10 and not re.search(r"[.,;:!?]$|://|@", s) and not s.startswith("- ") and not NUM.match(s):
                flush(); out.append(("# " if s.isupper() and not out else "## ") + s); continue
            if s.startswith("- ") or NUM.match(s):
                flush(); para.append(s); continue
            if para and re.search(r"[.!?:]$", para[-1]) and s[:1].isupper():
                flush()
            para.append(s)
        flush()
        lines = out
    return tidy("\n".join(esc_line(l) for l in lines))


# ---- Markdown ----
def md_inline(s):
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"</?[a-zA-Z][^>]*>", "", s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"~~(.+?)~~", r"\1", s)
    s = re.sub(r"(\*\*|__)(.+?)\1", "\x01\\2\x01", s)
    s = re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])", r"//\1//", s)
    s = re.sub(r"(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])", r"//\1//", s)
    return s.replace("\x01", "**")


def from_md(t):
    t = t.replace("\r", "")
    t = re.sub(r"\$\$(.+?)\$\$", lambda m: "\n[center] " + tex(m.group(1)) + "\n", t, flags=re.S)
    t = re.sub(r"(?<![\\$])\$(?=\S)([^$\n]*?\S)\$(?!\d)", lambda m: tex(m.group(1)), t)
    t = t.replace("//", "\\//").replace("{{", "\\{{")
    out, fence, tbl = [], False, False
    lines = t.split("\n")
    for i, ln in enumerate(lines):
        s = ln.rstrip()
        if s.strip().startswith("```"):
            fence = not fence; continue
        if fence:
            out.append(s); continue
        if re.fullmatch(r"\s*([-*_])(\s*\1){2,}\s*", s):
            out.append(""); tbl = False; continue
        if "|" in s and re.fullmatch(r"\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?", s):
            tbl = True; continue
        if not s.strip():
            tbl = False; out.append(""); continue
        h = re.match(r"^(#{1,6})\s+(.*)", s)
        if h:
            out.append(("# " if len(h.group(1)) == 1 else "## ") + md_inline(h.group(2))); continue
        s = re.sub(r"^\s*>\s?", "", s)
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if s.strip().startswith("|") or (tbl and "|" in s) or ("|" in s and re.fullmatch(r"\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?", nxt)):
            c = [md_inline(x.strip()) for x in s.strip().strip("|").split("|")]
            out.append("|" + "|".join(c) + "|"); continue
        s = re.sub(r"^(\s*)[-*+]\s+\[[ xX]\]\s+", r"\1- ", s)
        s = re.sub(r"^\s*[-*+]\s+", "- ", s)
        s = re.sub(r"^\s*(\d+)[.)]\s+", r"\1. ", s)
        out.append(md_inline(s))
    return tidy(ascii_math("\n".join(out)))


# ---- DOCX (no dependencies: zip + XML) ----
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"


def omml(e):
    if e is None:
        return ""
    t = e.tag.replace(M, "")
    ch = lambda n: next((c for c in e if c.tag == M + n), None)
    if t == "f":
        return "(" + omml(ch("num")) + ")/(" + omml(ch("den")) + ")"
    if t == "sSup":
        return omml(ch("e")) + "^{" + omml(ch("sup")) + "}"
    if t == "sSub":
        return omml(ch("e")) + "_{" + omml(ch("sub")) + "}"
    if t == "sSubSup":
        return omml(ch("e")) + "_{" + omml(ch("sub")) + "}^{" + omml(ch("sup")) + "}"
    if t == "rad":
        return "sqrt(" + omml(ch("e")) + ")"
    if t == "nary":
        pr = ch("naryPr"); c = pr.find(M + "chr") if pr is not None else None
        name = {"∑": "sum", "∫": "int", "∏": "prod"}.get(c.get(M + "val") if c is not None else "∫", "sum")
        lo, hi = omml(ch("sub")), omml(ch("sup"))
        return name + ("_{" + lo + "}" if lo else "") + ("^{" + hi + "}" if hi else "") + " " + omml(ch("e"))
    if t == "d":
        return "(" + ", ".join(omml(c) for c in e if c.tag == M + "e") + ")"
    if t == "t":
        return e.text or ""
    return "".join(omml(c) for c in e if not c.tag.endswith("Pr"))


def runs(el, acc):
    for c in el:
        if c.tag == W + "r":
            rp = c.find(W + "rPr")
            def on(n):
                x = rp.find(W + n) if rp is not None else None
                return x is not None and x.get(W + "val") not in ("0", "false", "none")
            va = rp.find(W + "vertAlign") if rp is not None else None
            va = va.get(W + "val") if va is not None else ""
            txt = "".join((x.text or "") if x.tag == W + "t" else " " if x.tag in (W + "tab", W + "br") else "" for x in c)
            if txt:
                acc.append([txt, on("b"), on("i"), on("u"), va])
        elif c.tag in (M + "oMath", M + "oMathPara"):
            acc.append([omml(c), 0, 0, 0, "math"])
        elif c.tag not in (W + "pPr",):
            runs(c, acc)


def para_text(p, heading=False):
    acc = []
    runs(p, acc)
    merged = []
    for a in acc:
        if merged and merged[-1][1:] == a[1:]:
            merged[-1][0] += a[0]
        else:
            merged.append(a)
    out = ""
    for txt, b, i, u, va in merged:
        if va == "math":
            out += txt; continue
        txt = esc(txt)
        if va == "superscript": txt = "^{" + txt + "}"
        elif va == "subscript": txt = "_{" + txt + "}"
        if txt.strip():
            if b and not heading: txt = "**" + txt + "**"
            if i: txt = "//" + txt + "//"
            if u: txt = "__" + txt + "__"
        out += txt
    return out.strip(), len(acc) == 1 and acc[0][4] == "math"


def docx_to_markup(data):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        if sum(i.file_size for i in z.infolist()) > 80_000_000:
            raise ValueError("This DOCX is too large to import.")
        root = ET.fromstring(z.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        raise ValueError("Couldn't read this DOCX. Re-save it from Word as .docx and try again.")
    fm = {}
    try:
        nr = ET.fromstring(z.read("word/numbering.xml"))
        ab = {}
        for a in nr.findall(W + "abstractNum"):
            f = a.find(f"{W}lvl/{W}numFmt")
            ab[a.get(W + "abstractNumId")] = f.get(W + "val") if f is not None else "bullet"
        for n in nr.findall(W + "num"):
            r = n.find(W + "abstractNumId")
            fm[n.get(W + "numId")] = ab.get(r.get(W + "val") if r is not None else "", "bullet")
    except (KeyError, ET.ParseError):
        pass
    out, counters = [], {}

    def para(p):
        ppr = p.find(W + "pPr")
        st = (ppr.find(W + "pStyle").get(W + "val") if ppr is not None and ppr.find(W + "pStyle") is not None else "").lower()
        head = "# " if st in ("title", "heading1") else "## " if re.match(r"(heading|subtitle)", st) else ""
        text, only_math = para_text(p, bool(head))
        if not text:
            return ""
        if head:
            return head + text
        num = ppr.find(f"{W}numPr/{W}numId") if ppr is not None else None
        if num is not None or st.startswith("list"):
            nid = num.get(W + "val") if num is not None else st
            if fm.get(nid, "bullet") != "bullet" or "number" in st:
                counters[nid] = counters.get(nid, 0) + 1
                return f"{counters[nid]}. {text}"
            return "- " + text
        jc = ppr.find(W + "jc") if ppr is not None else None
        j = jc.get(W + "val") if jc is not None else ""
        return ("[center] " if j == "center" or only_math else "[right] " if j == "right" else "") + text

    for el in root.find(W + "body"):
        if el.tag == W + "p":
            out.append(para(el))
        elif el.tag == W + "tbl":
            out.append("")
            for tr in el.iter(W + "tr"):
                cells = [" ".join(para_text(p)[0] for p in tc.iter(W + "p")).replace("|", "/").strip() for tc in tr.findall(W + "tc")]
                out.append("|" + "|".join(cells) + "|")
            out.append("")
    return tidy(ascii_math("\n".join(out)))


# ---- PDF (pdfplumber: font sizes -> headings, ruled tables -> table rows, line gaps -> paragraphs) ----
def pdf_to_markup(data, max_pages=120):
    import pdfplumber
    items, weights = [], Counter()
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            if len(pdf.pages) > max_pages:
                raise ValueError(f"This PDF has {len(pdf.pages)} pages. Import up to {max_pages} pages at a time.")
            for pn, pg in enumerate(pdf.pages):
                tabs = pg.find_tables()
                boxes = [t.bbox for t in tabs]
                words = [w for w in pg.extract_words(extra_attrs=["size"]) if not any(
                    b[0] - 2 <= w["x0"] and w["x1"] <= b[2] + 2 and b[1] - 2 <= w["top"] and w["bottom"] <= b[3] + 2 for b in boxes)]
                words.sort(key=lambda w: (round(w["top"]), w["x0"]))
                lines = []
                for w in words:
                    if lines and abs(w["top"] - lines[-1]["top"]) < 0.45 * w["size"]:
                        lines[-1]["w"].append(w)
                    else:
                        lines.append(dict(top=w["top"], w=[w]))
                for l in lines:
                    ws = sorted(l["w"], key=lambda w: w["x0"])
                    text = re.sub(r"\(cid:\d+\)", "•", " ".join(w["text"] for w in ws))
                    size = statistics.median(w["size"] for w in ws)
                    weights[round(size, 1)] += len(text)
                    items.append((pn, l["top"], "line", size, text))
                for t in tabs:
                    rows = [[(c or "").replace("\n", " ").replace("|", "/").strip() for c in r] for r in t.extract()]
                    items.append((pn, t.bbox[1], "table", 0, rows))
                pg.flush_cache()
    except ValueError:
        raise
    except Exception:
        raise ValueError("Couldn't read this PDF (it may be encrypted or damaged).")
    items.sort(key=lambda i: (i[0], i[1]))
    if not weights or sum(weights.values()) < 15:
        raise ValueError("This PDF has no selectable text — it looks scanned. Take photos of the pages and import those (OCR).")
    body = weights.most_common(1)[0][0]
    out, para, prev = [], [], None

    def flush():
        if para:
            out.append(join_para(para)); para.clear()
    for pn, top, kind, size, text in items:
        if kind == "table":
            flush(); out += ["", *("|" + "|".join(r) + "|" for r in text if any(r)), ""]; prev = None; continue
        head = size >= 1.25 * body and len(text) <= 100
        if head:
            flush()
            if prev and prev[3] and prev[2] == size and out and out[-1].startswith(("# ", "## ")):
                out[-1] += " " + text
            else:
                out += ["", ("# " if size >= 1.55 * body else "## ") + text, ""]
            prev = (pn, top, size, True); continue
        line = norm_line(text)
        new = prev is None or prev[3] or line.startswith(("- ", "1. ")) or re.match(r"\d+\. ", line) \
            or (prev[0] == pn and top - prev[1] > 1.7 * prev[2]) or (prev[0] != pn and para and re.search(r"[.!?:]$", para[-1]))
        if new:
            flush()
        para.append(line)
        prev = (pn, top, size, False)
    flush()
    return tidy(ascii_math("\n".join(esc_line(l) for l in out)))


def stats(t):
    L = t.split("\n")
    return dict(chars=len(t), headings=sum(l.startswith(("# ", "## ")) for l in L), lists=sum(bool(re.match(r"(- |\d+\. )", l)) for l in L),
                tables=sum(1 for i, l in enumerate(L) if l.startswith("|") and (i == 0 or not L[i - 1].startswith("|"))),
                math=len(re.findall(r"[\^_]\{|sqrt|\bsum\b|\bint\b", t)))


def convert_text(text, kind="txt"):
    return dict(text=from_text(text, kind), warnings=[])


def convert_file(name, data):
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    warns = []
    if ext in ("txt", "text"):
        try:
            t = data.decode("utf-8")
        except UnicodeDecodeError:
            t = data.decode("latin-1")
        return dict(text=from_text(t), warnings=warns)
    if ext in ("md", "markdown"):
        return dict(text=from_md(data.decode("utf-8", "replace")), warnings=warns)
    if ext == "docx":
        return dict(text=docx_to_markup(data), warnings=warns)
    if ext == "pdf":
        warns.append("PDF text is rebuilt from the page layout: check headings, lists and tables.")
        return dict(text=pdf_to_markup(data), warnings=warns)
    if ext == "doc":
        raise ValueError("Old .doc files aren't supported. In Word choose Save As → .docx.")
    raise ValueError("Unsupported file. Use TXT, Markdown, DOCX, PDF, or a photo (JPG/PNG).")
