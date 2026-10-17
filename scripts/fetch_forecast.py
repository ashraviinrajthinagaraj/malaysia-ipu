#!/usr/bin/env python3
"""Haze forecast (an ESTIMATE, not official IPU) for every station.

Writes docs/data/forecast.json. The page shows it in its own, clearly
labelled block. It is never used for the official reading or the school
closure check, which come only from DOE APIMS.

Method, per station:
  1. Model: hourly PM2.5 forecast from the Copernicus Atmosphere Monitoring
     Service (CAMS global), served by Open-Meteo's air-quality API, at the
     station's coordinates. Turned into a 24-hour running mean, like the IPU.
  2. Calibration: over the last 24 hours, compare the station's official
     hourly IPU with that model mean. The middle ratio scales the model to
     this station's IPU; the smallest and largest ratios give the range.
  3. Start: the estimate starts at the station's latest official reading and
     blends into the scaled model over about 12 hours.
  No estimate is made when there are too few official readings to calibrate,
  or when the latest official reading is more than 3 hours old.

The model data is downloaded at most every 3 hours (it updates twice a day)
and kept in data_cache/cams.json. Python standard library only.
"""
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
CACHE_DIR = Path(os.environ.get("IPU_CACHE_DIR", ROOT / "data_cache"))
LATEST = DATA_DIR / "latest.json"
OUT = DATA_DIR / "forecast.json"
CACHE = CACHE_DIR / "cams.json"

AQ_URL = os.environ.get("OPEN_METEO_AQ_URL", "https://air-quality-api.open-meteo.com/v1/air-quality")
REFRESH = timedelta(hours=3)
CHUNK = 25                 # locations per request
HORIZON_H = 48             # hours of estimate after the latest official reading
BLEND_H = 12.0             # how fast the start value blends into the scaled model
MIN_PAIRS = 6              # official/model pairs needed to calibrate
RATIO_LIMITS = (0.4, 6.0)
STALE_H = 3
RETRY_WAIT = float(os.environ.get("OPEN_METEO_RETRY_WAIT", "4"))


def log(msg):
    print(msg, flush=True)


def now_myt():
    forced = os.environ.get("IPU_NOW")
    if forced:
        return datetime.fromisoformat(forced).replace(tzinfo=MYT)
    return datetime.now(MYT).replace(microsecond=0)


def key(dt):
    return dt.strftime("%Y-%m-%dT%H:00")


def parse_key(k):
    return datetime.fromisoformat(str(k)[:16]).replace(tzinfo=MYT)


def get_json(url, params, tries=3, timeout=60):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": "MalaysiaIPUDashboard/1.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
            last = err
            log(f"  attempt {attempt} failed: {err}")
            if attempt < tries:
                time.sleep(RETRY_WAIT * attempt)
    raise RuntimeError(f"could not read {url}: {last}")


