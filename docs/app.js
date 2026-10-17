/* Malaysia IPU dashboard – page behaviour. Logic lives in logic.js (window.IPU). */
(function () {
  "use strict";
  var L = window.IPU;
  var UPDATE_MINUTE = 20;               // the GitHub workflow runs at minute 20 of every hour
  var REFRESH_MS = 10 * 60 * 1000;      // re-read data/latest.json every 10 minutes
  var NOMINATIM = "https://nominatim.openstreetmap.org/search";

  var S = {
    data: null, rule: null, dosm: null,
    schools: null, schoolsMeta: null, schoolsLoading: null,
    sel: null, lastPlaceQuery: 0
  };

  function $(id) { return document.getElementById(id); }
  function now() { return new Date(); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function stations() { return (S.data && S.data.stations) || []; }
  function stationById(id) { return stations().filter(function (s) { return s.id === id; })[0] || null; }

  function getJSON(path) {
    return fetch(path + (path.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(path + ": HTTP " + r.status); return r.json(); });
  }

  // ------------------------------------------------------------ small renderers

  function badge(api) {
    var c = L.categoryFor(api);
    if (!c) return '<span class="cat none">No current reading</span>';
    return '<span class="cat"><i style="background:' + c.color + '"></i>' + esc(c.label) + "</span>";
  }

  function readingTime(iso, n) {
    var t = L.parseTime(iso);
    if (!t) return "—";
    return L.mytDateKey(t) === L.mytDateKey(n) ? L.fmtTime(t) : L.fmtDateTime(t);
  }

  function nextUpdate(n) {
    var d = new Date(n.getTime());
    d.setUTCMinutes(UPDATE_MINUTE, 0, 0);       // Malaysia is UTC+8, so minutes are the same
    if (d <= n) d = new Date(d.getTime() + 3600000);
    return d;
  }

  // ------------------------------------------------------------ status line

  function renderStatus() {
    var n = now(), box = $("status");
    if (!S.data) {
      box.innerHTML = '<div class="banner bad">The readings file could not be loaded. If this site was just set up, ' +
        "wait for the first hourly update (see the README), then reload.</div>";
      return;
    }
    var f = L.freshness(S.data, n);
    var html = '<div class="row">' +
      "<span>Readings as of <b>" + esc(f.observation ? L.fmtDateTime(f.observation) : "—") + "</b> (DOE APIMS, published hourly)</span>" +
      "<span>Last successful update: <b>" + esc(f.lastSuccess ? L.fmtDateTime(f.lastSuccess) : "none yet") + "</b>" +
      (f.lastSuccess ? " (" + esc(L.ago(f.lastSuccess, n)) + ")" : "") + "</span>" +
      "<span>Next scheduled update: around " + esc(L.fmtTime(nextUpdate(n))) + "</span></div>";
    if (!stations().length) {
      html += '<div class="banner">No readings have been retrieved yet. The first hourly update has not run (or has not succeeded). ' +
        "Nothing on this page is a current reading.</div>";
    } else if (f.stale) {
      html += '<div class="banner bad"><b>Data may be outdated.</b> ' + esc(f.reasons.join(" ")) +
        " Readings are from the last successful update and are marked as outdated below; no current reading is assumed.</div>";
    } else if (f.partial) {
      html += '<div class="banner">Part of the last update failed. Stations affected keep their previous reading and show its time.</div>';
    }
    if (f.lastAttempt && f.lastSuccess && f.lastAttempt > f.lastSuccess) {
      html += '<div class="small muted" style="margin-top:.35rem">Last attempt: ' + esc(L.fmtDateTime(f.lastAttempt)) + " (failed).</div>";
    }
    box.innerHTML = html;
  }

  // ------------------------------------------------------------ national overview

  function renderSummary() {
    var n = now(), sum = L.nationalSummary(stations(), n), box = $("summary");
    function who(list) {
      if (!list.length) return "";
      var first = list[0];
      var more = list.length > 1 ? " and " + (list.length - 1) + " more" : "";
      return '<button type="button" class="link" data-station="' + esc(first.id) + '">' + esc(first.name + ", " + first.state) + "</button>" + esc(more);
    }
    var reached = sum.current.filter(function (s) { return S.rule && L.meets(s.api, S.rule.closure); });
    var html = "";
    html += '<div class="item"><div class="k">Highest current reading</div><div class="v">' +
      (sum.highest ? "<strong>" + sum.highest.api + "</strong> " + badge(sum.highest.api) + "<br>" + who(sum.highestAll) : "—") + "</div></div>";
    html += '<div class="item"><div class="k">Lowest current reading</div><div class="v">' +
      (sum.lowest ? "<strong>" + sum.lowest.api + "</strong> " + badge(sum.lowest.api) + "<br>" + who(sum.lowestAll) : "—") + "</div></div>";
    html += '<div class="item"><div class="k">Stations with a current reading</div><div class="v"><strong>' + sum.current.length +
      "</strong> of " + stations().length + (sum.noReading ? '<br><span class="small muted">' + sum.noReading + " with no current reading</span>" : "") + "</div></div>";
    html += '<div class="item"><div class="k">Stations at the school-closure level (' + (S.rule ? S.rule.closure.threshold : 200) + '+) now</div><div class="v"><strong>' +
      reached.length + "</strong>" + (reached.length ? "<br>" + who(reached) : "") + "</div></div>";
    box.innerHTML = html;

    var leg = L.CATEGORIES.map(function (c) {
      var range = c.max === Infinity ? "above 300" : c.min + "–" + c.max;
      return '<span class="cat"><i style="background:' + c.color + '"></i>' + esc(c.label) + " (" + range + "): <b>" + sum.counts[c.key] + "</b></span>";
    }).join("");
    $("legend").innerHTML = leg;
    renderStateChart(sum);
  }

  // ------------------------------------------------------------ charts (plain SVG)

  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function showTip(html, x, y) {
    var t = $("tip");
    t.innerHTML = html; t.hidden = false;
    var w = t.offsetWidth, h = t.offsetHeight;
    var left = Math.min(x + 14, window.innerWidth - w - 8), top = y + 14;
    if (top + h > window.innerHeight - 8) top = y - h - 10;
    t.style.left = Math.max(8, left) + "px"; t.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { $("tip").hidden = true; }

  function niceMax(v, floor) {
    var m = Math.max(v, floor);
    return Math.ceil(m / 50) * 50;
  }

  function renderStateChart(sum) {
    var box = $("state-chart");
    box.innerHTML = "";
    var rows = Object.keys(sum.byState).map(function (k) { return sum.byState[k]; })
      .sort(function (a, b) { return b.api - a.api || a.state.localeCompare(b.state); });
    if (!rows.length) { box.innerHTML = '<p class="muted">No current readings to chart.</p>'; return; }
    var W = Math.max(300, box.clientWidth || 600);
    var labelW = Math.min(170, Math.round(W * 0.34)), padR = 44, rowH = 26, top = 22, bottom = 22;
    var H = top + rows.length * rowH + bottom;
    var max = niceMax(Math.max.apply(null, rows.map(function (r) { return r.api; })), 220);
    var x0 = labelW, x1 = W - padR;
    var sx = function (v) { return x0 + (v / max) * (x1 - x0); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img",
      "aria-label": "Highest current IPU reading in each state" });
    // grid
    for (var g = 0; g <= max; g += 50) {
      svg.appendChild(svgEl("line", { x1: sx(g), x2: sx(g), y1: top - 4, y2: H - bottom, stroke: "#ececea" }));
      svg.appendChild(svgEl("text", { x: sx(g), y: H - 6, "font-size": 11, fill: "#6b6b68", "text-anchor": "middle" }, String(g)));
    }
    rows.forEach(function (r, i) {
      var y = top + i * rowH, c = L.categoryFor(r.api);
      var name = r.state.length > 22 && W < 420 ? r.state.slice(0, 20) + "…" : r.state;
      svg.appendChild(svgEl("text", { x: labelW - 8, y: y + rowH / 2 + 4, "font-size": 12.5, fill: "#1a1a1a", "text-anchor": "end" }, name));
      var bw = Math.max(2, sx(r.api) - x0);
      var bar = svgEl("rect", { x: x0, y: y + 5, width: bw, height: rowH - 10, rx: 3, fill: c.color });
      svg.appendChild(bar);
      svg.appendChild(svgEl("text", { x: x0 + bw + 6, y: y + rowH / 2 + 4, "font-size": 12, fill: "#1a1a1a" }, String(r.api)));
      var hit = svgEl("rect", { x: 0, y: y, width: W, height: rowH, fill: "transparent", style: "cursor:pointer" });
      hit.addEventListener("mousemove", function (ev) {
        showTip("<b>" + esc(r.state) + "</b><br>Highest: " + r.api + " (" + esc(c.label) + ")<br>at " + esc(r.name) + ", " + esc(readingTime(r.observed, now())), ev.clientX, ev.clientY);
      });
      hit.addEventListener("mouseleave", hideTip);
      hit.addEventListener("click", function () { hideTip(); select({ type: "state", state: r.state }); });
      svg.appendChild(hit);
    });
    if (S.rule) {
      svg.appendChild(svgEl("line", { x1: sx(S.rule.outdoor.threshold), x2: sx(S.rule.outdoor.threshold), y1: top - 4, y2: H - bottom, stroke: "#8a8a86", "stroke-dasharray": "4 4" }));
      svg.appendChild(svgEl("line", { x1: sx(S.rule.closure.threshold), x2: sx(S.rule.closure.threshold), y1: top - 4, y2: H - bottom, stroke: "#b03a2e", "stroke-dasharray": "4 4" }));
      svg.appendChild(svgEl("text", { x: sx(S.rule.closure.threshold), y: top - 8, "font-size": 11, fill: "#b03a2e", "text-anchor": "middle" }, "200 closure level"));
      svg.appendChild(svgEl("text", { x: sx(S.rule.outdoor.threshold), y: top - 8, "font-size": 11, fill: "#4a4a48", "text-anchor": "middle" }, "100"));
    }
    box.appendChild(svg);
    var note = document.createElement("p");
    note.className = "small muted";
    note.textContent = "Each bar is the highest current station reading in that state. Dashed lines: 100 (outdoor activities stop) and 200 (school closure level). Select a bar to see that state.";
    box.appendChild(note);
  }

  /* 24-hour line chart for one station, with the 100 and 200 reference lines. */
  function renderTrend(box, st, titleText) {
    box.innerHTML = "";
    var h = document.createElement("h3");
    h.textContent = titleText;
    box.appendChild(h);
    var n = now();
    var pts = (st.hourly || []).filter(function (p) { return p[1] !== null && p[1] !== undefined; })
      .map(function (p) { return { t: L.parseTime(p[0]), y: p[1] }; })
      .filter(function (p) { return p.t && (n - p.t) <= 30 * 3600000; });
    if (pts.length < 2) {
      var p = document.createElement("p"); p.className = "muted";
      p.textContent = "Not enough hourly readings yet to draw a trend for this station.";
      box.appendChild(p); return;
    }
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    var W = Math.max(300, chart.clientWidth || 600), H = 220, padL = 36, padR = 12, padT = 18, padB = 28;
    var t0 = pts[0].t.getTime(), t1 = pts[pts.length - 1].t.getTime();
    var ymax = niceMax(Math.max.apply(null, pts.map(function (p) { return p.y; })), 220);
    var sx = function (t) { return padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img",
      "aria-label": "Hourly IPU at " + st.name + " over the last 24 hours" });
    for (var g = 0; g <= ymax; g += 50) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(g), y2: sy(g), stroke: "#ececea" }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: "#6b6b68", "text-anchor": "end" }, String(g)));
    }
    // x labels every ~6 hours
    var step = 6 * 3600000;
    for (var tt = Math.ceil(t0 / step) * step; tt <= t1; tt += step) {
      svg.appendChild(svgEl("text", { x: sx(tt), y: H - 8, "font-size": 11, fill: "#6b6b68", "text-anchor": "middle" }, L.fmtTime(new Date(tt))));
    }
    if (S.rule) {
      [[S.rule.outdoor.threshold, "Above 100: outdoor activities stop", "#8a8a86"],
       [S.rule.closure.threshold, "200: school closure level", "#b03a2e"]].forEach(function (r) {
        svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(r[0]), y2: sy(r[0]), stroke: r[2], "stroke-dasharray": "4 4" }));
        svg.appendChild(svgEl("text", { x: padL + 4, y: sy(r[0]) - 4, "font-size": 11, fill: r[2], "text-anchor": "start",
          stroke: "#ffffff", "stroke-width": 3, "paint-order": "stroke" }, r[1]));
      });
    }
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + sx(p.t.getTime()).toFixed(1) + " " + sy(p.y).toFixed(1); }).join(" ");
    svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: "#2a78d6", "stroke-width": 2, "stroke-linejoin": "round" }));
    var last = pts[pts.length - 1];
    svg.appendChild(svgEl("circle", { cx: sx(last.t.getTime()), cy: sy(last.y), r: 4, fill: "#2a78d6", stroke: "#fff", "stroke-width": 2 }));
    var cross = svgEl("line", { x1: 0, x2: 0, y1: padT, y2: H - padB, stroke: "#1a1a1a", "stroke-width": 1, opacity: 0 });
    var dot = svgEl("circle", { r: 4, fill: "#2a78d6", stroke: "#fff", "stroke-width": 2, opacity: 0 });
    svg.appendChild(cross); svg.appendChild(dot);
    var overlay = svgEl("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
    function hover(ev) {
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) * (W / rect.width);
      var best = pts[0];
      pts.forEach(function (p) { if (Math.abs(sx(p.t.getTime()) - px) < Math.abs(sx(best.t.getTime()) - px)) best = p; });
      var x = sx(best.t.getTime());
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("opacity", 0.35);
      dot.setAttribute("cx", x); dot.setAttribute("cy", sy(best.y)); dot.setAttribute("opacity", 1);
      showTip("<b>" + best.y + "</b> " + esc(L.categoryFor(best.y).label) + "<br>" + esc(L.fmtDateTime(best.t)), ev.clientX, ev.clientY);
    }
    overlay.addEventListener("mousemove", hover);
    overlay.addEventListener("touchstart", function (ev) { if (ev.touches[0]) hover(ev.touches[0]); }, { passive: true });
    overlay.addEventListener("mouseleave", function () { cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip(); });
    svg.appendChild(overlay);
    chart.appendChild(svg);
    var det = document.createElement("details");
    det.innerHTML = "<summary>Show these readings as a table</summary>" +
      '<div class="table-wrap" style="margin-top:.5rem"><table class="mini"><thead><tr><th>Hour (Malaysia time)</th><th class="num">IPU</th><th>Category</th></tr></thead><tbody>' +
      pts.slice().reverse().map(function (p) {
        return "<tr><td>" + esc(L.fmtDateTime(p.t)) + '</td><td class="num">' + p.y + "</td><td>" + badge(p.y) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    box.appendChild(det);
    var lastPt = pts[pts.length - 1];
    if ((n - lastPt.t) / 3600000 > L.STALE_HOURS) {
      var warn = document.createElement("p"); warn.className = "note";
      warn.textContent = "Outdated: the newest reading in this chart is from " + L.fmtDateTime(lastPt.t) + " (" + L.ago(lastPt.t, n) + ").";
      chart.parentNode.insertBefore(warn, chart);
    }
    var src = document.createElement("p"); src.className = "small muted";
    src.textContent = "Source: DOE APIMS hourly table for " + st.name + " (" + st.id + "). Each value is DOE's 24-hour running average index for that hour.";
    box.appendChild(src);
  }

  function renderDosm() {
    var box = $("dosm");
    var d = S.dosm;
    if (!d || !d.rows || !d.rows.length) {
      box.innerHTML = '<p class="muted">DOSM historical data has not been downloaded yet. It is added by the first update run.</p>';
      return;
    }
    var want = [["pm25", "PM2.5", "#2a78d6"], ["pm10", "PM10", "#eb6834"]];
    var series = want.map(function (w) {
      return { key: w[0], name: w[1], color: w[2], pts: d.rows.filter(function (r) { return r[1] === w[0] && r[2] !== null; })
        .map(function (r) { return { t: new Date(r[0] + "T00:00:00Z"), y: r[2], date: r[0] }; }) };
    }).filter(function (s) { return s.pts.length > 1; });
    box.innerHTML = "<p>Monthly national average concentration of fine particles (µg/m³), from DOSM's published dataset. " +
      "This is history for context only: it is not IPU, not per station and not current. Latest month available: <b>" +
      esc(d.last_month ? L.fmtDayKey(d.last_month).replace(/^\w+ \d+ /, "") : "—") + "</b>.</p>";
    if (!series.length) { box.innerHTML += '<p class="muted">No PM2.5 or PM10 values in the DOSM file.</p>'; return; }
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    var all = []; series.forEach(function (s) { all = all.concat(s.pts); });
    var W = Math.max(300, chart.clientWidth || 600), H = 240, padL = 36, padR = 56, padT = 14, padB = 28;
    var t0 = Math.min.apply(null, all.map(function (p) { return p.t.getTime(); }));
    var t1 = Math.max.apply(null, all.map(function (p) { return p.t.getTime(); }));
    var ymax = Math.ceil(Math.max.apply(null, all.map(function (p) { return p.y; })) / 10) * 10;
    var sx = function (t) { return padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img",
      "aria-label": "Monthly national average PM2.5 and PM10 concentration, DOSM" });
    var gstep = ymax > 60 ? 20 : 10;
    for (var g = 0; g <= ymax; g += gstep) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(g), y2: sy(g), stroke: "#ececea" }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: "#6b6b68", "text-anchor": "end" }, String(g)));
    }
    var y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    var ystep = Math.max(1, Math.ceil((y1 - y0 + 1) / Math.max(2, Math.floor(W / 80))));
    for (var yr = y0; yr <= y1; yr += ystep) {
      var tx = Date.UTC(yr, 0, 1);
      if (tx < t0) continue;
      svg.appendChild(svgEl("text", { x: sx(tx), y: H - 8, "font-size": 11, fill: "#6b6b68", "text-anchor": "middle" }, String(yr)));
    }
    series.forEach(function (s) {
      var dd = s.pts.map(function (p, i) { return (i ? "L" : "M") + sx(p.t.getTime()).toFixed(1) + " " + sy(p.y).toFixed(1); }).join(" ");
      svg.appendChild(svgEl("path", { d: dd, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round" }));
      var last = s.pts[s.pts.length - 1];
      svg.appendChild(svgEl("text", { x: sx(last.t.getTime()) + 6, y: sy(last.y) + 4, "font-size": 12, fill: "#1a1a1a" }, s.name));
    });
    var cross = svgEl("line", { y1: padT, y2: H - padB, stroke: "#1a1a1a", opacity: 0 });
    svg.appendChild(cross);
    var overlay = svgEl("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
    overlay.addEventListener("mousemove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) * (W / rect.width);
      var ref = series[0].pts, best = ref[0];
      ref.forEach(function (p) { if (Math.abs(sx(p.t.getTime()) - px) < Math.abs(sx(best.t.getTime()) - px)) best = p; });
      cross.setAttribute("x1", sx(best.t.getTime())); cross.setAttribute("x2", sx(best.t.getTime())); cross.setAttribute("opacity", 0.3);
      var lines = series.map(function (s) {
        var m = s.pts.filter(function (p) { return p.date === best.date; })[0];
        return esc(s.name) + ": " + (m ? m.y.toFixed(1) + " µg/m³" : "—");
      });
      showTip("<b>" + esc(L.fmtDayKey(best.date).replace(/^\w+ \d+ /, "")) + "</b><br>" + lines.join("<br>"), ev.clientX, ev.clientY);
    });
    overlay.addEventListener("mouseleave", function () { cross.setAttribute("opacity", 0); hideTip(); });
    svg.appendChild(overlay);
    chart.appendChild(svg);
    var leg = document.createElement("div"); leg.className = "legend";
    leg.innerHTML = series.map(function (s) {
      return '<span class="cat"><i style="background:' + s.color + '"></i>' + esc(s.name) + " (µg/m³)</span>";
    }).join("");
    box.appendChild(leg);
    var src = document.createElement("p"); src.className = "small muted";
    src.innerHTML = 'Source: <a href="' + esc(d.source.page) + '" rel="noopener">OpenDOSM – Monthly Air Pollution</a> (' + esc(d.source.licence) +
      "), source agencies DOE and DOSM. Downloaded " + esc(L.fmtDateTime(L.parseTime(d.fetched_at))) + ".";
    box.appendChild(src);
  }

  // ------------------------------------------------------------ station table

  function populateStateFilter() {
    var sel = $("f-state"), cur = sel.value;
    var names = {};
    stations().forEach(function (s) { if (s.state) names[s.state] = true; });
    sel.innerHTML = '<option value="">All states</option>' + Object.keys(names).sort().map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + "</option>";
    }).join("");
    sel.value = cur;
  }

  function renderTable() {
    var n = now();
    var fs = $("f-state").value, sort = $("f-sort").value, ft = L.norm($("f-text").value);
    var list = stations().filter(function (s) {
      if (fs && s.state !== fs) return false;
      if (ft && L.norm([s.name, s.location, s.place, s.id].join(" ")).indexOf(ft) < 0) return false;
      return true;
    });
    var val = function (s) { return L.stationCurrent(s, n) ? s.api : null; };
    list.sort(function (a, b) {
      if (sort === "api-desc" || sort === "api-asc") {
        var va = val(a), vb = val(b);
        if (va === null && vb === null) return a.name.localeCompare(b.name);
        if (va === null) return 1;
        if (vb === null) return -1;
        return sort === "api-desc" ? vb - va : va - vb;
      }
      if (sort === "name") return a.name.localeCompare(b.name);
      return (a.state || "").localeCompare(b.state || "") || a.name.localeCompare(b.name);
    });
    var html = "", lastState = null;
    list.forEach(function (s) {
      if (sort === "state" && s.state !== lastState) {
        lastState = s.state;
        html += '<tr class="state-row"><td colspan="5">' + esc(s.state) + "</td></tr>";
      }
      var cur = L.stationCurrent(s, n);
      var pol = L.pollutantName(s.pollutant);
      html += '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + ">" +
        "<td>" + esc(s.name) + '<span class="sub">' + esc(s.id) + (s.place ? " · " + esc(s.place) : "") + "</span></td>" +
        "<td>" + esc(s.state) + "</td>" +
        '<td class="num api">' + (cur ? esc(s.api) : "—") + "</td>" +
        "<td>" + (cur ? badge(s.api) + (pol ? '<span class="sub">' + esc(pol) + "</span>" : "") : badge(null)) + "</td>" +
        "<td>" + esc(readingTime(s.observed, n)) + (cur ? "" : (s.api !== null && s.observed ? '<span class="sub">last reading ' + esc(s.api) + ", outdated</span>" : "")) + "</td></tr>";
    });
    if (!list.length) html = '<tr class="state-row"><td colspan="5">No stations match.</td></tr>';
    document.querySelector("#station-table tbody").innerHTML = html;
  }

  // ------------------------------------------------------------ selection

  function select(sel, opts) {
    S.sel = sel;
    if (!opts || !opts.keepHash) setHash(sel);
    $("results").innerHTML = "";
    renderSelection();
    if (!opts || !opts.noScroll) $("selection").scrollIntoView({ behavior: "auto", block: "start" });
  }

  function setHash(sel) {
    var h = "";
    if (sel) {
      if (sel.type === "station") h = "station=" + encodeURIComponent(sel.id);
      else if (sel.type === "state") h = "state=" + encodeURIComponent(sel.state);
      else if (sel.type === "school" && sel.code) h = "school=" + encodeURIComponent(sel.code);
      else if (sel.lat !== undefined) h = "at=" + sel.lat.toFixed(5) + "," + sel.lon.toFixed(5) +
        "&label=" + encodeURIComponent(sel.label || "") + "&src=" + encodeURIComponent(sel.source || "") +
        (sel.state ? "&st=" + encodeURIComponent(sel.state) : "");
    }
    try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch (e) { /* ignore */ }
  }

  function readHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h) return null;
    var q = {};
    h.split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
    if (q.station) return { type: "station", id: q.station };
    if (q.state) return { type: "state", state: q.state };
    if (q.school) return { type: "school-code", code: q.school };
    if (q.at) {
      var p = q.at.split(",").map(Number);
      if (p.length === 2 && isFinite(p[0]) && isFinite(p[1])) {
        return { type: "place", lat: p[0], lon: p[1], label: q.label || "Selected location", source: q.src || "link", state: q.st || null };
      }
    }
    return null;
  }

  var SOURCE_TEXT = {
    kpm: "School location from the official KPM school list",
    "kpm-town": "Town centre estimated from the official KPM school list (average position of its schools)",
    osm: "Location found with OpenStreetMap place search (not an official source)",
    device: "Your device's location",
    link: "Location from a shared link"
  };

  function renderSelection() {
    var box = $("selection");
    var sel = S.sel;
    if (!sel) { box.hidden = true; return; }
    box.hidden = false;
    var n = now();
    if (sel.type === "school-code") {
      // resolve after the school list loads
      loadSchools().then(function () {
        var r = (S.schools || []).filter(function (x) { return x[0] === sel.code; })[0];
        if (r) select(schoolSel(r), { keepHash: true, noScroll: true }); else { S.sel = null; renderSelection(); }
      });
      $("loc-info").innerHTML = '<p class="muted">Loading school…</p>';
      return;
    }
    if (sel.type === "state") return renderStateSelection(sel, n);

    var title, info = "", st = null, lat, lon, kind;
    if (sel.type === "station") {
      st = stationById(sel.id);
      if (!st) { $("loc-info").innerHTML = '<p class="muted">This station is not in the current data.</p>'; $("prediction").innerHTML = ""; $("trend").innerHTML = ""; return; }
      title = st.name + " monitoring station";
      lat = st.lat; lon = st.lon;
      var stCur = L.stationCurrent(st, n);
      info = '<dl class="kv"><dt>Station</dt><dd>' + esc(st.name) + " (" + esc(st.id) + ")</dd>" +
        "<dt>Town / area</dt><dd>" + esc(st.name) + (st.place ? "<br>" + esc(L.tidy(st.place)) : "") + "</dd>" +
        "<dt>State</dt><dd>" + esc(st.state) + "</dd>" +
        (!stCur && st.api !== null && st.observed ? "<dt>Last reading</dt><dd>" + esc(st.api) + " at " + esc(L.fmtDateTime(L.parseTime(st.observed))) +
          " <b>(outdated, not a current reading)</b></dd>" : "") + "</dl>";
    } else {
      title = sel.label;
      lat = sel.lat; lon = sel.lon;
      kind = sel.type === "school" ? "School" : sel.type === "locality" ? "Town / district" : "Place";
      var loc = [sel.town, sel.district, sel.state].filter(Boolean).join(", ");
      info = '<dl class="kv"><dt>Type</dt><dd>' + esc(kind) + "</dd>" +
        (sel.sub ? "<dt>Details</dt><dd>" + esc(sel.sub) + "</dd>" : "") +
        (loc ? "<dt>Locality</dt><dd>" + esc(loc) + "</dd>" : "") +
        (sel.code ? "<dt>School code</dt><dd>" + esc(sel.code) + "</dd>" : "") +
        "<dt>Location source</dt><dd>" + esc(SOURCE_TEXT[sel.source] || sel.source || "—") + "</dd></dl>";
    }
    $("sel-title").textContent = title;

    var m = (typeof lat === "number" && typeof lon === "number") ? L.matchStations(lat, lon, stations(), n, { state: sel.state }) : null;
    var ref = m && m.reference;
    var html = info;
    if (!m) {
      html += '<p class="note">No station coordinates are available, so a reference station cannot be chosen.</p>';
    } else if (!ref) {
      html += '<p class="note">No station near this location has a current reading. Readings may be outdated; see the notice at the top of the page.</p>';
    } else {
      var rs = ref.station;
      var self = sel.type === "station" && rs.id === sel.id;
      html += '<div style="margin-top:.9rem"><span class="label-tag">' + (self ? "Station reading" : "Reference station reading") + "</span>" +
        '<div class="big-reading"><span class="val">' + esc(rs.api) + "</span>" + badge(rs.api) + "</div>" +
        "<div>" + (self ? "" : "From <b>" + esc(rs.name) + "</b>, " + esc(rs.state) + " (" + esc(rs.id) + "), " +
          (ref.km < 1 ? "under 1 km" : Math.round(ref.km) + " km") + " from this location.<br>") +
        "Reading for " + esc(L.fmtDateTime(L.parseTime(rs.observed))) + (L.pollutantName(rs.pollutant) ? " · Dominant pollutant: " + esc(L.pollutantName(rs.pollutant)) : "") + "</div>";
      if (!self) {
        html += '<p class="note">This is the reading at the DOE monitoring station named above, not a measurement taken at ' +
          (sel.type === "school" ? "the school" : "this location") + " itself.</p>";
      }
      html += "</div>";
      m.notes.forEach(function (t) { html += '<p class="note">' + esc(t) + "</p>"; });
    }
    if (m && m.shown.length) {
      html += '<h3 style="margin-top:1rem">Nearest monitoring stations</h3><div class="table-wrap"><table class="mini"><thead><tr><th>Station</th><th class="num">Distance</th><th class="num">IPU</th><th>Category</th><th class="hide-sm">Time</th></tr></thead><tbody>' +
        m.shown.map(function (x) {
          var s = x.station, cur = L.stationCurrent(s, n);
          return '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + "><td>" + esc(s.name) +
            (ref && x === ref ? " <b>(reference)</b>" : "") + '<span class="sub">' + esc(s.state) + "</span></td>" +
            '<td class="num">' + (x.km < 1 ? "&lt;1" : Math.round(x.km)) + " km</td>" +
            '<td class="num">' + (cur ? esc(s.api) : "—") + "</td><td>" + badge(cur ? s.api : null) + "</td>" +
            '<td class="hide-sm">' + esc(readingTime(s.observed, n)) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    $("loc-info").innerHTML = html;
    renderPrediction(ref ? ref.station : (st || null), sel.state || (ref && ref.station.state) || (st && st.state), m);
    if (ref) renderTrend($("trend"), ref.station, "Last 24 hours at " + ref.station.name + (sel.type === "station" ? "" : " (reference station)"));
    else if (st) renderTrend($("trend"), st, "Last 24 hours at " + st.name);
    else $("trend").innerHTML = "";
  }

  function disclaimer() {
    var r = S.rule;
    return '<div class="disclaimer"><b>This is a prediction, not an official closure announcement.</b> It is worked out from official DOE readings. ' +
      "School closures are decided and announced by KPM, the State Education Department (JPN) or the District Education Office (PPD); check their announcements. " +
      "Rule used: " + esc(r.name) + ", in force from " + esc(L.fmtDayKey(r.effective_from)) + ": " + esc(r.closure.summary) +
      ' <a href="#about">How the prediction works</a></div>';
  }

  function renderPrediction(st, stateName, m) {
    var box = $("prediction"), n = now();
    if (!S.rule) { box.innerHTML = "<h3>School status prediction</h3><p class='muted'>The closure rule file could not be loaded.</p>"; return; }
    var p = L.predict(st, S.rule, n, stateName);
    var html = "<h3>School status prediction</h3>";
    if (!p.available) {
      html += '<div class="pred-status unavailable">Prediction unavailable</div><p>' + esc(p.reason) + "</p>" + disclaimer();
      box.innerHTML = html; return;
    }
    html += '<div class="pred-status ' + p.level + '">' + esc(p.status) + "</div>" +
      "<p><b>" + esc(p.headline) + ".</b> " + esc(p.detail) + "</p>" +
      '<dl class="kv">' +
      "<dt>Reference station</dt><dd>" + esc(st.name) + ", " + esc(st.state) + "</dd>" +
      "<dt>Current IPU</dt><dd>" + esc(p.latest) + " " + badge(p.latest) + "</dd>" +
      "<dt>Reading time</dt><dd>" + esc(L.fmtDateTime(p.latestAt)) + "</dd>" +
      "<dt>Highest today</dt><dd>" + (p.todayMax !== null ? esc(p.todayMax) + " at " + esc(L.fmtTime(p.todayMaxAt)) : "—") + "</dd>" +
      "<dt>Closure threshold (" + S.rule.closure.threshold + ") reached today</dt><dd><b>" + (p.reachedToday ? "Yes" : "No") + "</b></dd>" +
      "<dt>Predicted status, " + esc(L.fmtDayKey(p.tomorrowKey)) + "</dt><dd><b>" + esc(p.status) + "</b></dd>" +
      "<dt>Outdoor activities now</dt><dd>" + (p.outdoorStop ? "Should stop (IPU above " + S.rule.outdoor.threshold + ")" : "No restriction at this reading") + "</dd>" +
      "</dl>";
    if (m && m.all && !p.reachedToday) {
      var nearHit = m.all.filter(function (x) {
        if (x.station === st || x.km > 30 || !L.stationCurrent(x.station, n)) return false;
        var q = L.predict(x.station, S.rule, n, stateName);
        return q.available && q.reachedToday;
      });
      nearHit.forEach(function (x) {
        html += '<p class="note">' + esc(x.station.name) + " (" + Math.round(x.km) + " km away) reached the closure level today. " +
          "Schools in its area may close, which may include this location.</p>";
      });
    }
    html += disclaimer();
    box.innerHTML = html;
  }

  function renderStateSelection(sel, n) {
    var sum = L.stateSummary(sel.state, stations(), S.rule, n);
    $("sel-title").textContent = sel.state;
    var html = "";
    if (!sum.stations.length) {
      $("loc-info").innerHTML = html + '<p class="muted">No stations found for this state.</p>';
      $("prediction").innerHTML = ""; $("trend").innerHTML = ""; return;
    }
    html += '<p>' + sum.stations.length + " monitoring station" + (sum.stations.length > 1 ? "s" : "") + ", " +
      sum.current.length + " with a current reading." +
      (sum.highest ? " Highest now: <b>" + esc(sum.highest.api) + "</b> at " + esc(sum.highest.name) + "." : "") +
      (sum.lowest && sum.lowest !== sum.highest ? " Lowest: <b>" + esc(sum.lowest.api) + "</b> at " + esc(sum.lowest.name) + "." : "") + "</p>" +
      '<p class="note">Air quality differs across a state, so each station is listed separately. Search a town or school to use its nearest station.</p>' +
      '<div class="table-wrap"><table class="mini"><thead><tr><th>Station</th><th class="num">IPU</th><th>Category</th><th class="hide-sm">Time</th></tr></thead><tbody>' +
      sum.stations.slice().sort(function (a, b) {
        var ca = L.stationCurrent(a, n) ? a.api : -1, cb = L.stationCurrent(b, n) ? b.api : -1;
        return cb - ca;
      }).map(function (s) {
        var cur = L.stationCurrent(s, n);
        return '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + "><td>" + esc(s.name) + '<span class="sub">' + esc(s.id) + "</span></td>" +
          '<td class="num">' + (cur ? esc(s.api) : "—") + "</td><td>" + badge(cur ? s.api : null) + '</td><td class="hide-sm">' + esc(readingTime(s.observed, n)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    $("loc-info").innerHTML = html;

    var p = "<h3>School status prediction</h3>";
    var noSchool = sum.tomorrowNoSchool;
    var dayLabel = L.fmtDayKey(sum.tomorrowKey);
    if (!sum.current.length) {
      p += '<div class="pred-status unavailable">Prediction unavailable</div><p>No station in this state has a current reading.</p>';
    } else if (sum.reached.length) {
      p += '<div class="pred-status may_close">' + (noSchool ? (noSchool.kind === "weekend" ? "No school (weekend)" : "No school (holiday)") : "Schools in some areas may be closed") + "</div>" +
        "<p><b>The closure level of " + S.rule.closure.threshold + " was reached today at " + sum.reached.length + " station" + (sum.reached.length > 1 ? "s" : "") + ".</b> " +
        (noSchool ? "Under the current rule, schools in the affected areas close immediately at this level. Tomorrow (" + esc(dayLabel) + ") is not a school day in " +
          esc(sel.state) + (noSchool.kind === "weekend" ? " (weekend)." : " (" + esc(noSchool.label) + ").")
                  : "Schools in the affected areas may be closed tomorrow (" + esc(dayLabel) + ").") +
        " Closure applies to affected areas, not necessarily the whole state.</p><ul>" +
        sum.reached.map(function (r) { return "<li>" + esc(r.station.name) + ": highest " + esc(r.p.todayMax) + " at " + esc(L.fmtTime(r.p.todayMaxAt)) + ", latest " + esc(r.p.latest) + "</li>"; }).join("") + "</ul>";
    } else {
      p += '<div class="pred-status ' + (noSchool ? "no_school" : "not_reached") + '">' + (noSchool ? (noSchool.kind === "weekend" ? "No school (weekend)" : "No school (holiday)") : "Not predicted to close") + "</div>" +
        "<p><b>Closure threshold not reached.</b> No station in " + esc(sel.state) + " has reached " + S.rule.closure.threshold +
        " today at the latest available readings." +
        (noSchool ? " Tomorrow (" + esc(dayLabel) + ") is not a school day in " + esc(sel.state) + (noSchool.kind === "weekend" ? " (weekend)." : " (" + esc(noSchool.label) + ").")
                  : " Based on readings so far, no haze closure is predicted for " + esc(dayLabel) + ". This can change if readings rise later today.") + "</p>";
    }
    var outdoor = sum.current.filter(function (s) { return L.meets(s.api, S.rule.outdoor); }).length;
    if (sum.current.length) {
      var predicted = noSchool ? (noSchool.kind === "weekend" ? "No school (weekend)" : "No school (holiday)")
                               : sum.reached.length ? "Schools may be closed in affected areas" : "Not predicted to close";
      p += '<dl class="kv"><dt>Closure threshold (' + S.rule.closure.threshold + ") reached today</dt><dd><b>" +
        (sum.reached.length ? "Yes, at " + sum.reached.length + " station" + (sum.reached.length > 1 ? "s" : "") : "No") + "</b></dd>" +
        "<dt>Predicted status, " + esc(dayLabel) + "</dt><dd><b>" + esc(predicted) + "</b></dd>" +
        "<dt>Stations above " + S.rule.outdoor.threshold + " now</dt><dd>" + outdoor + " of " + sum.current.length +
        " (outdoor activities stop in those areas)</dd><dt>Readings as of</dt><dd>" + esc(S.data.observation_time ? L.fmtDateTime(L.parseTime(S.data.observation_time)) : "—") + "</dd></dl>";
    }
    p += disclaimer();
    $("prediction").innerHTML = p;
    if (sum.highest) renderTrend($("trend"), sum.highest, "Last 24 hours at " + sum.highest.name + " (highest station in " + sel.state + " now)");
    else $("trend").innerHTML = "";
  }

  function schoolSel(r) {
    return { type: "school", code: r[0], label: L.tidy(r[1]), state: L.tidy(r[2]), district: L.tidy(r[3]), town: L.tidy(r[4]),
             lat: r[5], lon: r[6], source: "kpm" };
  }

  // ------------------------------------------------------------ search

  function loadSchools() {
    if (S.schoolsLoading) return S.schoolsLoading;
    S.schoolsLoading = getJSON("data/schools.json").then(function (d) {
      S.schoolsMeta = d;
      S.schools = d && d.available ? d.schools : [];
    }).catch(function () { S.schools = []; S.schoolsMeta = { available: false }; })
      .then(function () { renderSearchNote(); renderAbout(); });
    return S.schoolsLoading;
  }

  function renderSearchNote() {
    var m = S.schoolsMeta, el = $("search-note");
    if (!m) { el.textContent = ""; return; }
    if (m.available) {
      el.textContent = "Schools, towns and districts: official KPM school list (" + m.count + " schools). " +
        "Other places: OpenStreetMap place search (press Enter or Search places).";
    } else {
      el.textContent = "The official KPM school list has not been added to this site yet, so schools and towns are found with " +
        "OpenStreetMap place search (press Enter or Search places). States and stations come from APIMS.";
    }
  }

  var GROUPS = { state: "States", station: "Monitoring stations", locality: "Towns and districts (KPM list)", school: "Schools (KPM list)", place: "Places (OpenStreetMap)" };

  function renderResults(items, extraMsg, q) {
    var box = $("results");
    var html = "", last = null;
    items.forEach(function (r, i) {
      if (r.type !== last) { html += '<div class="group">' + esc(GROUPS[r.type] || r.type) + "</div>"; last = r.type; }
      html += '<button type="button" role="option" data-i="' + i + '">' + esc(r.label) + '<span class="sub">' + esc(r.sub || "") + "</span></button>";
    });
    if (extraMsg) html += '<div class="msg">' + extraMsg + "</div>";
    if (q && q.length >= 3 && !items.some(function (r) { return r.type === "place"; })) {
      html += '<button type="button" role="option" data-place="1">Search all places for “' + esc(q) + '” (OpenStreetMap)<span class="sub">Towns, neighbourhoods and schools not listed above</span></button>';
    }
    box.innerHTML = html;
    box._items = items;
  }

  function onSearchInput() {
    var q = $("q").value.trim();
    if (q.length < 2) { $("results").innerHTML = ""; return; }
    var items = L.searchLocal(q, stations(), S.schools);
    renderResults(items, items.length ? "" : "No state, station" + (S.schools && S.schools.length ? ", town or school" : "") + " matches yet.", q);
  }

  function chooseResult(r) {
    if (r.type === "state") select({ type: "state", state: r.state });
    else if (r.type === "station") select({ type: "station", id: r.id });
    else if (r.type === "school") select({ type: "school", code: r.code, label: r.label, state: r.state, district: r.district, town: r.town, lat: r.lat, lon: r.lon, source: "kpm" });
    else if (r.type === "locality") select({ type: "locality", label: r.label, lat: r.lat, lon: r.lon, state: r.state, sub: r.sub, source: "kpm-town" });
    else if (r.type === "place") select({ type: "place", label: r.label, lat: r.lat, lon: r.lon, state: r.state, sub: r.sub, source: "osm" });
  }

  function placeSearch() {
    var q = $("q").value.trim();
    if (q.length < 3) { $("q").focus(); return; }
    var wait = Math.max(0, 1100 - (Date.now() - S.lastPlaceQuery));   // Nominatim: max 1 request per second
    var box = $("results");
    box.innerHTML = '<div class="msg">Searching places in Malaysia…</div>';
    setTimeout(function () {
      S.lastPlaceQuery = Date.now();
      var url = NOMINATIM + "?format=jsonv2&addressdetails=1&limit=8&countrycodes=my&accept-language=en&q=" + encodeURIComponent(q);
      fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (list) {
          var local = L.searchLocal(q, stations(), S.schools);
          var places = (list || []).map(function (p) {
            var a = p.address || {};
            var name = p.name || String(p.display_name || "").split(",")[0];
            var area = [a.suburb || a.village || a.town || a.city || a.county, a.state].filter(Boolean).join(", ");
            var kind = (p.type || p.category || "place").replace(/_/g, " ");
            return { type: "place", label: name, sub: kind.charAt(0).toUpperCase() + kind.slice(1) + (area ? " · " + area : ""),
                     lat: Number(p.lat), lon: Number(p.lon), state: a.state || null };
          }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lon); });
          var all = local.concat(places);
          renderResults(all, places.length ? '<span class="small muted">Place results © OpenStreetMap contributors. Check that the place is the one you mean.</span>' :
            "No places found for “" + esc(q) + "”. Try a different spelling or a nearby town.", null);
        })
        .catch(function () {
          box.innerHTML = '<div class="msg">Place search is not available right now. You can still search states and stations, or use your location.</div>';
        });
    }, wait);
  }

  function useMyLocation() {
    var btn = $("loc-btn");
    if (!navigator.geolocation) { alertMsg("Your browser does not share its location."); return; }
    btn.disabled = true; btn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false; btn.textContent = "Use my location";
      var acc = Math.round(pos.coords.accuracy || 0);
      select({ type: "place", label: "Your location", lat: pos.coords.latitude, lon: pos.coords.longitude,
               sub: acc ? "Accurate to about " + (acc > 1000 ? Math.round(acc / 1000) + " km" : acc + " m") : null, source: "device" });
    }, function () {
      btn.disabled = false; btn.textContent = "Use my location";
      alertMsg("Location was not shared. Search for your town or school instead.");
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }

  function alertMsg(text) { $("results").innerHTML = '<div class="msg">' + esc(text) + "</div>"; }

  // ------------------------------------------------------------ about

  function renderAbout() {
    var r = S.rule, d = S.data;
    if (!r) { $("about-body").innerHTML = ""; return; }
    var html = "<h3>Where the readings come from</h3>" +
      "<p>Every hour, an automated job reads the Department of Environment's Air Pollutant Index Management System (APIMS), using the same public data the official portal at " +
      '<a href="https://eqms.doe.gov.my/APIMS/main" rel="noopener">eqms.doe.gov.my/APIMS</a> displays: each station\'s latest reading and the last 24 hourly readings per state. ' +
      "The job then republishes this page. The page also re-reads the data every 10 minutes while it is open. " +
      "No reading on this page is estimated or filled in; a station without a recent reading is shown as having no current reading.</p>" +
      "<p>The IPU (API) is DOE's 24-hour running average of the dominant pollutant, so it changes slowly and lags sudden changes in haze.</p>" +
      "<h3>How a location is matched to a station</h3>" +
      "<p>For a school, town or place, the dashboard uses the nearest DOE monitoring station that has a current reading (straight-line distance). " +
      "It shows the distance and the next nearest stations, and notes when stations close by disagree. " +
      "The station's reading is never presented as a measurement taken at the school or place itself.</p>" +
      "<h3>The school-closure rule used</h3>" +
      "<p><b>" + esc(r.name) + "</b>, in force from " + esc(L.fmtDayKey(r.effective_from)) + ".</p><ul>" +
      "<li>" + esc(r.closure.summary) + " " + esc(r.closure.note) + "</li>" +
      "<li>" + esc(r.outdoor.summary) + "</li></ul>" +
      "<p>How the dashboard applies it:</p><ul>" + r.how_applied.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" +
      "<p>" + esc(r.who_decides) + "</p>" +
      "<p>Earlier rule: " + r.previous_rules.map(function (p) { return esc(L.fmtDayKey(p.from)) + " to " + esc(L.fmtDayKey(p.to)) + ": " + esc(p.summary); }).join(" ") + "</p>" +
      "<p>Sources for the rule:</p><ul>" + r.sources.map(function (s) {
        return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.title) + "</a> (" + esc(s.date) + ")</li>";
      }).join("") + "</ul>" +
      "<h3>Limitations</h3><ul>" +
      "<li>Malaysia has about 68 DOE stations. Many schools are far from one, and a single station cannot show local differences.</li>" +
      "<li>The dashboard cannot see official announcements. A school may be closed (or open) for reasons this rule does not capture, such as a state directive or a district decision based on other stations.</li>" +
      "<li>Weekends and the year-end school holidays are included; public holidays and state-specific holidays are not.</li>" +
      "<li>The APIMS data endpoints are not a documented public API. If DOE changes them, updates will stop and this page will mark its readings as outdated.</li>" +
      "<li>Updates run on GitHub Actions at minute " + UPDATE_MINUTE + " of every hour. GitHub sometimes starts scheduled runs several minutes late.</li>" +
      "<li>Historical statistics from DOSM are national monthly averages of pollutant concentrations (not IPU, not per station) and end at the latest month DOSM has published.</li>" +
      "<li>" + (S.schoolsMeta && S.schoolsMeta.available ?
        "School locations come from the official KPM list (" + esc(S.schoolsMeta.count) + " schools with coordinates" +
          (S.schoolsMeta.skipped_no_coordinates ? "; " + esc(S.schoolsMeta.skipped_no_coordinates) + " schools without coordinates are not searchable" : "") + ")." :
        "The official KPM school list has not been added yet. Until it is, schools and towns are located with OpenStreetMap, which is community-made and may be incomplete or wrong.") + "</li>" +
      "</ul>";
    if (d && d.source) {
      html += '<p class="small muted">Data endpoints: ' + esc(d.source.current_endpoint) + " and " + esc(d.source.hourly_endpoint) + ".</p>";
    }
    $("about-body").innerHTML = html;
  }

  // ------------------------------------------------------------ wiring

  function renderAll() {
    renderStatus();
    populateStateFilter();
    renderSummary();
    renderTable();
    renderSelection();
    renderAbout();
  }

  function refresh() {
    getJSON("data/latest.json").then(function (d) {
      var changed = !S.data || d.last_attempt !== S.data.last_attempt;
      S.data = d;
      if (changed) renderAll(); else renderStatus();
    }).catch(function () { renderStatus(); });
  }

  function bind() {
    var t = null;
    $("q").addEventListener("input", function () { clearTimeout(t); t = setTimeout(onSearchInput, 120); });
    $("q").addEventListener("focus", function () { loadSchools(); });
    $("q").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); placeSearch(); }
      if (ev.key === "ArrowDown") { var b = $("results").querySelector("button"); if (b) { ev.preventDefault(); b.focus(); } }
      if (ev.key === "Escape") $("results").innerHTML = "";
    });
    $("results").addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (!b) return;
      if (b.dataset.place) { placeSearch(); return; }
      var items = $("results")._items || [];
      var r = items[Number(b.dataset.i)];
      if (r) chooseResult(r);
    });
    $("results").addEventListener("keydown", function (ev) {
      var list = Array.prototype.slice.call($("results").querySelectorAll("button"));
      var i = list.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" && i < list.length - 1) { ev.preventDefault(); list[i + 1].focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); if (i > 0) list[i - 1].focus(); else $("q").focus(); }
    });
    $("places-btn").addEventListener("click", placeSearch);
    $("loc-btn").addEventListener("click", useMyLocation);
    $("sel-close").addEventListener("click", function () { S.sel = null; setHash(null); renderSelection(); });
    ["f-state", "f-sort"].forEach(function (id) { $(id).addEventListener("change", renderTable); });
    $("f-text").addEventListener("input", renderTable);
    document.addEventListener("click", function (ev) {
      var el = ev.target.closest("[data-station]");
      if (el && !ev.target.closest("#results")) select({ type: "station", id: el.dataset.station });
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      var el = ev.target.closest && ev.target.closest("tr[data-station]");
      if (el) select({ type: "station", id: el.dataset.station });
    });
    var rt = null;
    window.addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(function () { renderSummary(); renderSelection(); renderDosm(); }, 200);
    });
    window.addEventListener("hashchange", function () {
      var h = readHash();
      if (h) select(h, { keepHash: true });
    });
  }

  function init() {
    bind();
    Promise.all([
      getJSON("data/latest.json").catch(function () { return null; }),
      getJSON("data/rule.json").catch(function () { return null; })
    ]).then(function (res) {
      S.data = res[0]; S.rule = res[1];
      S.sel = readHash();
      renderAll();
      if (S.sel) $("selection").scrollIntoView({ block: "start" });
      getJSON("data/dosm_monthly.json").then(function (d) { S.dosm = d; }).catch(function () { S.dosm = null; })
        .then(renderDosm);
      loadSchools();
    });
    setInterval(refresh, REFRESH_MS);
    setInterval(renderStatus, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  }

  init();
})();
