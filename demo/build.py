"""Build the Last Button demo composition (runs on Kaggle).

1. Cuts and speeds up recording segments with ffmpeg (from marks.json).
2. Writes composition/index.html for Hyperframes: recordings in a rounded frame,
   captions in a strip underneath, chapter cards and slides, one paused GSAP timeline.

    python build.py <takes_dir> <out_dir>
Asserts the plan is exactly TARGET seconds and that nothing overlaps.
"""
import html, json, os, shutil, subprocess, sys
from pathlib import Path

TAKES = Path(sys.argv[1] if len(sys.argv) > 1 else "takes")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "composition")
ASSETS = OUT / "assets"
TARGET = 175.0
FPS = 30
MARKS = json.loads((TAKES / "marks.json").read_text())


def m(take, label):
    for x in MARKS[take]:
        if x["label"] == label:
            return x["t"]
    raise KeyError(f"{take}: {label}")


# ---------------------------------------------------------------- timeline
SECTIONS = [
    ("hook", 0, 4), ("title", 4, 4), ("glance", 8, 12),
    ("card1", 20, 1.5), ("ch1", 21.5, 20),
    ("card2", 41.5, 1.5), ("ch2", 43, 27),
    ("slideAI", 70, 9),
    ("card3", 79, 1.5), ("ch3", 80.5, 18),
    ("slidePP", 98.5, 9),
    ("card4", 107.5, 1.5), ("ch4", 109, 32.5),
    ("card5", 141.5, 1.5), ("ch5", 143, 17),
    ("results", 160, 9.5), ("outro", 169.5, 5.5),
]
SEC = {k: (s, d) for k, s, d in SECTIONS}
t = 0.0
for k, s, d in SECTIONS:
    assert abs(s - t) < 1e-6, f"gap/overlap before {k}: expected {t}, got {s}"
    t = s + d
assert abs(t - TARGET) < 1e-6, f"plan is {t}s, target {TARGET}s"

# Segments: (id, chapter, file, src_start, src_end, out_duration, layout, badge)
# speed = (src_end - src_start) / out_duration
POPUP = "ch4bot/ch4bot.webm"   # PayPal checkout popup (content is the top-left 568x752)
BOTMAIN = "ch4bot/ch4bot-extra1.webm"
ch4_verify_from = m("ch4", "clicked verify") + 0.8
ch4_all = m("ch4", "all verified")
SEGMENTS = [
    ("c1a", "ch1", "ch1/ch1.webm", 4.0, 23.5, 15.0, "full", None),
    ("c1b", "ch1", "ch1/ch1.webm", 24.5, 29.5, 5.0, "full", None),
    ("c2", "ch2", "ch2/ch2.webm", 1.3, 31.0, 27.0, "full", None),
    ("c3", "ch3", "ch3/ch3.webm", 1.5, 19.5, 18.0, "full", None),
    ("c4a", "ch4", "ch4/ch4.webm", 1.5, ch4_verify_from, None, "full", None),
    ("c4b", "ch4", BOTMAIN, 1.0, 2.9, 1.9, "full", "Buyer bot's view"),
    ("c4c", "ch4", POPUP, 8.0, 13.8, 5.8, "popup", "PayPal sandbox checkout"),
    ("c4d", "ch4", BOTMAIN, 20.5, 22.6, 2.1, "full", "Buyer bot's view"),
    ("c4e", "ch4", "ch4/ch4.webm", ch4_verify_from, ch4_all, 9.7, "full", "speed"),
    ("c4f", "ch4", "ch4/ch4.webm", ch4_all, m("ch4", "end"), None, "full", None),
    ("c5", "ch5", "ch5/ch5.webm", 1.2, 20.3, 17.0, "full", None),
]
# Fill the open durations so each chapter fits exactly.
seg = [list(x) for x in SEGMENTS]
for ch in ["ch4"]:
    fixed = sum(x[5] for x in seg if x[1] == ch and x[5] is not None)
    open_ = [x for x in seg if x[1] == ch and x[5] is None]
    room = SEC[ch][1] - fixed
    natural = [x[4] - x[3] for x in open_]
    # c4a plays at 1x; c4f takes whatever is left.
    open_[0][5] = round(natural[0], 3)
    open_[1][5] = round(room - natural[0], 3)
