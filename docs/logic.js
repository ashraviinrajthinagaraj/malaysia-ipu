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
      if (sc) res.push({ type: "station", label: s.name, sub: "Monitoring station · " + s.state, score: sc + 3, id: s.id });
    });
    if (schools && schools.length) {
      var towns = {};
      schools.forEach(function (r) {
        var sc = Math.max(scoreText(r[1], q, tokens), r[0] && norm(r[0]) === q ? 100 : 0);
        if (sc) res.push({ type: "school", label: tidy(r[1]), sub: "School · " + [r[4], r[3], r[2]].filter(Boolean).map(tidy).join(", "),
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
        if (sc) res.push({ type: "locality", label: tidy(t.name), sub: (t.kind === "district" ? "District · " : "Town · ") + tidy(t.state) +
                           " (centre of " + t.n + " school" + (t.n > 1 ? "s" : "") + ")",
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

  var api = {
    TZ: TZ, STALE_HOURS: STALE_HOURS, CATEGORIES: CATEGORIES, categoryFor: categoryFor, pollutantName: pollutantName,
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
