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

test("forecast estimate is shown only next to a current official reading", () => {
  const s = st("A", "Klang", "Selangor", 3.0, 101.4, 170, "2026-10-17T14:00:00+08:00");
  assert.equal(L.forecastStatus({ anchor: "2026-10-17T14:00" }, s, NOW).ok, true);
  assert.equal(L.forecastStatus(null, s, NOW).ok, false);
  assert.equal(L.forecastStatus({ anchor: "2026-10-17T09:00" }, s, NOW).ok, false);     // estimate older than the reading
  const old = { ...s, observed: "2026-10-17T08:00:00+08:00" };
  assert.equal(L.forecastStatus({ anchor: "2026-10-17T08:00" }, old, NOW).ok, false);   // reading itself outdated
});

test("wind direction names where the wind comes from", () => {
  assert.equal(L.windFrom(3.54, 3.54), "south-west");   // blowing toward the north-east
  assert.equal(L.windFrom(0, -5), "north");
  assert.equal(L.windFrom(-5, 0), "east");
});

// ---- air paths and coverage zones
function windHist(u, v, hours) {           // uniform wind everywhere, m/s
  const grid = { lon0: 93, lat0: -8, dlon: 1.5, dlat: 1.5, nx: 20, ny: 13 };
  const n = grid.nx * grid.ny, t0 = 29000000;
  const times = [], U = [], V = [];
  for (let h = 0; h <= hours; h++) { times.push(t0 + h * 60); U.push(Array(n).fill(u * 10)); V.push(Array(n).fill(v * 10)); }
  return { grid, times, u: U, v: V };
}

test("air path goes upwind: wind from the south-west means the air came from the south-west", () => {
  const h = windHist(3.54, 3.54, 80);                       // 5 m/s from the SW
  const tr = L.backTrajectory(h, 101.45, 3.04, 18);
  const last = tr.hourly[tr.hourly.length - 1];
  assert.ok(last[0] < 101.45 && last[1] < 3.04);            // back towards the south-west
  assert.ok(Math.abs(tr.km - 5 * 18 * 3.6) < 6);            // 5 m/s for 18 h is about 324 km
  assert.equal(tr.hourly.length, 19);
  assert.equal(L.regionOf(last[0], last[1]), "Sumatra");
});

test("air path stops at the edge of the wind data", () => {
  const h = windHist(-20, 0, 80);                            // strong wind from the east: path runs east
  const tr = L.backTrajectory(h, 118, 5, 72);
  assert.ok(tr.hoursCovered < 72);
  assert.ok(tr.hourly[tr.hourly.length - 1][0] <= 121.5);
});

test("regions and fires near a path", () => {
  assert.equal(L.regionOf(102.0, -1.0), "Sumatra");
  assert.equal(L.regionOf(113.5, -1.5), "Borneo");
  assert.equal(L.regionOf(101.7, 3.1), "Peninsular Malaysia");
  assert.equal(L.regionOf(100.5, 3.0), "the Strait of Malacca");
  const dense = [];
  for (let i = 0; i <= 48; i++) dense.push([101.5 - i * 0.05, 3.0 - i * 0.08, 30000 - i * 60]);
  const fires = [[101.0, 2.2, 10], [99.5, 1.5, 5], [101.48, 2.98, 8]];
  const near = L.firesNearPath(dense, fires, 25, 2);
  assert.deepEqual(near.indexes, [0]);                       // far fire and the one at the start are excluded
});

test("coverage zones: each point lies in the zone of its nearest station", () => {
  const sites = [{ id: "A", lon: 101.0, lat: 3.0 }, { id: "B", lon: 102.0, lat: 3.0 }, { id: "C", lon: 101.5, lat: 4.0 }];
  const z = L.coverageZones(sites, [[99, 1], [104, 6]]);
  assert.equal(Object.keys(z).length, 3);
  assert.ok(L.inPoly(101.1, 2.9, z.A));
  assert.ok(!L.inPoly(101.1, 2.9, z.B));
  assert.ok(L.inPoly(101.9, 3.1, z.B));
  assert.ok(L.inPoly(101.5, 4.5, z.C));
});

// ---- official closure announcements
const ANN = require("../docs/data/announcements.json");
const BOUNDS = require("../docs/data/boundaries.json");

test("places are located in the right state and district", () => {
  assert.deepEqual(L.locate(103.76, 1.49, BOUNDS), { state: "Johor", district: "Johor Bahru" });
  assert.deepEqual(L.locate(102.93, 1.85, BOUNDS), { state: "Johor", district: "Batu Pahat" });
  assert.equal(L.locate(101.45, 3.04, BOUNDS).state, "Selangor");
  assert.equal(L.locate(102.25, 2.19, BOUNDS).state, "Melaka");
  assert.equal(L.locate(101.69, 3.14, BOUNDS).state, "W.P. Kuala Lumpur");
  assert.equal(L.locate(105.0, 3.0, BOUNDS), null);              // sea
});

test("Johor closure applies Mon 19 to Fri 23 Oct", () => {
  const jb = { state: "Johor", district: "Johor Bahru" };
  const sun = L.officialStatus(jb, new Date("2026-10-18T08:30:00+08:00"), ANN);
  assert.equal(sun.today, null);
  assert.equal(sun.tomorrow.id, "johor-2026-10-19");
  assert.equal(sun.lastDay, "2026-10-23");
  const fri = L.officialStatus(jb, new Date("2026-10-23T09:00:00+08:00"), ANN);
  assert.equal(fri.today.id, "johor-2026-10-19");
  assert.equal(fri.tomorrow, null);                               // ends today
  const mon = L.officialStatus(jb, new Date("2026-10-26T09:00:00+08:00"), ANN);
  assert.equal(mon.ended.id, "johor-2026-10-19");                 // ended recently, no extension
  const kl = L.officialStatus({ state: "W.P. Kuala Lumpur" }, new Date("2026-10-18T08:30:00+08:00"), ANN);
  assert.equal(kl.tomorrow, null);
  assert.equal(L.officialStatus({ state: "Johor" }, new Date("2026-10-18T08:30:00+08:00"), ANN).tomorrow.id, "johor-2026-10-19");
});

