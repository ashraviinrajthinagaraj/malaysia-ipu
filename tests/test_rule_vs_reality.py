"""Tests for scripts/rule_vs_reality.py with a local fake of the APIMS hourly table.
All readings are made-up test values."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 10, 21, 10, 20)                 # Wednesday, during the closure

# two Johor stations, one Melaka station
STATIONS = [
    {"id": "J1", "name": "Pasir Gudang", "state": "Johor", "state_id": 1, "lat": 1.47, "lon": 103.89},
    {"id": "J2", "name": "Segamat", "state": "Johor", "state_id": 1, "lat": 2.51, "lon": 102.81},
    {"id": "M1", "name": "Bandaraya Melaka", "state": "Melaka", "state_id": 4, "lat": 2.19, "lon": 102.25},
]


def reading(sid, t):
    """J1 reaches 205 on Fri 16 Oct afternoon only; J2 stays at 150; M1 at 90."""
    if sid == "J1":
        return 205 if (t.date().isoformat() == "2026-10-16" and 14 <= t.hour <= 16) else 180
    return 150 if sid == "J2" else 90


class Handler(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        Handler.calls.append(q["datetime"][0])
        end = datetime.strptime(q["datetime"][0], "%Y-%m-%d %H:%M:%S")
        rows = []
        for s in STATIONS:
            if str(s["state_id"]) != q["stateid"][0]:
                continue
            for h in range(24):
                t = end - timedelta(hours=h)
                rows.append({"STATION_ID": s["id"], "DATETIME": t.strftime("%Y-%m-%dT%H:00:00"), "API": reading(s["id"], t)})
        body = json.dumps({"api_table_hourly": rows}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


def latest_json():
    sts = []
    for s in STATIONS:
        hourly = [[(NOW.replace(minute=0) - timedelta(hours=h)).strftime("%Y-%m-%dT%H:00"),
                   reading(s["id"], NOW.replace(minute=0) - timedelta(hours=h))] for h in range(47, -1, -1)]
        sts.append(dict(s, api=hourly[-1][1], observed=NOW.replace(minute=0).strftime("%Y-%m-%dT%H:00:00+08:00"), hourly=hourly))
    return {"stations": sts}


def announcements(extra=None):
    c = [{
        "id": "johor-2026-10-19", "area": {"states": ["Johor"]}, "from": "2026-10-19", "to": "2026-10-23",
        "covers": "All schools", "announced_by": "Test", "announced_on": "2026-10-17",
        "sources": [{"title": "t", "url": "https://www.bernama.com/en/x", "published": "2026-10-17T22:09:00+08:00"}],
    }]
    return {"source_policy": {"allowed_domains": ["bernama.com"]}, "closures": c + (extra or [])}


class RuleRealityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Handler.calls = []
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copy(ROOT / "docs" / "data" / "boundaries.json", self.tmp / "boundaries.json")
        (self.tmp / "latest.json").write_text(json.dumps(latest_json()))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_it(self, ann, url=None, now=NOW):
        (self.tmp / "announcements.json").write_text(json.dumps(ann))
        env = dict(os.environ, IPU_DATA_DIR=str(self.tmp), IPU_CACHE_DIR=str(self.tmp / "cache"),
                   IPU_NOW=now.strftime("%Y-%m-%dT%H:%M:%S"), APIMS_RETRY_WAIT="0",
                   APIMS_TABLE_URL=url or f"http://127.0.0.1:{self.srv.server_address[1]}/apitablehourly")
        p = subprocess.run([sys.executable, str(ROOT / "scripts" / "rule_vs_reality.py")], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return json.loads((self.tmp / "rule_reality.json").read_text())["closures"]

    def test_state_closure_compared_with_official_readings(self):
        r = self.run_it(announcements())["johor-2026-10-19"]
        self.assertEqual(sorted(r["stations"]), ["J1", "J2"])                # Melaka station not included
        b24 = r["before24"]
        self.assertEqual(b24["max"]["api"], 180)
        self.assertEqual(b24["reached200"], [])
        self.assertTrue(b24["complete"])                                    # backfilled from the APIMS table
        self.assertEqual(r["before72"]["reached200"][0]["api"], 205)
        self.assertEqual(r["verdict"]["kind"], "beyond")
        self.assertIn("Pasir Gudang (205 on Fri 16 Oct)", r["verdict"]["text"])
        days = {d["date"]: d for d in r["days"]}
        self.assertEqual(min(days), "2026-10-15")                           # from 2 days before the announcement
        self.assertEqual(max(days), "2026-10-21")                           # up to today
        self.assertTrue(days["2026-10-20"]["closed"])
        self.assertFalse(days["2026-10-18"]["closed"])
        self.assertEqual(days["2026-10-16"]["reached200"], 1)
        self.assertTrue(days["2026-10-21"]["partial_day"])

    def test_stored_hours_survive_when_apims_drops_them(self):
        self.run_it(announcements())
        later = NOW + timedelta(days=9)                                     # APIMS no longer keeps 15-17 Oct
        (self.tmp / "latest.json").write_text(json.dumps({"stations": [dict(s, hourly=[]) for s in latest_json()["stations"]]}))
        r = self.run_it(announcements(), url="http://127.0.0.1:9/down", now=later)["johor-2026-10-19"]
        self.assertTrue(r["before24"]["complete"])
        self.assertEqual(r["before72"]["reached200"][0]["api"], 205)

    def test_district_without_station_uses_nearest_and_says_so(self):
        extra = [{"id": "mersing-2026-10-20", "area": {"state": "Johor", "districts": ["Mersing"]}, "from": "2026-10-20", "to": "2026-10-21",
                  "covers": "Schools", "announced_by": "Test", "announced_on": "2026-10-19",
                  "sources": [{"title": "t", "url": "https://www.bernama.com/en/y", "published": "2026-10-19T20:00:00+08:00"}]}]
        r = self.run_it(announcements(extra))["mersing-2026-10-20"]
        self.assertIn("nearest", r["basis"])
        self.assertEqual(len(r["stations"]), 1)

    def test_non_bernama_closure_is_ignored(self):
        extra = [{"id": "fake", "area": {"states": ["Melaka"]}, "from": "2026-10-20", "to": "2026-10-21", "covers": "x",
                  "announced_by": "x", "announced_on": "2026-10-19",
                  "sources": [{"title": "t", "url": "https://example.com/z", "published": "2026-10-19T20:00:00+08:00"}]}]
        self.assertNotIn("fake", self.run_it(announcements(extra)))


if __name__ == "__main__":
    unittest.main()
