"""Fits Capacitor's fresh Android project to Pacelife (run from mobile/ (as ../android/setup.py) after `npx cap add android`)."""
import os, re, shutil, sys
from PIL import Image

A = "android/app"
pkg = f"{A}/src/main/java/com/hazch3m/commandcentre"
for f in ("CCNativePlugin.java", "MainActivity.java"):
    shutil.copy(f"../android/{f}", f"{pkg}/{f}")

# Sign-ins that finish in the browser come back on commandcentre://
m = f"{A}/src/main/AndroidManifest.xml"
s = open(m).read()
if "commandcentre" not in s:
    s = s.replace(
        "</activity>",
        """    <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="commandcentre" />
            </intent-filter>
        </activity>""",
        1,
    )
s = s.replace('android:launchMode="singleTask"', 'android:launchMode="singleTask"')
if "launchMode" not in s:
    s = s.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:launchMode="singleTask"', 1)
open(m, "w").write(s)

# Icons and splash from the iPhone app's artwork (plain PNGs; no adaptive icon).
shutil.rmtree(f"{A}/src/main/res/mipmap-anydpi-v26", ignore_errors=True)
icon = Image.open("assets/icon-1024.png").convert("RGBA")
for d, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    p = f"{A}/src/main/res/mipmap-{d}"
    os.makedirs(p, exist_ok=True)
    for n in ("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"):
        icon.resize((px, px), Image.LANCZOS).save(f"{p}/{n}")
splash = Image.open("assets/splash-2732.png").convert("RGB")
for root, _, files in os.walk(f"{A}/src/main/res"):
    for f in files:
        if f == "splash.png":
            w, h = Image.open(f"{root}/{f}").size
            side = max(w, h)
            splash.resize((side, side), Image.LANCZOS).crop(((side - w) // 2, (side - h) // 2, (side - w) // 2 + w, (side - h) // 2 + h)).save(f"{root}/{f}")

# Version from the CI run; release signing from GitHub secrets when they're set.
g = f"{A}/build.gradle"
s = open(g).read()
code = os.environ.get("VERSION_CODE", "1")
s = re.sub(r"versionCode \d+", f"versionCode {code}", s)
s = re.sub(r'versionName "[^"]*"', f'versionName "1.0.{code}"', s)
if os.environ.get("KEYSTORE_FILE"):
    s = s.replace(
        "    buildTypes {",
        """    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_FILE"))
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
    buildTypes {""",
        1,
    )
    s = re.sub(r"(release \{\n\s*minifyEnabled false)", r"\1\n            signingConfig signingConfigs.release", s, 1)
    assert "signingConfig signingConfigs.release" in s, "couldn't add release signing"
open(g, "w").write(s)
print("android project ready, versionCode", code)
