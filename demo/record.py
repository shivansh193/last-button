"""Scripted recording of the Last Button demo against the live app.

Each chapter is its own video (1440x900). Key moments are logged to marks.json
(seconds from the start of that chapter's recording). Buyer credentials are read
from ../.env and never printed; the password field is masked by PayPal.

    python demo/record.py            # all chapters
    python demo/record.py ch1 ch2    # only some
"""
import asyncio, json, os, re, sys, time, shutil
from pathlib import Path
from playwright.async_api import async_playwright, Page

BASE = os.environ.get("LB_BASE", "https://last-button.onrender.com")
ROOT = Path(__file__).resolve().parent
TAKES = ROOT / "takes"
VIEW = {"width": 1440, "height": 900}
STATE_FILE = TAKES / "state.json"  # migration id etc. shared between chapters


def load_env():
    env = {}
    for line in (ROOT.parent / ".env").read_text(encoding="utf8").splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line)
        if m:
            env[m.group(1)] = m.group(2)
    return env


CURSOR_JS = """
(() => {
  if (window.__cursor) return; window.__cursor = 1;
  const mk = () => {
    const d = document.createElement('div');
    d.id = '__cursor';
    d.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(29,92,74,.85);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);z-index:2147483647;' +
      'pointer-events:none;transition:transform .12s ease;transform:translate(-100px,-100px)';
    document.documentElement.appendChild(d);
    let x = -100, y = -100, s = 1;
    const paint = () => d.style.transform = `translate(${x}px,${y}px) scale(${s})`;
    addEventListener('mousemove', e => { x = e.clientX; y = e.clientY; paint(); }, true);
    addEventListener('mousedown', () => { s = 1.6; paint(); }, true);
    addEventListener('mouseup', () => { s = 1; paint(); }, true);
  };
  if (document.documentElement) mk(); else addEventListener('DOMContentLoaded', mk);
})();
"""


class Take:
    def __init__(self, name: str):
        self.name, self.t0, self.marks = name, None, []

    def start(self):
        self.t0 = time.monotonic()

    def mark(self, label: str):
        t = round(time.monotonic() - self.t0, 2)
        self.marks.append({"t": t, "label": label})
        print(f"  [{self.name} {t:6.2f}s] {label}")


async def glide_click(page: Page, locator, pause=0.9, steps=28):
    await locator.scroll_into_view_if_needed()
    box = await locator.bounding_box()
    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=steps)
    await asyncio.sleep(0.25)
    await locator.click()
    await asyncio.sleep(pause)


async def glide_to(page: Page, locator, steps=28):
    await locator.scroll_into_view_if_needed()
    box = await locator.bounding_box()
    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=steps)


async def smooth_scroll(page: Page, y: int, ms=900):
    await page.evaluate(
        """([y, ms]) => new Promise(r => { const s = scrollY, t0 = performance.now();
        const f = t => { const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k + 2, 2) / 2;
          scrollTo(0, s + (y - s) * e); k < 1 ? requestAnimationFrame(f) : r(); }; requestAnimationFrame(f); })""",
        [y, ms],
    )


def row(page: Page, text: str):
    return page.locator(".ag-center-cols-container .ag-row", has_text=text).first


async def new_recorded(browser, name: str, **ctx_kw):
    d = TAKES / name
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    ctx = await browser.new_context(viewport=VIEW, record_video_dir=str(d), record_video_size=VIEW, locale="en-US", **ctx_kw)
    await ctx.add_init_script(CURSOR_JS)
    return ctx


async def finish(ctx, take: Take, name: str):
    pages = ctx.pages
    await ctx.close()
    vids = sorted((TAKES / name).glob("*.webm"), key=lambda p: p.stat().st_mtime)
    # The first page's video is the chapter; extra pages (popups) are kept alongside.
    for i, v in enumerate(vids):
        v.rename(TAKES / name / (f"{name}.webm" if i == 0 else f"{name}-extra{i}.webm"))
    return take.marks


