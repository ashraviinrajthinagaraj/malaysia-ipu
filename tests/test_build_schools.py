"""Tests for scripts/build_schools.py using small made-up school files
(test data only, in the column layout of KPM's school list)."""
import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_schools  # noqa: E402

CSV = """SENARAI SEKOLAH (TEST FILE)
,,,,,,,
NEGERI,PPD,KODSEKOLAH,NAMASEKOLAH,BANDARSURAT,POSKODSURAT,KOORDINATXX,KOORDINATYY
NEGERI SEMBILAN,PPD KUALA PILAH,NBA0001,SK TEST SATU,KUALA PILAH,72000,102.2490,2.7390
NEGERI SEMBILAN,PPD KUALA PILAH,NEA0002,SMK TEST DUA,KUALA PILAH,72000,2.7400,102.2500
SELANGOR,PPD PETALING,BBA0003,SK TEST TIGA,SHAH ALAM,40000,,
SELANGOR,PPD PETALING,BBA0003,SK TEST TIGA,SHAH ALAM,40000,101.5,3.07
"""


def write_xlsx(path, rows):
    def cell(ref, v):
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(v))}</t></is></c>'
    letters = "ABCDEFGHIJ"
    sheet_rows = "".join(
        f'<row r="{i + 1}">' + "".join(cell(f"{letters[j]}{i + 1}", v) for j, v in enumerate(r)) + "</row>"
        for i, r in enumerate(rows))
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/workbook.xml",
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Target="worksheets/sheet1.xml" '
                   'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml",
                   '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   f"<sheetData>{sheet_rows}</sheetData></worksheet>")


class SchoolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.old = (build_schools.SRC_DIR, build_schools.OUT)
        build_schools.SRC_DIR = self.tmp / "src"
        build_schools.OUT = self.tmp / "schools.json"
        build_schools.SRC_DIR.mkdir()

    def tearDown(self):
        build_schools.SRC_DIR, build_schools.OUT = self.old
        shutil.rmtree(self.tmp)

    def load(self):
        build_schools.main()
        return json.loads(build_schools.OUT.read_text())

    def test_csv_with_title_rows_swapped_coords_and_missing(self):
        (build_schools.SRC_DIR / "senarai.csv").write_text(CSV, encoding="utf-8")
        d = self.load()
        self.assertTrue(d["available"])
        self.assertEqual(d["count"], 3)
        self.assertEqual(d["skipped_no_coordinates"], 1)
        by = {s[0]: s for s in d["schools"]}
        self.assertEqual(by["NBA0001"][1], "SK TEST SATU")
        self.assertEqual(by["NBA0001"][3], "PPD KUALA PILAH")
        self.assertAlmostEqual(by["NBA0001"][5], 2.739)     # latitude from KOORDINATYY
        self.assertAlmostEqual(by["NBA0001"][6], 102.249)   # longitude from KOORDINATXX
        self.assertAlmostEqual(by["NEA0002"][5], 2.74)      # swapped columns corrected

    def test_xlsx(self):
        write_xlsx(build_schools.SRC_DIR / "senarai.xlsx", [
            ["Title row"],
            ["NEGERI", "PPD", "KODSEKOLAH", "NAMASEKOLAH", "BANDARSURAT", "KOORDINATXX", "KOORDINATYY"],
            ["JOHOR", "PPD BATU PAHAT", "JBA0001", "SK TEST EMPAT", "BATU PAHAT", "102.93", "1.85"],
        ])
        d = self.load()
        self.assertEqual(d["count"], 1)
        self.assertEqual(d["schools"][0][:5], ["JBA0001", "SK TEST EMPAT", "JOHOR", "PPD BATU PAHAT", "BATU PAHAT"])

    def test_no_file(self):
        d = self.load()
        self.assertFalse(d["available"])
        self.assertEqual(d["schools"], [])


if __name__ == "__main__":
    unittest.main()