for ch in ["ch1", "ch2", "ch3", "ch4", "ch5"]:
    total = sum(x[5] for x in seg if x[1] == ch)
    assert abs(total - SEC[ch][1]) < 0.01, f"{ch} segments sum to {total}, section is {SEC[ch][1]}"
for x in seg:
    sp = (x[4] - x[3]) / x[5]
    assert 0.95 <= sp <= 120, f"{x[0]} speed {sp}"

# Absolute placement of each segment, and a source-time -> film-time mapper.
PLACED = []
for ch in ["ch1", "ch2", "ch3", "ch4", "ch5"]:
    at = SEC[ch][0]
    for x in [s for s in seg if s[1] == ch]:
        PLACED.append({"id": x[0], "ch": ch, "file": x[2], "src0": x[3], "src1": x[4], "start": round(at, 3), "dur": x[5],
                       "speed": (x[4] - x[3]) / x[5], "layout": x[6], "badge": x[7]})
        at += x[5]


def at(seg_id, src_t):
    p = next(p for p in PLACED if p["id"] == seg_id)
    assert p["src0"] - 0.01 <= src_t <= p["src1"] + 0.01, f"{seg_id}: {src_t} outside {p['src0']}..{p['src1']}"
    return round(p["start"] + (src_t - p["src0"]) / p["speed"], 2)


def seg_start(seg_id):
    return next(p for p in PLACED if p["id"] == seg_id)["start"]


CAPTIONS = [
    (21.5, "A community theatre site from 2010."),
    (at("c1a", m("ch1", "shop page")), "Nine PayPal buttons, pasted in years ago."),
    (at("c1a", m("ch1", "support page: saved + encrypted")), "Two are saved or encrypted: the price isn't in the code."),
    (seg_start("c1b"), "The owner just pastes the address."),
    (43.0, "Nine buttons found. Seven may stop working."),
    (at("c2", m("ch2", "t-shirt spec from HTML")), "Readable buttons are copied field by field."),
    (at("c2", m("ch2", "season pass AI badge")), "Gemini reads the page where settings are hidden."),
    (at("c2", m("ch2", "AI quote visible")), "Its answer must quote the page, word for word."),
    (at("c2", m("ch2", "donate + subscribe left alone")), "Donate and Subscribe aren't affected: left alone."),
    (at("c2", m("ch2", "confirmed Season Pass")) - 1.0, "Prices the AI read wait for the owner's click."),
    (80.5, "One click: a PayPal Payment Link per product."),
    (at("c3", m("ch3", "links created")), "Seven links, created in the PayPal sandbox."),
    (at("c3", m("ch3", "paypal link page")), "Same sizes and prices, on PayPal's own page."),
    (at("c3", m("ch3", "totals: 21 + 4.50")), "XL: $21, plus $4.50 postage."),
    (109.0, "Verify all seven links."),
    (seg_start("c4b"), "A test buyer pays through each link in the PayPal sandbox."),
    (seg_start("c4e"), "Then the order is read back from PayPal."),
    (seg_start("c4e") + 4.8, "Green only when paid = price + postage + tax."),
    (seg_start("c4f"), "7 of 7 verified, each with a signed webhook."),
    (at("c4f", m("ch4", "verification table")), "Bundle: $12 + $3 postage + $0.99 tax = $15.99."),
    (143.0, "Swap them in: download the patched page…"),
    (at("c5", m("ch5", "script line")), "…or paste one line into your template."),
    (at("c5", m("ch5", "json-ld shown")), "Product markup lets AI shopping agents buy too."),
    (at("c5", m("ch5", "shop after swap")), "The theatre's buttons, now PayPal Payment Links."),
]
CAPTIONS.sort()
# Each caption runs until the next one or the end of its chapter.
CH_ENDS = {ch: SEC[ch][0] + SEC[ch][1] for ch in ["ch1", "ch2", "ch3", "ch4", "ch5"]}
CAP = []
for i, (s, text) in enumerate(CAPTIONS):
    ch_end = min(e for e in CH_ENDS.values() if e > s)
    nxt = CAPTIONS[i + 1][0] if i + 1 < len(CAPTIONS) else TARGET
    end = min(nxt, ch_end)
    assert end - s >= 2.0, f"caption too short ({end - s:.1f}s): {text}"
    CAP.append((round(s, 2), round(end - s, 2), text))


