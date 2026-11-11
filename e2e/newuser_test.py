"""A brand-new user, end to end (no watch, no runs): sign in, build a plan from a race time,
every page, races, import, a workout, settings and deleting the account. Based on the phone test against the real sync service (local stand-in): sign in, Garmin runs arrive,
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
EMU = 8812
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
  signInWithApple: async () => ({ identityToken: 'test:newbie' + Date.now() }),
  garminLogin: async () => ({ ticket: 'ST-0000001-TESTTICKET' }),
}) };
"""
# A drag across the page: start, eight moves, and (unless `hold`) let go.
SW = """async ([sel, x0, x1, y, hold]) => { const m = document.querySelector(sel); const mk = (type, x) => { const t = new Touch({identifier: 1, target: m, clientX: x, clientY: y}); m.dispatchEvent(new TouchEvent(type, {touches: type==='touchend'?[]:[t], changedTouches: [t], bubbles: true, cancelable: true})); };
  mk('touchstart', x0); for (let i = 1; i <= 8; i++) { mk('touchmove', x0 + (x1 - x0) * i / 8); await new Promise(r => setTimeout(r, 16)); } if (!hold) mk('touchend', x1); }"""
END = """([sel, x]) => { const m = document.querySelector(sel); const t = new Touch({identifier: 1, target: m, clientX: x, clientY: 600}); m.dispatchEvent(new TouchEvent('touchend', {touches: [], changedTouches: [t], bubbles: true, cancelable: true})); }"""


def shot(name):
    pp.screenshot(path=f"{out}/{name}.png", full_page=True)


def tab(name):
    pp.locator(".p-tabs").get_by_role("tab", name=name, exact=True).click()
    pp.wait_for_timeout(1500)


