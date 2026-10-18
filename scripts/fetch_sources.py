#!/usr/bin/env python3
"""'Where the haze comes from': satellite fire hotspots and surface wind.

Writes docs/data/sources.json with:
  fires - NASA FIRMS near-real-time active fire detections (VIIRS on NOAA-20,
          NOAA-21 and Suomi NPP), last 24 hours, for the region around
          Malaysia. Detections older than 36 hours are never shown as current:
          if nothing recent is available, the file says so.
  wind  - current 10 m wind on a 2-degree grid over the region, from the
          Open-Meteo forecast API (a weather model, not a measurement).
And docs/data/wind_history.json:
  hourly low-level wind (925 hPa, about 800 m up, where smoke travels; 10 m
  where 925 hPa is missing) for the past 3 days on a 1.5-degree grid. The
  page uses it to trace where the air arriving at a place came from.
And docs/data/wind_forecast.json:
  the same wind for the next 48 hours (forecast), used to estimate where air
  now over fire areas is heading ("smoke on the way"). A model forecast.
Fires are read every run; wind at most every 3 hours. Python standard library only.
"""
import csv
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

MYT = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("IPU_DATA_DIR", ROOT / "docs" / "data"))
OUT = DATA_DIR / "sources.json"
HISTORY = DATA_DIR / "wind_history.json"
FORECAST = DATA_DIR / "wind_forecast.json"
FORECAST_HOURS = 48

FIRMS_BASE = os.environ.get("FIRMS_BASE", "https://firms.modaps.eosdis.nasa.gov/data/active_fire")
FIRMS_FILES = [
    ("NOAA-20 VIIRS", "noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_24h.csv"),
    ("NOAA-21 VIIRS", "noaa-21-viirs-c2/csv/J2_VIIRS_C2_SouthEast_Asia_24h.csv"),
    ("Suomi NPP VIIRS", "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv"),
]
WIND_URL = os.environ.get("OPEN_METEO_WX_URL", "https://api.open-meteo.com/v1/forecast")

BBOX = {"west": 94.0, "east": 121.0, "south": -7.0, "north": 9.5}
GRID = {"lon0": 94.0, "lat0": -6.0, "dlon": 2.0, "dlat": 2.0, "nx": 14, "ny": 9}   # 94..120 E, -6..10 N
HGRID = {"lon0": 93.0, "lat0": -8.0, "dlon": 1.5, "dlat": 1.5, "nx": 20, "ny": 13}  # 93..121.5 E, -8..10 N
HISTORY_DAYS = 3
FIRE_MAX_AGE = timedelta(hours=36)
WIND_REFRESH = timedelta(hours=3)
CHUNK = 50
RETRY_WAIT = float(os.environ.get("SOURCES_RETRY_WAIT", "4"))


def log(msg):
    print(msg, flush=True)


def now_utc():
    forced = os.environ.get("IPU_NOW")   # Malaysia time, for tests
    if forced:
        return datetime.fromisoformat(forced).replace(tzinfo=MYT).astimezone(timezone.utc)
    return datetime.now(timezone.utc).replace(microsecond=0)


def fetch(url, params=None, tries=3, timeout=60):
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    last = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": "MalaysiaIPUDashboard/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8-sig")
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last = err
            log(f"  attempt {attempt} failed: {err}")
            if attempt < tries:
                time.sleep(RETRY_WAIT * attempt)
    raise RuntimeError(f"could not read {url}: {last}")


# ---------------------------------------------------------------- fires

def parse_firms(text, now):
    """Rows inside the region, not low confidence. Returns (points, newest_time, total_rows)."""
    pts, newest, total = [], None, 0
    for r in csv.DictReader(io.StringIO(text)):
        total += 1
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
            stamp = datetime.strptime(r["acq_date"] + r["acq_time"].zfill(4), "%Y-%m-%d%H%M").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError, TypeError):
            continue
        if not (BBOX["west"] <= lon <= BBOX["east"] and BBOX["south"] <= lat <= BBOX["north"]):
            continue
        conf = (r.get("confidence") or "").strip().lower()
        if conf in ("l", "low"):
            continue
        if newest is None or stamp > newest:
            newest = stamp
        if now - stamp > FIRE_MAX_AGE:
            continue
        try:
            frp = round(float(r.get("frp") or 0), 1)
        except ValueError:
            frp = 0.0
        pts.append((round(lon, 3), round(lat, 3), frp, stamp))
    return pts, newest, total


