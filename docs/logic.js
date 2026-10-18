/* Pure logic for the IPU dashboard: categories, time, freshness, station
   matching, closure prediction and search. No DOM access, so it can be
   tested with Node (tests/logic.test.js). */
(function (root) {
  "use strict";

  var TZ = "Asia/Kuala_Lumpur";
  var STALE_HOURS = 3;          // a station reading older than this is not "current"
  var UPDATE_STALE_HOURS = 2.5; // no successful update for this long = data may be outdated

  // DOE API categories and colours (blue, green, yellow, orange, red).
  var CATEGORIES = [
    { key: "good", label: "Good", min: 0, max: 50, color: "#1f6fd1", ink: "#ffffff" },
    { key: "moderate", label: "Moderate", min: 51, max: 100, color: "#1e9e4a", ink: "#ffffff" },
    { key: "unhealthy", label: "Unhealthy", min: 101, max: 200, color: "#f2c200", ink: "#1a1a1a" },
    { key: "very", label: "Very unhealthy", min: 201, max: 300, color: "#f07f13", ink: "#1a1a1a" },
    { key: "hazardous", label: "Hazardous", min: 301, max: Infinity, color: "#d62728", ink: "#ffffff" }
  ];

  // APIMS PARAM_SYMBOL legend (dominant pollutant).
  var POLLUTANTS = {
    "*": "PM10", "**": "PM2.5", "a": "SO₂ (sulphur dioxide)", "b": "NO₂ (nitrogen dioxide)",
    "c": "O₃ (ozone)", "d": "CO (carbon monoxide)", "&": "2 or more pollutants with the same index"
  };

  function categoryFor(api) {
    if (api === null || api === undefined || isNaN(api)) return null;
    for (var i = 0; i < CATEGORIES.length; i++) if (api <= CATEGORIES[i].max) return CATEGORIES[i];
    return CATEGORIES[CATEGORIES.length - 1];
  }

  function pollutantName(sym) {
    if (!sym) return null;
    return POLLUTANTS[String(sym).trim()] || null;
  }

  // ------------------------------------------------------------ time

  function parseTime(iso) {
    if (!iso) return null;
    var s = String(iso);
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += "+08:00";   // bare hour keys are Malaysia time
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  var partsFmt = null;
  function mytParts(date) {
    if (!partsFmt) {
      partsFmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23"
      });
    }
    var out = {};
    partsFmt.formatToParts(date).forEach(function (p) { out[p.type] = p.value; });
    return out;
  }

  function mytDateKey(date) {
    var p = mytParts(date);
    return p.year + "-" + p.month + "-" + p.day;
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function fmtTime(date) {
    if (!date) return "—";
    var p = mytParts(date);
    return p.hour + ":" + p.minute;
  }

  function fmtDateTime(date) {
    if (!date) return "—";
    var p = mytParts(date);
    return p.weekday + " " + Number(p.day) + " " + MONTHS[Number(p.month) - 1] + " " + p.year + ", " + p.hour + ":" + p.minute;
  }

  function fmtDayKey(key) {
    var d = new Date(key + "T00:00:00Z");
    return WEEKDAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  function addDaysKey(key, n) {
    var d = new Date(key + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function weekdayOfKey(key) {
    return WEEKDAYS[new Date(key + "T00:00:00Z").getUTCDay()];
  }

  function hoursBetween(a, b) { return (b.getTime() - a.getTime()) / 3600000; }

  function ago(date, now) {
    if (!date) return "never";
    var mins = Math.round((now - date) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h < 48) return h + " h " + (m ? m + " min " : "") + "ago";
    return Math.round(h / 24) + " days ago";
  }

  // ------------------------------------------------------------ freshness

  function freshness(data, now) {
    var lastSuccess = parseTime(data && data.last_success);
    var lastAttempt = parseTime(data && data.last_attempt);
    var obs = parseTime(data && data.observation_time);
    var obsAge = obs ? hoursBetween(obs, now) : Infinity;
    var succAge = lastSuccess ? hoursBetween(lastSuccess, now) : Infinity;
    var failed = !!data && data.status === "failed";
    var stale = failed || obsAge > STALE_HOURS || succAge > UPDATE_STALE_HOURS;
    var reasons = [];
    if (!data || !data.stations || !data.stations.length) reasons.push("No readings have been retrieved yet.");
    if (failed) reasons.push("The last attempt to read APIMS failed.");
    if (succAge > UPDATE_STALE_HOURS && isFinite(succAge)) reasons.push("No successful update for " + Math.floor(succAge) + " hours.");
    if (obsAge > STALE_HOURS && isFinite(obsAge)) reasons.push("The newest reading is " + Math.floor(obsAge) + " hours old.");
    return {
      lastSuccess: lastSuccess, lastAttempt: lastAttempt, observation: obs,
      obsAgeHours: obsAge, successAgeHours: succAge,
      failed: failed, partial: !!data && data.status === "partial",
      stale: stale, reasons: reasons
    };
  }

  function stationCurrent(st, now) {
    if (!st || st.api === null || st.api === undefined) return false;
    var t = parseTime(st.observed);
    if (!t) return false;
    var age = hoursBetween(t, now);
    return age <= STALE_HOURS && age > -1;
  }

  // ------------------------------------------------------------ distance & matching

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function byDistance(lat, lon, stations) {
    return (stations || [])
      .filter(function (s) { return typeof s.lat === "number" && typeof s.lon === "number"; })
      .map(function (s) { return { station: s, km: haversineKm(lat, lon, s.lat, s.lon) }; })
      .sort(function (a, b) { return a.km - b.km; });
  }

  /* Reference station for a point: the nearest station with a current
     reading. Also returns the nearest stations to show alongside it, and
     plain-language notes about anything the user should know. */
  function matchStations(lat, lon, stations, now, opts) {
    opts = opts || {};
    var list = byDistance(lat, lon, stations);
    if (!list.length) return null;
    var ref = null;
    for (var i = 0; i < list.length; i++) if (stationCurrent(list[i].station, now)) { ref = list[i]; break; }
    var nearestAny = list[0];
    var shown = list.slice(0, 4);
    if (ref && shown.indexOf(ref) < 0) shown.push(ref);
    var notes = [];
    if (!ref) {
      notes.push("No station has a current reading, so no reference reading can be shown.");
    } else {
      if (ref !== nearestAny) {
        notes.push("The nearest station, " + nearestAny.station.name + " (" + Math.round(nearestAny.km) +
          " km), has no current reading, so the next nearest station with a current reading is used.");
      }
      if (ref.km > 40) {
        notes.push("The reference station is " + Math.round(ref.km) + " km away, so its reading may not reflect local conditions.");
      }
      if (opts.state && ref.station.state && !sameState(opts.state, ref.station.state)) {
        notes.push("The reference station is in " + ref.station.state + ", not " + opts.state + ".");
      }
      // other relevant stations: within 30 km of the location and reading noticeably differently
      var differ = list.filter(function (x) {
        return x !== ref && x.km <= 30 && stationCurrent(x.station, now) && Math.abs(x.station.api - ref.station.api) >= 30;
      });
      if (differ.length) {
        notes.push("Other stations within 30 km read differently (" + differ.map(function (x) {
          return x.station.name + " " + x.station.api + ", " + Math.round(x.km) + " km";
        }).join("; ") + "). Air quality may vary across this area; all nearby readings are listed below.");
      }
    }
    return { reference: ref, nearest: nearestAny, shown: shown, notes: notes, all: list };
  }

  // ------------------------------------------------------------ school days

  /* One key per state, whatever spelling a source uses:
     'W.P. Kuala Lumpur', 'WP KUALA LUMPUR', 'Federal Territory of Kuala Lumpur' -> 'kuala lumpur'. */
  function stateKey(s) {
    var n = norm(s).replace(/^(wilayah persekutuan|federal territory of|federal territory|w p|wp)\s+/, "");
    var alias = { "pulau pinang": "penang", "pinang": "penang", "malacca": "melaka", "n sembilan": "negeri sembilan" };
    return alias[n] || n;
  }

  function sameState(a, b) { return !!a && !!b && stateKey(a) === stateKey(b); }

  function stateMatches(stateList, state) {
    return (stateList || []).some(function (x) { return sameState(x, state); });
  }

  function noSchoolReason(dateKey, state, rule) {
    if (!rule) return null;
    var wk = rule.weekend || {};
    var days = wk.default || ["Sat", "Sun"];
    Object.keys(wk).forEach(function (k) {
      if (k !== "default" && sameState(k, state)) days = wk[k];
    });
    if (days.indexOf(weekdayOfKey(dateKey)) >= 0) return { kind: "weekend", label: "Weekend" };
    var hols = rule.school_holidays || [];
    var groupA = [];
    hols.forEach(function (h) { if (Array.isArray(h.states)) groupA = groupA.concat(h.states); });
    for (var i = 0; i < hols.length; i++) {
      var h = hols[i];
      var applies = Array.isArray(h.states) ? stateMatches(h.states, state) : !stateMatches(groupA, state);
      if (applies && dateKey >= h.from && dateKey <= h.to) return { kind: "holiday", label: h.name };
    }
    return null;
  }

  // ------------------------------------------------------------ prediction

  function meets(value, cond) {
    if (value === null || value === undefined) return false;
    switch (cond.comparison) {
      case ">": return value > cond.threshold;
      case ">=": return value >= cond.threshold;
      default: return value >= cond.threshold;
    }
  }

  function todaysReadings(st, now) {
    var key = mytDateKey(now);
    var out = (st.hourly || []).filter(function (p) {
      return p[1] !== null && p[1] !== undefined && String(p[0]).slice(0, 10) === key;
    }).map(function (p) { return { t: parseTime(p[0]), api: p[1] }; });
    var latestT = parseTime(st.observed);
    if (latestT && mytDateKey(latestT) === key &&
        !out.some(function (r) { return r.t.getTime() === latestT.getTime(); })) {
      out.push({ t: latestT, api: st.api });
    }
    return out;
  }

  function predict(st, rule, now, state) {
    var closure = rule.closure, outdoor = rule.outdoor;
    var res = { available: false };
    if (!st || !stationCurrent(st, now)) {
      res.reason = "There is no current official reading for the reference station, so no prediction can be made.";
      return res;
    }
    var latestT = parseTime(st.observed);
    var today = todaysReadings(st, now);
    var max = null;
    today.forEach(function (r) { if (max === null || r.api > max.api) max = r; });
    var reachedNow = meets(st.api, closure);
    var reachedToday = reachedNow || (max !== null && meets(max.api, closure));
    var todayKey = mytDateKey(now);
    var tomorrowKey = addDaysKey(todayKey, 1);
    var noSchool = noSchoolReason(tomorrowKey, state || st.state, rule);

    res.available = true;
    res.latest = st.api;
    res.latestAt = latestT;
    res.todayMax = max ? max.api : null;
    res.todayMaxAt = max ? max.t : null;
    res.reachedNow = reachedNow;
    res.reachedToday = reachedToday;
    res.outdoorStop = meets(st.api, outdoor);
    res.tomorrowKey = tomorrowKey;
    res.tomorrowNoSchool = noSchool;

    var latestTxt = st.api + " at " + fmtTime(latestT);
    if (reachedNow) {
      res.level = "may_close";
      res.status = "Schools may be closed";
      res.headline = "Schools in this area may be closed tomorrow";
      res.detail = "The reference station reads IPU " + latestTxt + ", which has reached the closure level of " +
        closure.threshold + ". Under the current rule, schools in the affected area close immediately at this level, " +
        "so a closure may already apply today and may continue tomorrow.";
    } else if (reachedToday) {
      res.level = "may_close";
      res.status = "Schools may be closed";
      res.headline = "Schools in this area may be closed tomorrow";
      res.detail = "IPU reached " + max.api + " at " + fmtTime(max.t) + " today, at or above the closure level of " +
        closure.threshold + ". The latest reading is lower (" + latestTxt + "). Whether schools open tomorrow depends on the official announcement.";
    } else {
      res.level = "not_reached";
      res.status = "Not predicted to close";
      res.headline = "Closure threshold not reached";
      res.detail = "The latest reading is " + latestTxt + (max && max.api !== st.api ? " (highest today: " + max.api + " at " + fmtTime(max.t) + ")" : "") +
        ", below the closure level of " + closure.threshold + ". Based on readings so far, no haze closure is predicted for tomorrow. " +
        "This can change if readings rise later today.";
    }
    if (noSchool) {
      var where = state || st.state || "this state";
      res.status = noSchool.kind === "weekend" ? "No school (weekend)" : "No school (holiday)";
      if (reachedToday) res.headline = "Closure threshold reached today";
      res.detail += " Tomorrow (" + fmtDayKey(tomorrowKey) + ") is not a school day in " + where +
        (noSchool.kind === "weekend" ? " (weekend)." : " (" + noSchool.label + ").");
      if (res.level !== "may_close") res.level = "no_school";
    }
    return res;
  }

  /* Summary for a whole state: which stations reached the threshold today. */
  function stateSummary(stateName, stations, rule, now) {
    var list = stations.filter(function (s) { return sameState(s.state, stateName); });
    var current = list.filter(function (s) { return stationCurrent(s, now); });
    var reached = [];
    current.forEach(function (s) {
      var p = predict(s, rule, now, stateName);
      if (p.available && p.reachedToday) reached.push({ station: s, p: p });
    });
    var hi = null, lo = null;
    current.forEach(function (s) {
      if (!hi || s.api > hi.api) hi = s;
      if (!lo || s.api < lo.api) lo = s;
    });
    return { stations: list, current: current, reached: reached, highest: hi, lowest: lo,
             tomorrowKey: addDaysKey(mytDateKey(now), 1),
             tomorrowNoSchool: noSchoolReason(addDaysKey(mytDateKey(now), 1), stateName, rule) };
  }

  // ------------------------------------------------------------ search

  /* 'SMK TAMAN DESA, PPD KUALA PILAH' -> 'SMK Taman Desa, PPD Kuala Pilah'. Mixed-case text is left alone. */
  var KEEP_UPPER = { SK: 1, SMK: 1, SJK: 1, SMJK: 1, SMKA: 1, SABK: 1, SBP: 1, MRSM: 1, PPD: 1, KAFA: 1, KV: 1, SM: 1, SR: 1,
                     SRA: 1, SMA: 1, SKM: 1, SMT: 1, SMV: 1, SMS: 1, SPK: 1, PKBP: 1, LKTP: 1, FELDA: 1, FELCRA: 1, RISDA: 1,
                     KG: 0, WP: 1, "W.P.": 1, II: 1, III: 1, IV: 1 };
  function tidy(s) {
    var t = String(s || "");
    if (!t || t !== t.toUpperCase() || !/[A-Z]/.test(t)) return t;
    return t.split(/(\s+|,|\/|-)/).map(function (w) {
      if (!/[A-Z]/.test(w)) return w;
      if (KEEP_UPPER[w] === 1 || /^[A-Z]+\([A-Z]\)$/.test(w)) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    }).join("");
  }

  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function scoreText(text, q, tokens) {
    var t = norm(text);
    if (!t) return 0;
    if (t === q) return 100;
    if (t.indexOf(q) === 0) return 80;
    if ((" " + t).indexOf(" " + q) >= 0) return 60;
    if (tokens.every(function (tok) { return t.indexOf(tok) >= 0; })) return 40;
    return 0;
  }

  /* Local search over stations, states, localities and (if loaded) schools.
     schools: array of [code, name, state, district, town, lat, lon]. */
  function searchLocal(query, stations, schools) {
    var q = norm(query);
    if (q.length < 2) return [];
    var tokens = q.split(" ");
    var res = [];
    var states = {};
    (stations || []).forEach(function (s) { if (s.state) states[s.state] = true; });
    Object.keys(states).forEach(function (name) {
      var sc = scoreText(name, q, tokens);
      if (sc) res.push({ type: "state", label: name, sub: "State", score: sc + 5, state: name });
    });
    (stations || []).forEach(function (s) {
      var sc = Math.max(scoreText(s.name, q, tokens), scoreText(s.location, q, tokens),
                        scoreText(s.place, q, tokens), s.id && norm(s.id) === q ? 100 : 0);
      if (sc) res.push({ type: "station", label: s.name, sub: "Monitoring station in " + s.state, score: sc + 3, id: s.id });
    });
    if (schools && schools.length) {
      var towns = {};
      schools.forEach(function (r) {
        var sc = Math.max(scoreText(r[1], q, tokens), r[0] && norm(r[0]) === q ? 100 : 0);
        if (sc) res.push({ type: "school", label: tidy(r[1]), sub: [r[4], r[3], r[2]].filter(Boolean).map(tidy).join(", "),
                           score: sc, code: r[0], lat: r[5], lon: r[6], state: tidy(r[2]), town: tidy(r[4]), district: tidy(r[3]) });
        [["town", r[4]], ["district", r[3]]].forEach(function (pair) {
          if (!pair[1]) return;
          var k = pair[0] + "|" + norm(pair[1]) + "|" + norm(r[2]);
          var t = towns[k] || (towns[k] = { kind: pair[0], name: pair[1], state: r[2], lat: 0, lon: 0, n: 0 });
          t.lat += r[5]; t.lon += r[6]; t.n += 1;
        });
      });
      Object.keys(towns).forEach(function (k) {
        var t = towns[k];
        var sc = scoreText(t.name, q, tokens);
        if (sc) res.push({ type: "locality", label: tidy(t.name), sub: (t.kind === "district" ? "District in " : "Town in ") + tidy(t.state) +
                           ", centre of " + t.n + " school" + (t.n > 1 ? "s" : ""),
                           score: sc + 2, lat: t.lat / t.n, lon: t.lon / t.n, state: tidy(t.state) });
      });
    }
    res.sort(function (a, b) { return b.score - a.score || a.label.localeCompare(b.label); });
    var out = [], counts = {};
    var caps = { state: 3, station: 5, locality: 4, school: 8 };
    res.forEach(function (r) {
      counts[r.type] = (counts[r.type] || 0) + 1;
      if (counts[r.type] <= caps[r.type]) out.push(r);
    });
    return out.slice(0, 16);
  }

  // ------------------------------------------------------------ national summary

  function nationalSummary(stations, now) {
    var current = (stations || []).filter(function (s) { return stationCurrent(s, now); });
    var hi = null, lo = null, counts = {};
    CATEGORIES.forEach(function (c) { counts[c.key] = 0; });
    current.forEach(function (s) {
      if (!hi || s.api > hi.api) hi = s;
      if (!lo || s.api < lo.api) lo = s;
      counts[categoryFor(s.api).key] += 1;
    });
    var byState = {};
    current.forEach(function (s) {
      if (!byState[s.state] || s.api > byState[s.state].api) byState[s.state] = s;
    });
    var ties = function (v) { return current.filter(function (s) { return s.api === v; }); };
    return {
      current: current, highest: hi, lowest: lo,
      highestAll: hi ? ties(hi.api) : [], lowestAll: lo ? ties(lo.api) : [],
      counts: counts, noReading: (stations || []).length - current.length, byState: byState
    };
  }

  // ------------------------------------------------------------ forecast (estimate) & wind

  /* Whether a station's forecast estimate can be shown next to its current official reading. */
  function forecastStatus(fc, st, now) {
    if (!fc) return { ok: false, reason: "No forecast estimate is available for this station." };
    if (!stationCurrent(st, now)) return { ok: false, reason: "The station has no current official reading, so no estimate is shown." };
    var anchor = parseTime(fc.anchor), obs = parseTime(st.observed);
    if (!anchor || !obs || hoursBetween(anchor, obs) > 2) {
      return { ok: false, reason: "The forecast estimate is older than the latest official reading. It will be refreshed with the next hourly update." };
    }
    return { ok: true };
  }

  /* Compass name for where a wind comes FROM, given its u (east) and v (north) components. */
  var COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  function windFrom(u, v) {
    var deg = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    return COMPASS[Math.round(deg / 45) % 8];
  }

  // ------------------------------------------------------------ air path (back-trajectory), regions, coverage zones

  /* Wind (u, v in m/s) at a place and time from the hourly wind history:
     bilinear in space, linear in time. hist.u/v are [hour][point] in m/s x 10. */
  function windHistAt(hist, lon, lat, tMin) {
    var g = hist.grid, times = hist.times, n = times.length;
    if (n < 2 || tMin < times[0] || tMin > times[n - 1]) return null;
    var fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (times[mid] <= tMin) lo = mid; else hi = mid; }
    var ft = (tMin - times[lo]) / (times[hi] - times[lo]);
    var i = Math.floor(fx), j = Math.floor(fy), i1 = Math.min(i + 1, g.nx - 1), j1 = Math.min(j + 1, g.ny - 1), tx = fx - i, ty = fy - j;
    function bl(arr) {
      var a = arr[j * g.nx + i], b = arr[j * g.nx + i1], c = arr[j1 * g.nx + i], d = arr[j1 * g.nx + i1];
      if (a === null || b === null || c === null || d === null) return null;
      return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / 10;
    }
    var u0 = bl(hist.u[lo]), v0 = bl(hist.v[lo]), u1 = bl(hist.u[hi]), v1 = bl(hist.v[hi]);
    if (u0 === null || v0 === null || u1 === null || v1 === null) return null;
    return { u: u0 + (u1 - u0) * ft, v: v0 + (v1 - v0) * ft };
  }

  /* Where the air now at (lon, lat) came from: step backwards in time through the wind
     (midpoint method, 15-minute steps). Returns hourly points [lon, lat, unixMinutes]
     from now back up to `hours`, and a denser path for distance checks. */
  function backTrajectory(hist, lon, lat, hours, stepMin) {
    hours = hours || 72; stepMin = stepMin || 15;
    var t = hist.times[hist.times.length - 1], M = 111320;
    var hourly = [[lon, lat, t]], dense = [[lon, lat, t]];
    var steps = Math.round(hours * 60 / stepMin), dt = stepMin * 60;
    for (var s = 1; s <= steps; s++) {
      var w1 = windHistAt(hist, lon, lat, t);
      if (!w1) break;
      var c1 = Math.cos(lat * Math.PI / 180);
      var mlon = lon - w1.u * dt / 2 / (M * c1), mlat = lat - w1.v * dt / 2 / M;
      var w2 = windHistAt(hist, mlon, mlat, t - stepMin / 2);
      if (!w2) break;
      var c2 = Math.cos(mlat * Math.PI / 180);
      lon -= w2.u * dt / (M * c2);
      lat -= w2.v * dt / M;
      t -= stepMin;
      dense.push([lon, lat, t]);
      if ((s * stepMin) % 60 === 0) hourly.push([lon, lat, t]);
    }
    var km = 0;
    for (var k = 1; k < dense.length; k++) km += haversineKm(dense[k - 1][1], dense[k - 1][0], dense[k][1], dense[k][0]);
    return { hourly: hourly, dense: dense, km: km, hoursCovered: (dense.length - 1) * stepMin / 60 };
  }

  // Rough outlines, only for naming where a path or a fire is ("over Sumatra").
  var REGIONS = [
    { name: "Peninsular Malaysia", poly: [[100.1, 6.5], [101.0, 6.9], [102.4, 6.3], [103.5, 4.6], [104.4, 2.6], [104.4, 1.3], [103.4, 1.2], [101.4, 2.5], [100.4, 4.0], [100.1, 6.5]] },
    { name: "Sumatra", poly: [[95.2, 5.8], [97.6, 5.3], [99.6, 3.4], [101.4, 2.2], [103.6, 0.2], [104.7, -1.6], [106.3, -3.1], [105.9, -5.9], [104.4, -5.9], [102.2, -4.1], [100.3, -1.1], [98.6, 1.5], [96.9, 3.0], [95.2, 5.8]] },
    { name: "Borneo", poly: [[108.6, 1.1], [109.6, 2.1], [111.0, 2.0], [113.4, 3.9], [115.0, 5.1], [116.4, 7.1], [119.4, 5.4], [118.1, 4.3], [117.9, 1.0], [116.6, -2.0], [116.1, -4.1], [113.0, -3.6], [110.1, -3.0], [109.0, -1.0], [108.6, 1.1]] },
    { name: "Java", poly: [[105.2, -6.0], [106.5, -5.8], [108.5, -6.3], [111.0, -6.3], [112.7, -6.8], [114.6, -7.7], [114.4, -8.7], [111.0, -8.3], [108.0, -7.8], [105.4, -6.9], [105.2, -6.0]] }
  ];
  function inPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function regionOf(lon, lat) {
    for (var i = 0; i < REGIONS.length; i++) if (inPoly(lon, lat, REGIONS[i].poly)) return REGIONS[i].name;
    if (lon >= 98 && lon <= 104 && lat >= -1 && lat <= 6.5) return "the Strait of Malacca";
    if (lon >= 104 && lon <= 119 && lat >= -1 && lat <= 10) return "the South China Sea";
    if (lon >= 105 && lon <= 118 && lat >= -7 && lat < -1) return "the Java Sea";
    return "the open sea";
  }

  /* Summary of a path: the places it spent most time over, ignoring the first hours
     (which are around the selected place itself). */
  function pathRegions(hourly, skipHours) {
    var counts = {}, order = [];
    hourly.slice(skipHours || 3).forEach(function (p) {
      var r = regionOf(p[0], p[1]);
      if (!counts[r]) { counts[r] = 0; order.push(r); }
      counts[r] += 1;
    });
    return order.map(function (r) { return { name: r, hours: counts[r] }; }).sort(function (a, b) { return b.hours - a.hours; });
  }

  /* Fires within `km` of the path (after the first `skipHours`, and not at the place itself), grouped by region. */
  function firesNearPath(dense, fires, km, skipHours) {
    km = km || 25; skipHours = skipHours || 2;
    var startT = dense.length ? dense[0][2] : 0, pts = dense.filter(function (p) { return startT - p[2] >= skipHours * 60; });
    var hits = [], byRegion = {};
    if (!pts.length) return { count: 0, indexes: [], byRegion: [] };
    var w = 180, e = -180, s = 90, n = -90;
    pts.forEach(function (p) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); });
    var pad = km / 100;
    var home = dense[0];
    (fires || []).forEach(function (f, idx) {
      if (f[0] < w - pad || f[0] > e + pad || f[1] < s - pad || f[1] > n + pad) return;
      if (haversineKm(home[1], home[0], f[1], f[0]) <= km * 1.2) return;   // at the place itself, not along the route
      for (var k = 0; k < pts.length; k++) {
        if (Math.abs(pts[k][1] - f[1]) > pad || Math.abs(pts[k][0] - f[0]) > pad * 1.1) continue;
        if (haversineKm(pts[k][1], pts[k][0], f[1], f[0]) <= km) {
          hits.push(idx);
          var r = regionOf(f[0], f[1]);
          byRegion[r] = (byRegion[r] || 0) + 1;
          return;
        }
      }
    });
    return { count: hits.length, indexes: hits,
             byRegion: Object.keys(byRegion).map(function (r) { return { name: r, count: byRegion[r] }; }).sort(function (a, b) { return b.count - a.count; }) };
  }

  /* Coverage zones: the area closest to each station (Voronoi cells), computed in a
     locally flat projection. sites: [{id, lon, lat}]; bbox: [[w, s], [e, n]]. */
  function coverageZones(sites, bbox) {
    var k = Math.cos(4 * Math.PI / 180);
    var P = sites.map(function (s) { return { id: s.id, x: s.lon * k, y: s.lat }; });
    var box = [[bbox[0][0] * k, bbox[0][1]], [bbox[1][0] * k, bbox[0][1]], [bbox[1][0] * k, bbox[1][1]], [bbox[0][0] * k, bbox[1][1]]];
    function clip(poly, p, q) {
      // keep the side of the bisector of p-q that is closer to p
      var mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, nx = q.x - p.x, ny = q.y - p.y, out = [];
      function side(pt) { return (pt[0] - mx) * nx + (pt[1] - my) * ny; }
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], b = poly[(i + 1) % poly.length], sa = side(a), sb = side(b);
        if (sa <= 0) out.push(a);
        if ((sa <= 0) !== (sb <= 0)) {
          var t = sa / (sa - sb);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      return out;
    }
    var zones = {};
    P.forEach(function (p) {
      var poly = box.slice();
      for (var i = 0; i < P.length && poly.length; i++) if (P[i] !== p && (P[i].x !== p.x || P[i].y !== p.y)) poly = clip(poly, p, P[i]);
      if (poly.length >= 3) zones[p.id] = poly.map(function (pt) { return [pt[0] / k, pt[1]]; }).concat([[poly[0][0] / k, poly[0][1]]]);
    });
    return zones;
  }

  // ------------------------------------------------------------ official closure announcements

  function districtKey(s) { return norm(s).replace(/^(daerah|district of|ppd)\s+/, ""); }

  /* State and district of a point, from the official district boundaries. */
  function locate(lon, lat, bounds) {
    if (!bounds || !bounds.districts || typeof lon !== "number" || typeof lat !== "number") return null;
    var ds = bounds.districts;
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i], b = d.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      for (var p = 0; p < d.polygons.length; p++) {
        var poly = d.polygons[p];
        if (inPoly(lon, lat, poly[0])) {
          var inHole = false;
          for (var h = 1; h < poly.length; h++) if (inPoly(lon, lat, poly[h])) { inHole = true; break; }
          if (!inHole) return { state: d.state, district: d.district };
        }
      }
    }
    return null;
  }

  function isAllowedSource(url, domains) {
    var m = /^https:\/\/([^\/?#]+)/i.exec(String(url || ""));
    if (!m) return false;
    var host = m[1].toLowerCase().replace(/:\d+$/, "");
    return (domains || []).some(function (d) { d = d.toLowerCase(); return host === d || host.slice(-(d.length + 1)) === "." + d; });
  }

  /* An entry is used only if its dates are valid and every source is on an allowed domain (Bernama). */
  function validClosure(c, policy) {
    var dom = (policy && policy.allowed_domains) || ["bernama.com"];
    var re = /^\d{4}-\d{2}-\d{2}$/;
    if (!c || !re.test(c.from || "") || !re.test(c.to || "") || c.from > c.to) return false;
    if (!c.sources || !c.sources.length) return false;
    return c.sources.every(function (s) { return isAllowedSource(s.url, dom); });
  }

  function closureCovers(c, place) {
    var a = c.area || {};
    if (!place) return false;
    if (a.school_codes && place.code && a.school_codes.some(function (x) { return norm(x) === norm(place.code); })) return true;
    if (a.states && place.state && a.states.some(function (s) { return sameState(s, place.state); })) return true;
    if (a.districts && a.state && place.state && place.district && sameState(a.state, place.state)) {
      return a.districts.some(function (d) { return districtKey(d) === districtKey(place.district); });
    }
    return false;
  }

  /* Official status of a place around today, from Bernama-reported announcements.
     place: {state, district, code}. Returns the closures that apply today and tomorrow,
     one that starts later, and one that ended in the last 3 days. */
  function officialStatus(place, now, ann) {
    var todayKey = mytDateKey(now), tomorrowKey = addDaysKey(todayKey, 1);
    var list = ((ann && ann.closures) || []).filter(function (c) { return validClosure(c, ann.source_policy) && closureCovers(c, place); });
    function on(day) { return list.filter(function (c) { return c.from <= day && day <= c.to; }).sort(function (a, b) { return a.to < b.to ? 1 : -1; })[0] || null; }
    var today = on(todayKey), tomorrow = on(tomorrowKey);
    var upcoming = list.filter(function (c) { return c.from > tomorrowKey && c.from <= addDaysKey(todayKey, 14); })
      .sort(function (a, b) { return a.from < b.from ? -1 : 1; })[0] || null;
    var ended = (!today && !tomorrow) ? (list.filter(function (c) { return c.to < todayKey && c.to >= addDaysKey(todayKey, -3); })
      .sort(function (a, b) { return a.to < b.to ? 1 : -1; })[0] || null) : null;
    // the last day of the whole closure run (consecutive or overlapping entries)
    var lastDay = null;
    if (tomorrow || today) {
      lastDay = (tomorrow || today).to;
      var grew = true;
      while (grew) {
        grew = false;
        list.forEach(function (c) { if (c.from <= addDaysKey(lastDay, 1) && c.to > lastDay) { lastDay = c.to; grew = true; } });
      }
    }
    return { today: today, tomorrow: tomorrow, upcoming: upcoming, ended: ended, lastDay: lastDay,
             todayKey: todayKey, tomorrowKey: tomorrowKey, all: list };
  }

  /* All valid closures active today or starting within 14 days, for the overview. */
  function activeClosures(ann, now) {
    var todayKey = mytDateKey(now), limit = addDaysKey(todayKey, 14);
    return ((ann && ann.closures) || []).filter(function (c) {
      return validClosure(c, ann.source_policy) && c.to >= todayKey && c.from <= limit;
    }).sort(function (a, b) { return a.from < b.from ? -1 : 1; });
  }

  function areaLabel(c) {
    var a = c.area || {};
    if (a.states && a.states.length) return a.states.join(", ");
    if (a.districts && a.districts.length) return a.districts.join(", ") + " (" + a.state + ")";
    if (a.school_codes) return a.school_codes.length + " listed school" + (a.school_codes.length > 1 ? "s" : "");
    return "";
  }

  // ------------------------------------------------------------ school-day dose (estimate)

  /* Breathing rates: US EPA Exposure Factors Handbook (2011), Table 6-2, mean short-term rates
     (m³ per minute), sedentary/passive and light intensity. A school day is taken as mostly
     sitting (80%) with some light activity (20%). WHO 2021 guideline for 24-hour PM2.5: 15 µg/m³. */
  var DOSE = {
    who24h: 15,
    primary: { label: "primary pupil (age 7 to 12)", hours: 6, sedentary: 4.8e-3, light: 1.1e-2 },
    secondary: { label: "secondary student (age 13 to 17)", hours: 7, sedentary: 5.4e-3, light: 1.3e-2 },
    lightShare: 0.2
  };

  function schoolDayDose(pm25) {
    if (typeof pm25 !== "number" || !(pm25 >= 0)) return null;
    function one(g) {
      var perMin = (1 - DOSE.lightShare) * g.sedentary + DOSE.lightShare * g.light;
      var volume = perMin * 60 * g.hours;                 // m³ of air breathed during the school day
      return { label: g.label, hours: g.hours, volume: volume, dose: pm25 * volume, whoDose: DOSE.who24h * volume };
    }
    return { pm25: pm25, who: DOSE.who24h, ratio: pm25 / DOSE.who24h, primary: one(DOSE.primary), secondary: one(DOSE.secondary) };
  }

  // ------------------------------------------------------------ rising fastest

  /* Change in official IPU over `hours` hours, for stations with a current reading:
     the latest hour against the same station `hours` hours earlier. */
  function risingFastest(stations, now, hours) {
    hours = hours || 6;
    var out = [];
    (stations || []).forEach(function (s) {
      if (!stationCurrent(s, now)) return;
      var h = {};
      (s.hourly || []).forEach(function (p) { if (p[1] !== null && p[1] !== undefined) h[p[0]] = p[1]; });
      var t = parseTime(s.observed), k1 = hourKeyOf(t), k0 = hourKeyOf(new Date(t.getTime() - hours * 3600000));
      if (h[k1] === undefined || h[k0] === undefined) return;
      var series = [];
      for (var i = 12; i >= 0; i--) {
        var k = hourKeyOf(new Date(t.getTime() - i * 3600000));
        if (h[k] !== undefined) series.push([k, h[k]]);
      }
      out.push({ station: s, from: h[k0], to: h[k1], delta: h[k1] - h[k0], fromKey: k0, toKey: k1, series: series });
    });
    return out.sort(function (a, b) { return b.delta - a.delta || b.to - a.to; });
  }

  function hourKeyOf(d) {
    var p = mytParts(d);
    return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":00";
  }

  // ------------------------------------------------------------ unusual readings

  /* A station is flagged when its current reading differs from the middle value of the
     other stations within `km` km (at least 2 with current readings) by 40 or more and by
     at least 35% of that middle value. The reading itself is never changed. */
  function unusualReadings(stations, now, opts) {
    opts = opts || {};
    var km = opts.km || 60, minDiff = opts.minDiff || 40, minShare = opts.minShare || 0.35;
    var cur = (stations || []).filter(function (s) { return stationCurrent(s, now) && typeof s.lat === "number"; });
    var out = {};
    cur.forEach(function (s) {
      var nb = cur.filter(function (o) { return o !== s; })
        .map(function (o) { return { s: o, km: haversineKm(s.lat, s.lon, o.lat, o.lon) }; })
        .filter(function (x) { return x.km <= km; })
        .sort(function (a, b) { return a.km - b.km; });
      if (nb.length < 2) return;
      var vals = nb.map(function (x) { return x.s.api; }).sort(function (a, b) { return a - b; });
      var n = vals.length, med = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
      var diff = s.api - med;
      if (Math.abs(diff) >= Math.max(minDiff, minShare * med)) {
        out[s.id] = { station: s, median: Math.round(med), diff: Math.round(diff), count: n,
                      neighbours: nb.map(function (x) { return { name: x.s.name, api: x.s.api, km: Math.round(x.km) }; }), km: km };
      }
    });
    return out;
  }

  // ------------------------------------------------------------ hear the haze (sound mapping)

  /* Pitch for a reading: 220 Hz at 0, doubling every 150 points (440 Hz at 150, 880 Hz at 300). */
  function toneFor(api) {
    var v = Math.max(0, Math.min(400, api || 0));
    return { freq: 220 * Math.pow(2, v / 150), wave: v >= 200 ? "square" : v > 100 ? "triangle" : "sine" };
  }

  var api = {
    TZ: TZ, forecastStatus: forecastStatus, windFrom: windFrom, schoolDayDose: schoolDayDose, DOSE: DOSE,
    risingFastest: risingFastest, unusualReadings: unusualReadings, toneFor: toneFor, hourKeyOf: hourKeyOf, locate: locate, validClosure: validClosure,
    closureCovers: closureCovers, officialStatus: officialStatus, activeClosures: activeClosures, areaLabel: areaLabel,
    isAllowedSource: isAllowedSource, windHistAt: windHistAt, backTrajectory: backTrajectory,
    regionOf: regionOf, pathRegions: pathRegions, firesNearPath: firesNearPath, coverageZones: coverageZones, inPoly: inPoly, STALE_HOURS: STALE_HOURS, CATEGORIES: CATEGORIES, categoryFor: categoryFor, pollutantName: pollutantName,
    parseTime: parseTime, mytDateKey: mytDateKey, fmtTime: fmtTime, fmtDateTime: fmtDateTime, fmtDayKey: fmtDayKey,
    addDaysKey: addDaysKey, weekdayOfKey: weekdayOfKey, ago: ago, freshness: freshness, stationCurrent: stationCurrent,
    haversineKm: haversineKm, byDistance: byDistance, matchStations: matchStations, noSchoolReason: noSchoolReason,
    predict: predict, stateSummary: stateSummary, norm: norm, searchLocal: searchLocal, nationalSummary: nationalSummary,
    stateKey: stateKey, sameState: sameState, tidy: tidy,
    todaysReadings: todaysReadings, meets: meets
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IPU = api;
})(typeof window !== "undefined" ? window : this);
