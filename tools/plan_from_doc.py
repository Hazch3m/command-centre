#!/usr/bin/env python3
"""
Converts the "Sub-2:50 Training Plan" Claude doc into training-plan.json for
Command Centre's Running card.

Usage:
  python3 tools/plan_from_doc.py <doc-read-output.json> > training-plan.json

<doc-read-output.json> is the raw result of reading the plan tab with the
Claude Docs connector (it contains an "xml" field). Any Claude chat with the
Claude Docs connector can produce it; or just ask Claude to "re-export my
training plan for Command Centre", which runs this script.

The JSON goes in %APPDATA%\\CommandCentre\\training-plan.json; the app picks up
changes automatically.
"""
import json
import re
import sys
from datetime import date

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
PLAN_START_YEAR = 2026  # the plan starts in late October 2026


# The plan is written in date order, so each date is placed in the first year
# that keeps it after the previous one (a small overlap is allowed).
PLAN_START = date(PLAN_START_YEAR, 10, 1)

# Races the plan names without an exact date: usual dates, flagged as approximate.
APPROX = {
    "early december": f"{PLAN_START_YEAR + 1}-12-05",  # Valencia: usually the first Sunday of December
    "late october": f"{PLAN_START_YEAR + 1}-10-24",    # Lausanne half
    "october": f"{PLAN_START_YEAR + 1}-10-24",
    "july": f"{PLAN_START_YEAR + 1}-07-11",
}


def parse_day(text: str, fallback_month: int | None = None, not_before: date = PLAN_START) -> date | None:
    m = re.search(r"(\d{1,2})\s*([A-Za-z]{3})?", text)
    if not m:
        return None
    d = int(m.group(1))
    mon = MONTHS.get((m.group(2) or "").lower()[:3]) if m.group(2) else fallback_month
    if not mon:
        return None
    for y in range(not_before.year, not_before.year + 3):
        try:
            cand = date(y, mon, d)
        except ValueError:
            return None
        if (cand - not_before).days >= -14:
            return cand
    return None


def parse_range(text: str, not_before: date = PLAN_START) -> tuple[str, str] | None:
    """'9 – 15 Nov' or '26 Oct – 1 Nov' or '30 Nov – 6 Dec' → ISO dates."""
    parts = re.split(r"\s*[–-]\s*", text.strip())
    if len(parts) != 2:
        return None
    end = parse_day(parts[1], not_before=not_before)
    if not end:
        return None
    # The start is the latest such date on or before the end (e.g. 28 Dec – 3 Jan).
    m = re.search(r"(\d{1,2})\s*([A-Za-z]{3})?", parts[0])
    start = None
    if m:
        mon = MONTHS.get((m.group(2) or "").lower()[:3]) if m.group(2) else end.month
        start = date(end.year, mon, int(m.group(1)))
        if start > end:
            start = date(end.year - 1, mon, int(m.group(1)))
    return (start.isoformat(), end.isoformat()) if start else None


# Past races and marathon blocks shown on the progression page, carried over from
# the "Running progression review" dashboard (Strava activity ids). New races are
# picked up automatically from Strava's race flag, so this list rarely changes.
HISTORY = {
    "races": [
        {"id": "11452967146", "name": "First 5k", "km": 5},
        {"id": "11500803488", "name": "5k, May 2024", "km": 5},
        {"id": "12088984843", "name": "10k, Aug 2024", "km": 10},
        {"id": "12350678201", "name": "Dingle half", "km": 21.0975},
        {"id": "13372394383", "name": "5k, Jan 2025", "km": 5},
        {"id": "14239914103", "name": "5k time trial, Apr 2025", "km": 5},
        {"id": "14505331136", "name": "Killarney half 2025", "km": 21.0975},
        {"id": "14946184231", "name": "10k time trial, Jun 2025", "km": 10},
        {"id": "15239535708", "name": "Kilkee half", "km": 21.0975},
        {"id": "15806879110", "name": "Charleville half", "km": 21.0975},
        {"id": "16738923605", "name": "Malaga marathon", "km": 42.195},
        {"id": "16872874509", "name": "5k time trial, Dec 2025", "km": 5},
        {"id": "17814416249", "name": "Presinge 10k", "km": 10},
        {"id": "18435848742", "name": "Killarney half 2026", "km": 21.0975},
        {"id": "20314485615", "name": "CERN road race 5.5 km", "km": 5.5},
        {"id": "20727686060", "name": "Lausanne marathon", "km": 42.195},
    ],
    "marathons": [
        {"name": "Malaga", "date": "2025-12-14"},
        {"name": "Milan", "date": "2026-04-12"},
        {"name": "Lausanne", "date": "2026-10-25"},
    ],
}


def text_of(node: str) -> str:
    t = re.sub(r"<[^>]+>", "", node)
    return re.sub(r"\s+", " ", t).strip()


