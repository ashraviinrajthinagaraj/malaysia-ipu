// Tests for docs/logic.js (station matching, freshness, closure prediction, search).
// Run: node --test tests/      All values are test values.
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../docs/logic.js");
const rule = require("../docs/data/rule.json");

function hours(day, from, to, f) {
  const out = [];
  for (let h = from; h <= to; h++) out.push([`${day}T${String(h).padStart(2, "0")}:00`, f(h)]);
  return out;
}
function st(id, name, state, lat, lon, api, observed, hourly) {
  return { id, name, state, lat, lon, api, observed, hourly: hourly || [] };
}

// Saturday 17 Oct 2026, 14:25 Malaysia time
const NOW = new Date("2026-10-17T14:25:00+08:00");
const DAY = "2026-10-17";

test("categories follow DOE bands", () => {
  assert.equal(L.categoryFor(50).label, "Good");
  assert.equal(L.categoryFor(51).label, "Moderate");
  assert.equal(L.categoryFor(200).label, "Unhealthy");
  assert.equal(L.categoryFor(201).label, "Very unhealthy");
  assert.equal(L.categoryFor(301).label, "Hazardous");
  assert.equal(L.categoryFor(null), null);
});

test("Malaysia time formatting is independent of the viewer's time zone", () => {
  const t = L.parseTime("2026-10-17T14:00:00+08:00");
  assert.equal(L.fmtTime(t), "14:00");
  assert.equal(L.mytDateKey(new Date("2026-10-17T17:30:00Z")), "2026-10-18");
  assert.equal(L.fmtDayKey("2026-10-18"), "Sun 18 Oct 2026");
});

test("old readings are not treated as current", () => {
  const fresh = st("A", "A", "Selangor", 3, 101.5, 120, "2026-10-17T14:00:00+08:00");
  const old = st("B", "B", "Selangor", 3, 101.6, 120, "2026-10-17T10:00:00+08:00");
  assert.equal(L.stationCurrent(fresh, NOW), true);
  assert.equal(L.stationCurrent(old, NOW), false);
  assert.equal(L.stationCurrent({ ...fresh, api: null }, NOW), false);
});

test("freshness flags a failed or late update", () => {
  const ok = { status: "ok", last_success: "2026-10-17T14:21:00+08:00", observation_time: "2026-10-17T14:00:00+08:00", stations: [{}] };
  assert.equal(L.freshness(ok, NOW).stale, false);
  assert.equal(L.freshness({ ...ok, status: "failed" }, NOW).stale, true);
  const late = new Date("2026-10-17T18:30:00+08:00");
  const f = L.freshness(ok, late);
  assert.equal(f.stale, true);
  assert.ok(f.reasons.length >= 1);
});

test("reference station is the nearest with a current reading, and is identified", () => {
  const near = st("N", "Nearby (offline)", "Negeri Sembilan", 2.73, 102.25, null, null);
  const mid = st("M", "Seremban", "Negeri Sembilan", 2.72, 101.94, 150, "2026-10-17T14:00:00+08:00");
  const far = st("F", "Nilai", "Negeri Sembilan", 2.82, 101.81, 177, "2026-10-17T14:00:00+08:00");
  const m = L.matchStations(2.739, 102.249, [far, mid, near], NOW, { state: "Negeri Sembilan" });
  assert.equal(m.nearest.station.id, "N");
  assert.equal(m.reference.station.id, "M");
  assert.ok(m.notes.some((t) => t.includes("has no current reading")));
  assert.ok(m.shown.length >= 2);
});

test("state names from different sources compare equal", () => {
  assert.equal(L.sameState("W.P. Kuala Lumpur", "Kuala Lumpur"), true);
  assert.equal(L.sameState("WP KUALA LUMPUR", "Federal Territory of Kuala Lumpur"), true);
  assert.equal(L.sameState("Pulau Pinang", "Penang"), true);
  assert.equal(L.sameState("Melaka", "Malacca"), true);
  assert.equal(L.sameState("Selangor", "Johor"), false);
});

test("prediction: threshold not reached", () => {
  const s = st("A", "Shah Alam", "Selangor", 3.1, 101.5, 170, "2026-10-17T14:00:00+08:00",
    hours(DAY, 0, 14, (h) => 150 + h));
  // tomorrow is Sunday: weekend for Selangor (Group B)
  const p = L.predict(s, rule, NOW, "Selangor");
  assert.equal(p.available, true);
  assert.equal(p.reachedToday, false);
  assert.equal(p.todayMax, 164);
  assert.equal(p.tomorrowNoSchool.kind, "weekend");
  assert.equal(p.status, "No school (weekend)");
  assert.equal(p.outdoorStop, true);
  // on a weekday evening the same readings give "not predicted to close"
  const tue = new Date("2026-10-20T14:25:00+08:00");
  const s2 = { ...s, observed: "2026-10-20T14:00:00+08:00", hourly: hours("2026-10-20", 0, 14, (h) => 150 + h) };
  const p2 = L.predict(s2, rule, tue, "Selangor");
  assert.equal(p2.level, "not_reached");
  assert.equal(p2.status, "Not predicted to close");
  assert.match(p2.detail, /below the closure level of 200/);
});

