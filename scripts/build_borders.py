#!/usr/bin/env python3
"""Find districts that share a land border, from docs/data/boundaries.json.

Writes docs/data/borders.json, used by the "Across the border" finder:
  districts: [{"s": state, "d": district, "p": [lon, lat]}]   p = a point well inside the district
  pairs:     [[i, j, lon, lat, km]]                           a point on the shared border and its rough length

Two districts count as neighbours when stretches of one's boundary lie within
1 km of the other's boundary for at least 2 km in total.
(The boundaries are simplified, so shared borders are not exactly identical.)
Run again only when boundaries.json changes. Python standard library only.
"""
import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(os.environ.get("BORDERS_SRC", ROOT / "docs" / "data" / "boundaries.json"))
OUT = Path(os.environ.get("BORDERS_OUT", ROOT / "docs" / "data" / "borders.json"))
NEAR_KM = 1.0
MIN_KM = 2.0
CELL = 0.01                     # degrees, for the vertex grid


def km(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    dx = (a[0] - b[0]) * 111.32 * math.cos(lat)
    dy = (a[1] - b[1]) * 110.57
    return math.hypot(dx, dy)


def rings(d):
    for poly in d["polygons"]:
        for ring in poly:
            yield ring


def inside(pt, d):
    x, y = pt
    hit = False
    for poly in d["polygons"]:
        for ring in poly:
            j = len(ring) - 1
            for i in range(len(ring)):
                xi, yi = ring[i]
                xj, yj = ring[j]
                if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                    hit = not hit
                j = i
    return hit


def label_point(d, verts):
    """A point well inside the district: of a grid of inside points, the one farthest from the boundary."""
    w, s, e, n = d["bbox"]
    best, best_d = None, -1
    steps = 18
    sample = verts[:: max(1, len(verts) // 400)]
    for i in range(steps):
        for j in range(steps):
            p = (w + (e - w) * (i + 0.5) / steps, s + (n - s) * (j + 0.5) / steps)
            if not inside(p, d):
                continue
            dist = min(km(p, v) for v in sample)
            if dist > best_d:
                best, best_d = p, dist
    if best is None:                       # very thin district: use the middle vertex
        best = verts[len(verts) // 2]
    return [round(best[0], 4), round(best[1], 4)]


def seg_km(p, a, b):
    """Distance in km from point p to segment a-b (local flat approximation)."""
    lat = math.radians(p[1])
    kx, ky = 111.32 * math.cos(lat), 110.57
    ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * ky
    bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * ky
    dx, dy = bx - ax, by - ay
    ll = dx * dx + dy * dy
    t = 0.0 if ll == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / ll))
    return math.hypot(ax + t * dx, ay + t * dy)


def seg_grid(d):
    g = {}
    for ring in rings(d):
        for k in range(len(ring) - 1):
            a, b = ring[k], ring[k + 1]
            for cx in range(int(min(a[0], b[0]) // CELL) - 1, int(max(a[0], b[0]) // CELL) + 2):
                for cy in range(int(min(a[1], b[1]) // CELL) - 1, int(max(a[1], b[1]) // CELL) + 2):
                    g.setdefault((cx, cy), []).append((a, b))
    return g


def densify(ring, step=0.005):
    """Extra points along long edges (about every 0.5 km), so shared borders are found
    even where the two simplified outlines have their corners in different places."""
    out = []
    for k in range(len(ring) - 1):
        a, b = ring[k], ring[k + 1]
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        for t in range(n):
            out.append((a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n))
    out.append(tuple(ring[-1]))
    return out


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    ds = data["districts"]
    verts = [[tuple(p) for r in rings(d) for p in r] for d in ds]
    grids = [seg_grid(d) for d in ds]
    dense = [[densify(r) for r in rings(d)] for d in ds]
    pad = 0.02
    pairs = []
    for i in range(len(ds)):
        for j in range(i + 1, len(ds)):
            a, b = ds[i]["bbox"], ds[j]["bbox"]
            if a[0] - pad > b[2] or b[0] - pad > a[2] or a[1] - pad > b[3] or b[1] - pad > a[3]:
                continue
            gb = grids[j]
            close, length = [], 0.0
            for ring in dense[i]:
                flags = []
                for p in ring:
                    cell = gb.get((int(p[0] // CELL), int(p[1] // CELL)), ())
                    flags.append(any(seg_km(p, s0, s1) <= NEAR_KM for s0, s1 in cell))
                for k, p in enumerate(ring):
                    if flags[k]:
                        close.append(tuple(p))
                    if k and flags[k] and flags[k - 1]:
                        length += km(ring[k - 1], p)
            if len(close) < 2 or length < MIN_KM:
                continue
            mid = close[len(close) // 2]
            pairs.append([i, j, round(mid[0], 4), round(mid[1], 4), round(length, 1)])
    out = {
        "source": "Computed from boundaries.json (district boundaries from data.gov.my).",
        "method": "Neighbours share at least 2 km of border (boundaries within 1 km of each other). "
                  "p is a point well inside each district.",
        "built_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "districts": [{"s": d["state"], "d": d["district"], "p": label_point(d, verts[k])} for k, d in enumerate(ds)],
        "pairs": pairs,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    cross = sum(1 for p in pairs if ds[p[0]]["state"] != ds[p[1]]["state"])
    print(f"{len(ds)} districts, {len(pairs)} neighbour pairs ({cross} across state lines). Wrote {OUT}")


if __name__ == "__main__":
    main()
