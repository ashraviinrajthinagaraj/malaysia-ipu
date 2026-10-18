"""Tests for scripts/check_announcements.py, including the real announcements file."""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import check_announcements as C  # noqa: E402

REAL = json.loads((ROOT / "docs" / "data" / "announcements.json").read_text())
BOUNDS = json.loads((ROOT / "docs" / "data" / "boundaries.json").read_text())


class AnnouncementTests(unittest.TestCase):
    def test_real_file_is_valid(self):
        self.assertEqual(C.check(REAL, BOUNDS), [])

    def test_only_bernama_sources(self):
        d = copy.deepcopy(REAL)
        d["closures"][0]["sources"][0]["url"] = "https://www.example.com/news/1"
        self.assertTrue(any("bernama.com" in e for e in C.check(d, BOUNDS)))
        d["closures"][0]["sources"][0]["url"] = "http://www.bernama.com/en/news.php?id=1"
        self.assertTrue(any("https" in e for e in C.check(d, BOUNDS)))
        d["closures"][0]["sources"][0]["url"] = "https://notbernama.com/x"
        self.assertTrue(C.check(d, BOUNDS))
        d["source_policy"]["allowed_domains"] = ["bernama.com", "example.com"]
        self.assertTrue(any("allowed_domains" in e for e in C.check(d, BOUNDS)))

    def test_dates_and_area(self):
        d = copy.deepcopy(REAL)
        d["closures"][0]["to"] = "2026-10-18"
        self.assertTrue(any("after" in e for e in C.check(d, BOUNDS)))
        d = copy.deepcopy(REAL)
        d["closures"][0]["area"] = {"states": ["Johore Darul Takzim"]}
        self.assertTrue(any("unknown state" in e for e in C.check(d, BOUNDS)))
        d["closures"][0]["area"] = {"state": "Johor", "districts": ["Batu Pahat", "Atlantis"]}
        errs = C.check(d, BOUNDS)
        self.assertEqual(len(errs), 1)
        self.assertIn("Atlantis", errs[0])
        d["closures"][0]["area"] = {"states": ["W.P. Kuala Lumpur", "Pulau Pinang"]}
        self.assertEqual(C.check(d, BOUNDS), [])

    def test_boundaries_cover_every_state_with_stations(self):
        latest = json.loads((ROOT / "docs" / "data" / "latest.json").read_text())
        known = {C.norm(d["state"]) for d in BOUNDS["districts"]}
        for st in latest.get("stations", []):
            self.assertIn(C.norm(st["state"]), known, st["state"])


if __name__ == "__main__":
    unittest.main()
