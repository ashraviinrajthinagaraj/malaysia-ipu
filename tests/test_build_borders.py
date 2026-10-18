"""Tests for scripts/build_borders.py with small made-up districts (test values only)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def square(x0, y0, size):
    ring = [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]
    return {"bbox": [x0, y0, x0 + size, y0 + size], "polygons": [[ring]]}


class BordersTest(unittest.TestCase):
    def test_neighbours_and_inside_points(self):
        ds = [dict(state="A", district="West", **square(101.0, 3.0, 0.2)),
              dict(state="B", district="East", **square(101.2, 3.05, 0.2)),     # shares about 17 km of edge
              dict(state="B", district="Far", **square(102.0, 3.0, 0.2))]
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "b.json", Path(tmp) / "o.json"
            src.write_text(json.dumps({"districts": ds}))
            env = dict(os.environ, BORDERS_SRC=str(src), BORDERS_OUT=str(out))
            subprocess.run([sys.executable, str(ROOT / "scripts" / "build_borders.py")], env=env, check=True, capture_output=True)
            data = json.loads(out.read_text())
        self.assertEqual([(p[0], p[1]) for p in data["pairs"]], [(0, 1)])
        km = data["pairs"][0][4]
        self.assertTrue(15 < km < 19, km)
        lon, lat = data["districts"][0]["p"]
        self.assertTrue(101.0 < lon < 101.2 and 3.0 < lat < 3.2)


if __name__ == "__main__":
    unittest.main()
