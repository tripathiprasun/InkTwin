# InkTwin

Teach it your handwriting. Upload a photo of a calibration sheet you filled in; InkTwin builds a personal handwriting profile (several variants of every character plus style measurements) and renders new pages that vary naturally on every generation.

Frontend: plain HTML/CSS/JS (GitHub Pages). Backend: Flask + OpenCV + Pillow (Render). No database, no accounts.

## Run locally
```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py                                          # http://localhost:5000
# new terminal
cd frontend && python -m http.server 8000              # http://localhost:8000
```
Open http://localhost:8000, download the sheet, print it, fill it in, photograph/scan it, upload. The frontend defaults to `http://localhost:5000`.

## Deploy
**Backend (Render):** New → Web Service → connect repo. Root directory `backend`; build `pip install -r requirements.txt`; start `gunicorn app:app --workers 1 --timeout 600`. Set env `ALLOWED_ORIGINS=https://YOUR_USER.github.io`. (Free instances sleep; first request may be slow. Keep workers at 1 for 512 MB RAM.)

**Frontend (GitHub Pages):** In `frontend/index.html`, add before `app.js`:
`<script>window.INKTWIN_API_BASE="https://YOUR-SERVICE.onrender.com"</script>`.
Push, then Settings → Pages → deploy from branch, folder `/frontend` (or copy the folder to `/docs`).

## API
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | – | `{ok:true}` |
| GET | `/api/template` | – | calibration sheet PNG |
| POST | `/api/profile` | multipart: `samples` (1–4 JPG/PNG/WEBP, ≤12 MB, ≤40 MP), `consent=true` | `{profile}` |
| POST | `/api/generate` | JSON `{profile, text (≤12000 chars), settings:{variation 0–1, mood neat/normal/rushed/messy, paper lined/notebook/blank/graph/exam, pen ballpoint/gel/pencil, seed?}}` | `{pages:[base64 PNG], pdf:base64, seed, missing, truncated}` |
Errors: `{error: "message"}` with 4xx/5xx. The profile is stateless: the browser keeps it (localStorage) and sends it with each generate call.

## Pipeline
1. **Template** (`make_template`): known grid; every box's character is known, so no recognition guesswork. Four black corner squares.
2. **Load** (`load_image`): validate type/size/dimensions, EXIF-rotate, grayscale, cap at 3200 px. In memory only.
3. **Perspective correction** (`find_corners`/`warp`): detect the four squares, homography to canonical 1500×2400.
4. **Background removal**: estimate paper brightness with a large morphological max-filter + blur, divide it out, then map to a soft ink-amount channel (keeps pressure and stroke edges; printed guide lines fall below threshold).
5. **Segmentation**: per box, connected components (drops specks), tight crop, kept as an alpha glyph with its distance above/below the baseline.
6. **Profile** (`build_profile`).
7. **Layout → variant selection → variation → ink → paper → PNG/PDF** (`generate`).

## The profile
JSON: `glyphs` (per character, up to 9 variants: base64 alpha PNG, size, `top` = height above baseline), and measured style: `x_height`, `ascender_ratio`, `descender_ratio`, `cap_ratio`, `slant` (from image moments of ascender letters), `stroke_width` (area/perimeter), `pressure_mean/var` (ink darkness), `size_variance` (spread of same-letter heights), `baseline_variance`, plus `char_spacing`/`word_spacing` defaults. Sizes are normalised by your x-height, so your proportions (tall ascenders, big caps, loops) carry over. Different users produce different glyph shapes and measured variances, hence different pages.

## Natural variation
Per generation a fresh RNG (random unless you set a seed). Amplitude = (0.25 + 1.5·Variation) × mood (neat 0.6, normal 1, rushed 1.5, messy 2.1). Per glyph: variant choice (never the same variant twice in a row for a letter, mostly), size, rotation, shear, baseline offset, ink pressure, advance. Per word: shared offset/tilt/pressure (so jitter is coherent, not glitchy). Per line: sinusoidal drift + slope and start jitter; rushed/messy text shrinks slightly toward the line end. Your measured size/baseline/pressure variance sets the floor so noise scales with *your* inconsistency.

