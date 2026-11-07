"""App Store Connect checks before a build: registers the app's bundle ID if
it isn't yet, and stops with clear instructions if the app record is missing
(Apple only lets you create that on the website). Reads the API key from the
environment (GitHub secrets); prints nothing secret."""
import json, os, sys, time, urllib.error, urllib.request

import jwt  # PyJWT

BUNDLE = sys.argv[1]
API = "https://api.appstoreconnect.apple.com/v1"


def token():
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        os.environ["KEY_P8"],
        algorithm="ES256",
        headers={"kid": os.environ["KEY_ID"], "typ": "JWT"},
    )


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        if e.code == 401:
            sys.exit("::error::App Store Connect refused the API key. Check APPSTORE_KEY_ID, APPSTORE_ISSUER_ID and APPSTORE_KEY_P8 (the whole .p8 file, including the BEGIN/END lines).")
        if e.code == 403:
            sys.exit("::error::The API key isn't allowed to do this. Make it a Team key with the Admin role.")
        sys.exit(f"::error::App Store Connect answered {e.code}: {detail}")


ids = [b for b in call("GET", f"/bundleIds?filter[identifier]={BUNDLE}&limit=5")["data"] if b["attributes"]["identifier"] == BUNDLE]
if not ids:
    ids = [call("POST", "/bundleIds", {"data": {"type": "bundleIds", "attributes": {"identifier": BUNDLE, "name": "Pacelife", "platform": "IOS"}}})["data"]]
    print(f"Registered the bundle ID {BUNDLE}")
else:
    print(f"Bundle ID {BUNDLE} is registered")

# Sign in with Apple on the app's ID (the signing profile then includes it).
caps = call("GET", f"/bundleIds/{ids[0]['id']}/bundleIdCapabilities")["data"]
if not any(c["attributes"].get("capabilityType") == "APPLE_ID_AUTH" for c in caps):
    call("POST", "/bundleIdCapabilities", {"data": {"type": "bundleIdCapabilities", "attributes": {"capabilityType": "APPLE_ID_AUTH", "settings": [{"key": "APPLE_ID_AUTH_APP_CONSENT", "options": [{"key": "PRIMARY_APP_CONSENT"}]}]}, "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": ids[0]["id"]}}}}})
    print("Switched on Sign in with Apple for the app")

apps = call("GET", f"/apps?filter[bundleId]={BUNDLE}&limit=5")["data"]
if not apps:
    sys.exit(
        "::error::One manual step left: in App Store Connect choose Apps → + → New App, platform iOS, "
        f"name 'Pacelife' (or any free name), bundle ID {BUNDLE}, SKU commandcentre. Then run this workflow again."
    )
print(f"App record found: {apps[0]['attributes']['name']}")


# The app's name in App Store Connect and TestFlight (best effort: Apple may say the name is taken).
WANT = "Pacelife"
def try_call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        print(f"::warning::Couldn't rename the app to {WANT} in App Store Connect ({e.code}): {e.read().decode(errors='replace')[:300]}")
        return None

if apps[0]["attributes"]["name"] != WANT:
    infos = try_call("GET", f"/apps/{apps[0]['id']}/appInfos") or {"data": []}
    for info in infos["data"]:
        locs = try_call("GET", f"/appInfos/{info['id']}/appInfoLocalizations") or {"data": []}
        for loc in locs["data"]:
            if loc["attributes"].get("name") != WANT and try_call("PATCH", f"/appInfoLocalizations/{loc['id']}", {"data": {"type": "appInfoLocalizations", "id": loc["id"], "attributes": {"name": WANT}}}):
                print(f"Renamed the app to {WANT} ({loc['attributes'].get('locale')})")
