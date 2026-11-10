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
        pp.locator(".p-start-pills button", has_text="Garmin").click()
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
        check(pp.locator(".wc-cta-today").count() == 0, "Today: big workout button hidden by default")
        pp.locator(".p-edit-dash").click()
        pp.wait_for_timeout(600)
        check(pp.locator(".p-dash-row").count() >= 8, "Today: customise lists the blocks")
        pp.locator(".p-dash-row", has_text="Create a workout").locator(".p-switch input").click(force=True)
        pp.locator(".p-dash-row", has_text="Weather").get_by_role("button", name=re.compile("up")).click()
        pp.wait_for_timeout(800)
        check(pp.locator(".wc-cta-today").count() == 1, "Today: turn a block on")
        pp.screenshot(path=f"{out}/03c-customise.png", full_page=True)
        pp.locator(".p-dash-edit .p-link", has_text="Done").click()
        pp.wait_for_timeout(400)
        pp.screenshot(path=f"{out}/03-today.png", full_page=True)

        # The run: notes, then the map.
        pp.locator(".p-tabs").get_by_role("tab", name="Runs", exact=True).click()
        pp.wait_for_timeout(1500)
        pp.wait_for_timeout(6000)
        check(pp.locator(".p-wchart-col").count() == 12, "Runs: weekly chart")
        check(pp.locator(".p-routethumb img").count() >= 1, "Runs: route pictures on the map")
        pp.screenshot(path=f"{out}/03d-runs.png")
        pp.locator(".p-wchart-col.now").click()
        pp.wait_for_timeout(600)
        check(pp.locator(".p-weekpick").count() == 1, "Runs: tap a week for its runs")
        pp.screenshot(path=f"{out}/03e-runs-week.png")
        pp.locator(".p-weekpick-head .p-link").click()
        pp.wait_for_timeout(300)
        pp.locator(".p-runcard").first.click()
        pp.wait_for_selector(".run-modal", timeout=20000)
        pp.wait_for_timeout(1500)
        txt = pp.locator(".run-modal").inner_text()
        check("Tempo by the lake" in txt, "run shows the new title")
        check("windy on the way back" in txt and "Pegasus" in txt, "run shows notes and shoes")
        pp.screenshot(path=f"{out}/04-run.png")
        hrc = pp.locator(".chart.xy", has_text="Heart rate")
        if hrc.count():
            hrc.scroll_into_view_if_needed()
            pp.wait_for_timeout(500)
            hrc.screenshot(path=f"{out}/04c-hr-chart.png")
            print("hr chart ticks:", hrc.locator(".chart-label").all_inner_texts()[:8])
        else:
            print("hr chart: none")
        pp.locator(".run-detail-map").click()
        pp.wait_for_selector(".run-map .maplibregl-canvas", timeout=15000)
        pp.wait_for_timeout(5000)
        check(pp.locator(".run-map .mp-km").count() >= 1 and pp.locator(".run-map .mp-start").count() == 1, "km markers and start pin")
        check(pp.evaluate("""() => { const c = document.querySelector('.run-map .maplibregl-canvas'); return !!c && c.width > 100; }"""), "vector map draws")
        pp.screenshot(path=f"{out}/05-map.png")
        for st in ["Satellite", "Light"]:
            pp.locator(".rm-style", has_text=st).click()
            pp.wait_for_timeout(3500)
            pp.screenshot(path=f"{out}/05-map-{st.lower()}.png")
        pp.locator(".rm-style", has_text="Standard").click()
        pp.locator(".run-map .run-close").click()
        pp.wait_for_timeout(500)
        check(pp.locator(".run-map").count() == 0, "map closes")
        pp.locator(".run-modal .run-close").first.click()
        pp.wait_for_timeout(600)

        # A PC joins with a code, bringing its plan.
        pp.locator(".p-gear").click()
        pp.wait_for_timeout(1000)
        pp.screenshot(path=f"{out}/04b-settings.png")
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
        pp.locator(".p-back").click()
        pp.wait_for_timeout(300)
        for _ in range(4):
            pp.locator(".p-refresh").click()
            pp.wait_for_timeout(6000)
            pp.locator(".p-tabs").get_by_role("tab", name="Plan", exact=True).click()
            pp.wait_for_timeout(1000)
            if pp.locator(".p-subnav").count():
                break

        if not pp.locator(".p-subnav").count() and pp.get_by_role("button", name="Build your plan").count():
            # No plan yet: build one on the phone with the builder's defaults.
            pp.get_by_role("button", name="Build your plan").click()
            pp.wait_for_timeout(1500)
            for step in range(8):
                use = pp.get_by_role("button", name=re.compile("Use this plan|Tap again to replace"))
                if use.count():
                    pp.screenshot(path=f"{out}/05c-builder-review.png")
                    use.first.click()
                    pp.wait_for_timeout(1500)
                    if pp.get_by_role("button", name=re.compile("Tap again")).count():
                        pp.get_by_role("button", name=re.compile("Tap again")).first.click()
                        pp.wait_for_timeout(1500)
                    break
                nxt = pp.locator(".pb-nav .btn-primary")
                if not nxt.count():
                    print("builder: no next button at step", step, pp.locator(".p-pushed").inner_text()[:300].replace("\n", " | "))
                    break
                nxt.last.click()
                pp.wait_for_timeout(1500)
            pp.wait_for_timeout(2000)
            if pp.locator(".p-back").count():
                pp.locator(".p-back").click()
                pp.wait_for_timeout(1000)
            pp.locator(".p-tabs").get_by_role("tab", name="Plan", exact=True).click()
            pp.wait_for_timeout(1500)
            check(pp.locator(".p-subnav").count() == 1, "plan built on the phone")
        if pp.locator(".modal.rr").count():
            pp.screenshot(path=f"{out}/05b-another-review.png")
            pp.locator(".rr .run-close").click()
            pp.wait_for_timeout(600)
        # Swipe: hold mid-drag, the next page is drawn alongside (not blank).
        pp.locator(".p-tabs").get_by_role("tab", name="Today", exact=True).click()
        pp.wait_for_timeout(2000)
        print("before swipe scrollY:", pp.evaluate("window.scrollY"))
        pp.evaluate(SW, [".p-main", 330, 150, 600, True])
        pp.wait_for_timeout(100)
        peek = pp.evaluate("""() => { const p = document.querySelector('[data-pane="planner"]'); if (!p) return null; const r = p.getBoundingClientRect(); return { peeking: p.classList.contains('peeking'), left: r.left, h: r.height, text: p.innerText.trim().length }; }""")
        print("peer mid-drag:", peek)
        pp.screenshot(path=f"{out}/06-mid-swipe.png")
        check(bool(peek and peek["peeking"] and peek["left"] < 390 and peek["h"] > 200 and peek["text"] > 20), "mid-swipe: the next page is drawn alongside")
        y0 = pp.evaluate("document.querySelector('[data-pane=planner]').getBoundingClientRect().top")
        pp.evaluate(END, [".p-main", 150])
        pp.wait_for_timeout(800)
        y1 = pp.evaluate("document.querySelector('[data-pane=planner]').getBoundingClientRect().top")
        print("chain:", pp.evaluate("""() => ['html','body','.p-app','.p-head','.p-ptr','.p-main','[data-pane=planner]','[data-pane=planner] .p-title','[data-pane=today]'].map(q => { const e = document.querySelector(q); if (!e) return q + ': none'; const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return `${q}: top ${Math.round(r.top)} h ${Math.round(r.height)} scrollTop ${e.scrollTop} pos ${c.position} tf ${c.transform} ov ${c.overflowY} mt ${c.marginTop}`; }).join(' || ') + ' || vv ' + (visualViewport ? visualViewport.offsetTop + '/' + visualViewport.pageTop : '') + ' || se ' + document.scrollingElement.scrollTop"""))
        print("after landing:", pp.evaluate("""() => { const p = document.querySelector('[data-pane=planner]'); const m = document.querySelector('.p-main'); return { scrollY: window.scrollY, mainTop: m.getBoundingClientRect().top, cls: p.className, style: p.getAttribute('style'), docH: document.documentElement.scrollHeight, act: document.activeElement && document.activeElement.className }; }"""))
        print("planner top during/after swipe:", y0, y1)
        check(abs(y0 - y1) < 3, f"no jump when the swipe lands ({y0} -> {y1})")
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
            pp.locator(".p-subnav").get_by_role("tab", name=name, exact=True).click()
            pp.wait_for_timeout(1500)
            pp.screenshot(path=f"{out}/08-plan-{i}-{name.split()[0].lower()}.png", full_page=True)
            sw = pp.evaluate("document.documentElement.scrollWidth")
            check(sw <= 392, f"Plan/{name}: no sideways scroll ({sw})")
            if name == "Week":
                check(pp.locator(".p-pane.on .wa").count() == 1, "Plan week: the build to your race")
                if pp.locator(".p-pane.on .p-adjust-btn").count():
                    pp.locator(".p-pane.on .p-adjust-btn").click()
                    pp.wait_for_timeout(1500)
                    bu = pp.locator(".ps-card", has_text="Build-up")
                    check(bu.count() == 1, "Adjust plan opens on Adjust, with build-up")
                    if bu.count():
                        bu.get_by_role("button", name="3 wk").click()
                        pp.wait_for_timeout(1200)
                        print("build-up:", bu.inner_text().replace("\n", " | ")[:160])
                        bu.scroll_into_view_if_needed()
                        pp.screenshot(path=f"{out}/08-plan-0d-adjust.png")
                    pp.locator(".p-back").click()
                    pp.wait_for_timeout(1200)
                print("week ahead:", pp.locator(".p-pane.on .wa").inner_text().replace("\n", " | ")[:300] if pp.locator(".p-pane.on .wa").count() else None)
                check(pp.locator(".p-pane.on .lfw-strip").count() == 1, "Plan week: load focus % for the week")
                check(pp.locator(".p-pane.on .lf-row2").count() == 3, "Plan week: 4-week load focus card")
                print("week focus:", pp.locator(".p-pane.on .lfw-strip").inner_text().replace("\n", " ") if pp.locator(".p-pane.on .lfw-strip").count() else None)
                if pp.locator(".p-pane.on .lf").count():
                    pp.locator(".p-pane.on .lf").scroll_into_view_if_needed()
                    pp.screenshot(path=f"{out}/08-plan-0b-load-focus.png")
                    pp.evaluate("window.scrollTo(0,0)")
            if name == "All weeks":
                n = pp.locator(".p-pane.on .lfw-row").count()
                check(n >= 2, f"All weeks: load focus % per upcoming week ({n})")
                if n:
                    pp.locator(".p-pane.on .lfw").scroll_into_view_if_needed()
                    pp.screenshot(path=f"{out}/08-plan-1b-focus-weeks.png")
                    print("focus weeks:", pp.locator(".p-pane.on .lfw").inner_text().replace("\n", " ")[:400])
                    pp.evaluate("window.scrollTo(0,0)")
        check(pp.locator(".pp-week").count() > 3, "Progress: weeks planned vs done")
        check(pp.locator(".gc-card").count() >= 3, "Progress: goals to swipe across")
        print("goal cards:", [c.replace("\n", " | ")[:120] for c in pp.locator(".gc-card").all_inner_texts()])
        check(pp.locator(".gc-card .pt-chart").count() >= 1, "Progress: the line to race day on the cards")
        check(pp.locator(".fp-table .fp-row").count() == 4, "Progress: race predictor")
        pp.screenshot(path=f"{out}/08-plan-3a-progress-top.png")
        if pp.locator(".rr2").count():
            pp.locator(".rr2-seg button", has_text="Ready today").click()
            pp.locator(".rr2-part").first.click()
            pp.wait_for_timeout(500)
            check(pp.locator(".rr2-more").count() == 1, "Readiness: today, and a part opens")
            pp.screenshot(path=f"{out}/08-plan-3b-readiness.png")
        if pp.locator(".gc-card.on .gc-link").count():
            pp.locator(".gc-card.on .gc-link").click()
            pp.wait_for_timeout(2000)
            check(pp.locator(".p-subnav [aria-selected=true]").inner_text().strip() == "Pace on point", "Progress card opens Pace on point")
            print("pace picked:", pp.locator(".pt-picks button.on").inner_text() if pp.locator(".pt-picks button.on").count() else None)
        pp.locator(".p-subnav").get_by_role("tab", name="Pace on point", exact=True).click()
        pp.wait_for_timeout(2500)
        check(pp.locator(".pt-picks button").count() >= 4, "Pace: races and distances to pick from")
        print("pace card:", pp.locator(".pt-card").first.inner_text()[:300].replace("\n", " | ") if pp.locator(".pt-card").count() else None)
        check(pp.locator(".pt-day-row").count() == 1, "Pace: current, race day and goal")
        pp.screenshot(path=f"{out}/08-plan-2b-pace-top.png")
        pp.locator(".pt-picks").get_by_role("tab", name="10K", exact=True).click()
        pp.wait_for_timeout(1500)
        pp.locator(".pt-goal-btn").first.click()
        pp.locator(".pt-goal-edit input").fill("38:30")
        pp.locator(".pt-goal-edit button").click()
        pp.wait_for_timeout(1500)
        check("38:30" in pp.locator(".pt-card").inner_text(), "Pace: set a 10K goal")
        pp.screenshot(path=f"{out}/08-plan-2c-pace-10k.png")
        pp.locator(".p-subnav").get_by_role("tab", name="Week", exact=True).click()
        pp.wait_for_timeout(800)
        # The + Workout button: on screen, and building a fartlek in two sets.
        fab = pp.locator(".p-wfab")
        check(fab.count() == 1, "Plan: workout button shown")
        bb = fab.bounding_box()
        check(bool(bb and bb["x"] >= 0 and bb["x"] + bb["width"] <= 390 and bb["width"] > 90), f"Plan: workout button fully on screen ({bb})")
        check(fab.evaluate("e => e.scrollWidth <= e.clientWidth + 1"), "Plan: workout button's label fits")
        pp.screenshot(path=f"{out}/08-plan-0b-fab.png")
        fab.click()
        pp.wait_for_timeout(1500)
        pp.locator(".wc-chip", has_text="Fartlek").click()
        pp.wait_for_timeout(500)
        pp.locator(".wc-add").click()
        pp.wait_for_timeout(500)
        txt = pp.locator(".wc-preview .p-session-text").inner_text()
        print("fartlek:", txt)
        check(pp.locator(".wc-set").count() == 2 and "then" in txt, "Workout: fartlek with a second set")
        check("float" in txt, "Workout: fartlek floats")
        # Exact values: tap the pace, type it to the second; hold + to keep going.
        pp.locator(".wc-set").first.locator(".wc-step", has_text="Pace").first.locator(".wc-val").click()
        pp.locator(".wc-exact").fill("3:47")
        pp.locator(".wc-exact").press("Enter")
        pp.wait_for_timeout(400)
        t2 = pp.locator(".wc-preview .p-session-text").inner_text()
        print("exact pace:", t2[:120])
        check("3:45–3:49" in t2, "Workout: typed pace 3:47")
        rec = pp.locator(".wc-set").first.locator(".wc-step", has_text="Recovery").first
        before = rec.locator(".wc-val").inner_text()
        plus = rec.get_by_role("button", name=re.compile("More"))
        plus.dispatch_event("pointerdown")
        pp.wait_for_timeout(1200)
        plus.dispatch_event("pointerup")
        after = rec.locator(".wc-val").inner_text()
        print("hold:", before, "->", after)
        check(before != after, "Workout: holding + keeps going")
        check(pp.locator(".wc-preview .fo").count() == 1, "Workout: training focus shown")
        pp.locator(".wc-chip", has_text="Over-unders").click()
        pp.wait_for_timeout(500)
        txt = pp.locator(".wc-preview .p-session-text").inner_text()
        print("over-unders:", txt, "|", pp.locator(".wc-preview .fo").inner_text().replace("\n", " "))
        check("over-unders" in txt.lower() and "+" in txt, "Workout: over-unders")
        pp.screenshot(path=f"{out}/08-plan-0d-overunder.png", full_page=True)
        pp.locator(".wc-chip", has_text="Progression").click()
        pp.wait_for_timeout(500)
        pp.locator(".wc-add").click()
        pp.wait_for_timeout(500)
        txt = pp.locator(".wc-preview .p-session-text").inner_text()
        print("progression:", txt)
        check("km easy" in txt and txt.count(" km at ") >= 2, "Workout: progression with two blocks")
        pp.locator(".wc-preview").scroll_into_view_if_needed()
        pp.screenshot(path=f"{out}/08-plan-0c-builder.png", full_page=True)
        pp.locator(".p-back").click()
        pp.wait_for_timeout(800)
        # Weeks: forward then all the way back to this week.
        nxt = pp.locator(".p-pane.on .p-weekbar").get_by_role("button", name="Next week")
        prv = pp.locator(".p-pane.on .p-weekbar").get_by_role("button", name="Previous week")
        for _ in range(3):
            if nxt.is_enabled():
                nxt.click()
                pp.wait_for_timeout(250)
        for _ in range(3):
            if prv.is_enabled():
                prv.click()
                pp.wait_for_timeout(250)
        check(pp.locator(".p-when").count() == 0, "weeks: back to this week")

        # Today once today's run is done: a small tile.
        pp.locator(".p-tabs").get_by_role("tab", name="Today", exact=True).click()
        pp.wait_for_timeout(1500)
        print("done tile:", pp.locator(".p-donetile").count(), "session:", pp.locator(".p-session").count())
        pp.screenshot(path=f"{out}/03b-today-done.png")
        # Today: the health panel and its pages.
        check(pp.locator(".hp-page").count() == 3, "Today: health panel with three pages")
        pp.locator(".hp").scroll_into_view_if_needed()
        pp.screenshot(path=f"{out}/03f-health-1.png")
        pp.locator(".hp-dots button").nth(1).click()
        pp.wait_for_timeout(800)
        pp.screenshot(path=f"{out}/03g-health-2.png")
        pp.locator(".hp-dots button").nth(2).click()
        pp.wait_for_timeout(800)
        pp.screenshot(path=f"{out}/03h-health-3.png")
        # Stats: training load.
        pp.locator(".p-tabs").get_by_role("tab", name="Today", exact=True).click()
        pp.wait_for_timeout(1500)
        check(pp.locator(".p-pane.on .wa").count() == 1, "Today: week ahead card")
        check(pp.locator(".p-pane.on .wp").count() == 1, "Today: week progress")
        if pp.locator(".p-pane.on .wp").count():
            pp.locator(".p-pane.on .wp").scroll_into_view_if_needed()
            pp.wait_for_timeout(1300)
            pp.locator(".p-pane.on .wp").screenshot(path=f"{out}/03c-week-progress.png")
            print("week progress:", pp.locator(".p-pane.on .wp").inner_text().replace("\n", " | ")[:300])
        if pp.locator(".p-pane.on .wa").count():
            pp.locator(".p-pane.on .wa").scroll_into_view_if_needed()
            pp.locator(".p-pane.on .wa").screenshot(path=f"{out}/03d-week-ahead.png")
            picks = pp.locator(".p-pane.on .wa-picks button")
            print("race picks:", picks.count())
            if picks.count() > 1:
                before = pp.locator(".p-pane.on .wa-title").inner_text()
                picks.nth(1).click()
                pp.wait_for_timeout(1200)
                after = pp.locator(".p-pane.on .wa-title").inner_text()
                print("highlight:", before, "->", after)
                check(before != after, "Week ahead: pick another race to highlight")
                pp.locator(".p-pane.on .wa").screenshot(path=f"{out}/03e-week-ahead-other.png")
                print("block:", pp.locator(".p-pane.on .wa").inner_text().replace("\n", " | ")[:240])
                pp.locator(".p-pane.on .wa-picks button").nth(0).click()
                pp.wait_for_timeout(800)
            keys = pp.locator(".p-pane.on .wa-key")
            if keys.count():
                keys.last.click()
                pp.wait_for_timeout(1500)
                check(pp.locator(".p-tab.on").inner_text().strip() == "Plan", "Week ahead: a key session opens the Plan")
                print("plan day picked:", pp.locator(".p-pane.on .p-wday.on").inner_text().replace("\n", " ") if pp.locator(".p-pane.on .p-wday.on").count() else None)
                pp.screenshot(path=f"{out}/03f-session-from-today.png")
        pp.evaluate("window.scrollTo(0,0)")
        pp.locator(".p-tabs").get_by_role("tab", name="Stats", exact=True).click()
        pp.wait_for_timeout(2500)
        check(pp.locator(".tl-chart").count() == 1, "Stats: training load chart")
        check(pp.locator(".tl-zones > span").count() == 5, "Stats: heart-rate zones")
        pp.screenshot(path=f"{out}/09-stats.png", full_page=True)
        check(pp.locator(".tl-zname small").count() == 5, "Zones: bpm range for each")
        check(pp.locator(".rz-paces .rz-pace").count() == 8, "Stats: training paces")
        print("load focus:", pp.locator(".p-pane.on .lf").inner_text().replace("\n", " ")[:300] if pp.locator(".p-pane.on .lf").count() else None)
        check(pp.locator(".p-pane.on .lf-row2").count() == 3 and pp.locator(".p-pane.on .lf-st").count() == 3, "Stats: load focus, each with in/below/above")
        check(pp.locator(".p-pane.on .lf-src").count() == 1 and "Short of anaerobic" in pp.locator(".p-pane.on .lf").inner_text(), "Stats: Garmin's own load focus (620 / 742 / 33)")
        pp.locator(".p-pane.on .lf").scroll_into_view_if_needed()
        pp.screenshot(path=f"{out}/12-load-focus.png")
        pp.locator(".xp-btn").first.click()
        pp.wait_for_timeout(400)
        check(pp.locator(".xp-body").count() >= 1, "Stats: explanations open")
        print("zones:", pp.locator(".tl-zsource").inner_text())
        pp.locator(".tl-zsource button").click()
        pp.wait_for_timeout(500)
        pp.locator(".tl-zmethods button", has_text="% of reserve").click()
        pp.wait_for_timeout(1500)
        print("zones after:", pp.locator(".tl-zsource").inner_text(), pp.locator(".tl-zones").inner_text().replace("\n", " | ")[:300])
        check("reserve" in pp.locator(".tl-zsource").inner_text().lower(), "Zones: switch to heart-rate reserve")
        pp.locator(".tl-zones").scroll_into_view_if_needed()
        pp.screenshot(path=f"{out}/11-zones.png")
        pp.locator(".tl").scroll_into_view_if_needed()
        pp.screenshot(path=f"{out}/10-stats-load.png")
        # The desktop: Training with the week first, Training load, Watch.
        try:
            pg.bring_to_front()
            for _ in range(3):
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(300)
            pg.screenshot(path=f"{out}/19-desktop-before.png")
            pg.get_by_role("tab", name="Training", exact=True).click(force=True)
            pg.wait_for_timeout(2500)
            pg.screenshot(path=f"{out}/20-desktop-plan.png")
            pg.locator(".page-tabs").get_by_role("tab", name="Training load", exact=True).click()
            pg.wait_for_timeout(2500)
            check(pg.locator(".tl-chart").count() == 1, "desktop: training load chart")
            pg.screenshot(path=f"{out}/21-desktop-load.png", full_page=True)
            pg.locator(".page-tabs").get_by_role("tab", name="Watch", exact=True).click()
            pg.wait_for_timeout(1500)
            check(pg.get_by_role("tab", name="Watch", exact=True).count() == 1, "desktop: Watch is inside Training (not a top tab)")
            pg.screenshot(path=f"{out}/22-desktop-watch.png")
        except Exception as e:
            print("desktop shots:", e)
            fails.append("desktop shots")
        pcx.close()
        # Pacelife on the web: the same account as the phone, in the desktop view.
        try:
            wp = ph.new_page()
            wp.set_viewport_size({"width": 1440, "height": 900})
            wp.on("pageerror", lambda e: errors.append("web: " + str(e)))
            wp.goto(cloud + "/web")
            wp.wait_for_selector(".page-tabs, [role=tablist]", timeout=60000)
            wp.wait_for_timeout(3000)
            wp.screenshot(path=f"{out}/30-web-home.png")
            tabs = [t.strip() for t in wp.get_by_role("tab").all_inner_texts() if t.strip()]
            print("web tabs:", tabs[:20])
            check(any(t == "Training" for t in tabs), "web: the desktop view opens with your account")
            for name in ["Training", "Runs", "Stats", "Health"]:
                t = wp.get_by_role("tab", name=name, exact=True)
                if t.count():
                    t.first.click(force=True)
                    wp.wait_for_timeout(2500)
                    wp.screenshot(path=f"{out}/31-web-{name.lower()}.png")
            if wp.locator(".page-tabs").get_by_role("tab", name="Training load", exact=True).count():
                wp.get_by_role("tab", name="Training", exact=True).first.click(force=True)
                wp.wait_for_timeout(1500)
                wp.locator(".page-tabs").get_by_role("tab", name="Training load", exact=True).click()
                wp.wait_for_timeout(2500)
                check(wp.locator(".tl-chart").count() == 1, "web: training load from the account's runs")
                wp.screenshot(path=f"{out}/32-web-load.png", full_page=True)
            wp.get_by_role("tab", name="Overview", exact=True).first.click(force=True)
            wp.wait_for_timeout(2000)
            check(wp.locator(".card-calendar, .card-tasks, .card-checklist").count() == 0, "web: overview is running-only by default")
            wp.screenshot(path=f"{out}/30-web-overview.png")
            pl = wp.get_by_role("tab", name="Planner", exact=True)
            check(pl.count() == 1, "web: Planner tab")
            if pl.count():
                pl.first.click(force=True)
                wp.wait_for_timeout(1500)
                check(wp.locator(".planner-tabs [role=tab]").count() == 3, "web: Planner has Calendar, To-do and Habits")
                wp.screenshot(path=f"{out}/35-web-planner.png")
            wp.get_by_role("tab", name="Training", exact=True).first.click(force=True)
            wp.wait_for_timeout(1500)
            check(wp.locator(".recent-block").count() == 0, "web: trends not on the Plan sub-tab")
            tr = wp.locator(".page-tabs").get_by_role("tab", name="Trends", exact=True)
            if tr.count():
                tr.click()
                wp.wait_for_timeout(2000)
                sc = wp.locator(".recent-block .chart-scroll")
                check(sc.count() == 1, "web: trends chart scrolls")
                if sc.count():
                    print("trends scroll:", sc.evaluate("e => [e.scrollWidth, e.clientWidth, e.scrollLeft]"))
                wp.screenshot(path=f"{out}/36-web-trends.png")
            an = wp.get_by_role("tab", name="Analysis", exact=True)
            check(an.count() == 1, "web: Analysis is a main tab")
            if an.count():
                an.first.click(force=True)
                wp.wait_for_timeout(4000)
                check(wp.locator(".ana-table").count() >= 3, "web: Analysis week, months and weeks tables")
                print("analysis:", wp.locator(".ana").inner_text().replace("\n", " | ")[:900])
                wp.screenshot(path=f"{out}/33-web-analysis.png", full_page=True)
                if wp.locator(".ana-weekbar button").first.count():
                    wp.locator(".ana-weekbar button").first.click()
                    wp.wait_for_timeout(1200)
                    wp.screenshot(path=f"{out}/34-web-analysis-lastweek.png")
            land = ph.new_page()
            land.set_viewport_size({"width": 1280, "height": 900})
            land.goto(cloud + "/about")
            check(land.locator("a[href='/web']").count() >= 1, "website links to the web app")
        except Exception as e:
            print("web:", e)
            fails.append("web app")
        b.close()
finally:
    emu.terminate()
    print("ERRORS:", errors[:15])
    print("FAILS:", fails)
    if fails:
        sys.exit(1)