Ink/paper: pen changes colour, opacity, edge softness, bleed (gel), grain (pencil) and faint skips (ballpoint); paper has fibre noise, low-frequency mottling, vignette and a light scan blur/noise.

## Extending with ML
`generate()` only needs "give me ink strokes/pixels for a word at a position". Replace `make_word`/`stamp` with a stroke-sequence model conditioned on the profile's glyphs as style exemplars; the paper/ink stages stay unchanged.

## Privacy and limits
Only upload handwriting you have permission to use. Samples are processed in memory and never written to disk; the server keeps no profiles. No signature generation and no identity documents — the calibration covers letters, digits and basic punctuation, and the exam sheet leaves name/date blank. MVP limits: glyphs are isolated (no cursive joins), sheet must be the InkTwin template, no pen-lift simulation, no in-app glyph correction, and the sentence line of the brief isn't on the template.

## Free-paper calibration (default)
`POST /api/profile` with `mode=free` (multipart, same fields). `GET /api/prompt` returns the 8 lines the user copies onto any paper. Pipeline (`extract_free`): normalise lighting and ink -> erase printed ruled lines -> deskew -> find the writing lines (merging fragments until the count equals the prompt's) -> connected components, merging dots/bars with their letter -> since we know each line's word count, split clusters at the widest gaps -> accept a word only if cluster count equals letter count (labels come from the known text, no OCR) -> per-word baseline from non-descender letters -> rescale so x-height = 30 px. Response adds `report:{matched,total}` words. Unmatched words are skipped, so print-style letters work best; users can delete wrongly read glyphs in the UI and add more photos.

## Classmate-style pages
Paper `classmate`: cool-white page, blue rules, double red margin. Every page also gets photographed-page realism: uneven lighting, spine shadow, faint back-side show-through (classmate), gentle page curl that bends rules and text together, scan noise.

## Paper, signature, scan (latest)
- Papers: A4 plain white, Classmate notebook (46 px rule pitch, double red margin + header rule), Spiral notebook, Lined A4, Graph, Exam. All A4 at 150 dpi (1240x1754). Every page gets photographed-page realism.
- Signature: drawn by the user in a pad (consent checkbox), sent as a transparent PNG with the generate request (`settings.signature`, `settings.sig_pos` left/center/right), stamped as-is at the top of page 1 with the chosen pen. It is never generated from the handwriting profile and never stored.
- Scanned copy: client-side (canvas). Shadow removal (paper-brightness map), white-balance, levels; modes Magic color / Grayscale / Black & white; download as JPG or a PDF built in the browser.
- Calibration: the printable sheet is the default tab; "Any paper" is the alternative.

## Limits, formatting, letter editing (latest)
- Limits (env, see `.env.example`): `MAX_TEXT` default 60,000 characters, `MAX_PAGES` default 30. Use start command `gunicorn app:app --workers 1 --timeout 600`.
- `POST /api/generate` now streams NDJSON: one line per page `{n, img (base64 JPEG or null), glyphs}` then `{done, seed, missing, truncated}`. Pages appear as they finish; PDF/PNG/scan are built in the browser, so there is no page cap beyond `MAX_PAGES`.
- `glyphs` is `[[id, x, y, w, h], ...]` in page pixels (1240x1754). Send back `settings.seed` (from `done`), `settings.adjust` = `{id: [dx, dy, rotDeg, scale]}` and `settings.only` = `[pageIndex]` to re-render just those pages with letters moved; the layout is deterministic for a given seed.
- Calibration sheet covers all 94 printable keyboard characters (5 groups x 19 rows, A4 ratio). Old 4-column sheets are not compatible.
- Text markup: `# Heading`, `## Subheading`, `**bold**`, `//italic//`, `__underline__`, `{{r|red}}` (r b g k), `- bullet`, `[center] `, `[right] `, tables as `|a|b|` lines. Escape with a backslash.
