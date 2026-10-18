#!/usr/bin/env python3
"""Check docs/data/announcements.json before it is published.

Rules:
  * every closure has an id, an area, from/to dates (YYYY-MM-DD, from <= to,
    at most 31 days), what it covers, who announced it and when;
  * every source is an https link on an allowed domain (Bernama only);
  * state and district names match the official boundaries in
    docs/data/boundaries.json, so the page can find the area;
  * ids are unique.
Exit code 0 when everything is valid, 1 otherwise (with the problems listed).
Python standard library only.
"""
import json
import re
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
ANN = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "data" / "announcements.json"
BOUNDS = ROOT / "docs" / "data" / "boundaries.json"
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def norm(s):
    s = re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()
    s = re.sub(r"^(wilayah persekutuan|federal territory of|w p|wp|daerah|district of)\s+", "", s)
    return {"pulau pinang": "penang", "malacca": "melaka"}.get(s, s)


def parse_day(s):
    if not isinstance(s, str) or not DATE.match(s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def check(data, bounds):
    errors = []
    allowed = [d.lower() for d in data.get("source_policy", {}).get("allowed_domains", [])]
    if allowed != ["bernama.com"]:
        errors.append("source_policy.allowed_domains must be exactly [\"bernama.com\"]")
    states = {}
    for d in bounds.get("districts", []):
        states.setdefault(norm(d["state"]), set()).add(norm(d["district"]))
    seen = set()
    for i, c in enumerate(data.get("closures", [])):
        where = f"closure {c.get('id') or i}"
        if not c.get("id"):
            errors.append(f"{where}: missing id")
        elif c["id"] in seen:
            errors.append(f"{where}: duplicate id")
        seen.add(c.get("id"))
        f, t = parse_day(c.get("from")), parse_day(c.get("to"))
        if not f or not t:
            errors.append(f"{where}: from/to must be dates like 2026-10-19")
        elif f > t:
            errors.append(f"{where}: from is after to")
        elif (t - f).days > 31:
            errors.append(f"{where}: longer than 31 days; check the dates")
        for k in ("covers", "announced_by"):
            if not str(c.get(k) or "").strip():
                errors.append(f"{where}: missing {k}")
        if not parse_day(c.get("announced_on")):
            errors.append(f"{where}: announced_on must be a date")
        area = c.get("area") or {}
        st_list = area.get("states") or []
        dist = area.get("districts") or []
        codes = area.get("school_codes") or []
        if not (st_list or dist or codes):
            errors.append(f"{where}: area needs states, districts or school_codes")
        for s in st_list:
            if norm(s) not in states:
                errors.append(f"{where}: unknown state '{s}'")
        if dist:
            st = area.get("state")
            if not st or norm(st) not in states:
                errors.append(f"{where}: districts need a known 'state'")
            else:
                for d in dist:
                    if norm(d) not in states[norm(st)]:
                        errors.append(f"{where}: unknown district '{d}' in {st}")
        srcs = c.get("sources") or []
        if not srcs:
            errors.append(f"{where}: needs at least one source")
        for s in srcs:
            u = urlparse(str(s.get("url") or ""))
            host = (u.hostname or "").lower()
            if u.scheme != "https" or not any(host == d or host.endswith("." + d) for d in allowed or ["bernama.com"]):
                errors.append(f"{where}: source must be an https link on bernama.com, got '{s.get('url')}'")
            if not str(s.get("title") or "").strip():
                errors.append(f"{where}: source needs a title")
    return errors


def main():
    try:
        data = json.loads(ANN.read_text(encoding="utf-8"))
        bounds = json.loads(BOUNDS.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(f"Could not read the files: {err}")
        return 1
    errors = check(data, bounds)
    if errors:
        print("Announcements are NOT valid:")
        for e in errors:
            print(" -", e)
        return 1
    print(f"Announcements valid: {len(data.get('closures', []))} closure(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
