"""Tests for scripts/fetch_forecast.py and scripts/fetch_sources.py against local
fakes of Open-Meteo and NASA FIRMS. All values are made-up test values.
Run: python3 -m unittest discover -s tests
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
MYT = timezone(timedelta(hours=8))
NOW = datetime(2026, 10, 20, 14, 20)            # Tuesday 14:20 Malaysia time
TODAY = NOW.replace(hour=0, minute=0)
PM_BASE = 80.0                                   # past PM2.5, flat
RISE = 4.0                                       # forecast PM2.5 rises this much per hour for 24 h


class Fake:
    aq_ok = True
    fires_ok = True
    wind_calls = 0


def pm_at(t):
    lead = (t - NOW.replace(minute=0)).total_seconds() / 3600
    if lead <= 0:
        return PM_BASE
    return PM_BASE + RISE * min(lead, 24)


def firms_csv():
    head = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"
    utc = (NOW - timedelta(hours=8))
    recent = (utc - timedelta(hours=5))
    old = (utc - timedelta(hours=40))
    rows = [
        (-1.20, 103.10, recent, "nominal", 12.5),      # Sumatra, recent: kept
        (-1.2001, 103.1001, recent, "high", 20.0),     # same ~1 km cell: merged, stronger kept
        (0.50, 101.40, recent, "low", 5.0),            # low confidence: dropped
        (-9.50, 142.0, recent, "high", 9.0),           # outside region: dropped
        (1.10, 110.30, old, "high", 30.0),             # too old: dropped
        (2.10, 112.50, recent, "high", 8.0),           # Borneo, recent: kept
    ]
    return head + "".join(
        f"{la},{lo},330,0.4,0.6,{t:%Y-%m-%d},{t:%H%M},N20,{c},2.0NRT,295,{f},D\n" for la, lo, t, c, f in rows)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path.endswith("/air-quality"):
            if not Fake.aq_ok:
                return self.send_error(503)
            lats, lons = q["latitude"][0].split(","), q["longitude"][0].split(",")
            past, days = int(q["past_days"][0]), int(q["forecast_days"][0])
            start = TODAY - timedelta(days=past)
            ts = [start + timedelta(hours=i) for i in range((past + days) * 24)]
            locs = [{"latitude": float(a), "longitude": float(b),
                     "hourly": {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in ts],
                                "pm2_5": [pm_at(t) if i < len(ts) - 6 else None for i, t in enumerate(ts)]}}
                    for a, b in zip(lats, lons)]
            return self.send(locs if len(locs) > 1 else locs[0])
        if u.path.endswith("/forecast"):
            Fake.wind_calls += 1
            lats, lons = q["latitude"][0].split(","), q["longitude"][0].split(",")
            locs = [{"latitude": float(a), "longitude": float(b),
                     "current": {"time": "2026-10-20T14:15", "interval": 900, "wind_speed_10m": 5.0, "wind_direction_10m": 225}}
                    for a, b in zip(lats, lons)]
            return self.send(locs if len(locs) > 1 else locs[0])
        if u.path.endswith(".csv"):
            if not Fake.fires_ok:
                return self.send_error(503)
            return self.send(firms_csv(), "text/csv")
        self.send_error(404)


def station(sid, api_now, observed=NOW.replace(minute=0), ratio=2.0, lat=3.0, lon=101.5):
    hourly = []
    for h in range(47, -1, -1):
        t = observed - timedelta(hours=h)
        hourly.append([t.strftime("%Y-%m-%dT%H:00"), round(ratio * PM_BASE)])
    return {"id": sid, "name": sid, "state": "Selangor", "lat": lat, "lon": lon, "api": api_now,
            "observed": observed.replace(tzinfo=MYT).isoformat(), "hourly": hourly}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Fake.aq_ok = Fake.fires_ok = True
        Fake.wind_calls = 0
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "data").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, name, now=NOW):
        env = dict(os.environ,
                   IPU_DATA_DIR=str(self.dir / "data"), IPU_CACHE_DIR=str(self.dir / "cache"),
                   IPU_NOW=now.strftime("%Y-%m-%dT%H:%M:%S"),
                   OPEN_METEO_AQ_URL=f"http://127.0.0.1:{self.port}/v1/air-quality",
                   OPEN_METEO_WX_URL=f"http://127.0.0.1:{self.port}/v1/forecast",
                   FIRMS_BASE=f"http://127.0.0.1:{self.port}/firms",
                   OPEN_METEO_RETRY_WAIT="0", SOURCES_RETRY_WAIT="0")
        p = subprocess.run([sys.executable, str(ROOT / "scripts" / name)], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout


class ForecastTests(Base):
    def write_latest(self, stations):
        (self.dir / "data" / "latest.json").write_text(json.dumps({"stations": stations}))

    def load(self):
        return json.loads((self.dir / "data" / "forecast.json").read_text())

    def test_estimate_is_calibrated_labelled_and_separate(self):
        self.write_latest([station("A", 160), station("B", 160, lon=103.0)])
        self.run_script("fetch_forecast.py")
        f = self.load()
        self.assertEqual(f["kind"], "estimate")
        self.assertFalse(f["official"])
        a = f["stations"]["A"]
        self.assertEqual(a["calibration"]["ratio"], 2.0)
        self.assertEqual(a["anchor"], "2026-10-20T14:00")
        self.assertEqual(a["start"], "2026-10-20T15:00")
        self.assertLess(abs(a["est"][0] - 160), 5)          # starts at the official reading
        self.assertEqual(a["reach200_24h"], "likely")        # model mean rises to about 130 µg/m³, x 2
        self.assertEqual(a["confidence"], "normal")
        self.assertGreater(a["hi"][23] - a["lo"][23], 0.3 * a["est"][23])   # range is never falsely narrow
        self.assertEqual(a["morning"]["time"], "2026-10-21T07:00")
        self.assertTrue(all(lo <= e <= hi for e, lo, hi in zip(a["est"], a["lo"], a["hi"])))

    def test_stale_official_reading_is_not_forecast(self):
        self.write_latest([station("OLD", 160, observed=NOW.replace(minute=0) - timedelta(hours=5))])
        self.run_script("fetch_forecast.py")
        f = self.load()
        self.assertNotIn("OLD", f["stations"])
        self.assertIn("more than 3 hours", f["skipped"]["OLD"])
        self.assertEqual(f["status"], "unavailable")

    def test_large_disagreement_gives_no_estimate_and_high_ratio_is_low_confidence(self):
        self.write_latest([station("FAR", 1200, ratio=15.0), station("LOW", 560, ratio=7.0, lon=103.0)])
        self.run_script("fetch_forecast.py")
        f = self.load()
        self.assertNotIn("FAR", f["stations"])
        self.assertIn("disagree", f["skipped"]["FAR"])
        self.assertEqual(f["stations"]["LOW"]["confidence"], "low")

    def test_model_download_failure(self):
        self.write_latest([station("A", 160)])
        Fake.aq_ok = False
        self.run_script("fetch_forecast.py")
        self.assertEqual(self.load()["status"], "unavailable")

    def test_cache_is_reused_within_three_hours(self):
        self.write_latest([station("A", 160)])
        self.run_script("fetch_forecast.py")
        Fake.aq_ok = False
        self.run_script("fetch_forecast.py", now=NOW + timedelta(hours=1))
        self.assertEqual(self.load()["status"], "ok")


class SourcesTests(Base):
    def load(self):
        return json.loads((self.dir / "data" / "sources.json").read_text())

    def test_fires_filtered_and_recent_only(self):
        self.run_script("fetch_sources.py")
        fires = self.load()["fires"]
        self.assertEqual(fires["status"], "ok")
        self.assertEqual(fires["count"], 2)
        sumatra = [p for p in fires["points"] if p[0] > 103][0]
        self.assertEqual(sumatra[2], 20.0)                   # merged duplicate keeps the stronger one
        lons = [p[0] for p in fires["points"]]
        self.assertNotIn(142.0, lons)                         # outside region
        self.assertNotIn(110.3, lons)                         # older than 36 h

    def test_wind_vectors_and_refresh(self):
        self.run_script("fetch_sources.py")
        w = self.load()["wind"]
        self.assertEqual(w["status"], "ok")
        self.assertEqual(len(w["u"]), w["grid"]["nx"] * w["grid"]["ny"])
        # wind FROM the south-west blows toward the north-east: u > 0, v > 0
        self.assertAlmostEqual(w["u"][0], 3.54, places=2)
        self.assertAlmostEqual(w["v"][0], 3.54, places=2)
        calls = Fake.wind_calls
        self.run_script("fetch_sources.py", now=NOW + timedelta(hours=1))
        self.assertEqual(Fake.wind_calls, calls)              # not downloaded again within 3 h

    def test_fires_unreachable_keeps_only_recent_previous(self):
        self.run_script("fetch_sources.py")
        Fake.fires_ok = False
        self.run_script("fetch_sources.py", now=NOW + timedelta(hours=2))
        self.assertEqual(self.load()["fires"]["status"], "previous")
        self.run_script("fetch_sources.py", now=NOW + timedelta(hours=40))
        fires = self.load()["fires"]
        self.assertEqual(fires["status"], "failed")
        self.assertEqual(fires["points"], [])


if __name__ == "__main__":
    unittest.main()