# ---------------- chapters ----------------
async def ch1(browser, state):
    """A site from 2010 -> landing -> Try the demo site."""
    take = Take("ch1")
    ctx = await new_recorded(browser, "ch1")
    page = await ctx.new_page()
    take.start()
    await page.goto(f"{BASE}/demo-site/", wait_until="load")
    await page.mouse.move(700, 300)
    take.mark("theatre tickets page")
    await asyncio.sleep(2.0)
    await glide_to(page, page.locator("form input[type=image]").first)
    take.mark("hover buy now")
    await asyncio.sleep(1.5)
    await glide_click(page, page.locator("#nav a", has_text="Shop"), pause=0.3)
    await page.wait_for_load_state("load")
    take.mark("shop page")
    await glide_to(page, page.locator("select[name=os0]"))
    await asyncio.sleep(1.2)
    await smooth_scroll(page, 520)
    take.mark("cart + raffle")
    await asyncio.sleep(1.8)
    await smooth_scroll(page, 0, 500)
    await glide_click(page, page.locator("#nav a", has_text="Support"), pause=0.3)
    await page.wait_for_load_state("load")
    take.mark("support page: saved + encrypted")
    await asyncio.sleep(1.5)
    await smooth_scroll(page, 380)
    await asyncio.sleep(1.5)
    await smooth_scroll(page, 900)
    take.mark("donate + subscribe")
    await asyncio.sleep(1.5)
    await page.goto(f"{BASE}/", wait_until="load")
    await page.mouse.move(600, 400)
    take.mark("landing page")
    await asyncio.sleep(2.5)
    await glide_to(page, page.locator("#url"))
    await asyncio.sleep(0.6)
    btn = page.locator("#demo")
    await glide_click(page, btn, pause=0.2)
    take.mark("clicked try the demo site")
    await page.wait_for_url(re.compile(r"/m/[a-z0-9]+$"), timeout=180_000)
    take.mark("results page loaded")
    state["mid"] = page.url.rsplit("/", 1)[1]
    await page.wait_for_selector(".ag-row")
    await asyncio.sleep(2.0)
    take.mark("end")
    return await finish(ctx, take, "ch1")


async def ch2(browser, state):
    """Find and rebuild: table, provenance, AI quote, left alone, confirm."""
    take = Take("ch2")
    ctx = await new_recorded(browser, "ch2")
    page = await ctx.new_page()
    take.start()
    await page.goto(f"{BASE}/m/{state['mid']}", wait_until="load")
    await page.wait_for_selector(".ag-row")
    await asyncio.sleep(0.8)
    await page.mouse.move(900, 160)
    take.mark("table with tiles")
    await asyncio.sleep(3.0)
    await glide_to(page, row(page, "Crew T-shirt").locator(".ag-cell").nth(2))
    take.mark("t-shirt spec from HTML")
    await asyncio.sleep(3.0)
    season = row(page, "Season Pass")
    await smooth_scroll(page, 700)
    await glide_to(page, season.locator(".pv.ai").first)
    take.mark("season pass AI badge")
    await asyncio.sleep(2.0)
    await glide_click(page, season.locator(".ag-cell").first, pause=0.5)
    take.mark("drawer open")
    q = page.locator("#drawer .quote").first
    await q.scroll_into_view_if_needed()
    await glide_to(page, q)
    take.mark("AI quote visible")
    await asyncio.sleep(3.5)
    ctx_block = page.locator("#drawer pre.code").last
    await ctx_block.scroll_into_view_if_needed()
    take.mark("page text the AI read")
    await asyncio.sleep(2.5)
    await glide_click(page, page.locator("#drawer-close"), pause=0.6)
    await smooth_scroll(page, 1150)
    await glide_to(page, row(page, "Donate").locator(".ag-cell").nth(2))
    take.mark("donate + subscribe left alone")
    await asyncio.sleep(2.5)
    await smooth_scroll(page, 700)
    for name in ["Season Pass", "gift voucher"]:
        b = row(page, name).locator("[data-act=confirm]")
        await glide_click(page, b, pause=1.2)
        take.mark(f"confirmed {name}")
    await asyncio.sleep(1.0)
    take.mark("end")
    return await finish(ctx, take, "ch2")


