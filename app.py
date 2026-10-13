import os, io, re, json, base64, itertools, queue, threading
from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS
import engine, importer

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_REQUEST_MB", "40")) * 1024 * 1024
CORS(app, origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")])
MAX_FILE = int(os.getenv("MAX_FILE_MB", "12")) * 1024 * 1024
MAX_TEXT = int(os.getenv("MAX_TEXT", "60000"))
GEN = threading.Semaphore(1)  # one document at a time keeps memory bounded on small instances


def err(msg, code=400):
    return jsonify(error=msg), code


@app.errorhandler(413)
def too_big(_):
    return err("Upload is too large.", 413)


@app.errorhandler(Exception)
def boom(e):
    if hasattr(e, "code") and isinstance(e.code, int):
        return err(getattr(e, "description", "Request failed"), e.code)
    app.logger.exception("unhandled")
    return err("Something went wrong on the server.", 500)


@app.get("/api/health")
def health():
    return jsonify(ok=True, max_text=MAX_TEXT, max_pages=engine.MAX_PAGES)


@app.post("/api/import")
def import_doc():
    """TXT / Markdown / DOCX / PDF upload, or JSON {text, kind:"ocr"} from in-browser OCR -> InkTwin markup."""
    try:
        if request.is_json:
            d = request.get_json(silent=True) or {}
            t = d.get("text")
            if not isinstance(t, str) or not t.strip():
                return err("No text was found in that image. Try a sharper, straighter photo.")
            res = importer.convert_text(t[:400_000], "ocr" if d.get("kind") == "ocr" else "txt")
        else:
            f = request.files.get("file")
            if not f:
                return err("Choose a file to import.")
            data = f.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                return err(f"File is over {MAX_FILE // 2**20} MB.", 413)
            res = importer.convert_file(f.filename or "", data)
    except ValueError as e:
        return err(str(e))
    if not res["text"].strip():
        return err("No text could be extracted from that file.")
    if len(res["text"]) > MAX_TEXT:
        cut = res["text"][:MAX_TEXT]
        res["text"] = cut[:cut.rfind("\n")] if "\n" in cut else cut
        res["warnings"].append(f"Text was cut at {MAX_TEXT:,} characters.")
    res["stats"] = importer.stats(res["text"])
    return jsonify(res)


@app.get("/api/prompt")
def prompt():
    return jsonify(lines=engine.PROMPT)


@app.get("/api/template")
def template():
    return send_file(io.BytesIO(engine.make_template()), mimetype="image/png",
                     as_attachment=True, download_name="inktwin-calibration-sheet.png")


@app.post("/api/profile")
def profile():
    if request.form.get("consent") != "true":
        return err("Confirm you have permission to use this handwriting.")
    files = request.files.getlist("samples")[:4]
    if not files:
        return err("Upload at least one photo or scan.")
    samples, rep = [], [0, 0]
    free = request.form.get("mode") == "free"
    for f in files:  # processed in memory only; nothing is written to disk
        data = f.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            return err(f"{f.filename}: file is over {MAX_FILE // 2**20} MB.", 413)
        try:
            if free:
                g, (m, t) = engine.extract_free(data)
                samples.append(g); rep[0] += m; rep[1] += t
            else:
                samples.append(engine.extract_sample(data))
        except ValueError as e:
            return err(f"{f.filename}: {e}")
    try:
        return jsonify(profile=engine.build_profile(samples, 26 if free else 40), report=dict(matched=rep[0], total=rep[1]))
    except ValueError as e:
        return err(str(e))


def clean_adjust(raw):
    out = {}
    if isinstance(raw, dict):
        for k, v in list(raw.items())[:8000]:
            try:
                dx, dy, dr, ds = (float(x) for x in v[:4])
                av = int(v[4]) if len(v) > 4 and isinstance(v[4], (int, float)) else -1
                ac = v[5] if len(v) > 5 and isinstance(v[5], str) and len(v[5]) == 1 and v[5] in engine.CHARSET else ""
            except Exception:
                continue
            if str(k).isdigit():
                out[str(k)] = (max(-400, min(400, dx)), max(-400, min(400, dy)), max(-180, min(180, dr)),
                               max(.3, min(3., ds)), max(-1, min(99, av)), ac)
    return out


@app.post("/api/generate")
def generate():
    """Streams NDJSON: one line per page {n, img (base64 JPEG|null), glyphs}, then {done, seed, missing, truncated}."""
    d = request.get_json(silent=True) or {}
    text, prof = d.get("text"), d.get("profile")
    if not isinstance(text, str) or not text.strip():
        return err("Type some text first.")
    if len(text) > MAX_TEXT:
        return err(f"Text is too long (max {MAX_TEXT:,} characters).")
    if not isinstance(prof, dict) or not isinstance(prof.get("glyphs"), dict) or len(prof["glyphs"]) < 20:
        return err("Invalid handwriting profile. Rebuild it from a sample.")
    s = d.get("settings") or {}
    only, ic = s.get("only"), s.get("ink_color")

    def num(k, lo, hi, dflt):
        try:
            return min(max(float(s.get(k, dflt)), lo), hi)
        except (TypeError, ValueError):
            return dflt
    clean = dict(
        variation=min(max(float(s.get("variation", .5)), 0), 1),
        mood=s.get("mood") if s.get("mood") in engine.MOODS else "normal",
        paper=s.get("paper") if s.get("paper") in ("classmate", "blank", "lined", "notebook", "graph", "exam") else "classmate",
        pen=s.get("pen") if s.get("pen") in engine.PENS else "ballpoint",
        seed=int(s["seed"]) if str(s.get("seed", "")).lstrip("-").isdigit() else None,
        signature=engine.load_signature(s.get("signature")),
        sig_pos=s.get("sig_pos") if s.get("sig_pos") in ("left", "center", "right") else "right",
        adjust=clean_adjust(s.get("adjust")),
        size=num("size", .6, 1.6, 1), spacing=num("spacing", 0, 2, 1), wordgap=num("wordgap", .5, 2, 1), slant=num("slant", -20, 20, 0),
        drift=num("drift", 0, 3, 1), neat=num("neat", 0, 1, .5), rand=num("rand", 0, 1, .5), ink=num("ink", .4, 1.6, 1),
        thick=num("thick", .6, 1.8, 1), texture=num("texture", 0, 2, 1), light=num("light", 0, 2, 1),
        ink_color=tuple(int(ic[i:i + 2], 16) for i in (1, 3, 5)) if isinstance(ic, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", ic) else None,
        preview=min(max(s["preview"], 1), 5) if isinstance(s.get("preview"), int) else None,
        only={i for i in only if isinstance(i, int)} if isinstance(only, list) else None,
        **{"from": s["from"] if isinstance(s.get("from"), int) and s["from"] >= 0 else None})
    if not GEN.acquire(timeout=30):
        return err("The server is busy finishing another document. Try again in a moment.", 503)
    try:
        it = engine.generate(prof, text, clean)
        first = next(it)  # surfaces an invalid profile before streaming starts
    except (KeyError, ValueError, TypeError, StopIteration):
        GEN.release()
        return err("Invalid handwriting profile. Rebuild it from a sample.")
    except BaseException:
        GEN.release()
        raise

    def line(item):
        if item[0] == "seed":
            return dict(seed=item[1])
        if item[0] == "page":
            _, n, data, man = item
            return dict(n=n, img=base64.b64encode(data).decode() if data else None, glyphs=man)
        return dict(done=True, **item[1])

    def stream():
        q, stop = queue.Queue(maxsize=2), threading.Event()

        def put(x):
            while not stop.is_set():
                try:
                    q.put(x, timeout=1); return
                except queue.Full:
                    pass

        def work():  # renders in a thread so the response can send keep-alive newlines meanwhile
            try:
                for item in itertools.chain([first], it):
                    put(item)
                    if stop.is_set():
                        return
                put(None)
            except Exception:
                app.logger.exception("generate failed"); put("error")
            finally:
                GEN.release()

        threading.Thread(target=work, daemon=True).start()
        try:
            while True:
                try:
                    item = q.get(timeout=10)
                except queue.Empty:
                    yield "\n"; continue
                if item is None:
                    break
                if item == "error":
                    yield json.dumps(dict(error="Generation failed on the server.")) + "\n"; break
                yield json.dumps(line(item)) + "\n"
        finally:
            stop.set()

    return Response(stream_with_context(stream()), mimetype="application/x-ndjson",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG") == "1")
