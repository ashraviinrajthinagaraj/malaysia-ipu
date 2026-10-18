#!/usr/bin/env python3
"""Rule vs reality: compare each official school closure with the official
DOE APIMS readings in the closed area, and with the national rule
(schools close when the IPU reaches 200).

For every closure in docs/data/announcements.json (Bernama sources only)
announced in the last 30 days, it works out:
  * the stations in the closed area (stations inside the state, or inside
    the listed districts using the official boundaries; if a district has
    no station, the nearest station is used and this is said);
  * the 24 hours and the 3 days before the announcement: highest reading,
    which stations reached 200, how many were above 100;
  * each day from 2 days before the announcement to the end of the closure
    (or today): the highest reading in the area and the stations at 200+.

Readings come only from DOE APIMS: the hourly readings already saved in
docs/data/latest.json (last 48 hours) plus, for older hours, the APIMS
hourly table, which keeps about a week. Hours are stored in
data_cache/closure_hours.json so they are kept after APIMS drops them.
Writes docs/data/rule_reality.json. Python standard library only.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

MYT = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("IPU_DATA_DIR", ROOT / "docs" / "data"))
CACHE = Path(os.environ.get("IPU_CACHE_DIR", ROOT / "data_cache"))
OUT = DATA / "rule_reality.json"
HOURS = CACHE / "closure_hours.json"
TABLE_URL = os.environ.get("APIMS_TABLE_URL", "https://eqms.doe.gov.my/api3/publicportalapims/apitablehourly")
USER_AGENT = "Mozilla/5.0 (compatible; MalaysiaIPUDashboard/1.0; rule vs reality, a few requests per hour)"
THRESHOLD = 200
LOOKBACK_DAYS = 30           # closures announced within this many days are analysed
APIMS_KEEPS_DAYS = 7         # APIMS hourly table only goes back about a week
MIN_HOURS = 18               # hours of data needed to call a 24-hour window (or a day) complete
RETRY_WAIT = float(os.environ.get("APIMS_RETRY_WAIT", "4"))


def log(msg):
    print(msg, flush=True)


def now_myt():
    forced = os.environ.get("IPU_NOW")
    if forced:
        return datetime.fromisoformat(forced).replace(tzinfo=MYT)
    return datetime.now(MYT).replace(microsecond=0)


def hkey(dt):
    return dt.astimezone(MYT).strftime("%Y-%m-%dT%H:00")


def parse_hkey(k):
    return datetime.fromisoformat(k[:16]).replace(tzinfo=MYT)


def norm(s):
    s = re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()
    s = re.sub(r"^(wilayah persekutuan|federal territory of|w p|wp|daerah|district of)\s+", "", s)
    return {"pulau pinang": "penang", "malacca": "melaka"}.get(s, s)


def to_api(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f < 0 else (int(f) if f == int(f) else round(f, 1))


# ---------------------------------------------------------------- geometry

def in_ring(x, y, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def locate(lon, lat, bounds):
    for d in bounds.get("districts", []):
        b = d["bbox"]
        if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
            continue
        for poly in d["polygons"]:
            if in_ring(lon, lat, poly[0]) and not any(in_ring(lon, lat, h) for h in poly[1:]):
                return d["state"], d["district"]
    return None, None


def area_stations(c, stations, bounds):
    """(stations, basis text) for the closure's area."""
    area = c.get("area") or {}
    if area.get("states"):
        want = {norm(s) for s in area["states"]}
        return [s for s in stations if norm(s.get("state")) in want], "all DOE stations in " + ", ".join(area["states"])
    if area.get("districts") and area.get("state"):
        want = {norm(d) for d in area["districts"]}
        inside = []
        for s in stations:
            if not isinstance(s.get("lat"), (int, float)):
                continue
            st, di = locate(s["lon"], s["lat"], bounds)
            if st and norm(st) == norm(area["state"]) and norm(di) in want:
                inside.append(s)
        if inside:
            return inside, "DOE stations inside " + ", ".join(area["districts"])
        # no station inside: nearest station to each district's centre
        chosen = {}
        for d in bounds.get("districts", []):
            if norm(d["state"]) == norm(area["state"]) and norm(d["district"]) in want:
                cx, cy = (d["bbox"][0] + d["bbox"][2]) / 2, (d["bbox"][1] + d["bbox"][3]) / 2
                best = min((s for s in stations if isinstance(s.get("lat"), (int, float))),
                           key=lambda s: (s["lon"] - cx) ** 2 + (s["lat"] - cy) ** 2, default=None)
                if best:
                    chosen[best["id"]] = best
        return list(chosen.values()), "no DOE station inside " + ", ".join(area["districts"]) + "; the nearest station is used"
    return [], "listed schools only; no area to compare"


