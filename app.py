import os, io, base64
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import engine

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_REQUEST_MB", "40")) * 1024 * 1024
CORS(app, origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")])
MAX_FILE = int(os.getenv("MAX_FILE_MB", "12")) * 1024 * 1024
MAX_TEXT = 12000


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
    return jsonify(ok=True)


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
        return err("Upload at least one photo or scan of the calibration sheet.")
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


@app.post("/api/generate")
def generate():
    d = request.get_json(silent=True) or {}
    text, prof = d.get("text"), d.get("profile")
    if not isinstance(text, str) or not text.strip():
        return err("Type some text first.")
    if len(text) > MAX_TEXT:
        return err(f"Text is too long (max {MAX_TEXT} characters).")
    if not isinstance(prof, dict) or not isinstance(prof.get("glyphs"), dict) or len(prof["glyphs"]) < 20:
        return err("Invalid handwriting profile. Rebuild it from a sample.")
    try:
        float(prof["x_height"])
    except Exception:
        return err("Invalid handwriting profile.")
    s = d.get("settings") or {}
    clean = dict(
        variation=min(max(float(s.get("variation", .5)), 0), 1),
        mood=s.get("mood") if s.get("mood") in engine.MOODS else "normal",
        paper=s.get("paper") if s.get("paper") in ("classmate", "blank", "lined", "notebook", "graph", "exam") else "classmate",
        pen=s.get("pen") if s.get("pen") in engine.PENS else "ballpoint",
        seed=int(s["seed"]) if str(s.get("seed", "")).lstrip("-").isdigit() else None,
        signature=engine.load_signature(s.get("signature")),
        sig_pos=s.get("sig_pos") if s.get("sig_pos") in ("left", "center", "right") else "right")
    try:
        r = engine.generate(prof, text, clean)
    except (KeyError, ValueError, TypeError):
        return err("Invalid handwriting profile. Rebuild it from a sample.")
    b64 = lambda b: base64.b64encode(b).decode()
    return jsonify(pages=[b64(p) for p in r["pages"]], pdf=b64(r["pdf"]), seed=r["seed"],
                   missing=r["missing"], truncated=r["truncated"])


if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG") == "1")