test("prediction: reaching exactly 200 counts as reaching the threshold", () => {
  const tue = new Date("2026-10-20T14:25:00+08:00");
  const s = st("A", "Klang", "Selangor", 3.0, 101.4, 200, "2026-10-20T14:00:00+08:00", hours("2026-10-20", 0, 14, () => 190));
  const p = L.predict(s, rule, tue, "Selangor");
  assert.equal(p.reachedNow, true);
  assert.equal(p.level, "may_close");
  assert.equal(p.status, "Schools may be closed");
  assert.match(p.headline, /may be closed tomorrow/);
});

test("prediction: reached earlier today but now lower", () => {
  const tue = new Date("2026-10-20T16:25:00+08:00");
  const s = st("A", "Nilai", "Negeri Sembilan", 2.8, 101.8, 185, "2026-10-20T16:00:00+08:00",
    hours("2026-10-20", 0, 16, (h) => (h === 9 ? 204 : 185)));
  const p = L.predict(s, rule, tue, "Negeri Sembilan");
  assert.equal(p.reachedNow, false);
  assert.equal(p.reachedToday, true);
  assert.equal(p.todayMax, 204);
  assert.equal(p.level, "may_close");
});

test("prediction: Group A weekend is Friday and Saturday", () => {
  // Saturday: tomorrow (Sunday) is a school day in Kedah
  const s = st("K", "Alor Setar", "Kedah", 6.1, 100.3, 90, "2026-10-17T14:00:00+08:00", hours(DAY, 0, 14, () => 90));
  const p = L.predict(s, rule, NOW, "Kedah");
  assert.equal(p.tomorrowNoSchool, null);
  assert.equal(p.status, "Not predicted to close");
  // Thursday: tomorrow (Friday) is the weekend in Kedah
  const thu = new Date("2026-10-22T14:25:00+08:00");
  const s2 = { ...s, observed: "2026-10-22T14:00:00+08:00", hourly: hours("2026-10-22", 0, 14, () => 90) };
  assert.equal(L.predict(s2, rule, thu, "Kedah").tomorrowNoSchool.kind, "weekend");
});

test("prediction: year-end school holiday", () => {
  const d = new Date("2026-12-07T14:25:00+08:00");     // Monday; Tuesday is in the holiday
  const s = st("A", "Shah Alam", "Selangor", 3.1, 101.5, 60, "2026-12-07T14:00:00+08:00");
  const p = L.predict(s, rule, d, "Selangor");
  assert.equal(p.tomorrowNoSchool.kind, "holiday");
});

test("prediction is unavailable without a current reading", () => {
  const s = st("A", "Shah Alam", "Selangor", 3.1, 101.5, 250, "2026-10-17T08:00:00+08:00");
  const p = L.predict(s, rule, NOW, "Selangor");
  assert.equal(p.available, false);
  assert.match(p.reason, /no current official reading/);
});

test("state summary lists stations at the closure level", () => {
  const tue = new Date("2026-10-20T14:25:00+08:00");
  const a = st("A", "Klang", "Selangor", 3.0, 101.4, 210, "2026-10-20T14:00:00+08:00", hours("2026-10-20", 0, 14, () => 210));
  const b = st("B", "Banting", "Selangor", 2.8, 101.5, 120, "2026-10-20T14:00:00+08:00", hours("2026-10-20", 0, 14, () => 120));
  const c = st("C", "Kluang", "Johor", 2.0, 103.3, 230, "2026-10-20T14:00:00+08:00");
  const sum = L.stateSummary("Selangor", [a, b, c], rule, tue);
  assert.equal(sum.stations.length, 2);
  assert.deepEqual(sum.reached.map((r) => r.station.id), ["A"]);
  assert.equal(sum.highest.id, "A");
  assert.equal(sum.lowest.id, "B");
});

test("search finds states, stations, towns and schools", () => {
  const stations = [st("CA23N", "Nilai", "Negeri Sembilan", 2.8, 101.8, 177, "x"), st("CA16W", "Cheras", "W.P. Kuala Lumpur", 3.1, 101.7, 160, "x")];
  const schools = [["NBA0001", "SK TEST SATU", "NEGERI SEMBILAN", "PPD KUALA PILAH", "KUALA PILAH", 2.739, 102.249],
                   ["NEA0002", "SMK TEST DUA", "NEGERI SEMBILAN", "PPD KUALA PILAH", "KUALA PILAH", 2.741, 102.251]];
  const r1 = L.searchLocal("negeri", stations, schools);
  assert.equal(r1[0].type, "state");
  const r2 = L.searchLocal("cheras", stations, []);
  assert.equal(r2[0].type, "station");
  const r3 = L.searchLocal("kuala pilah", stations, schools);
  const town = r3.find((r) => r.type === "locality");
  assert.ok(town);
  assert.ok(Math.abs(town.lat - 2.74) < 0.01);
  const r4 = L.searchLocal("smk test", stations, schools);
  assert.equal(r4[0].type, "school");
  assert.equal(r4[0].code, "NEA0002");
});

test("national summary picks highest and lowest current readings only", () => {
  const s = [
    st("A", "A", "X", 3, 101, 90, "2026-10-17T14:00:00+08:00"),
    st("B", "B", "Y", 3, 101, 170, "2026-10-17T14:00:00+08:00"),
    st("C", "C", "Y", 3, 101, 400, "2026-10-17T05:00:00+08:00"),   // outdated, must be ignored
    st("D", "D", "Z", 3, 101, null, null)
  ];
  const sum = L.nationalSummary(s, NOW);
  assert.equal(sum.highest.id, "B");
  assert.equal(sum.lowest.id, "A");
  assert.equal(sum.noReading, 2);
  assert.equal(sum.counts.unhealthy, 1);
});
