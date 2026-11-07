"""Phone, end to end against the real sync service (local stand-in): sign in, Garmin runs arrive,
the run review opens by itself, the map, swiping with the next page drawn, the Plan views and training load.

Usage: review_test.py <pc preview dir> <phone dir> <out dir>
"""
import functools, http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time, urllib.request
from playwright.sync_api import sync_playwright

pc_root, phone_root, out = sys.argv[1], sys.argv[2], sys.argv[3]
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.environ["FIX"]
os.makedirs(out, exist_ok=True)
os.makedirs(f"{pc_root}/fixtures", exist_ok=True)
for f in os.listdir(FIX):
    shutil.copy(f"{FIX}/{f}", f"{pc_root}/fixtures/{f}")


class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Q, directory=pc_root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
pc = f"http://127.0.0.1:{srv.server_address[1]}"
EMU = 8811
log = open(f"{out}/emu.log", "w")
emu = subprocess.Popen(["tsx", "--tsconfig", "tsconfig.json", "server.ts", str(EMU), os.path.abspath(phone_root), "dbs"], cwd=f"{HERE}/emu", stdout=log, stderr=subprocess.STDOUT)
cloud = f"http://127.0.0.1:{EMU}"
for _ in range(60):
    try:
        urllib.request.urlopen(cloud + "/__garmin")
        break
    except Exception:
        time.sleep(1)
errors, fails = [], []


def check(c, m):
    print(("PASS " if c else "FAIL ") + m, flush=True)
    if not c:
        fails.append(m)


FAKE_NATIVE = """
window.Capacitor = { isNativePlatform: () => true, registerPlugin: () => ({
  signInWithApple: async () => ({ identityToken: 'test:friend1' }),
  garminLogin: async () => ({ ticket: 'ST-0000001-TESTTICKET' }),
}) };
"""
# A drag across the page: start, eight moves, and (unless `hold`) let go.
SW = """async ([sel, x0, x1, y, hold]) => { const m = document.querySelector(sel); const mk = (type, x) => { const t = new Touch({identifier: 1, target: m, clientX: x, clientY: y}); m.dispatchEvent(new TouchEvent(type, {touches: type==='touchend'?[]:[t], changedTouches: [t], bubbles: true, cancelable: true})); };
  mk('touchstart', x0); for (let i = 1; i <= 8; i++) { mk('touchmove', x0 + (x1 - x0) * i / 8); await new Promise(r => setTimeout(r, 16)); } if (!hold) mk('touchend', x1); }"""
