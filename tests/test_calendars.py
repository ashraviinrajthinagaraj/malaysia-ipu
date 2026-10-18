"""Tests for scripts/build_calendars.py (test values only)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BOUNDS = {"districts": [
    {"state": "Johor", "district": "Muar", "bbox": [0, 0, 1, 1], "polygons": []},
    {"state": "Selangor", "district": "Klang", "bbox": [0, 0, 1, 1], "polygons": []},
    {"state": "Selangor", "district": "Petaling", "bbox": [0, 0, 1, 1], "polygons": []},
    {"state": "W.P. Kuala Lumpur", "district": "Kuala Lumpur", "bbox": [0, 0, 1, 1], "polygons": []},
]}


def closure(cid, area, frm, to, url="https://www.bernama.com/en/news.php?id=1", **extra):
    c = {"id": cid, "area": area, "from": frm, "to": to, "covers": "All schools; test, with commas.",
         "announced_by": "Test Exco", "announced_on": "2026-10-17", "added_at": "2026-10-18T08:45:00+08:00",
         "sources": [{"title": "Test headline", "url": url, "published": "2026-10-17T22:00:00+08:00"}]}
    c.update(extra)
    return c


def unfold(text):
    return text.replace("\r\n ", "")


class CalendarTest(unittest.TestCase):
    def build(self, closures):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / "boundaries.json").write_text(json.dumps(BOUNDS))
        (d / "announcements.json").write_text(json.dumps({
            "source_policy": {"allowed_domains": ["bernama.com"]}, "updated_at": "2026-10-18T08:45:00+08:00",
            "closures": closures}))
        env = dict(os.environ, IPU_DATA_DIR=str(d), SITE_URL="https://example.org/ipu/")
        p = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_calendars.py")], env=env, capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return d / "cal", p.stdout

    def test_feeds_per_state(self):
        cal, log = self.build([
            closure("johor-2026-10-19", {"states": ["Johor"]}, "2026-10-19", "2026-10-23"),
            closure("selangor-klang-2026-10-20", {"state": "Selangor", "districts": ["Klang"]}, "2026-10-20", "2026-10-21",
                    until_further_notice=True),
            closure("bad-source", {"states": ["Johor"]}, "2026-10-25", "2026-10-26", url="https://example.com/news"),
        ])
        self.assertIn("Skipped bad-source", log)
        johor = (cal / "johor.ics").read_bytes().decode("utf-8")
        self.assertTrue(johor.startswith("BEGIN:VCALENDAR\r\n") and johor.endswith("END:VCALENDAR\r\n"))
        for line in johor.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75, line)
        u = unfold(johor)
        self.assertIn("UID:johor-2026-10-19@malaysia-ipu", u)
        self.assertIn("DTSTART;VALUE=DATE:20261019", u)
        self.assertIn("DTEND;VALUE=DATE:20261024", u)            # the day after the last closed day
        self.assertIn("All schools\\; test\\, with commas.", u)
        self.assertNotIn("bad-source", u)
        sel = unfold((cal / "selangor.ics").read_text())
        self.assertIn("SUMMARY:Schools closed (haze) until further notice: Klang (Selangor)", sel)
        self.assertNotIn("johor-2026", sel)
        self.assertEqual(unfold((cal / "all.ics").read_text()).count("BEGIN:VEVENT"), 2)
        self.assertEqual(unfold((cal / "kuala-lumpur.ics").read_text()).count("BEGIN:VEVENT"), 0)
        idx = json.loads((cal / "index.json").read_text())
        self.assertIn({"state": "W.P. Kuala Lumpur", "name": "W.P. Kuala Lumpur", "file": "kuala-lumpur.ics"}, idx["feeds"])

    def test_files_do_not_change_without_new_announcements(self):
        cal, _ = self.build([closure("johor-2026-10-19", {"states": ["Johor"]}, "2026-10-19", "2026-10-23")])
        first = (cal / "johor.ics").read_bytes()
        self.assertNotIn(b"DTSTAMP:2026101", first.replace(b"DTSTAMP:20261018T004500Z", b""))   # stamp = updated_at


if __name__ == "__main__":
    unittest.main()
