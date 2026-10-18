#!/usr/bin/env python3
"""Fetch the latest official Air Pollutant Index (IPU/API) readings from
the Department of Environment's APIMS portal and write docs/data/latest.json.

Runs every hour from GitHub Actions. Python standard library only.

Two public endpoints are used. Both are the ones the official portal
(https://eqms.doe.gov.my/APIMS/main) itself calls:

  1. Current reading map service (ArcGIS MapServer query):
     one row per station with STATION_ID, STATION_LOCATION, STATE_NAME,
     STATE_ID, LATITUDE, LONGITUDE, DATETIME, API, PARAM_SYMBOL ...
  2. Hourly table, per state:
     the last 24 hourly API values per station, with ISO timestamps.

Rules this script follows:
  * Never invents or fills in a reading. A missing or negative value is
    stored as null ("no reading").
  * If DOE cannot be reached, the previous file is kept, its readings are
    left unchanged, and "status" is set to "failed" so the page can mark
    them as possibly outdated. last_success is NOT moved forward.
  * All times are Malaysia time (UTC+8) in ISO 8601 with offset.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

MYT = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("IPU_DATA_DIR", ROOT / "docs" / "data"))
LATEST = DATA_DIR / "latest.json"

PORTAL_URL = "https://eqms.doe.gov.my/APIMS/main"
MAP_URL = os.environ.get(
    "APIMS_MAP_URL",
    "https://eqms.doe.gov.my/api3/publicmapproxy/PUBLIC_DISPLAY/"
    "CAQM_MCAQM_Current_Reading/MapServer/0/query")
TABLE_URL = os.environ.get(
    "APIMS_TABLE_URL",
    "https://eqms.doe.gov.my/api3/publicportalapims/apitablehourly")

MAP_FIELDS = ("STATION_ID,STATION_LOCATION,PLACE,STATE_NAME,STATE_ID,REGION_NAME,"
              "DATETIME,API,PARAM_SYMBOL,STATION_STATUS,LATITUDE,LONGITUDE,PM25_CONC,PM25_24H_AVG")
USER_AGENT = ("Mozilla/5.0 (compatible; MalaysiaIPUDashboard/1.0; "
              "hourly public dashboard, reads APIMS once per hour)")
KEEP_HOURS = 48          # hourly values kept per station (for "today" and the 24 h chart)
RETRY_WAIT = float(os.environ.get("APIMS_RETRY_WAIT", "4"))
SCHEMA = 1


def log(msg):
    print(msg, flush=True)


# ------------------------------------------------------------------ time

def now_myt():
    """Current Malaysia time. IPU_NOW (ISO, no offset) is for tests only."""
    forced = os.environ.get("IPU_NOW")
    if forced:
        return datetime.fromisoformat(forced).replace(tzinfo=MYT)
    return datetime.now(MYT).replace(microsecond=0)


def iso(dt):
    return dt.astimezone(MYT).replace(microsecond=0).isoformat()


def hour_key(dt):
    return dt.astimezone(MYT).strftime("%Y-%m-%dT%H:00")


def map_wall_time(ms):
    """The map service stores the Malaysia wall-clock time in a field that is
    labelled UTC (1792245600000 is 14:00 Malaysia time, not 14:00 UTC).
    Read the number as UTC and keep the clock reading as Malaysia time."""
    wall = datetime.fromtimestamp(ms / 1000, timezone.utc).replace(tzinfo=None)
    return wall.replace(tzinfo=MYT)


def table_time(text):
    """'2026-10-17T14:00:00' (Malaysia time) -> aware datetime."""
    return datetime.fromisoformat(str(text)[:19]).replace(tzinfo=MYT)


# ------------------------------------------------------------------ values

def to_api(value):
    """API value as int (or float), None when missing/invalid/negative."""
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f < 0 or f != f:          # negative codes and NaN mean "no reading"
        return None
    return int(f) if f == int(f) else round(f, 1)


def to_conc(value):
    """Concentration in µg/m³ (1 decimal), None when missing, negative or absurd."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f < 0 or f > 2000:
        return None
    return round(f, 1)


def to_coord(value, lo, hi):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return round(f, 6) if lo <= f <= hi else None


def category(api):
    """DOE API categories."""
    if api is None:
        return None
    if api <= 50:
        return "Good"
    if api <= 100:
        return "Moderate"
    if api <= 200:
        return "Unhealthy"
    if api <= 300:
        return "Very unhealthy"
    return "Hazardous"


def nice_case(text):
    """'NEGERI SEMBILAN' -> 'Negeri Sembilan'. Leaves mixed-case text alone."""
    if not text:
        return ""
    text = " ".join(str(text).split())
    if text.isupper():
        small = {"Dan", "Of"}
        words = [w.capitalize() for w in text.split(" ")]
        text = " ".join(w.lower() if w in small else w for w in words)
        text = text.replace("W.p.", "W.P.").replace("Wp ", "WP ")
    return text


def split_location(location, state=None):
    """'Nilai, NEGERI SEMBILAN' -> 'Nilai' (the town part, before the state)."""
    loc = " ".join(str(location or "").split())
    if "," in loc:
        return loc.rsplit(",", 1)[0].strip()
    return loc


