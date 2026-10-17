#!/usr/bin/env python3
"""Build docs/data/schools.json from the Ministry of Education's (KPM)
official school list.

How to use:
  1. Download KPM's school list ("Senarai Sekolah Rendah dan Menengah", the
     version that includes the coordinate columns) from the official KPM
     website or the government open data portal (data.gov.my).
  2. Put the file (.csv or .xlsx) in data_sources/schools/ in this repository.
  3. Commit. The hourly workflow runs this script and the school search on
     the dashboard starts using the official list.

Recognised column names (case and spaces ignored):
  school code : KODSEKOLAH, KOD SEKOLAH, SCHOOL_CODE, CODE
  school name : NAMASEKOLAH, NAMA SEKOLAH, SCHOOL_NAME, NAME
  state       : NEGERI, STATE
  district    : PPD, DAERAH, DISTRICT
  town        : BANDARSURAT, BANDAR, TOWN, LOKASI_BANDAR
  latitude    : KOORDINATYY, LATITUDE, LAT
  longitude   : KOORDINATXX, LONGITUDE, LON, LNG

Schools without usable coordinates are counted and left out; nothing is
guessed. Python standard library only (the .xlsx reader is built in).
"""
import csv
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

MYT = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "data_sources" / "schools"
OUT = ROOT / "docs" / "data" / "schools.json"

ALIASES = {
    "code": ["kodsekolah", "kodsek", "schoolcode", "code", "kod"],
    "name": ["namasekolah", "schoolname", "namasek", "name", "nama"],
    "state": ["negeri", "state"],
    "district": ["ppd", "daerah", "district", "pejabatpendidikandaerah"],
    "town": ["bandarsurat", "bandar", "town", "lokasibandar", "city"],
    "lat": ["koordinatyy", "koordinaty", "latitude", "lat"],
    "lon": ["koordinatxx", "koordinatx", "longitude", "lon", "lng", "long"],
}

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "rel": "http://schemas.openxmlformats.org/package/2006/relationships"}


def key(text):
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


# ----------------------------------------------------------- readers

def col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_xlsx(path):
    """Rows of the first worksheet as lists of strings."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        first = wb.find("m:sheets/m:sheet", NS)
        rid = first.get(f"{{{NS['r']}}}id")
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = next(r.get("Target") for r in rels.findall("rel:Relationship", NS)
                      if r.get("Id") == rid)
        target = target.lstrip("/")
        sheet_path = target if target.startswith("xl/") else "xl/" + target
        sheet = ET.fromstring(z.read(sheet_path))
        rows = []
        for row in sheet.iter(f"{{{NS['m']}}}row"):
            cells = {}
            for c in row.findall("m:c", NS):
                ref, t = c.get("r"), c.get("t")
                v = c.find("m:v", NS)
                if t == "s" and v is not None:
                    val = shared[int(v.text)]
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                else:
                    val = v.text if v is not None else ""
                cells[col_index(ref)] = val or ""
            if cells:
                width = max(cells) + 1
                rows.append([cells.get(i, "") for i in range(width)])
        return rows


def read_csv(path):
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect)]


# ----------------------------------------------------------- mapping

def find_header(rows):
    """KPM files sometimes have title lines above the header. Look for the
    first row that has a name column and a coordinate column."""
    for i, row in enumerate(rows[:30]):
        keys = [key(c) for c in row]
        cols = {}
        for field, names in ALIASES.items():
            for name in names:
                if name in keys:
                    cols[field] = keys.index(name)
                    break
        if "name" in cols and "lat" in cols and "lon" in cols:
            return i, cols
    return None, None


def to_float(text):
    try:
        return float(str(text).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def in_malaysia(lat, lon):
    return lat is not None and lon is not None and 0.5 <= lat <= 7.6 and 99.5 <= lon <= 119.5


def clean(text):
    return " ".join(str(text or "").split())


def build(paths):
    schools, skipped, used = [], 0, []
    seen = set()
    for path in paths:
        rows = read_xlsx(path) if path.suffix.lower() == ".xlsx" else read_csv(path)
        h, cols = find_header(rows)
        if h is None:
            print(f"  {path.name}: no header with school name + coordinate columns found; skipped")
            continue
        used.append(path.name)
        for row in rows[h + 1:]:
            get = lambda f: clean(row[cols[f]]) if f in cols and cols[f] < len(row) else ""
            name = get("name")
            if not name:
                continue
            lat, lon = to_float(get("lat")), to_float(get("lon"))
            if not in_malaysia(lat, lon) and in_malaysia(lon, lat):
                lat, lon = lon, lat           # columns swapped in some releases
            if not in_malaysia(lat, lon):
                skipped += 1
                continue
            code = get("code")
            dedupe = code or (name, round(lat, 4), round(lon, 4))
            if dedupe in seen:
                continue
            seen.add(dedupe)
            schools.append([code, name, get("state"), get("district"), get("town"),
                            round(lat, 6), round(lon, 6)])
    schools.sort(key=lambda s: (s[2], s[1]))
    return schools, skipped, used


def main():
    paths = sorted(p for p in SRC_DIR.glob("*") if p.suffix.lower() in (".csv", ".xlsx"))
    now = datetime.now(MYT).replace(microsecond=0).isoformat()
    if not paths:
        out = {"available": False, "built_at": now, "schools": [],
               "note": "Official KPM school list not added yet. See README: 'Adding the official school list'."}
        print("No school list in data_sources/schools/; writing an empty schools.json.")
    else:
        schools, skipped, used = build(paths)
        out = {
            "available": bool(schools),
            "built_at": now,
            "source": {
                "name": "Ministry of Education Malaysia (KPM) – official school list",
                "files": used,
            },
            "columns": ["code", "name", "state", "district", "town", "lat", "lon"],
            "count": len(schools),
            "skipped_no_coordinates": skipped,
            "schools": schools,
        }
        print(f"Schools: {len(schools)} with coordinates, {skipped} skipped (no usable coordinates).")
    # Rewrite only when the content changed, so the hourly job does not commit for nothing.
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
        old.pop("built_at", None)
        same = old == {k: v for k, v in out.items() if k != "built_at"}
    except (OSError, ValueError):
        same = False
    if same:
        print("School list unchanged.")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