test("district and school-level closures, extensions, and source checks", () => {
  const ann = { source_policy: { allowed_domains: ["bernama.com"] }, closures: [
    { id: "a", area: { state: "Johor", districts: ["Batu Pahat"] }, from: "2026-10-19", to: "2026-10-21", sources: [{ url: "https://www.bernama.com/x" }] },
    { id: "b", area: { state: "Johor", districts: ["Batu Pahat"] }, from: "2026-10-22", to: "2026-10-27", sources: [{ url: "https://www.bernama.com/y" }] },
    { id: "c", area: { school_codes: ["JBA0001"] }, from: "2026-10-19", to: "2026-10-19", sources: [{ url: "https://bernama.com/z" }] },
    { id: "bad", area: { states: ["Selangor"] }, from: "2026-10-19", to: "2026-10-23", sources: [{ url: "https://www.example.com/fake" }] }
  ] };
  const now = new Date("2026-10-18T20:00:00+08:00");
  const bp = L.officialStatus({ state: "Johor", district: "Batu Pahat" }, now, ann);
  assert.equal(bp.tomorrow.id, "a");
  assert.equal(bp.lastDay, "2026-10-27");                          // extension joined on
  assert.equal(L.officialStatus({ state: "Johor", district: "Muar" }, now, ann).tomorrow, null);
  assert.equal(L.officialStatus({ state: "Johor", district: "Muar", code: "JBA0001" }, now, ann).tomorrow.id, "c");
  assert.equal(L.officialStatus({ state: "Selangor" }, now, ann).tomorrow, null);    // non-Bernama entry ignored
  assert.equal(L.isAllowedSource("https://www.bernama.com.evil.net/x", ["bernama.com"]), false);
});

// ---- school-day dose, rising fastest, unusual readings, sound
test("school-day dose uses EPA breathing rates and the WHO level", () => {
  const d = L.schoolDayDose(90);
  assert.equal(d.ratio, 6);
  assert.ok(Math.abs(d.primary.volume - (0.8 * 4.8e-3 + 0.2 * 1.1e-2) * 60 * 6) < 1e-9);   // about 2.17 m³
  assert.ok(Math.abs(d.primary.dose - 90 * d.primary.volume) < 1e-9);
  assert.ok(d.secondary.dose > d.primary.dose);
  assert.equal(L.schoolDayDose(null), null);
});

function hourlySeries(endIso, values) {          // values oldest -> newest, one per hour ending at endIso
  const end = new Date(endIso).getTime();
  return values.map((v, i) => [L.hourKeyOf(new Date(end - (values.length - 1 - i) * 3600000)), v]);
}

test("rising fastest compares the latest hour with 6 hours earlier", () => {
  const obs = "2026-10-17T14:00:00+08:00";
  const a = st("A", "Serian", "Sarawak", 1.1, 110.6, 154, obs, hourlySeries(obs, [120, 125, 129, 133, 140, 146, 150, 154]));
  const b = st("B", "Tawau", "Sabah", 4.3, 117.9, 100, obs, hourlySeries(obs, [118, 117, 115, 110, 106, 102, 100]));
  const c = st("C", "Old", "Sabah", 5, 116, 300, "2026-10-17T05:00:00+08:00", []);
  const r = L.risingFastest([a, b, c], NOW, 6);
  assert.equal(r.length, 2);
  assert.equal(r[0].station.id, "A");
  assert.equal(r[0].delta, 29);                     // 125 at 08:00 to 154 at 14:00
  assert.equal(r[0].from, 125);
  assert.equal(r[0].series.length, 8);
  assert.equal(r[1].delta, -18);
});

test("unusual readings are flagged against nearby stations only", () => {
  const obs = "2026-10-17T14:00:00+08:00";
  const near = [
    st("KS", "Kuala Selangor", "Selangor", 3.33, 101.25, 86, obs),
    st("K", "Klang", "Selangor", 3.01, 101.41, 170, obs),
    st("SA", "Shah Alam", "Selangor", 3.10, 101.56, 170, obs),
    st("PJ", "Petaling Jaya", "Selangor", 3.13, 101.61, 158, obs),
    st("FAR", "Kota Bharu", "Kelantan", 6.13, 102.24, 48, obs)
  ];
  const u = L.unusualReadings(near, NOW);
  assert.deepEqual(Object.keys(u), ["KS"]);
  assert.equal(u.KS.median, 170);
  assert.equal(u.KS.diff, -84);
  assert.ok(!u.FAR);                                   // no neighbours within 60 km: never flagged
  const calm = near.map((s) => ({ ...s, api: s.id === "KS" ? 140 : s.api }));
  assert.deepEqual(Object.keys(L.unusualReadings(calm, NOW)), []);   // 30 below: not unusual
});

test("sound: higher readings give higher pitch and a harsher tone above 200", () => {
  assert.equal(Math.round(L.toneFor(0).freq), 220);
  assert.equal(Math.round(L.toneFor(150).freq), 440);
  assert.equal(L.toneFor(80).wave, "sine");
  assert.equal(L.toneFor(150).wave, "triangle");
  assert.equal(L.toneFor(210).wave, "square");
});