def state_sort_key(value):
    try:
        return (0, int(value), "")
    except (TypeError, ValueError):
        return (1, 0, str(value))


# ------------------------------------------------------------------ network

def get_json(url, params, tries=3, timeout=40):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(full, headers={
                "User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8-sig"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
            last = err
            log(f"  attempt {attempt} failed: {err}")
            if attempt < tries:
                time.sleep(RETRY_WAIT * attempt)
    raise RuntimeError(f"could not read {url}: {last}")


def fetch_map():
    """Latest reading + station details for every station."""
    payload = get_json(MAP_URL, {
        "where": "1=1",
        "outFields": MAP_FIELDS,
        "returnGeometry": "false",
        "f": "json",
    })
    if not isinstance(payload, dict) or "features" not in payload:
        raise RuntimeError(f"unexpected map answer: {str(payload)[:200]}")
    if payload.get("error"):
        raise RuntimeError(f"map service error: {payload['error']}")
    out = {}
    for feat in payload["features"]:
        a = feat.get("attributes") or {}
        sid = str(a.get("STATION_ID") or "").strip()
        if not sid:
            continue
        state = nice_case(a.get("STATE_NAME"))
        ms = a.get("DATETIME")
        observed = map_wall_time(ms) if isinstance(ms, (int, float)) and ms > 0 else None
        out[sid] = {
            "id": sid,
            "name": nice_case(split_location(a.get("STATION_LOCATION"), state)),
            "location": " ".join(str(a.get("STATION_LOCATION") or "").split()),
            "place": " ".join(str(a.get("PLACE") or "").split()) or None,
            "state": state,
            "state_id": a.get("STATE_ID"),
            "region": nice_case(a.get("REGION_NAME")) or None,
            "lat": to_coord(a.get("LATITUDE"), 0.5, 8.0),
            "lon": to_coord(a.get("LONGITUDE"), 99.0, 120.0),
            "api": to_api(a.get("API")),
            "pollutant": (str(a.get("PARAM_SYMBOL")).strip() or None) if a.get("PARAM_SYMBOL") is not None else None,
            "station_status": a.get("STATION_STATUS"),
            "observed": observed,
            # official PM2.5 concentrations from the same reading (µg/m³)
            "pm25_1h": to_conc(a.get("PM25_CONC")),
            "pm25_24h": to_conc(a.get("PM25_24H_AVG")),
        }
    if not out:
        raise RuntimeError("map service returned no stations")
    if payload.get("exceededTransferLimit"):
        log("  warning: map service says the result was cut short")
    return out


def fetch_table(state_id, end):
    """Hourly API for the 24 h ending at `end` (Malaysia time), one state.
    Returns {station_id: {"hours": {hour_key: api}, "meta": {...}}}."""
    payload = get_json(TABLE_URL, {
        "stateid": state_id,
        "datetime": end.strftime("%Y-%m-%d %H:00:00"),
    })
    rows = payload.get("api_table_hourly") if isinstance(payload, dict) else None
    if rows is None:
        raise RuntimeError("unexpected table answer (no api_table_hourly)")
    out = {}
    for row in rows:
        sid = str(row.get("STATION_ID") or "").strip()
        stamp = row.get("DATETIME")
        if not sid or not stamp:
            continue
        try:
            t = table_time(stamp)
        except ValueError:
            continue
        entry = out.setdefault(sid, {"hours": {}, "meta": {}})
        entry["hours"][hour_key(t)] = to_api(row.get("API"))
        if not entry["meta"]:
            entry["meta"] = {
                "location": " ".join(str(row.get("STATION_LOCATION") or "").split()),
                "lat": to_coord(row.get("LATITUDE"), 0.5, 8.0),
                "lon": to_coord(row.get("LONGITUDE"), 99.0, 120.0),
                "state_id": row.get("STATE_ID"),
            }
    return out


# ------------------------------------------------------------------ build

def load_previous():
    try:
        return json.loads(LATEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def merge_hours(old_pairs, new_hours, now):
    """old_pairs: [[hour_key, api], ...]; new_hours: {hour_key: api}.
    New values win. Keeps the last KEEP_HOURS hours."""
    merged = {k: v for k, v in (old_pairs or [])}
    merged.update(new_hours or {})
    cutoff = hour_key(now - timedelta(hours=KEEP_HOURS))
    return [[k, merged[k]] for k in sorted(merged) if k >= cutoff]


def newest_value(pairs):
    """Newest hour that has a reading: (hour_key, api) or (None, None)."""
    for k, v in reversed(pairs):
        if v is not None:
            return k, v
    return None, None


def build(now, prev):
    prev_stations = {s["id"]: s for s in (prev or {}).get("stations", [])}
    problems = []

    # 1. current readings
    current = None
    try:
        log("Reading current station readings (map service)...")
        current = fetch_map()
        log(f"  {len(current)} stations")
    except RuntimeError as err:
        problems.append(f"current readings: {err}")
        log(f"  FAILED: {err}")

    # 2. hourly tables, one request per state
    state_ids = sorted({s.get("state_id") for s in (current or prev_stations).values()
                        if s.get("state_id") is not None}, key=state_sort_key)
    end = now.replace(minute=0, second=0, microsecond=0)
    tables, table_fail = {}, 0
    for sid in state_ids:
        try:
            tables.update(fetch_table(sid, end))
        except RuntimeError as err:
            table_fail += 1
            problems.append(f"hourly table state {sid}: {err}")
            log(f"  hourly table for state {sid} FAILED: {err}")
    if state_ids:
        log(f"Hourly tables: {len(state_ids) - table_fail}/{len(state_ids)} states read")

    got_new = bool(current) or bool(tables)
    if not got_new:
        return None, problems

    # 3. one record per station
    ids = set(current or {}) | set(tables) | set(prev_stations)
    stations = []
    for sid in sorted(ids):
        old = prev_stations.get(sid, {})
        base = dict((current or {}).get(sid) or {})
        tab = tables.get(sid)
        if not base:
            if not tab and current is not None:
                # station no longer listed by DOE: drop it
                continue
            # keep old details; fill from the table where possible
            base = {k: old.get(k) for k in ("id", "name", "location", "place", "state",
                                             "state_id", "region", "lat", "lon",
                                             "pollutant", "station_status")}
            base["id"] = sid
            if tab:
                m = tab["meta"]
                base["location"] = base.get("location") or m.get("location")
                base["name"] = base.get("name") or nice_case(split_location(m.get("location"), base.get("state")))
                base["lat"] = base.get("lat") or m.get("lat")
                base["lon"] = base.get("lon") or m.get("lon")
                base["state_id"] = base.get("state_id") or m.get("state_id")
            base["api"] = None
            base["observed"] = None
            if not tab:
                # nothing new for this station: keep the old reading as it was
                base["api"] = old.get("api")
                base["observed"] = old.get("observed")
                base["hourly"] = old.get("hourly", [])
                base["source"] = old.get("source")
                base["category"] = category(base["api"])
                stations.append(base)
                continue

        hourly = merge_hours(old.get("hourly"), tab["hours"] if tab else {}, now)
        base["hourly"] = hourly

        # latest reading: the newer of the map reading and the newest table hour
        obs = base.get("observed")
        api = base.get("api")
        source = "current" if obs is not None else None
        tkey, tapi = newest_value(hourly)
        if tkey is not None:
            tdt = datetime.fromisoformat(tkey).replace(tzinfo=MYT)
            if obs is None or api is None or tdt > obs:
                obs, api, source = tdt, tapi, "hourly"
        base["api"] = api if obs is not None else None
        base["observed"] = iso(obs) if obs is not None else None
        base["source"] = source
        if source != "current":
            base["pm25_1h"] = None          # concentrations come only with the map reading;
            base["pm25_24h"] = None         # never pair an old one with a newer hour
        base["category"] = category(base["api"])
        stations.append(base)

    if current is None:
        status = "partial"
    elif table_fail:
        status = "partial"
    else:
        status = "ok"
    return {"stations": stations, "status": status}, problems


def observation_time(stations):
    """The reading hour shared by most stations (the 'as of' time)."""
    hours = [s["observed"] for s in stations if s.get("observed") and s.get("api") is not None]
    if not hours:
        return None
    common = Counter(hours).most_common()
    best = max(c for _, c in common)
    return max(h for h, c in common if c == best)


def main():
    now = now_myt()
    prev = load_previous()
    built, problems = build(now, prev)

    if built is None:
        # Total failure: keep everything from the previous file, mark as failed.
        out = dict(prev or {})
        out.setdefault("stations", [])
        out["status"] = "failed"
        out["message"] = "Could not reach DOE APIMS on the last attempt. " \
                         "Readings shown are from the last successful update and may be outdated."
        out["problems"] = problems[:10]
        out["last_attempt"] = iso(now)
        out.setdefault("last_success", None)
        code = 1
    else:
        out = {
            "status": built["status"],
            "message": None if built["status"] == "ok" else
                       "Some APIMS requests failed on the last update; affected stations keep their previous reading.",
            "problems": problems[:10],
            "last_attempt": iso(now),
            "last_success": iso(now),
            "stations": built["stations"],
        }
        code = 0

    out["schema"] = SCHEMA
    out["source"] = {
        "name": "Department of Environment Malaysia (DOE) – Air Pollutant Index Management System (APIMS)",
        "portal": PORTAL_URL,
        "current_endpoint": MAP_URL,
        "hourly_endpoint": TABLE_URL,
        "note": "API is the 24-hour running average of the dominant pollutant, published hourly by DOE.",
    }
    out["observation_time"] = observation_time(out["stations"])
    with_reading = [s for s in out["stations"] if s.get("api") is not None]
    out["counts"] = {"stations": len(out["stations"]), "with_reading": len(with_reading)}

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LATEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
                   encoding="utf-8")
    tmp.replace(LATEST)
    log(f"Status: {out['status']}. Stations: {out['counts']['stations']} "
        f"({out['counts']['with_reading']} with a reading). As of: {out['observation_time']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
