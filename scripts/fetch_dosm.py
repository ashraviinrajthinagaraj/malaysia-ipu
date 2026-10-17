#!/usr/bin/env python3
"""Download DOSM's published monthly air pollution dataset (OpenDOSM,
https://open.dosm.gov.my/data-catalogue/air_pollution) and write
docs/data/dosm_monthly.json for the "historical context" chart.

This is supplementary history only. It is national monthly average pollutant
concentrations, not IPU, not per station and not current, and the page says so.

The file changes rarely, so it is downloaded at most once every 7 days
(pass --force to download anyway). Python standard library only.
"""
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

MYT = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("IPU_DATA_DIR", ROOT / "docs" / "data"))
OUT = DATA_DIR / "dosm_monthly.json"
CSV_URL = os.environ.get("DOSM_CSV_URL", "https://storage.data.gov.my/environment/air_pollution.csv")
PAGE_URL = "https://open.dosm.gov.my/data-catalogue/air_pollution"
MAX_AGE = timedelta(days=7)


def norm_pollutant(text):
    """'PM2.5', 'pm25', 'PM₂.₅' -> 'pm25'."""
    sub = str.maketrans("₀₁₂₃₄₅₆₇₈₉", "0123456789")
    t = str(text or "").translate(sub).lower()
    return "".join(ch for ch in t if ch.isalnum())


def main():
    force = "--force" in sys.argv
    now = datetime.now(MYT).replace(microsecond=0)
    if OUT.exists() and not force:
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
            fetched = datetime.fromisoformat(old.get("fetched_at"))
            if now - fetched < MAX_AGE:
                print(f"DOSM data is recent ({old.get('fetched_at')}); skipping.")
                return 0
        except (ValueError, TypeError, OSError):
            pass

    try:
        req = urllib.request.Request(CSV_URL, headers={"User-Agent": "MalaysiaIPUDashboard/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8-sig")
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        print(f"Could not download DOSM data: {err}. Keeping the previous file.")
        return 0  # not fatal: history is supplementary

    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        date = (r.get("date") or "").strip()[:10]
        pol = norm_pollutant(r.get("pollutant"))
        val = (r.get("concentration") or "").strip()
        if not date or not pol:
            continue
        try:
            conc = round(float(val), 4) if val not in ("", "NA", "nan") else None
        except ValueError:
            conc = None
        rows.append([date, pol, conc])

    if not rows:
        print("DOSM file had no usable rows; keeping the previous file.")
        return 0

    rows.sort()
    out = {
        "fetched_at": now.isoformat(),
        "source": {
            "name": "Department of Statistics Malaysia (OpenDOSM) – Monthly Air Pollution "
                    "(source agencies: DOE, DOSM)",
            "page": PAGE_URL,
            "csv": CSV_URL,
            "licence": "CC BY 4.0",
        },
        "note": "Monthly national average concentrations from DOE monitoring stations. "
                "Gases in ppm, PM10 and PM2.5 in µg/m³. Not IPU, not per station, not current.",
        "columns": ["date", "pollutant", "concentration"],
        "rows": rows,
        "first_month": rows[0][0],
        "last_month": max(r[0] for r in rows if r[2] is not None) if any(r[2] is not None for r in rows) else None,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"DOSM: {len(rows)} rows, {out['first_month']} to {out['last_month']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