# ---------------------------------------------------------------- data

def get_json(url, params, tries=3, timeout=40):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8-sig"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
            last = err
            if attempt < tries:
                time.sleep(RETRY_WAIT * attempt)
    raise RuntimeError(f"could not read {url}: {last}")


def fetch_table(state_id, end):
    payload = get_json(TABLE_URL, {"stateid": state_id, "datetime": end.strftime("%Y-%m-%d %H:00:00")})
    rows = payload.get("api_table_hourly") if isinstance(payload, dict) else None
    if rows is None:
        raise RuntimeError("unexpected answer (no api_table_hourly)")
    out = {}
    for r in rows:
        sid, stamp = str(r.get("STATION_ID") or "").strip(), r.get("DATETIME")
        if not sid or not stamp:
            continue
        try:
            k = hkey(datetime.fromisoformat(str(stamp)[:19]).replace(tzinfo=MYT))
        except ValueError:
            continue
        out.setdefault(sid, {})[k] = to_api(r.get("API"))
    return out


def gather_hours(sts, start, end, store, now):
    """Fill store[station][hour] for start..end from latest.json values (already in store)
    and, for hours still missing that APIMS still keeps, from the APIMS hourly table."""
    oldest_ok = now - timedelta(days=APIMS_KEEPS_DAYS) + timedelta(hours=2)
    by_state = {}
    for s in sts:
        if s.get("state_id") is not None:
            by_state.setdefault(s["state_id"], []).append(s["id"])
    t = end
    while t >= start:
        window = [hkey(t - timedelta(hours=h)) for h in range(24)]
        for sid_state, ids in by_state.items():
            missing = any(k not in store.get(i, {}) for i in ids for k in window if parse_hkey(k) >= start)
            if missing and t >= oldest_ok:
                try:
                    got = fetch_table(sid_state, t)
                    for i, hours in got.items():
                        if i in ids:
                            store.setdefault(i, {}).update({k: v for k, v in hours.items() if v is not None or k not in store.get(i, {})})
                    log(f"  APIMS hourly table: state {sid_state}, 24 h to {hkey(t)}")
                except RuntimeError as err:
                    log(f"  APIMS hourly table FAILED (state {sid_state}, {hkey(t)}): {err}")
        t -= timedelta(hours=24)