def collect_fires(now):
    pts, newest, ok, failed = [], None, [], []
    for name, path in FIRMS_FILES:
        try:
            text = fetch(f"{FIRMS_BASE}/{path}")
            p, n, total = parse_firms(text, now)
            pts.extend(p)
            if n and (newest is None or n > newest):
                newest = n
            ok.append(name)
            log(f"  {name}: {total} rows, {len(p)} recent in region")
        except RuntimeError as err:
            failed.append(name)
            log(f"  {name} FAILED: {err}")
    # the satellites overlap: keep one detection per ~1 km cell, the strongest
    best = {}
    for lon, lat, frp, stamp in pts:
        cell = (round(lon / 0.01), round(lat / 0.01))
        if cell not in best or frp > best[cell][2]:
            best[cell] = (lon, lat, frp, stamp)
    points = sorted(best.values(), key=lambda p: (p[1], p[0]))
    newest_recent = max((p[3] for p in points), default=None)
    status = "ok" if points else ("stale" if newest else ("failed" if not ok else "none"))
    return {
        "status": status,
        "source": "NASA FIRMS near-real-time active fire data (VIIRS 375 m: " + ", ".join(n for n, _ in FIRMS_FILES) + ")",
        "url": "https://firms.modaps.eosdis.nasa.gov/",
        "window_hours": 24,
        "max_age_hours": int(FIRE_MAX_AGE.total_seconds() // 3600),
        "satellites_read": ok, "satellites_failed": failed,
        "newest_detection": newest.astimezone(MYT).isoformat() if newest else None,
        "newest_recent_detection": newest_recent.astimezone(MYT).isoformat() if newest_recent else None,
        "count": len(points),
        "columns": ["lon", "lat", "frp_mw", "detected_unix_minutes"],
        "points": [[p[0], p[1], p[2], int(p[3].timestamp() // 60)] for p in points],
        "note": "Satellite heat detections. Most are vegetation or peat fires, but some can be other hot spots such as flares or industry.",
    }


# ---------------------------------------------------------------- wind

def grid_points():
    g = GRID
    return [(g["lat0"] + j * g["dlat"], g["lon0"] + i * g["dlon"]) for j in range(g["ny"]) for i in range(g["nx"])]


def as_list(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and payload.get("error"):
        raise RuntimeError(f"Open-Meteo error: {payload.get('reason')}")
    return [payload]


def collect_wind(now):
    pts = grid_points()
    u, v, stamp = [], [], None
    for i in range(0, len(pts), CHUNK):
        part = pts[i:i + CHUNK]
        rows = as_list(json.loads(fetch(WIND_URL, {
            "latitude": ",".join(f"{p[0]:.2f}" for p in part),
            "longitude": ",".join(f"{p[1]:.2f}" for p in part),
            "current": "wind_speed_10m,wind_direction_10m",
            "wind_speed_unit": "ms",
            "timezone": "Asia/Kuala_Lumpur",
        })))
        if len(rows) != len(part):
            raise RuntimeError(f"Open-Meteo returned {len(rows)} locations for {len(part)}")
        for row in rows:
            c = row.get("current") or {}
            spd, deg = c.get("wind_speed_10m"), c.get("wind_direction_10m")
            stamp = stamp or c.get("time")
            if spd is None or deg is None:
                u.append(None); v.append(None); continue
            # meteorological direction = where the wind comes FROM
            rad = math.radians(float(deg))
            u.append(round(-float(spd) * math.sin(rad), 2))
            v.append(round(-float(spd) * math.cos(rad), 2))
    return {
        "status": "ok",
        "source": "Open-Meteo forecast API, 10 m wind (weather model, not a measurement)",
        "url": "https://open-meteo.com/",
        "time": stamp, "fetched_at": now.astimezone(MYT).isoformat(),
        "grid": GRID, "u": u, "v": v,
    }


def collect_history(now):
    """Hourly u/v (m/s x 10, as integers) for every grid point, oldest hour first."""
    g = HGRID
    pts = [(g["lat0"] + j * g["dlat"], g["lon0"] + i * g["dlon"]) for j in range(g["ny"]) for i in range(g["nx"])]
    times, cols, level_used = None, [], {"925hPa": 0, "10m": 0, "missing": 0}
    for i in range(0, len(pts), CHUNK):
        part = pts[i:i + CHUNK]
        rows = as_list(json.loads(fetch(WIND_URL, {
            "latitude": ",".join(f"{p[0]:.2f}" for p in part),
            "longitude": ",".join(f"{p[1]:.2f}" for p in part),
            "hourly": "wind_speed_925hPa,wind_direction_925hPa,wind_speed_10m,wind_direction_10m",
            "wind_speed_unit": "ms", "timezone": "GMT",
            "past_days": HISTORY_DAYS, "forecast_days": 3,
        })))
        if len(rows) != len(part):
            raise RuntimeError(f"Open-Meteo returned {len(rows)} locations for {len(part)}")
        for row in rows:
            h = row.get("hourly") or {}
            t = h.get("time") or []
            if times is None:
                times = t
            elif t != times:
                raise RuntimeError("hourly times differ between locations")
            s9, d9 = h.get("wind_speed_925hPa") or [], h.get("wind_direction_925hPa") or []
            s0, d0 = h.get("wind_speed_10m") or [], h.get("wind_direction_10m") or []
            u, v = [], []
            for k in range(len(t)):
                spd = s9[k] if k < len(s9) else None
                deg = d9[k] if k < len(d9) else None
                if spd is None or deg is None:
                    spd = s0[k] if k < len(s0) else None
                    deg = d0[k] if k < len(d0) else None
                    level_used["10m" if spd is not None and deg is not None else "missing"] += 1
                else:
                    level_used["925hPa"] += 1
                if spd is None or deg is None:
                    u.append(None); v.append(None); continue
                rad = math.radians(float(deg))
                u.append(round(-float(spd) * math.sin(rad) * 10))
                v.append(round(-float(spd) * math.cos(rad) * 10))
            cols.append((u, v))
    if not times:
        raise RuntimeError("no hourly times in the wind answer")
    # history: hours up to now (the trace starts at the newest hour that is not in the future)
    # forecast: from the hour before now to FORECAST_HOURS ahead
    stamps = [int(datetime.fromisoformat(t).replace(tzinfo=timezone.utc).timestamp() // 60) for t in times]
    now_min = int(now.timestamp() // 60)
    keep = [k for k, m in enumerate(stamps) if m <= now_min]
    ahead = [k for k, m in enumerate(stamps) if now_min - 60 <= m <= now_min + FORECAST_HOURS * 60]
    forecast = {
        "status": "ok" if len(ahead) > 2 else "failed",
        "source": "Open-Meteo forecast API, hourly wind forecast at 925 hPa (about 800 m up), 10 m where 925 hPa is missing. A weather model forecast, not a measurement.",
        "url": "https://open-meteo.com/",
        "fetched_at": now.astimezone(MYT).isoformat(),
        "grid": HGRID, "units": "m/s x 10",
        "times": [stamps[k] for k in ahead],
        "u": [[cols[p][0][k] for p in range(len(cols))] for k in ahead],
        "v": [[cols[p][1][k] for p in range(len(cols))] for k in ahead],
    }
    return forecast, {
        "status": "ok",
        "source": "Open-Meteo forecast API, hourly wind at 925 hPa (about 800 m up), 10 m where 925 hPa is missing. Weather model, not a measurement.",
        "url": "https://open-meteo.com/",
        "fetched_at": now.astimezone(MYT).isoformat(),
        "grid": HGRID, "units": "m/s x 10",
        "levels_used": level_used,
        "times": [stamps[k] for k in keep],          # unix minutes, UTC
        "u": [[cols[p][0][k] for p in range(len(cols))] for k in keep],   # [hour][point]
        "v": [[cols[p][1][k] for p in range(len(cols))] for k in keep],
    }


def update_history(now):
    try:
        old = json.loads(HISTORY.read_text(encoding="utf-8"))
        if now - datetime.fromisoformat(old["fetched_at"]) < WIND_REFRESH:
            log(f"Wind history is recent ({old['fetched_at']}); not downloading.")
            return old.get("status")
    except (OSError, ValueError, KeyError, TypeError):
        old = None
    log("Reading 3-day wind history and 2-day forecast (Open-Meteo)...")
    try:
        forecast, hist = collect_history(now)
    except (RuntimeError, ValueError) as err:
        log(f"  FAILED: {err}")
        return "failed"
    HISTORY.write_text(json.dumps(hist, separators=(",", ":")), encoding="utf-8")
    log(f"  {len(hist['times'])} hours, levels used: {hist['levels_used']}")
    if forecast["status"] == "ok":
        FORECAST.write_text(json.dumps(forecast, separators=(",", ":")), encoding="utf-8")
        log(f"  wind forecast: {len(forecast['times'])} hours ahead")
    return "ok"


def main():
    now = now_utc()
    try:
        prev = json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prev = {}

    log("Reading satellite fire hotspots (NASA FIRMS)...")
    fires = collect_fires(now)
    if fires["status"] == "failed" and prev.get("fires", {}).get("points"):
        # FIRMS unreachable: keep earlier detections only while they are still recent enough
        old = prev["fires"]
        cutoff = int((now - FIRE_MAX_AGE).timestamp() // 60)
        keep = [p for p in old["points"] if len(p) > 3 and p[3] >= cutoff]
        if keep:
            old.update(points=keep, count=len(keep), status="previous")
            fires = old

    wind = prev.get("wind")
    need = True
    if wind and wind.get("fetched_at"):
        try:
            need = now - datetime.fromisoformat(wind["fetched_at"]) >= WIND_REFRESH
        except ValueError:
            need = True
    if need:
        log("Reading surface wind (Open-Meteo)...")
        try:
            wind = collect_wind(now)
        except (RuntimeError, ValueError) as err:
            log(f"  FAILED: {err}")
            if wind:
                wind["status"] = "failed"
            else:
                wind = {"status": "failed"}
    else:
        log(f"Wind data is recent ({wind['fetched_at']}); not downloading.")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    history_status = update_history(now)
    out = {"generated_at": now.astimezone(MYT).isoformat(), "bbox": BBOX, "fires": fires, "wind": wind,
           "wind_history": {"status": history_status, "file": "wind_history.json"}}
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    log(f"Fires: {fires['status']}, {fires.get('count', 0)} hotspots. Wind: {wind.get('status') if wind else 'none'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