def tables(xml: str):
    """Yields (heading, rows) for each table; rows are lists of cell texts."""
    heading = ""
    pos = 0
    for m in re.finditer(r"<paragraph[^>]*heading='(\d)'[^>]*>(.*?)</paragraph>|<table[^>]*>(.*?)</table>", xml, re.S):
        if m.group(1):
            heading = text_of(m.group(2))
        else:
            rows = []
            for row in re.findall(r"<row[^>]*>(.*?)</row>", m.group(3), re.S):
                rows.append([text_of(c) for c in re.findall(r"<cell[^>]*>(.*?)</cell>", row, re.S)])
            yield heading, rows
        pos = m.end()


def bullets_after(xml: str, label: str) -> list[str]:
    i = xml.find(label)
    if i < 0:
        return []
    lst = re.search(r"<list[^>]*>(.*?)</list>", xml[i:], re.S)
    return [text_of(li) for li in re.findall(r"<listItem[^>]*>(.*?)</listItem>", lst.group(1), re.S)] if lst else []


def km_range(text: str) -> tuple[float | None, float | None]:
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", text)]
    if not nums:
        return None, None
    return (nums[0], nums[1]) if len(nums) > 1 and "–" in text else (nums[0], nums[0])


def main():
    raw = json.load(open(sys.argv[1]))
    xml = raw.get("data", raw).get("xml") if isinstance(raw, dict) else None
    if not xml:
        sys.exit("No 'xml' field found in the doc read output.")

    plan = {
        "version": 1,
        "title": "Sub-2:45 Training Plan",
        "exported": date.today().isoformat(),
        "source": "Claude doc: Sub-2:50 Training Plan — Nov 2026 to Edinburgh",
        "phases": [],
        "races": [],
        "weeks": [],
        "paces": [],
        "structure": [],
        "strength": {"A": bullets_after(xml, "Strength A"), "B": bullets_after(xml, "Strength B")},
        "rules": bullets_after(xml, "Rules to stay healthy"),
        "benchmarks": [],
        "blocks": [],
        "history": HISTORY,
    }

    for heading, rows in tables(xml):
        head = [h.lower() for h in rows[0]]
        body = rows[1:]
        if head[:2] == ["date", "race"]:
            last = PLAN_START
            for r in body:
                d = parse_day(r[0], not_before=last)
                approx = False
                if not d:
                    d, approx = APPROX.get(r[0].lower(), (None, False)), True
                    d = date.fromisoformat(d) if d else None
                if d:
                    last = d
                plan["races"].append({"date": d.isoformat() if d else None, "approx": approx and d is not None, "when": r[0], "name": r[1], "target": r[2], "role": r[3]})
        elif head[0] == "zone":
            for r in body:
                plan["paces"].append({"zone": r[0], "now": r[1], "autumn": r[2], "hr": r[3], "use": r[4]})
        elif head[0] == "day":
            for r in body:
                plan["structure"].append({"day": r[0], "phases12": r[1], "phase3": r[2]})
        elif head[0] == "checkpoint":
            last = PLAN_START
            for r in body:
                d = parse_day(r[1], not_before=last) or (date.fromisoformat(APPROX[r[1].lower()]) if r[1].lower() in APPROX else None)
                last = d or last
                plan["benchmarks"].append({"name": r[0], "date": d.isoformat() if d else None, "when": r[1], "onTrack": r[2], "behind": r[3]})
        elif head[0] == "week" and "dates" in head:
            phase = heading
            # Column 4 is Thursday in most phases, Wednesday in phase 3.
            mid = "wed" if head[4].startswith("wed") else "thu"
            for r in body:
                prev = date.fromisoformat(plan["weeks"][-1]["end"]) if plan["weeks"] and plan["weeks"][-1]["end"] else PLAN_START
                rng = parse_range(r[1], not_before=prev)
                lo, hi = km_range(r[2])
                plan["weeks"].append({
                    "week": r[0], "start": rng[0] if rng else None, "end": rng[1] if rng else None, "phase": phase,
                    "km": r[2], "kmMin": lo, "kmMax": hi,
                    "sessions": {"tue": r[3], mid: r[4], "sun": r[5]}, "notes": r[6] if len(r) > 6 else "",
                })
        elif head[0].startswith("weeks after"):
            for r in body:
                rng = parse_range(r[1], not_before=date(PLAN_START_YEAR + 1, 5, 30))
                lo, hi = km_range(r[3])
                plan["blocks"].append({"name": r[2], "start": rng[0] if rng else None, "end": rng[1] if rng else None, "km": r[3], "kmMin": lo, "kmMax": hi, "key": r[4], "race": r[5]})

    # Phase summaries from the overview bullets ("Base (9 Nov – 3 Jan): …")
    for b in bullets_after(xml, "The phases:"):
        m = re.match(r"(.+?) \((.+?)\): (.*)", b)
        if m:
            rng = parse_range(m.group(2), not_before=date.fromisoformat(plan["phases"][-1]["start"]) if plan["phases"] and plan["phases"][-1]["start"] else PLAN_START)
            plan["phases"].append({"name": m.group(1), "start": rng[0] if rng else None, "end": rng[1] if rng else None, "summary": m.group(3)})
    json.dump(plan, sys.stdout, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