# ---------------------------------------------------------------- media
def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def cut_segments():
    ASSETS.mkdir(parents=True, exist_ok=True)
    for p in PLACED:
        src = TAKES / p["file"]
        vf = [f"setpts=(PTS-STARTPTS)/{p['speed']:.5f}"]
        if p["layout"] == "popup":
            vf.insert(0, "crop=568:752:0:0")
        vf.append(f"fps={FPS}")
        ffmpeg("-ss", f"{p['src0']:.3f}", "-to", f"{p['src1']:.3f}", "-i", str(src), "-vf", ",".join(vf),
               "-t", f"{p['dur']:.3f}", "-c:v", "libx264", "-crf", "20", "-g", "30", "-pix_fmt", "yuv420p", "-an",
               "-movflags", "+faststart", str(ASSETS / f"{p['id']}.mp4"))
    # Hook background: the theatre's ticket page.
    ffmpeg("-ss", "5.0", "-i", str(TAKES / "ch1/ch1.webm"), "-frames:v", "1", str(ASSETS / "hook.png"))


# ---------------------------------------------------------------- html
E = html.escape


def cards(items, cls="card"):
    out = []
    for label, body, *extra in items:
        tone = extra[0] if extra else ""
        out.append(f'<div class="{cls} {tone}"><div class="lbl">{E(label)}</div><div class="body">{body}</div></div>')
    return "".join(out)


def section(sid, inner, cls="slide"):
    s, d = SEC[sid]
    return f'<section id="{sid}" class="clip {cls}" data-start="{s}" data-duration="{d}" data-track-index="2">{inner}</section>'


def chapter_card(sid, n, title):
    return section(sid, f'<div class="cc"><div class="lbl">Chapter {n:02d}</div><h2>{E(title)}</h2></div>', "slide cardslide")