END = """([sel, x]) => { const m = document.querySelector(sel); const t = new Touch({identifier: 1, target: m, clientX: x, clientY: 600}); m.dispatchEvent(new TouchEvent('touchend', {touches: [], changedTouches: [t], bubbles: true, cancelable: true})); }"""

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ph = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, timezone_id="Europe/Zurich")
        ph.add_init_script(FAKE_NATIVE)
        pp = ph.new_page()
        pp.on("pageerror", lambda e: errors.append("phone: " + str(e)))
        pp.on("console", lambda m: m.type == "error" and errors.append("phone console: " + m.text[:300]))
        pp.goto(cloud + "/")
        pp.wait_for_selector(".apple-btn", timeout=30000)
        pp.locator(".apple-btn").click()
        pp.wait_for_selector(".p-app", timeout=60000)
        pp.wait_for_timeout(2500)
        # Connect Garmin: the runs arrive, and the newest (today) opens for review by itself.
        pp.locator(".p-start-step").first.click()
        try:
            pp.wait_for_selector(".modal.rr", timeout=60000)
        except Exception:
            pass
        pp.wait_for_timeout(1200)
        check(pp.locator(".modal.rr").count() == 1, "the new run's review opens by itself")
        pp.screenshot(path=f"{out}/01-review.png")
        if pp.locator(".modal.rr").count():
            pp.locator(".rr-field input").first.fill("Tempo by the lake")
            pp.locator(".rr-feels button", has_text="Great").click()
            pp.locator(".rr input[type=range]").fill("7")
            pp.locator(".rr textarea").fill("Felt smooth, windy on the way back")
            pp.locator(".rr-add").click()
            pp.locator(".rr-newshoe input").first.fill("Nike Pegasus 41")
            pp.locator(".rr-newshoe input").nth(1).fill("120")
            pp.locator(".rr-newshoe button").click()
            pp.wait_for_timeout(400)
            pp.locator(".rr-body").evaluate("e => e.scrollTo(0, e.scrollHeight)")
            pp.screenshot(path=f"{out}/02-review-filled.png")
            check(pp.locator(".rr-shoes button.on", has_text="Pegasus").count() == 1, "new shoes added and picked")
            pp.locator(".rr-save").click()
            pp.wait_for_timeout(2500)
            check(pp.locator(".modal.rr").count() == 0, "review saved and closed")
            glog = json.loads(urllib.request.urlopen(cloud + "/__garmin").read())
            check(any(x.startswith("PUT /activity-service/activity/") for x in glog), "title and notes sent to Garmin (PUT)")
        pp.reload()
        pp.wait_for_selector(".p-app", timeout=60000)
        pp.wait_for_timeout(3000)
        check(pp.locator(".modal.rr").count() == 0, "a reviewed run doesn't open again")

        # Today: create a workout is right there.
        pp.locator(".p-tabs").get_by_role("tab", name="Today", exact=True).click()
        pp.wait_for_timeout(1000)
        check(pp.locator(".wc-cta-today").is_visible(), "Today: Create a workout button")
        pp.screenshot(path=f"{out}/03-today.png", full_page=True)

        # The run: notes, then the map.
        pp.locator(".p-tabs").get_by_role("tab", name="Runs", exact=True).click()
        pp.wait_for_timeout(1500)
        pp.locator(".p-runcard").first.click()
        pp.wait_for_selector(".run-modal", timeout=20000)
        pp.wait_for_timeout(1500)
        txt = pp.locator(".run-modal").inner_text()
        check("Tempo by the lake" in txt, "run shows the new title")
        check("windy on the way back" in txt and "Pegasus" in txt, "run shows notes and shoes")
        pp.screenshot(path=f"{out}/04-run.png")
        pp.locator(".run-detail-map").click()
        pp.wait_for_selector(".run-map .leaflet-container", timeout=10000)
        try:
            pp.wait_for_selector(".leaflet-tile-loaded", timeout=15000)
        except Exception:
            pass
        pp.wait_for_timeout(1500)
        check(pp.locator(".run-map .leaflet-interactive").count() >= 1, "map draws the route")
        check(pp.locator(".rm-km").count() >= 1 and pp.locator(".rm-start").count() == 1, "km markers and start pin")
        check(pp.locator(".leaflet-tile-loaded").count() > 0, "map tiles load")
        pp.screenshot(path=f"{out}/05-map.png")
        pp.locator(".run-map .run-close").click()
        pp.wait_for_timeout(500)
        check(pp.locator(".run-map").count() == 0, "map closes")
        pp.locator(".run-modal .run-close").first.click()
        pp.wait_for_timeout(600)

        # A PC joins with a code, bringing its plan.
        pp.locator(".p-gear").click()
        pp.wait_for_timeout(1000)
        pp.get_by_role("button", name="Link a PC").click()
        pp.wait_for_timeout(1500)
        code = re.search(r"([A-Z0-9]{4}-[A-Z0-9]{4})", pp.locator(".p-section").filter(has_text="Account").inner_text()).group(1)
        pcx = b.new_context(viewport={"width": 1536, "height": 864}, timezone_id="Europe/Zurich")
        pg = pcx.new_page()
        pg.on("pageerror", lambda e: errors.append("pc: " + str(e)))
        pg.goto(pc + "/index.html")
        pg.wait_for_selector(".card-fitness .fit-big", timeout=60000)
        pg.wait_for_timeout(2000)
        pg.keyboard.press("Control+,")
        pg.wait_for_timeout(600)
        pg.get_by_text("Phone & cloud").first.click()
        pg.wait_for_timeout(600)
        pg.locator(".phone-url").fill(cloud)
        pg.get_by_role("button", name="Connect", exact=True).click()
        pg.wait_for_selector("text=Link a phone", timeout=30000)
        pg.wait_for_timeout(1000)
        pg.locator(".join-code").fill(code)
        pg.get_by_role("button", name="Join", exact=True).click()
        pg.wait_for_selector("text=Your account", timeout=60000)
        pg.wait_for_timeout(2500)
        pcx.close()
        pp.locator(".p-back").click()
        pp.wait_for_timeout(300)
        pp.locator(".p-refresh").click()
        pp.wait_for_timeout(8000)

        if pp.locator(".modal.rr").count():
            pp.screenshot(path=f"{out}/05b-another-review.png")
            pp.locator(".rr .run-close").click()
            pp.wait_for_timeout(600)
        # Swipe: hold mid-drag, the next page is drawn alongside (not blank).
        pp.locator(".p-tabs").get_by_role("tab", name="Today", exact=True).click()
        pp.wait_for_timeout(2000)
        pp.evaluate(SW, [".p-main", 330, 150, 600, True])
        pp.wait_for_timeout(100)
        peek = pp.evaluate("""() => { const p = document.querySelector('[data-pane="planner"]'); if (!p) return null; const r = p.getBoundingClientRect(); return { peeking: p.classList.contains('peeking'), left: r.left, h: r.height, text: p.innerText.trim().length }; }""")
        print("peer mid-drag:", peek)
        pp.screenshot(path=f"{out}/06-mid-swipe.png")
        check(bool(peek and peek["peeking"] and peek["left"] < 390 and peek["h"] > 200 and peek["text"] > 20), "mid-swipe: the next page is drawn alongside")
        pp.evaluate(END, [".p-main", 150])
        pp.wait_for_timeout(800)
        check(pp.locator(".p-tab.on").inner_text().strip() == "Planner", "swipe: Today -> Planner")
        check(pp.evaluate("[...document.querySelectorAll('.p-pane')].every(p => !p.style.transform)"), "pages back in place after the swipe")
        pp.evaluate(SW, [".p-main", 300, 250, 600, False])
        pp.wait_for_timeout(600)
        check(pp.locator(".p-tab.on").inner_text().strip() == "Planner", "a short drag springs back")
        pp.evaluate(SW, [".p-main", 330, 80, 600, False])
        pp.wait_for_timeout(900)
        check(pp.locator(".p-tab.on").inner_text().strip() == "Plan", "swipe: Planner -> Plan")
        pp.screenshot(path=f"{out}/07-plan-after-swipe.png")
        sw = pp.evaluate("document.documentElement.scrollWidth")
        check(sw <= 392, f"no sideways scroll ({sw})")

        # Plan views along the top.
        if pp.locator(".p-subnav button").count() != 4:
            print("plan pane:", pp.locator(".p-pane.on").inner_text()[:400].replace("\n", " | "))
        check(pp.locator(".p-subnav button").count() == 4, "Plan: four views along the top")
        for i, name in enumerate(["Week", "All weeks", "Pace on point", "Progress"]):
            pp.locator(".p-subnav button", has_text=name).click()
            pp.wait_for_timeout(1500)
            pp.screenshot(path=f"{out}/08-plan-{i}-{name.split()[0].lower()}.png", full_page=True)
            sw = pp.evaluate("document.documentElement.scrollWidth")
            check(sw <= 392, f"Plan/{name}: no sideways scroll ({sw})")
        check(pp.locator(".pp-week").count() > 3, "Progress: weeks planned vs done")
        pp.locator(".p-subnav button", has_text="Week").click()
        pp.wait_for_timeout(800)
        # Weeks: forward then all the way back to this week.
        nxt = pp.get_by_role("button", name="Next week")
        prv = pp.get_by_role("button", name="Previous week")
        for _ in range(3):
            if nxt.is_enabled():
                nxt.click()
                pp.wait_for_timeout(250)
        for _ in range(3):
            if prv.is_enabled():
                prv.click()
                pp.wait_for_timeout(250)
        check(pp.locator(".p-when").count() == 0, "weeks: back to this week")

        # Stats: training load.
        pp.locator(".p-tabs").get_by_role("tab", name="Stats", exact=True).click()
        pp.wait_for_timeout(2500)
        check(pp.locator(".tl-chart").count() == 1, "Stats: training load chart")
        check(pp.locator(".tl-zones span").count() == 5, "Stats: heart-rate zones")
        pp.screenshot(path=f"{out}/09-stats.png", full_page=True)
        pp.locator(".tl").scroll_into_view_if_needed()
        pp.screenshot(path=f"{out}/10-stats-load.png")
        b.close()
finally:
    emu.terminate()
    print("ERRORS:", errors[:15])
    print("FAILS:", fails)
    if fails:
        sys.exit(1)
