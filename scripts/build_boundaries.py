#!/usr/bin/env python3
"""Build docs/data/boundaries.json: simplified official district boundaries.

Source: the district GeoJSON published by data.gov.my (Government of
Malaysia) in github.com/data-gov-my/datagovmy-front
(packages/datagovmy-ui/src/lib/geojson/raw/district.json, MIT licence).

The page uses these boundaries to tell which state and district a school,
town or place is in, so that official closure announcements for a state or
district are applied to the right places, and to shade closed areas on the map.

Usage: python3 scripts/build_boundaries.py path/to/district.json [source-commit]
Python standard library only. Run it again only if the boundaries change.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "boundaries.json"
TOLERANCE = 0.0025      # degrees (about 250 m): fine for deciding which district a place is in
DECIMALS = 4
MIN_RING_POINTS = 4


def perp(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return ((x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2) ** 0.5


def simplify(points, tol):
    """Douglas-Peucker, iterative."""
    if len(points) <= 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, None
        for k in range(i + 1, j):
            d = perp(points[k], points[i], points[j])
            if d > best:
                best, idx = d, k
        if idx is not None and best > tol:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(points, keep) if k]


def ring(coords):
    pts = [(round(x, DECIMALS), round(y, DECIMALS)) for x, y in coords]
    pts = simplify(pts, TOLERANCE)
    out = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    if out and out[0] != out[-1]:
        out.append(out[0])
    return [list(p) for p in out] if len(out) >= MIN_RING_POINTS else None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    commit = sys.argv[2] if len(sys.argv) > 2 else None
    districts, before, after = [], 0, 0
    for f in src["features"]:
        props, g = f["properties"], f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        out_polys = []
        for poly in polys:
            before += sum(len(r) for r in poly)
            outer = ring(poly[0])
            if not outer:
                continue
            holes = [h for h in (ring(r) for r in poly[1:]) if h]
            out_polys.append([outer] + holes)
            after += sum(len(r) for r in [outer] + holes)
        if not out_polys:
            continue
        xs = [p[0] for poly in out_polys for p in poly[0]]
        ys = [p[1] for poly in out_polys for p in poly[0]]
        districts.append({
            "state": props["state"], "district": props["district"],
            "bbox": [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)],
            "polygons": out_polys,
        })
    out = {
        "source": {
            "name": "District boundaries, data.gov.my (Government of Malaysia)",
            "url": "https://github.com/data-gov-my/datagovmy-front/blob/main/packages/datagovmy-ui/src/lib/geojson/raw/district.json",
            "licence": "MIT (datagovmy-front repository)",
            "commit": commit,
            "simplified": f"Douglas-Peucker, tolerance {TOLERANCE} degrees",
        },
        "built_at": datetime.now(timezone(timedelta(hours=8))).replace(microsecond=0).isoformat(),
        "districts": districts,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{len(districts)} districts, {before} -> {after} points, {OUT.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