def build_html():
    parts = []
    parts.append(section("hook", f'''<img class="hookbg" src="assets/hook.png" alt="">
<div class="hookveil"></div>
<div class="hookq"><div class="lbl">PayPal developer docs · WPS deprecation</div>
<blockquote>“PayPal may retire WPS anytime after January&nbsp;1,&nbsp;2027.”</blockquote>
<div class="sub">That's the old copy-and-paste Buy Now and Add to Cart buttons.</div></div>''', "slide hook"))
    parts.append(section("title", '''<div class="center"><div class="mark"></div><h1>Last Button</h1>
<p class="tag">Rescue your old PayPal buttons before they stop working.</p>
<div class="lbl">PayPal AI Hackathon · 2026</div></div>'''))
    parts.append(section("glance", f'''<div class="slidein"><div class="lbl">At a glance</div><h2>Paste an address. Get verified PayPal Payment Links.</h2>
<div class="grid g4 flow">{cards([
        ("01 · Find", "Crawls up to 30 pages, respects robots.txt, runs JavaScript where buttons are built by script. <em>Donate and Subscribe are left alone.</em>"),
        ("02 · Rebuild", "A field mapper copies readable settings. <b>Gemini</b> fills only hidden ones, and must quote the page."),
        ("03 · Create", "<b>PayPal Payment Links API</b>: priced options, flat postage + extra-item, percentage tax, quantity."),
        ("04 · Prove", "A Playwright buyer pays in the sandbox. <b>Orders v2</b> and a signed <b>webhook</b> confirm the amount."),
    ])}</div><div class="foot">TypeScript · Express · Playwright · AG Grid · Render</div></div>'''))
    for sid, n, title in [("card1", 1, "A site from 2010"), ("card2", 2, "Find and rebuild"), ("card3", 3, "Create the links"),
                          ("card4", 4, "Prove it"), ("card5", 5, "Swap them in")]:
        parts.append(chapter_card(sid, n, title))
    parts.append(section("slideAI", f'''<div class="slidein"><div class="lbl">Design decision</div><h2>Keeping the AI honest</h2>
<div class="grid g4">{cards([
        ("Mapper first", "Readable HTML fields never go near the model. Copied exactly, with provenance."),
        ("Gaps only", "Saved and encrypted buttons, messy option menus, currency doubts."),
        ("Quote check", "Every AI value needs a verbatim quote from the page. A money quote must contain the number, or the value is dropped."),
        ("Owner click", "Any price the AI read waits for one click. Confidence under 0.8 goes to the owner too."),
    ])}</div><div class="foot mono">Gemini 3.5 Flash · structured JSON + response schema · zod validation · 1 retry · fallback model on 429/503</div></div>'''))
    parts.append(section("slidePP", f'''<div class="slidein"><div class="lbl">Integrations</div><h2>PayPal under the hood</h2>
<div class="grid g3">{cards([
        ("Payment Links API", "<code>POST /v1/checkout/payment-resources</code><br>one link per product, sandbox"),
        ("Field mapping", "<code>option_amount*</code> → priced variant<br><code>shipping2</code> → <code>additional_unit_value</code><br><code>tax_rate</code> → <code>PERCENTAGE</code>"),
        ("Orders v2", "<code>GET /v2/checkout/orders/{id}</code><br>status · link id · option · amount"),
        ("Webhook", "<code>CHECKOUT.PAYMENT-RESOURCE.PAYMENT-COMPLETED</code><br>signature verified with PayPal"),
        ("Day-1 spike findings", "No product price when options carry prices · return URL must be https"),
        ("Tax, to the cent", "PayPal taxes items, not postage, and rounds half-up. We do the same."),
    ])}</div></div>'''))
    parts.append(section("results", f'''<div class="slidein"><div class="lbl">Measured</div><h2>Results</h2>
<div class="grid g3">{cards([
        ("Eval · detection", "<span class='big'>1.00 / 1.00</span>precision / recall · 21 buttons on 4 fixture sites · 4/4 Donate &amp; Subscribe left alone"),
        ("Eval · rebuild", "<span class='big'>119 / 119</span>fields correct · 6/6 hidden prices recovered · 0 wrong values left unflagged"),
        ("Live on Render", "<span class='big'>7 / 7</span>sandbox payments matched to the cent · 7/7 signed webhooks"),
        ("Sent to the owner", "<span class='big'>41%</span>of rebuilt buttons wait for a click. By design: every AI-read price."),
        ("Weak spots", "We wrote the fixtures ourselves, and the set is small. Verification took 25–110 s per link. One sandbox error needed a retry. Only USD paid end to end.", "warn"),
    ])}</div></div>'''))
    parts.append(section("outro", '''<div class="center"><div class="mark"></div><h1 class="sm">Last Button</h1>
<div class="links mono">last-button.onrender.com<br>github.com/shivansh193/last-button</div>
<div class="foot">Built with PayPal Payment Links, Orders v2 &amp; webhooks · Gemini · Playwright · AG Grid · Render · MIT</div></div>'''))

    # Chapter frames, recordings, badges
    for ch in ["ch1", "ch2", "ch3", "ch4", "ch5"]:
        s, d = SEC[ch]
        parts.append(f'<div id="frame-{ch}" class="clip frame" data-start="{s}" data-duration="{d}" data-track-index="0"></div>')
    for p in PLACED:
        cls = "rec popup" if p["layout"] == "popup" else "rec"
        parts.append(f'<video id="v-{p["id"]}" class="clip {cls}" src="assets/{p["id"]}.mp4" data-start="{p["start"]}" '
                     f'data-duration="{p["dur"]}" data-media-start="0" data-track-index="1" muted playsinline></video>')
        badge = None
        if p["badge"] == "speed":
            mins = round((p["src1"] - p["src0"]) / 60)
            badge = f"{mins} min shown {round(p['speed'])}× faster"
        elif p["badge"]:
            badge = p["badge"]
        elif p["speed"] > 1.05:
            badge = f"{p['speed']:.1f}× speed"
        if badge:
            parts.append(f'<div id="b-{p["id"]}" class="clip badge" data-start="{p["start"]}" data-duration="{p["dur"]}" data-track-index="3">{E(badge)}</div>')
    for i, (s, d, text) in enumerate(CAP):
        parts.append(f'<div id="cap{i}" class="clip cap" data-start="{s}" data-duration="{d}" data-track-index="4">{E(text)}</div>')

    # GSAP: fades for every timed element, staggered cards on slides.
    js = ["const tl = gsap.timeline({ paused: true });"]
    for k, s, d in SECTIONS:
        if k.startswith("ch"):
            continue
        js.append(f'tl.fromTo("#{k}", {{opacity: 0}}, {{opacity: 1, duration: 0.3, ease: "power2.out"}}, {s});')
        js.append(f'tl.to("#{k}", {{opacity: 0, duration: 0.25, ease: "power1.in"}}, {s + d - 0.25});')
        js.append(f'tl.fromTo("#{k} .card, #{k} .cc > *, #{k} .center > *, #{k} .hookq > *", {{opacity: 0, y: 18}}, '
                  f'{{opacity: 1, y: 0, duration: 0.45, stagger: 0.12, ease: "power2.out"}}, {s + 0.15});')
        # A slow drift so long slides never sit perfectly still.
        js.append(f'tl.fromTo("#{k} > *", {{scale: 1}}, {{scale: 1.025, duration: {d}, ease: "none"}}, {s});')
    for ch in ["ch1", "ch2", "ch3", "ch4", "ch5"]:
        s, d = SEC[ch]
        js.append(f'tl.fromTo("#frame-{ch}", {{opacity: 0, scale: 0.985}}, {{opacity: 1, scale: 1, duration: 0.35, ease: "power2.out"}}, {s});')
    for p in PLACED:
        js.append(f'tl.fromTo("#v-{p["id"]}", {{opacity: 0}}, {{opacity: 1, duration: 0.2}}, {p["start"]});')
    for i, (s, d, _) in enumerate(CAP):
        js.append(f'tl.fromTo("#cap{i}", {{opacity: 0, y: 8}}, {{opacity: 1, y: 0, duration: 0.25, ease: "power2.out"}}, {s});')
        js.append(f'tl.to("#cap{i}", {{opacity: 0, duration: 0.2}}, {s + d - 0.2});')
    js.append('window.__timelines = window.__timelines || {};\nwindow.__timelines["main"] = tl;\ntl.seek(0);')

    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1920, height=1080">