async def ch3(browser, state):
    """Create links, then open the T-shirt link on PayPal."""
    take = Take("ch3")
    ctx = await new_recorded(browser, "ch3")
    page = await ctx.new_page()
    take.start()
    await page.goto(f"{BASE}/m/{state['mid']}", wait_until="load")
    await page.wait_for_selector(".ag-row")
    await page.mouse.move(900, 200)
    await asyncio.sleep(1.2)
    take.mark("ready for links")
    await glide_click(page, page.locator("#make-links"), pause=0.2)
    take.mark("clicked create links")
    await page.wait_for_selector(".linkcell a", timeout=120_000)
    await page.wait_for_function("document.querySelectorAll('.linkcell a').length >= 7", timeout=120_000)
    take.mark("links created")
    await asyncio.sleep(1.0)
    tee = row(page, "Crew T-shirt")
    await glide_to(page, tee.locator(".linkcell a"))
    await asyncio.sleep(1.5)
    href = await tee.locator(".linkcell a").get_attribute("href")
    state["tee_link"] = href
    await page.goto(href, wait_until="load")
    await page.locator("select").first.wait_for(timeout=30_000)
    await asyncio.sleep(1.5)
    await page.mouse.move(700, 400)
    take.mark("paypal link page")
    sel = page.locator("select").first
    await glide_to(page, sel)
    await asyncio.sleep(0.5)
    labels = await sel.locator("option").all_text_contents()
    xl = next(l for l in labels if l.strip().startswith("XL"))
    await sel.select_option(label=xl)
    take.mark("picked XL")
    await asyncio.sleep(1.0)
    await glide_to(page, page.get_by_text("Total", exact=True).first)
    take.mark("totals: 21 + 4.50")
    await asyncio.sleep(3.0)
    take.mark("end")
    return await finish(ctx, take, "ch3")


async def ch4_bot(browser, state, env):
    """What the buyer bot does: pay one link on the PayPal sandbox (separate clip)."""
    take = Take("ch4bot")
    ctx = await new_recorded(browser, "ch4bot")
    page = await ctx.new_page()
    take.start()
    await page.goto(state["tee_link"], wait_until="load")
    await page.locator("select").first.wait_for(timeout=30_000)
    await asyncio.sleep(1.0)
    sel = page.locator("select").first
    labels = await sel.locator("option").all_text_contents()
    await sel.select_option(label=next(l for l in labels if l.strip().startswith("XL")))
    take.mark("bot picked XL")
    frame_btn = None
    for _ in range(25):
        for f in page.frames:
            loc = f.locator('[data-funding-source="paypal"]')
            if await loc.count():
                frame_btn = loc.first
                break
        if frame_btn:
            break
        await asyncio.sleep(1)
    async with ctx.expect_page(timeout=20_000) as pop_info:
        await frame_btn.click()
    pop = await pop_info.value
    take.mark("paypal checkout opened")
    await pop.wait_for_load_state("domcontentloaded")
    email = pop.locator('#email, input[name="login_email"]').first
    submit = pop.locator('#payment-submit-btn, [data-id="payment-submit-btn"], button:has-text("Complete Purchase"), button:has-text("Pay Now")').first
    await email.wait_for(timeout=45_000)
    await email.fill(env["SANDBOX_BUYER_EMAIL"])
    nxt = pop.locator("#btnNext")
    if await nxt.is_visible():
        await nxt.click()
    pw = pop.locator('#password, input[name="login_password"]').first
    await pw.wait_for(state="visible")
    await pw.fill(env["SANDBOX_BUYER_PASSWORD"])  # masked on screen
    await pop.locator(".spinner[aria-busy=true]").wait_for(state="hidden", timeout=20_000)
    await pop.locator("#btnLogin").click()
    take.mark("logged in")
    await submit.wait_for(timeout=60_000)
    await asyncio.sleep(2.0)
    take.mark("review page")
    await submit.click()
    take.mark("clicked pay")
    try:
        await pop.wait_for_event("close", timeout=90_000)
    except Exception:
        pass
    await page.wait_for_load_state("load")
    await asyncio.sleep(3.0)
    take.mark("confirmation page")
    await asyncio.sleep(2.0)
    take.mark("end")
    return await finish(ctx, take, "ch4bot")


