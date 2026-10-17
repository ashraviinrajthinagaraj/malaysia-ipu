"""Tests for scripts/fetch_apims.py against a local fake of the two APIMS endpoints.

The fake answers with the same structure as the real services (checked
against the live APIMS endpoints). All values are test values.
Run: python3 -m unittest discover -s tests
"""
import json
import os
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
SCRIPT = ROOT / "scripts" / "fetch_apims.py"
MAP = json.loads((ROOT / "tests" / "fixtures" / "apims_map.json").read_text())

sys.path.insert(0, str(ROOT / "scripts"))
import fetch_apims  # noqa: E402


class Fake:
    map_ok = True
    table_ok = True
    table_states_failing = set()


def table_rows(state_id, end):
    rows = []
    for f in MAP["features"]:
        a = f["attributes"]
        if str(a["STATE_ID"]) != str(state_id):
            continue
        for back in range(0, 25):
            t = end - timedelta(hours=back)
            api = a["API"] - back if a["API"] >= 0 else -1
            if a["STATION_ID"] == "CA23N" and t.hour == 9:
                api = 201          # an earlier reading at the closure level
            rows.append({"PAGE_ROWNUM": len(rows) + 1, "STATION_ID": a["STATION_ID"], "STATE_ID": a["STATE_ID"],
                         "STATION_NAME": None, "STATION_LOCATION": a["STATION_LOCATION"],
                         "LATITUDE": a["LATITUDE"], "LONGITUDE": a["LONGITUDE"],
                         "DATETIME": t.strftime("%Y-%m-%dT%H:%M:%S"), "API": api, "PARAM_SYMBOL": "**"})
    return rows


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path.endswith("/query"):
            if not Fake.map_ok:
                return self.send_error(503)
            return self.send_json(MAP)
        if url.path.endswith("/apitablehourly"):
            state = q["stateid"][0]
            if not Fake.table_ok or state in Fake.table_states_failing:
                return self.send_error(503)
            end = datetime.strptime(q["datetime"][0], "%Y-%m-%d %H:%M:%S")
            return self.send_json({"api_table_hourly": table_rows(state, end)})
        self.send_error(404)


class FetchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Fake.map_ok = Fake.table_ok = True
        Fake.table_states_failing = set()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_fetch(self, now="2026-10-17T14:20:00"):
        env = dict(os.environ,
                   APIMS_MAP_URL=f"http://127.0.0.1:{self.port}/map/query",
                   APIMS_TABLE_URL=f"http://127.0.0.1:{self.port}/apitablehourly",
                   IPU_DATA_DIR=str(self.dir), IPU_NOW=now, APIMS_RETRY_WAIT="0")
        p = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
        data = json.loads((self.dir / "latest.json").read_text())
        return p.returncode, data, p.stdout + p.stderr

    def by_id(self, data):
        return {s["id"]: s for s in data["stations"]}

    def test_normal_update(self):
        code, data, log = self.run_fetch()
        self.assertEqual(code, 0, log)
        self.assertEqual(data["status"], "ok")
        st = self.by_id(data)
        self.assertEqual(st["CA23N"]["api"], 177)
        self.assertEqual(st["CA23N"]["name"], "Nilai")
        self.assertEqual(st["CA23N"]["state"], "Negeri Sembilan")
        self.assertEqual(st["CA23N"]["category"], "Unhealthy")
        self.assertEqual(st["CA24N"]["category"], "Very unhealthy")
        # map DATETIME is Malaysia wall-clock time stored as if UTC
        self.assertEqual(st["CA23N"]["observed"], "2026-10-17T14:00:00+08:00")
        self.assertEqual(data["observation_time"], "2026-10-17T14:00:00+08:00")
        self.assertEqual(data["last_success"], "2026-10-17T14:20:00+08:00")
        # hourly history from the per-state table
        hours = dict((k, v) for k, v in st["CA23N"]["hourly"])
        self.assertEqual(hours["2026-10-17T09:00"], 201)
        self.assertEqual(len(st["CA23N"]["hourly"]), 25)

    def test_negative_value_is_no_reading(self):
        _, data, _ = self.run_fetch()
        pd = self.by_id(data)["CA25N"]
        self.assertIsNone(pd["api"])
        self.assertIsNone(pd["category"])
        self.assertTrue(all(v is None for _, v in pd["hourly"]))
        self.assertEqual(data["counts"]["with_reading"], 4)

    def test_map_down_uses_hourly_table(self):
        self.run_fetch()                      # first a good run
        Fake.map_ok = False
        code, data, log = self.run_fetch(now="2026-10-17T15:20:00")
        self.assertEqual(code, 0, log)
        self.assertEqual(data["status"], "partial")
        st = self.by_id(data)["CA23N"]
        self.assertEqual(st["observed"], "2026-10-17T15:00:00+08:00")
        self.assertEqual(st["source"], "hourly")

    def test_total_failure_keeps_old_readings_and_marks_failed(self):
        self.run_fetch()
        Fake.map_ok = Fake.table_ok = False
        code, data, _ = self.run_fetch(now="2026-10-17T15:20:00")
        self.assertEqual(code, 1)
        self.assertEqual(data["status"], "failed")
        self.assertEqual(data["last_success"], "2026-10-17T14:20:00+08:00")   # not moved forward
        self.assertEqual(data["last_attempt"], "2026-10-17T15:20:00+08:00")
        st = self.by_id(data)["CA23N"]
        self.assertEqual(st["api"], 177)
        self.assertEqual(st["observed"], "2026-10-17T14:00:00+08:00")       # old time kept, not relabelled

    def test_failure_with_no_previous_file(self):
        Fake.map_ok = Fake.table_ok = False
        code, data, _ = self.run_fetch()
        self.assertEqual(code, 1)
        self.assertEqual(data["status"], "failed")
        self.assertEqual(data["stations"], [])
        self.assertIsNone(data["last_success"])

    def test_one_state_table_failing_is_partial(self):
        Fake.table_states_failing = {"5"}
        code, data, _ = self.run_fetch()
        self.assertEqual(code, 0)
        self.assertEqual(data["status"], "partial")
        self.assertEqual(self.by_id(data)["CA23N"]["api"], 177)   # still from the map service


class UnitTests(unittest.TestCase):
    def test_categories(self):
        c = fetch_apims.category
        self.assertEqual([c(0), c(50), c(51), c(100), c(101), c(200), c(201), c(300), c(301)],
                         ["Good", "Good", "Moderate", "Moderate", "Unhealthy", "Unhealthy",
                          "Very unhealthy", "Very unhealthy", "Hazardous"])
        self.assertIsNone(c(None))

    def test_values(self):
        self.assertIsNone(fetch_apims.to_api(-1))
        self.assertIsNone(fetch_apims.to_api(""))
        self.assertIsNone(fetch_apims.to_api("abc"))
        self.assertEqual(fetch_apims.to_api("63"), 63)
        self.assertEqual(fetch_apims.to_api(63.0), 63)

    def test_names(self):
        self.assertEqual(fetch_apims.split_location("Batu Muda, W.P. KUALA LUMPUR"), "Batu Muda")
        self.assertEqual(fetch_apims.nice_case("NEGERI SEMBILAN"), "Negeri Sembilan")
        self.assertEqual(fetch_apims.nice_case("W.P. KUALA LUMPUR"), "W.P. Kuala Lumpur")


if __name__ == "__main__":
    unittest.main()
