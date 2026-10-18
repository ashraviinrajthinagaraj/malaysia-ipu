#!/usr/bin/env python3
"""Calendar feeds of official haze school closures, one per state and one for all.

Reads docs/data/announcements.json (Bernama-reported closures only) and writes
docs/data/cal/<state>.ics, docs/data/cal/all.ics and docs/data/cal/index.json.
People subscribe to a feed in their calendar app; the app re-reads it on its own
schedule, so new closures, extensions and early reopenings appear by themselves.

Only closures that pass the same checks as scripts/check_announcements.py are
included. Closures given as a list of school codes go only into all.ics.
The files change only when the announcements change. Python standard library only.
"""
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("IPU_DATA_DIR", ROOT / "docs" / "data"))
ANN = DATA / "announcements.json"
BOUNDS = DATA / "boundaries.json"
OUT = DATA / "cal"
SITE = os.environ.get("SITE_URL", "https://ashraviinrajthinagaraj.github.io/malaysia-ipu/")

sys.path.insert(0, str(ROOT / "scripts"))
from check_announcements import check, norm  # noqa: E402


def slug(state):
    s = re.sub(r"^(w\.?\s*p\.?|wilayah persekutuan)\s+", "", state.strip(), flags=re.I)
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def esc(text):
    return (str(text).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n"))


def fold(line):
    """Lines longer than 75 octets are folded (RFC 5545), never inside a UTF-8 character."""
    out, cur = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > (75 if not out else 74):
            out.append(cur)
            cur = b""
        cur += b
    out.append(cur)
    return "\r\n ".join(x.decode("utf-8") for x in out)


def utc_stamp(iso):
    try:
        d = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        d = datetime(2026, 1, 1, tzinfo=timezone.utc)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone(timedelta(hours=8)))
    return d.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def area_text(c):
    a = c.get("area") or {}
    if a.get("states"):
        return ", ".join(a["states"])
    if a.get("districts"):
        return ", ".join(a["districts"]) + " (" + a.get("state", "") + ")"
    codes = a.get("school_codes") or []
    return f"{len(codes)} listed school" + ("s" if len(codes) != 1 else "")


def event(c, stamp):
    start = date.fromisoformat(c["from"])
    end = date.fromisoformat(c["to"]) + timedelta(days=1)          # DTEND is exclusive
    ufn = bool(c.get("until_further_notice"))
    summary = ("Schools closed (haze) until further notice: " if ufn else "Schools closed (haze): ") + area_text(c)
    src = (c.get("sources") or [{}])[0]
    parts = [c.get("covers", "")]
    for k in ("learning", "not_covered", "exceptions", "dates_note", "previous"):
        if c.get(k):
            parts.append(c[k])
    if ufn:
        parts.append("Announced until further notice: the end date moves forward each day until Bernama reports a reopening.")
    parts.append(f"Announced by {c.get('announced_by', '')} on {c.get('announced_on', '')}.")
    for s in c.get("sources") or []:
        parts.append(f"Reported by Bernama: {s.get('title', '')} {s.get('url', '')}")
    parts.append(f"From the IPU Malaysia dashboard (independent, not an official service): {SITE}")
    lines = [
        "BEGIN:VEVENT",
        f"UID:{c['id']}@malaysia-ipu",
        f"DTSTAMP:{stamp}",
        f"LAST-MODIFIED:{utc_stamp(c.get('added_at'))}",
        f"DTSTART;VALUE=DATE:{start:%Y%m%d}",
        f"DTEND;VALUE=DATE:{end:%Y%m%d}",
        f"SUMMARY:{esc(summary)}",
        f"DESCRIPTION:{esc(chr(10).join(p for p in parts if p))}",
        f"URL:{src.get('url', SITE)}",
        "STATUS:CONFIRMED",
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
    ]
    return lines


def calendar(name, desc, closures, stamp):
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//IPU Malaysia//Haze school closures//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{esc(name)}",
        f"X-WR-CALDESC:{esc(desc)}",
        "X-WR-TIMEZONE:Asia/Kuala_Lumpur",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
        "X-PUBLISHED-TTL:PT1H",
    ]
    for c in sorted(closures, key=lambda x: (x["from"], x["id"])):
        lines += event(c, stamp)
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(x) for x in lines) + "\r\n"


def covers_state(c, state):
    a = c.get("area") or {}
    if any(norm(s) == norm(state) for s in a.get("states") or []):
        return True
    return bool(a.get("districts")) and norm(a.get("state")) == norm(state)


def main():
    data = json.loads(ANN.read_text(encoding="utf-8"))
    bounds = json.loads(BOUNDS.read_text(encoding="utf-8"))
    policy = data.get("source_policy", {})
    good = []
    for c in data.get("closures", []):
        errs = check({"source_policy": policy, "closures": [c]}, bounds)
        if errs:
            print(f"Skipped {c.get('id')}: {errs[0]}")
            continue
        good.append(c)
    stamp = utc_stamp(data.get("updated_at"))
    states = sorted({d["state"] for d in bounds["districts"]})
    OUT.mkdir(parents=True, exist_ok=True)
    desc = ("Official haze school closures as reported by Bernama, from the IPU Malaysia dashboard "
            "(an independent site, not an official service). Confirm with your school or JPN.")
    index = {"site": SITE, "note": "Bernama-reported official closures only.", "feeds": []}
    files = {"all.ics": calendar("Haze school closures: Malaysia (IPU Malaysia)", desc, good, stamp)}
    index["feeds"].append({"state": None, "name": "All states", "file": "all.ics"})
    for st in states:
        f = slug(st) + ".ics"
        files[f] = calendar(f"Haze school closures: {st} (IPU Malaysia)", desc, [c for c in good if covers_state(c, st)], stamp)
        index["feeds"].append({"state": st, "name": st, "file": f})
    for name, text in files.items():
        p = OUT / name
        if not p.exists() or p.read_bytes() != text.encode("utf-8"):
            p.write_bytes(text.encode("utf-8"))
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Calendars: {len(files)} feeds, {len(good)} closure(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