async def ch4(browser, state):
    """Prove it: run verification, rows go green (long take, sped up in the edit)."""
    take = Take("ch4")
    ctx = await new_recorded(browser, "ch4")
    page = await ctx.new_page()
    take.start()
    await page.goto(f"{BASE}/m/{state['mid']}", wait_until="load")
    await page.wait_for_selector(".ag-row")
    await page.mouse.move(900, 200)
    await asyncio.sleep(1.2)
    take.mark("links made, not verified")
    await glide_click(page, page.locator("#verify"), pause=0.5)
    take.mark("clicked verify")
    seen = set()
    t_end = time.monotonic() + 20 * 60
    while time.monotonic() < t_end:
        names = await page.eval_on_selector_all(
            ".ag-center-cols-container .ag-row",
            "rs => rs.filter(r => [...r.querySelectorAll('.pill.green')].some(p => p.textContent.includes('Verified'))).map(r => r.getAttribute('row-id'))",
        )
        for n in names:
            if n not in seen:
                seen.add(n)
                take.mark(f"verified: {n.strip()}")
        verifying = await page.locator(".pill", has_text="Verifying").count()
        if len(seen) >= 7 or (verifying == 0 and len(seen) > 0):
            break
        await asyncio.sleep(1.0)
    await asyncio.sleep(2.0)
    take.mark("all verified")
    await smooth_scroll(page, 0, 600)
    await asyncio.sleep(2.0)
    take.mark("tiles: 7 verified")
    bundle = row(page, "Programme and poster")
    await glide_click(page, bundle.locator(".ag-cell").first, pause=0.6)
    take.mark("bundle drawer")
    v = page.locator("#drawer h3", has_text="Verification")
    await v.scroll_into_view_if_needed()
    await glide_to(page, v)
    take.mark("verification table")
    await asyncio.sleep(3.0)
    shot = page.locator("#drawer img.shot")
    if await shot.count():
        await shot.scroll_into_view_if_needed()
        take.mark("confirmation screenshot")
        await asyncio.sleep(3.0)
    take.mark("end")
    return await finish(ctx, take, "ch4")


async def ch5(browser, state):
    """Swap them in: outputs, then the shop page with the script applied."""
    take = Take("ch5")
    ctx = await new_recorded(browser, "ch5", accept_downloads=True)
    page = await ctx.new_page()
    take.start()
    await page.goto(f"{BASE}/m/{state['mid']}", wait_until="load")
    await page.wait_for_selector(".ag-row")
    await page.mouse.move(800, 300)
    out = page.locator("#outputs")
    await out.scroll_into_view_if_needed()
    await asyncio.sleep(0.8)
    take.mark("swap them in")
    link = page.locator("#patched-list a", has_text="shop.html")
    async with page.expect_download() as dl:
        await glide_click(page, link, pause=0.2)
    await dl.value
    take.mark("downloaded patched shop.html")
    await asyncio.sleep(1.2)
    await glide_to(page, page.locator("#swap-line"))
    take.mark("script line")
    await asyncio.sleep(2.0)
    await glide_click(page, page.locator("#jsonld-btn"), pause=0.8)
    take.mark("json-ld shown")
    await asyncio.sleep(2.0)
    await page.goto(f"{BASE}/demo-site/shop.html", wait_until="load")
    await page.mouse.move(700, 450)
    take.mark("shop before")
    await asyncio.sleep(2.0)
    await page.add_script_tag(url=f"{BASE}/api/m/{state['mid']}/swap.js")
    await asyncio.sleep(0.3)
    take.mark("shop after swap")
    await glide_to(page, page.locator("a.last-button-paypal").first)
    await asyncio.sleep(2.5)
    await smooth_scroll(page, 520)
    await asyncio.sleep(2.0)
    take.mark("end")
    return await finish(ctx, take, "ch5")


async def main():
    which = sys.argv[1:] or ["ch1", "ch2", "ch3", "ch4bot", "ch4", "ch5"]
    env = load_env()
    TAKES.mkdir(exist_ok=True)
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    marks_file = TAKES / "marks.json"
    marks = json.loads(marks_file.read_text()) if marks_file.exists() else {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        fns = {"ch1": ch1, "ch2": ch2, "ch3": ch3, "ch4": ch4, "ch5": ch5}
        for name in which:
            print(f"== {name}")
            if name == "ch4bot":
                marks[name] = await ch4_bot(browser, state, env)
            else:
                marks[name] = await fns[name](browser, state)
            STATE_FILE.write_text(json.dumps(state, indent=1))
            marks_file.write_text(json.dumps(marks, indent=1))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