<script src="assets/gsap.min.js"></script>
<style>
@font-face {{ font-family: Geist; src: url(assets/Geist-Regular.woff2) format("woff2"); font-weight: 400; }}
@font-face {{ font-family: Geist; src: url(assets/Geist-Medium.woff2) format("woff2"); font-weight: 500; }}
@font-face {{ font-family: Geist; src: url(assets/Geist-SemiBold.woff2) format("woff2"); font-weight: 600; }}
@font-face {{ font-family: "Geist Mono"; src: url(assets/GeistMono-Regular.woff2) format("woff2"); }}
:root {{ --bg: #f4f1ea; --card: #fffdf8; --ink: #1c1a17; --ink2: #514c43; --ink3: #8a8377; --line: #e2dbcd; --accent: #1d5c4a; --warn: #9a5b00; --warnbg: #fbf0dc; }}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); }}
#root {{ position: relative; width: 1920px; height: 1080px; background: var(--bg); font-family: Geist, sans-serif; color: var(--ink); }}
.clip {{ position: absolute; }}
.slide {{ inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; opacity: 0; }}
.lbl {{ font-family: "Geist Mono", monospace; font-size: 22px; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }}
.mono, code {{ font-family: "Geist Mono", monospace; }}
code {{ font-size: .86em; color: var(--ink); background: #efe9dc; padding: 1px 6px; border-radius: 5px; }}
h1 {{ font-size: 150px; font-weight: 600; letter-spacing: -.045em; line-height: 1; margin: 22px 0 18px; }}
h1.sm {{ font-size: 110px; }}
h2 {{ font-size: 60px; font-weight: 600; letter-spacing: -.03em; line-height: 1.1; margin: 14px 0 44px; max-width: 1500px; }}
.center {{ text-align: center; display: flex; flex-direction: column; align-items: center; }}
.mark {{ width: 86px; height: 86px; border-radius: 50%; background: var(--ink); position: relative; }}
.mark::after {{ content: ""; position: absolute; inset: 24px; border-radius: 50%; background: #ffc439; }}
.tag {{ font-size: 40px; color: var(--ink2); margin-bottom: 30px; }}
.slidein {{ width: 1620px; }}
.grid {{ display: grid; gap: 22px; }}
.g4 {{ grid-template-columns: repeat(4, 1fr); }}
.g3 {{ grid-template-columns: repeat(3, 1fr); }}
.card {{ background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 30px 30px 32px; box-shadow: 0 2px 0 var(--line); }}
.card .lbl {{ font-size: 19px; margin-bottom: 14px; }}
.card .body {{ font-size: 28px; line-height: 1.38; color: var(--ink2); }}
.card .body b {{ color: var(--ink); font-weight: 600; }}
.card .body em {{ font-style: normal; color: var(--ink); }}
.card .big {{ display: block; font-size: 64px; font-weight: 600; color: var(--ink); letter-spacing: -.03em; margin-bottom: 6px; }}
.card.warn {{ background: var(--warnbg); border-color: #ecd3a6; grid-column: span 2; }}
.card.warn .lbl {{ color: var(--warn); }}
.foot {{ margin-top: 34px; font-size: 24px; color: var(--ink3); }}
.links {{ font-size: 34px; line-height: 1.6; color: var(--ink); margin: 6px 0 26px; }}
.cardslide .cc {{ text-align: center; }}
.cardslide h2 {{ font-size: 96px; margin: 18px 0 0; }}
.hook img.hookbg {{ position: absolute; inset: 0; width: 1920px; height: 1200px; object-fit: cover; object-position: top; }}
.hookveil {{ position: absolute; inset: 0; background: rgba(28, 26, 23, .74); }}
.hookq {{ position: relative; color: #fff; max-width: 1500px; text-align: center; }}
.hookq .lbl {{ color: #ffc439; }}
.hookq blockquote {{ font-size: 84px; font-weight: 600; letter-spacing: -.03em; line-height: 1.12; margin: 26px 0 26px; }}
.hookq .sub {{ font-size: 34px; color: #e9e2d4; }}
.frame {{ left: 184px; top: 20px; width: 1552px; height: 976px; border-radius: 22px; background: var(--card); border: 1px solid var(--line);
  box-shadow: 0 30px 60px rgba(40, 32, 20, .16), 0 6px 14px rgba(40, 32, 20, .08); transform-origin: 50% 40%; }}
video.rec {{ left: 192px; top: 28px; width: 1536px; height: 960px; border-radius: 16px; object-fit: cover; background: #fff; }}
video.popup {{ left: 597px; top: 28px; width: 726px; height: 960px; object-fit: contain; border-radius: 0; box-shadow: 0 0 0 1px var(--line), 0 18px 40px rgba(0,0,0,.18); }}
.badge {{ right: 214px; top: 46px; background: rgba(28, 26, 23, .86); color: #fff; font-family: "Geist Mono", monospace; font-size: 22px;
  padding: 8px 16px; border-radius: 999px; z-index: 5; }}
.cap {{ left: 0; width: 1920px; top: 1006px; height: 62px; display: flex; align-items: center; justify-content: center;
  font-size: 34px; font-weight: 500; letter-spacing: -.01em; color: var(--ink); z-index: 6; }}
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{TARGET}" data-width="1920" data-height="1080" data-fps="{FPS}">
{chr(10).join(parts)}
</div>
<script>
{chr(10).join(js)}
</script>
</body></html>
'''


def main():
    cut = "--no-cut" not in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    if cut:
        cut_segments()
    (OUT / "index.html").write_text(build_html(), encoding="utf8")
    plan = {"target": TARGET, "sections": SECTIONS, "segments": PLACED, "captions": CAP}
    (OUT / "plan.json").write_text(json.dumps(plan, indent=1))
    print(f"OK: {len(PLACED)} segments, {len(CAP)} captions, {TARGET}s")
    for p in PLACED:
        print(f"  {p['id']:4} {p['start']:7.2f}s +{p['dur']:5.2f}s  speed {p['speed']:5.2f}  {p['file']} {p['src0']:.1f}-{p['src1']:.1f}")


if __name__ == "__main__":
    main()