def window_stats(sts, store, start, end):
    """Highest reading, stations at 200+, stations above 100 and hour coverage for start..end (inclusive)."""
    best, reached, above, hours = None, {}, set(), 0
    for s in sts:
        h = store.get(s["id"], {})
        n = 0
        for k, v in h.items():
            t = parse_hkey(k)
            if v is None or t < start or t > end:
                continue
            n += 1
            if best is None or v > best["api"] or (v == best["api"] and k < best["time"]):
                best = {"api": v, "station": s["id"], "name": s["name"], "time": k}
            if v >= THRESHOLD and (s["id"] not in reached or v > reached[s["id"]]["api"]):
                reached[s["id"]] = {"station": s["id"], "name": s["name"], "api": v, "time": k}
            if v > 100:
                above.add(s["id"])
        hours = max(hours, n)
    span = int((end - start).total_seconds() // 3600) + 1
    return {
        "from": hkey(start), "to": hkey(end), "max": best,
        "reached200": sorted(reached.values(), key=lambda r: -r["api"]),
        "above100": len(above), "stations": len(sts),
        "hours": hours, "span": span, "complete": hours >= span * 0.75,
    }


def day_name(k):
    t = parse_hkey(k)
    return t.strftime("%a ") + str(t.day) + t.strftime(" %b")


def join_names(parts):
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def verdict(before24, before72):
    if not before24["max"]:
        return {"kind": "no_data", "text": "Not enough official readings from before the announcement to compare."}
    n, total = len(before24["reached200"]), before24["stations"]
    if n == 0:
        txt = (f"No station in the area had reached {THRESHOLD} in the 24 hours before the announcement "
               f"(highest {before24['max']['api']} at {before24['max']['name']}).")
        if before72["reached200"]:
            parts = [f"{r['name']} ({r['api']} on {day_name(r['time'])})" for r in before72["reached200"][:3]]
            txt += " Earlier in the 3 days before, " + join_names(parts) + (" had" if len(parts) > 1 else " had") + f" reached {THRESHOLD}."
        return {"kind": "beyond", "text": txt}
    if n >= total:
        return {"kind": "matches", "text": f"Every station in the area had reached {THRESHOLD} in the 24 hours before the announcement."}
    return {"kind": "partly", "text": f"{n} of {total} stations in the area had reached {THRESHOLD} in the 24 hours before the announcement."}


def bernama_only(c):
    for s in c.get("sources") or []:
        m = re.match(r"^https://([^/?#]+)", str(s.get("url") or ""), re.I)
        host = m.group(1).lower() if m else ""
        if not (host == "bernama.com" or host.endswith(".bernama.com")):
            return False
    return bool(c.get("sources"))


def main():
    now = now_myt()
    try:
        ann = json.loads((DATA / "announcements.json").read_text(encoding="utf-8"))
        latest = json.loads((DATA / "latest.json").read_text(encoding="utf-8"))
        bounds = json.loads((DATA / "boundaries.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        log(f"Missing input: {err}")
        return 0
    try:
        prev = json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prev = {}
    try:
        store = json.loads(HOURS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        store = {}

    stations = latest.get("stations", [])
    for s in stations:                                   # newest official hours from the hourly update
        for k, v in s.get("hourly") or []:
            if v is not None:
                store.setdefault(s["id"], {})[k] = v

    results = dict(prev.get("closures", {}))
    for c in ann.get("closures", []):
        if not bernama_only(c):
            continue
        src = (c.get("sources") or [{}])[0]
        try:
            announced = datetime.fromisoformat(src["published"]).astimezone(MYT) if src.get("published") else \
                datetime.fromisoformat(c["announced_on"] + "T20:00:00").replace(tzinfo=MYT)
        except (KeyError, ValueError):
            continue
        if now - announced > timedelta(days=LOOKBACK_DAYS):
            continue                                      # keep the stored result as it is
        sts, basis = area_stations(c, stations, bounds)
        if not sts:
            results[c["id"]] = {"basis": basis, "announced_at": announced.isoformat(), "verdict": {"kind": "no_area", "text": basis}}
            continue
        ann_hour = announced.replace(minute=0, second=0)
        first_day = (announced - timedelta(days=2)).replace(hour=0, minute=0, second=0)
        last_day_d = min(datetime.fromisoformat(c["to"]).date(), now.date())
        end = min(now.replace(minute=0, second=0), datetime.combine(last_day_d, datetime.min.time()).replace(tzinfo=MYT, hour=23))
        log(f"{c['id']}: {len(sts)} stations ({basis})")
        gather_hours(sts, min(first_day, ann_hour - timedelta(hours=71)), end, store, now)

        before24 = window_stats(sts, store, ann_hour - timedelta(hours=23), ann_hour)
        before72 = window_stats(sts, store, ann_hour - timedelta(hours=71), ann_hour)
        days = []
        d = first_day
        while d.date() <= last_day_d:
            day_end = min(d.replace(hour=23), end)
            if day_end >= d:
                w = window_stats(sts, store, d, day_end)
                if w["max"]:
                    days.append({"date": d.date().isoformat(), "max": w["max"], "reached200": len(w["reached200"]),
                                 "above100": w["above100"], "hours": w["hours"],
                                 "closed": c["from"] <= d.date().isoformat() <= c["to"],
                                 "partial_day": day_end.hour < 23 or w["hours"] < MIN_HOURS})
            d += timedelta(days=1)
        old = results.get(c["id"], {})
        # never replace a stored window with one that has fewer hours (APIMS drops old data)
        if old.get("before24", {}).get("hours", 0) > before24["hours"]:
            before24 = old["before24"]
        if old.get("before72", {}).get("hours", 0) > before72["hours"]:
            before72 = old["before72"]
        old_days = {x["date"]: x for x in old.get("days", [])}
        merged = []
        for x in days:
            o = old_days.pop(x["date"], None)
            merged.append(o if o and o.get("hours", 0) > x["hours"] else x)
        merged.extend(old_days.values())
        merged.sort(key=lambda x: x["date"])
        results[c["id"]] = {
            "basis": basis, "stations": [s["id"] for s in sts],
            "announced_at": announced.isoformat(),
            "before24": before24, "before72": before72,
            "days": merged, "verdict": verdict(before24, before72),
        }

    out = {
        "generated_at": now.isoformat(),
        "rule": {"threshold": THRESHOLD, "text": "National Haze Action Plan: schools in the affected area close once the IPU reaches 200."},
        "source": "Official hourly IPU readings from DOE APIMS. Closures from Bernama reports.",
        "closures": results,
    }
    DATA.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    # keep only stations used by recent closures, and only the last 40 days
    keep_ids = {i for r in results.values() for i in r.get("stations", [])}
    cutoff = hkey(now - timedelta(days=40))
    store = {i: {k: v for k, v in h.items() if k >= cutoff} for i, h in store.items() if i in keep_ids}
    CACHE.mkdir(parents=True, exist_ok=True)
    HOURS.write_text(json.dumps(store, separators=(",", ":")), encoding="utf-8")
    log(f"Rule vs reality: {len(results)} closure(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