def as_list(payload):
    """Open-Meteo answers a single location with an object and several with a list."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and payload.get("error"):
        raise RuntimeError(f"Open-Meteo error: {payload.get('reason')}")
    return [payload]


# ---------------------------------------------------------------- model data

def fetch_cams(stations):
    """{station_id: {hour_key: pm2_5}} for the stations given (id, lat, lon)."""
    out = {}
    for i in range(0, len(stations), CHUNK):
        part = stations[i:i + CHUNK]
        payload = get_json(AQ_URL, {
            "latitude": ",".join(f"{s['lat']:.4f}" for s in part),
            "longitude": ",".join(f"{s['lon']:.4f}" for s in part),
            "hourly": "pm2_5",
            "past_days": 2,
            "forecast_days": 3,
            "timezone": "Asia/Kuala_Lumpur",
            "domains": "cams_global",
        })
        rows = as_list(payload)
        if len(rows) != len(part):
            raise RuntimeError(f"Open-Meteo returned {len(rows)} locations for {len(part)}")
        for s, row in zip(part, rows):
            h = row.get("hourly") or {}
            times, vals = h.get("time") or [], h.get("pm2_5") or []
            series = {}
            for t, v in zip(times, vals):
                if v is None:
                    continue
                try:
                    series[key(parse_key(t))] = round(float(v), 2)
                except (TypeError, ValueError):
                    continue
            out[s["id"]] = series
    return out


def load_cache():
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cams_data(stations, now, force=False):
    cache = load_cache()
    if cache and not force:
        try:
            age = now - datetime.fromisoformat(cache["fetched_at"])
            have = set(cache.get("series", {}))
            if age < REFRESH and all(s["id"] in have for s in stations):
                log(f"Using model data from {cache['fetched_at']}")
                return cache
        except (KeyError, ValueError, TypeError):
            pass
    log(f"Downloading CAMS PM2.5 forecast for {len(stations)} stations...")
    try:
        series = fetch_cams(stations)
    except RuntimeError as err:
        log(f"  FAILED: {err}")
        return cache          # older model data is still usable; staleness is reported
    cache = {"fetched_at": now.isoformat(), "source": AQ_URL + " (domains=cams_global)", "series": series}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    return cache


# ---------------------------------------------------------------- estimate

def running_mean(series, t, hours=24, min_values=18):
    vals = [series.get(key(t - timedelta(hours=h))) for h in range(hours)]
    vals = [v for v in vals if v is not None]
    if len(vals) < min_values:
        return None
    return sum(vals) / len(vals)


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def estimate_station(st, cams, now):
    """Estimate for one station, or (None, reason)."""
    official = {k: v for k, v in (st.get("hourly") or []) if v is not None}
    if not st.get("observed") or st.get("api") is None:
        return None, "no current official reading"
    t0 = datetime.fromisoformat(st["observed"]).astimezone(MYT).replace(minute=0, second=0, microsecond=0)
    if (now - t0) > timedelta(hours=STALE_H):
        return None, "latest official reading is more than 3 hours old"
    if not cams:
        return None, "no model data for this station"

    ratios = []
    for h in range(24):
        t = t0 - timedelta(hours=h)
        o = official.get(key(t))
        r = running_mean(cams, t)
        if o is not None and r is not None and r > 1:
            ratios.append(o / r)
    if len(ratios) < MIN_PAIRS:
        return None, "not enough official readings to calibrate the model"
    lo_lim, hi_lim = RATIO_LIMITS
    clamp = lambda x: min(hi_lim, max(lo_lim, x))
    k_mid, k_lo, k_hi = clamp(median(ratios)), clamp(min(ratios)), clamp(max(ratios))

    r0 = running_mean(cams, t0)
    if r0 is None:
        return None, "no model data at the time of the latest reading"
    start = float(st["api"])
    off_mid, off_lo, off_hi = start - k_mid * r0, start - k_lo * r0, start - k_hi * r0

    est, lo, hi, times = [], [], [], []
    for h in range(1, HORIZON_H + 1):
        t = t0 + timedelta(hours=h)
        r = running_mean(cams, t)
        if r is None:
            break
        w = math.exp(-h / BLEND_H)
        e, a, b = k_mid * r + off_mid * w, k_lo * r + off_lo * w, k_hi * r + off_hi * w
        lo_v, hi_v = min(a, b, e), max(a, b, e)
        times.append(key(t))
        est.append(max(0, round(e)))
        lo.append(max(0, round(lo_v)))
        hi.append(max(0, round(hi_v)))
    if not times:
        return None, "the model forecast does not cover the coming hours"

    # next 24 hours: peak and outlook against the closure level
    n24 = min(24, len(times))
    i_pk = max(range(n24), key=lambda i: est[i])
    reach = "likely" if max(lo[:n24]) >= 200 else ("possible" if max(hi[:n24]) >= 200 else "unlikely")
    # 07:00 tomorrow (school start)
    morning_t = (t0 + timedelta(days=1)).replace(hour=7)
    mk = key(morning_t)
    morning = None
    if mk in times:
        i = times.index(mk)
        morning = {"time": mk, "est": est[i], "lo": lo[i], "hi": hi[i]}
    return {
        "anchor": key(t0), "anchor_api": st["api"],
        "start": times[0], "est": est, "lo": lo, "hi": hi,
        "peak24": {"time": times[i_pk], "est": est[i_pk], "lo": lo[i_pk], "hi": hi[i_pk]},
        "morning": morning, "reach200_24h": reach,
        "calibration": {"pairs": len(ratios), "ratio": round(k_mid, 3), "ratio_low": round(k_lo, 3), "ratio_high": round(k_hi, 3)},
    }, None


def main():
    now = now_myt()
    try:
        latest = json.loads(LATEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log("No latest.json; nothing to forecast.")
        return 0
    stations = [s for s in latest.get("stations", []) if isinstance(s.get("lat"), (int, float)) and isinstance(s.get("lon"), (int, float))]
    if not stations:
        log("No stations with coordinates; nothing to forecast.")
        return 0

    cache = cams_data(stations, now, force="--force" in sys.argv)
    out = {
        "kind": "estimate",
        "generated_at": now.isoformat(),
        "official": False,
        "label": "Forecast estimate. Not official IPU.",
        "model": {
            "name": "CAMS global atmospheric composition forecast (Copernicus Atmosphere Monitoring Service), PM2.5",
            "via": "Open-Meteo air-quality API",
            "url": "https://open-meteo.com/en/docs/air-quality-api",
            "fetched_at": cache.get("fetched_at") if cache else None,
            "licence": "CAMS data: Copernicus licence; Open-Meteo: CC BY 4.0",
        },
        "method": [
            "The CAMS PM2.5 forecast at the station is turned into a 24-hour running mean, like the IPU.",
            "It is scaled to the station's official IPU using the last 24 hours of official readings; the smallest and largest ratios give the range.",
            "The estimate starts at the latest official reading and blends into the scaled model over about 12 hours.",
            "It covers PM2.5 haze only, ignores other pollutants, and the model's grid is about 40 km wide.",
        ],
        "stations": {},
        "skipped": {},
    }
    if not cache or not cache.get("series"):
        out["status"] = "unavailable"
        out["message"] = "The model forecast could not be downloaded."
    else:
        for st in stations:
            res, why = estimate_station(st, cache["series"].get(st["id"]), now)
            if res:
                out["stations"][st["id"]] = res
            else:
                out["skipped"][st["id"]] = why
        out["status"] = "ok" if out["stations"] else "unavailable"
        model_age = now - datetime.fromisoformat(cache["fetched_at"])
        out["model_stale"] = model_age > timedelta(hours=24)
        if out["model_stale"]:
            out["message"] = "The model data is more than a day old because recent downloads failed."
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    log(f"Forecast: {len(out['stations'])} stations estimated, {len(out['skipped'])} skipped. Status: {out['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