def text():
    return pp.locator(".p-pane.on, .p-pushed").first.inner_text()


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ph = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, timezone_id="Europe/Paris")
        ph.add_init_script(FAKE_NATIVE)
        pp = ph.new_page()
        pp.on("pageerror", lambda e: errors.append("phone: " + str(e)))
        pp.on("console", lambda m: m.type == "error" and errors.append("phone console: " + m.text[:300]))
        pp.goto(cloud + "/")
        pp.wait_for_selector(".apple-btn", timeout=30000)
        shot("n01-sign-in")
        pp.locator(".apple-btn").click()
        pp.wait_for_selector(".p-app", timeout=60000)
        pp.wait_for_timeout(2500)
        shot("n02-getting-started")
        check(pp.locator(".p-start-step").count() >= 2, "new: getting started steps")

        # Every tab renders with nothing in it.
        check(pp.locator(".p-tabs [role=tab]").count() == 4, "new: four tabs (no Planner until you turn it on)")
        tw = pp.evaluate("() => { const t = [...document.querySelectorAll('.p-tabs [role=tab]')].map(e => e.getBoundingClientRect()); return [Math.round(t[0].left), Math.round(t[t.length - 1].right), innerWidth]; }")
        check(tw[0] < 20 and tw[1] > tw[2] - 20, f"new: the four tabs span the bar ({tw})")
        for t in ["Today", "Plan", "Runs", "Stats"]:
            tab(t)
            shot(f"n03-empty-{t.lower()}")
            check(len(text().strip()) > 20, f"new: {t} has something to say with no data")

        # Build a plan with no runs: a suggestion, then a race time for the paces.
        tab("Plan")
        btn = pp.get_by_role("button", name="Build your plan")
        if not btn.count():
            tab("Today")
            btn = pp.locator(".p-start-step", has_text="plan")
        btn.first.click()
        pp.wait_for_timeout(2500)
        check("Looking at your training" not in pp.locator(".p-pushed").inner_text(), "new: the builder opens with no runs (no endless 'Looking at your training')")
        sug = pp.locator(".pb-sug")
        check(sug.count() == 4, f"new: four suggested plans ({sug.count()})")
        shot("n04-builder-suggestions")
        if sug.count():
            sug.nth(1).click()
            pp.wait_for_timeout(800)
        man = None
        for step in range(8):
            if pp.locator(".pb-manual").count() and man is None:
                man = True
                pp.locator(".pb-manual input").fill("50:00")
                pp.wait_for_timeout(800)
                check("VDOT" in pp.locator(".pb-manual").inner_text(), "new: a 10K time sets the paces")
                shot("n05-builder-fitness")
            use = pp.get_by_role("button", name=re.compile("Use this plan|Tap again to replace"))
            if use.count():
                shot("n06-builder-review")
                use.first.click()
                pp.wait_for_timeout(1500)
                if pp.get_by_role("button", name=re.compile("Tap again")).count():
                    pp.get_by_role("button", name=re.compile("Tap again")).first.click()
                    pp.wait_for_timeout(2000)
                break
            nxt = pp.locator(".pb-nav .btn-primary")
            if not nxt.count():
                print("builder stuck at", step, pp.locator(".p-pushed").inner_text()[:300].replace("\n", " | "))
                break
            nxt.last.click()
            pp.wait_for_timeout(1200)
        check(man is True, "new: asked for a race time (no runs)")
        while pp.locator(".p-back").count():
            pp.locator(".p-back").click()
            pp.wait_for_timeout(800)
        tab("Plan")
        check(pp.locator(".p-subnav").count() == 1, "new: plan built")
        shot("n07-plan-week")
        w1 = pp.get_by_role("button", name="See week 1 ›")
        check(w1.count() == 1 or "Week 1" in pp.locator(".p-pane.on").inner_text(), "new: says when the plan starts")
        if w1.count():
            w1.click()
            pp.wait_for_timeout(1200)
            shot("n07b-plan-week1")
        wk = pp.locator(".p-pane.on").inner_text()
        print("plan week:", wk[:400].replace("\n", " | "))
        print("has paces in week:", bool(re.search(r"\d:\d\d", wk)))

        # Every Plan view.
        for v in ["Plan", "Progress", "Races"]:
            pp.locator(".p-subnav").get_by_role("tab", name=v, exact=True).click()
            pp.wait_for_timeout(1500)
            shot(f"n08-plan-{v.split()[0].lower()}")
            check(len(text().strip()) > 40, f"new: Plan/{v} renders")
        pp.locator(".p-subnav").get_by_role("tab", name="Week", exact=True).click()
        pp.wait_for_timeout(1000)

        # Races: add one and save.
        pp.locator(".p-pane.on .p-adjust-btn").click()
        pp.wait_for_timeout(1200)
        pp.locator(".p-pushed [role=tablist] button", has_text=re.compile("^Races$")).click()
        pp.wait_for_timeout(1000)
        n0 = pp.locator(".rm-summary").count()
        pp.get_by_role("button", name="+ Add a race").click()
        pp.wait_for_timeout(600)
        ed = pp.locator(".rm-edit").last
        ed.locator("input").first.fill("Spring 10K")
        if ed.locator("input[type=date]").count():
            ed.locator("input[type=date]").first.fill("2027-04-11")
        pp.wait_for_timeout(300)
        pp.get_by_role("button", name=re.compile("^Save")).last.click()
        pp.wait_for_timeout(2000)
        shot("n09-races")
        check(pp.locator(".rm-summary").count() == n0 + 1 and "Spring 10K" in pp.locator(".p-pushed").inner_text(), "new: a race added")

        # Import: the example CSV.
        pp.locator(".p-pushed [role=tablist] button", has_text=re.compile("^Import$")).click()
        pp.wait_for_timeout(1000)
        pp.get_by_role("button", name="Show examples").click()
        pp.get_by_role("button", name="Try it").first.click()
        pp.wait_for_timeout(1500)
        shot("n10-import-preview")
        u = pp.get_by_role("button", name=re.compile("Use this plan"))
        check(u.count() >= 1, "new: imported plan previewed")
        if u.count():
            u.first.click()
            pp.wait_for_timeout(500)
            pp.get_by_role("button", name=re.compile("Tap again")).first.click()
            pp.wait_for_timeout(2500)
            check("now follows" in pp.locator(".p-pushed").inner_text(), "new: imported plan used")
            b2 = pp.get_by_role("button", name="Bring back my previous plan")
            if b2.count():
                b2.click()
                pp.wait_for_timeout(2000)
                check("previous plan is back" in pp.locator(".p-pushed").inner_text(), "new: previous plan brought back")
        shot("n11-import-done")
        while pp.locator(".p-back").count():
            pp.locator(".p-back").click()
            pp.wait_for_timeout(800)

        # A workout, then send it: without a watch it says how to connect.
        tab("Plan")
        if pp.locator(".p-wfab").count():
            pp.locator(".p-wfab").click()
            pp.wait_for_timeout(1500)
            shot("n12-workout")
            check("Your paces come from your race fitness" not in pp.locator(".p-pushed").inner_text() and pp.locator(".wc-step").count() > 0, "new: workout builder has paces from the race time")
            send = pp.get_by_role("button", name=re.compile("Send to|Save"))
            print("workout buttons:", [x.strip() for x in pp.locator(".p-pushed button").all_inner_texts()][-8:])
            if send.count():
                send.last.click()
                pp.wait_for_timeout(2500)
            shot("n13-workout-sent")
            print("after send:", pp.locator(".p-pushed").inner_text()[-300:].replace("\n", " | ") if pp.locator(".p-pushed").count() else "closed")
            while pp.locator(".p-back").count():
                pp.locator(".p-back").click()
                pp.wait_for_timeout(800)

        tab("Today")
        shot("n14-today-with-plan")
        check(pp.locator(".p-pane.on .wa").count() == 1, "new: Today shows the week ahead")
        tab("Stats")
        shot("n15-stats")

        # Settings: load focus source, then delete the account.
        pp.locator(".p-gear").click()
        pp.wait_for_timeout(1200)
        shot("n16-settings")
        if pp.get_by_role("button", name="Pacelife's").count():
            pp.get_by_role("button", name="Pacelife's").click()
            pp.wait_for_timeout(600)
            check("won't match your watch" in pp.locator(".p-pushed").inner_text(), "new: load focus source switches")
        d = pp.get_by_role("button", name=re.compile("Delete (my )?account"))
        check(d.count() == 1, "new: delete account offered")
        if d.count():
            d.click()
            pp.wait_for_timeout(500)
            pp.get_by_role("button", name=re.compile("Tap again|Delete")).first.click()
            pp.wait_for_timeout(4000)
            shot("n17-deleted")
            check(pp.locator(".apple-btn").count() == 1, "new: account deleted, back to sign-in")
        b.close()
except Exception as e:
    import traceback

    traceback.print_exc()
    errors.append("test crashed: " + str(e)[:300])
    try:
        pp.screenshot(path=f"{out}/n99-crash.png", full_page=True)
    except Exception:
        pass
finally:
    emu.terminate()
    print("ERRORS:", errors)
    print("FAILS:", fails)
    if fails or any("crashed" in e or "pageerror" in e for e in errors):
        sys.exit(1)
