/* IPU Malaysia – page behaviour: map, search, selection, prediction, charts.
   All rules (categories, matching, prediction) live in logic.js (window.IPU). */
(function () {
  "use strict";
  var L = window.IPU;
  var I18 = window.I18N || { lang: "en", t: function (s) { return s; }, set: function () {} };
  function i18(s) { return I18.t(s); }      // every English text on the page goes through this
  /* A text field from a data file in the page language: obj[key + "_ms"] in Bahasa Melayu when present. */
  function loc(obj, key) {
    if (!obj) return "";
    var ms = I18.lang === "ms" ? obj[key + "_ms"] : null;
    return ms !== null && ms !== undefined && ms !== "" ? ms : obj[key];
  }
  L.setLang(I18.lang, i18);
  var UPDATE_MINUTE = 20;                 // the GitHub workflow runs at minute 20 of every hour
  var REFRESH_MS = 10 * 60 * 1000;        // re-read data/latest.json every 10 minutes
  var NOMINATIM = "https://nominatim.openstreetmap.org/search";
  var THEMES = {
    light: {
      style: "https://tiles.openfreemap.org/styles/positron",
      cats: { good: "#1f6fd1", moderate: "#1e9e4a", unhealthy: "#f2c200", very: "#f07f13", hazardous: "#d62728" },
      inks: { good: "#ffffff", moderate: "#ffffff", unhealthy: "#1a1a1a", very: "#1a1a1a", hazardous: "#ffffff" },
      off: "#c9d3d6", offInk: "#64767d", haze: 0.2, link: "#172a35",
      grid: "#e9efee", axis: "#64767d", ink: "#172a35", halo: "#ffffff", outdoor: "#8d9da2", closure: "#c4442f",
      series: "#2a78d6", seriesB: "#eb6834", area: 0.08,
      fallback: { sea: "#dfe8ec", land: "#f6f8f8", coast: "#a9b8bd" }, meta: "#ffffff",
      forecast: "#b5179e", fireCore: "#d9480f", fireGlow: "#ff922b", wind: "rgba(23, 42, 53, 0.55)",
      trace: "#0b7285", traceCase: "#ffffff", fireHit: "#9c1d00", zoneLine: "#172a35", closedLine: "#b42318"
    },
    neon: {
      style: "https://tiles.openfreemap.org/styles/dark",
      cats: { good: "#4a9dff", moderate: "#19e3b1", unhealthy: "#ffd23f", very: "#ff7f2a", hazardous: "#ff3d81" },
      inks: { good: "#041019", moderate: "#041019", unhealthy: "#041019", very: "#041019", hazardous: "#041019" },
      off: "#33406a", offInk: "#8394ba", haze: 0.34, link: "#47f3ff",
      grid: "#162043", axis: "#8394ba", ink: "#eaf3ff", halo: "#070b18", outdoor: "#5b6fa8", closure: "#ff3d81",
      series: "#47f3ff", seriesB: "#ff5ce1", area: 0.14,
      fallback: { sea: "#04060d", land: "#0f1730", coast: "#2b3d70" }, meta: "#070b18",
      forecast: "#c084fc", fireCore: "#ffd08a", fireGlow: "#ff3d81", wind: "rgba(71, 243, 255, 0.8)",
      trace: "#f4f7ff", traceCase: "#47f3ff", fireHit: "#ffffff", zoneLine: "#47f3ff", closedLine: "#ff3d81"
    }
  };
  var THEME_KEY = "ipu-theme";
  var MY_BOUNDS = [[99.6, 0.85], [119.3, 7.4]];
  var REGION_BOUNDS = [[94.5, -6], [120.5, 8.5]];     // Sumatra and Borneo around Malaysia
  var FIRE_MAX_AGE_MIN = 36 * 60;
  var REDUCE = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  var S = { data: null, rule: null, windFc: null, windFcLoading: null, smoke: null, smokeHere: null, daily: null, borders: null, splits: [], bordersAll: false, simRes: null, dosm: null, forecast: null, sources: null, ann: null, bounds: null, rr: null, unusual: {}, windHist: null, windHistLoading: null, trace: null, schools: null, schoolsMeta: null, schoolsLoading: null,
            sel: null, lastPlaceQuery: 0, firstPaint: true };
  var M = { map: null, styleReady: false, introDone: false, markers: {}, pin: null, km: null,
            fallbackUsed: false, tileOk: false, tileErr: 0, pending: null, link: null, refId: null, homeZoom: 5, sourcesOn: false,
            dayMarkers: [], zones: null, closedLabels: [], pair: null };
  var W = { canvas: null, ctx: null, parts: [], raf: 0, running: false, dpr: 1 };

  function $(id) { return document.getElementById(id); }
  function themeName() { return document.documentElement.getAttribute("data-theme") === "neon" ? "neon" : "light"; }
  function T() { return THEMES[themeName()]; }
  /* Category for a reading, with this theme's colours. */
  function cat(api) {
    var c = L.categoryFor(api);
    if (!c) return null;
    return { key: c.key, label: c.label, min: c.min, max: c.max, color: T().cats[c.key], ink: T().inks[c.key] };
  }
  function swatch(color) { return "background:" + color + ";--c:" + color; }
  function now() { return new Date(); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function isMobile() { return window.matchMedia && matchMedia("(max-width: 979px)").matches; }
  function stations() { return (S.data && S.data.stations) || []; }
  function stationById(id) { return stations().filter(function (s) { return s.id === id; })[0] || null; }
  function getJSON(path) {
    return fetch(path + (path.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(path + ": HTTP " + r.status); return r.json(); });
  }
  function badge(api) {
    var c = cat(api);
    if (!c) return i18('<span class="cat none">No current reading</span>');
    return '<span class="cat"><i style="' + swatch(c.color) + '"></i>' + esc(c.label) + "</span>";
  }
  function readingTime(iso, n) {
    var t = L.parseTime(iso);
    if (!t) return "—";
    return L.mytDateKey(t) === L.mytDateKey(n) ? L.fmtTime(t) : L.fmtDateTime(t);
  }
  function nextUpdate(n) {
    var d = new Date(n.getTime());
    d.setUTCMinutes(UPDATE_MINUTE, 0, 0);
    if (d <= n) d = new Date(d.getTime() + 3600000);
    return d;
  }
  function countUp(el, to) {
    if (REDUCE || !S.firstPaint || typeof to !== "number") { el.textContent = to; return; }
    var t0 = null, dur = 1100;
    function step(t) {
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(to * e);
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function growTo(el, pct) {
    if (REDUCE || !S.firstPaint) { el.style.width = pct + "%"; return; }
    el.style.width = "0%";
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.style.width = pct + "%"; }); });
  }

  // ================================================================ status

  function renderStatus() {
    var n = now(), box = $("status");
    box.className = "status";
    if (!S.data) {
      box.innerHTML = i18('<span class="live-dot"></span><div class="banner bad">The readings file could not be loaded. If the site was just set up, wait for the first hourly update, then reload.</div>');
      return;
    }
    var f = L.freshness(S.data, n);
    var fresh = stations().length && !f.stale;
    box.classList.add(fresh ? "is-live" : "is-stale");
    var html = '<span class="live-dot" aria-hidden="true"></span><span class="status-lines">' +
      i18("<span>Readings for <b>") + esc(f.observation ? L.fmtDateTime(f.observation) : "—") + "</b></span>" +
      i18("<span>Updated ") + esc(L.ago(f.lastSuccess, n)) + i18(", next around ") + esc(L.fmtTime(nextUpdate(n))) + "</span></span>";
    if (!stations().length) {
      html += i18('<div class="banner">No readings have been retrieved yet. The first hourly update has not run or has not succeeded, so nothing here is a current reading.</div>');
    } else if (f.stale) {
      html += i18('<div class="banner bad"><b>Data may be outdated.</b> ') + esc(f.reasons.join(" ")) +
        i18(" The page shows the last successful update and marks old readings as outdated.</div>");
    } else if (f.partial) {
      html += i18('<div class="banner">Part of the last update failed. Affected stations keep their previous reading and show its time.</div>');
    }
    if (S.ann) {
      L.activeClosures(S.ann, n).forEach(function (c) {
        var a = c.area || {}, st = (a.states && a.states[0]) || a.state || "";
        var started = c.from <= L.mytDateKey(n);
        html += '<button type="button" class="closure-banner" data-state="' + esc(st) + i18('"><span class="off-chip">Official</span>') +
          i18("Schools in ") + esc(L.areaLabel(c)) + (started ? i18(" closed ") + esc(untilText(c)) : i18(" close ") + (c.until_further_notice ? i18("from ") + esc(dayShort(c.from)) + i18(" until further notice") : esc(rangeText(c.from, c.to)))) + "</button>";
      });
    }
    box.innerHTML = html;
  }

  // ================================================================ map

  function fallbackStyle() {
    return {
      version: 8,
      sources: { mys: { type: "geojson", data: "data/malaysia-outline.json" } },
      layers: [
        { id: "sea", type: "background", paint: { "background-color": T().fallback.sea } },
        { id: "land", type: "fill", source: "mys", paint: { "fill-color": T().fallback.land } },
        { id: "coast", type: "line", source: "mys", paint: { "line-color": T().fallback.coast, "line-width": 1 } }
      ]
    };
  }

  function mapUnavailable(msg) {
    var fb = $("map-fallback");
    fb.hidden = false;
    fb.textContent = msg;
    $("map-legend").hidden = true;
  }

  function pad(forSelection) {
    if (isMobile()) return forSelection ? { top: 64, bottom: 72, left: 92, right: 92 } : { top: 30, bottom: 60, left: 14, right: 14 };
    return forSelection ? { top: 100, bottom: 100, left: 110, right: 110 } : { top: 60, bottom: 60, left: 60, right: 60 };
  }

  function initMap() {
    renderLegend();
    if (!window.maplibregl) { mapUnavailable(i18("The map could not be loaded. Search and the station list below still work.")); return; }
    try {
      M.map = new maplibregl.Map({
        container: "map", style: T().style,
        center: REDUCE ? [109.4, 4.1] : [106, 9], zoom: REDUCE ? 4.6 : 2.3,
        attributionControl: { compact: true }, cooperativeGestures: isMobile(),
        dragRotate: false, pitchWithRotate: false, touchPitch: false, minZoom: 2, maxZoom: 16.5
      });
    } catch (e) {
      mapUnavailable(i18("This device cannot show the map (WebGL is turned off). Search and the station list below still work."));
      return;
    }
    var map = M.map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("error", function (e) {
      if (e && (e.tile || e.sourceId)) M.tileErr += 1;
      if (!M.fallbackUsed && (!M.styleReady || (M.tileErr >= 6 && !M.tileOk))) useFallback();
    });
    map.on("sourcedata", function (e) { if (e.tile && e.sourceId !== "stations" && e.sourceId !== "link") M.tileOk = true; });
    map.on("style.load", onStyleLoad);
    map.on("zoom", zoomClass);
    map.on("move", function () { if (W.ctx) W.ctx.clearRect(0, 0, W.canvas.width, W.canvas.height); });
    map.on("moveend", function () { if (M.sourcesOn && REDUCE) drawStaticWind(); });
    map.on("resize", sizeWindCanvas);
    W.canvas = document.createElement("canvas");
    W.canvas.className = "wind-canvas";
    W.canvas.setAttribute("aria-hidden", "true");
    map.getCanvasContainer().appendChild(W.canvas);
    W.ctx = W.canvas.getContext("2d");
    sizeWindCanvas();
    map.on("moveend", function () { $("map-home").hidden = !(map.getZoom() > M.homeZoom + 0.8); });
    setTimeout(function () { if (!M.styleReady && !M.fallbackUsed) useFallback(); }, 9000);
    zoomClass();
  }

  function useFallback() {
    M.fallbackUsed = true;
    M.styleReady = false;
    try { M.map.setStyle(fallbackStyle()); } catch (e) { mapUnavailable(i18("The map could not be loaded.")); }
  }

  function zoomClass() {
    if (M.map) $("map").classList.toggle("zoom-low", M.map.getZoom() < 6.8);
  }

  function stationsGeo() {
    var n = now();
    return {
      type: "FeatureCollection",
      features: stations().filter(function (s) { return typeof s.lat === "number" && typeof s.lon === "number"; }).map(function (s) {
        var cur = L.stationCurrent(s, n), c = cat(cur ? s.api : null);
        return { type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] },
                 properties: { id: s.id, api: cur ? s.api : 0, current: cur, color: c ? c.color : T().off } };
      })
    };
  }

  function onStyleLoad() {
    M.styleReady = true;
    var map = M.map;
    // "Haze glow" under each station: its size grows with the reading. It is a visual cue, not a measured area.
    if (!map.getSource("stations")) map.addSource("stations", { type: "geojson", data: stationsGeo() });
    if (!map.getLayer("haze")) {
      map.addLayer({ id: "haze", type: "circle", source: "stations", paint: {
        "circle-color": ["get", "color"],
        "circle-opacity": ["case", ["get", "current"], T().haze, 0],
        "circle-blur": 1,
        "circle-radius": ["interpolate", ["exponential", 2], ["zoom"],
          4, ["+", 8, ["/", ["get", "api"], 12]],
          7, ["+", 18, ["/", ["get", "api"], 3]],
          10, ["+", 60, ["/", ["get", "api"], 1.1]],
          14, ["+", 500, ["*", ["get", "api"], 6]]]
      } });
    }
    if (!map.getSource("link")) map.addSource("link", { type: "geojson", data: M.link || { type: "FeatureCollection", features: [] } });
    if (!map.getLayer("link")) {
      map.addLayer({ id: "link", type: "line", source: "link", layout: { "line-cap": "round" },
        paint: { "line-color": T().link, "line-width": 2.2, "line-dasharray": [1.2, 1.6], "line-opacity": 0.85 } });
    }
    if (!map.getSource("fires")) map.addSource("fires", { type: "geojson", data: firesGeo() });
    var vis = M.sourcesOn ? "visible" : "none";
    if (!map.getLayer("fires-glow")) {
      map.addLayer({ id: "fires-glow", type: "circle", source: "fires", layout: { visibility: vis }, paint: {
        "circle-color": T().fireGlow, "circle-blur": 1, "circle-opacity": 0.55,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4, 6, 8, 10, 14] } });
    }
    if (!map.getLayer("fires")) {
      map.addLayer({ id: "fires", type: "circle", source: "fires", layout: { visibility: vis }, paint: {
        "circle-color": T().fireCore, "circle-opacity": 0.95,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.6, 6, 2.6, 10, 4.5] } });
    }
    var empty = { type: "FeatureCollection", features: [] };
    if (map.hasImage("hatch")) map.removeImage("hatch");
    map.addImage("hatch", hatchImage(), { pixelRatio: 2 });
    if (!map.getSource("closed")) map.addSource("closed", { type: "geojson", data: empty });
    if (!map.getLayer("closed-fill")) map.addLayer({ id: "closed-fill", type: "fill", source: "closed", paint: { "fill-pattern": "hatch" } }, "haze");
    if (!map.getLayer("closed-line")) {
      map.addLayer({ id: "closed-line", type: "line", source: "closed",
        paint: { "line-color": T().closedLine, "line-width": 1.2, "line-opacity": 0.7 } }, "haze");
    }
    if (!map.getSource("zones")) map.addSource("zones", { type: "geojson", data: M.zones || empty });
    if (!map.getLayer("zones-fill")) {
      map.addLayer({ id: "zones-fill", type: "fill", source: "zones", filter: ["==", ["get", "mine"], true],
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.16 } }, "haze");
    }
    if (!map.getLayer("zones-line")) {
      map.addLayer({ id: "zones-line", type: "line", source: "zones",
        paint: { "line-color": T().zoneLine, "line-width": ["case", ["get", "mine"], 2.4, 1], "line-opacity": ["case", ["get", "mine"], 0.9, 0.35],
                 "line-dasharray": [2, 2] } }, "haze");
    }
    if (!map.getSource("pair")) map.addSource("pair", { type: "geojson", data: M.pair || empty });
    if (!map.getLayer("pair-fill")) {
      map.addLayer({ id: "pair-fill", type: "fill", source: "pair",
        paint: { "fill-color": ["match", ["get", "side"], "shut", T().closedLine, T().zoneLine], "fill-opacity": 0.1 } }, "haze");
    }
    if (!map.getLayer("pair-line")) {
      map.addLayer({ id: "pair-line", type: "line", source: "pair",
        paint: { "line-color": ["match", ["get", "side"], "shut", T().closedLine, T().zoneLine], "line-width": 2.6, "line-opacity": 0.95 } }, "haze");
    }
    if (!map.getSource("trace")) map.addSource("trace", { type: "geojson", data: traceGeo() });
    if (!map.getLayer("trace-case")) {
      map.addLayer({ id: "trace-case", type: "line", source: "trace", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": T().traceCase, "line-width": 7, "line-opacity": themeName() === "neon" ? 0.35 : 0.9, "line-blur": themeName() === "neon" ? 4 : 0 } });
    }
    if (!map.getLayer("trace")) {
      map.addLayer({ id: "trace", type: "line", source: "trace", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": T().trace, "line-width": 3 } });
    }
    if (!map.getSource("smoke")) map.addSource("smoke", { type: "geojson", data: smokeGeo() });
    if (!map.getLayer("smoke")) {
      map.addLayer({ id: "smoke", type: "line", source: "smoke", filter: ["==", ["get", "end"], 0], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": T().forecast, "line-width": 2, "line-opacity": 0.85, "line-dasharray": [1.4, 1.8] } }, "trace-case");
    }
    if (!map.getLayer("smoke-end")) {
      map.addLayer({ id: "smoke-end", type: "circle", source: "smoke", filter: ["==", ["get", "end"], 1],
        paint: { "circle-color": T().forecast, "circle-radius": 3.2, "circle-stroke-color": T().halo, "circle-stroke-width": 1 } }, "trace-case");
    }
    if (!map.getSource("fire-hits")) map.addSource("fire-hits", { type: "geojson", data: fireHitsGeo() });
    if (!map.getLayer("fire-hits")) {
      map.addLayer({ id: "fire-hits", type: "circle", source: "fire-hits", paint: {
        "circle-color": T().fireCore, "circle-stroke-color": T().fireHit, "circle-stroke-width": 1.2,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.6, 6, 4, 10, 6] } });
    }
    var cam = map.cameraForBounds(MY_BOUNDS, { padding: pad() });
    if (cam) M.homeZoom = cam.zoom;
    updateClosedAreas();
    renderMarkers();
    if (!M.introDone) intro();
    else if (M.pending) { var p = M.pending; M.pending = null; flyTo(p); }
  }

  function intro() {
    M.introDone = true;
    var map = M.map, cam = map.cameraForBounds(MY_BOUNDS, { padding: pad() });
    var then = function () {
      if (M.pending) { var p = M.pending; M.pending = null; flyTo(p); }
    };
    if (!cam) { then(); return; }
    if (REDUCE) { map.jumpTo(cam); then(); return; }
    $("map").classList.add("intro");
    map.flyTo({ center: cam.center, zoom: cam.zoom, duration: 2600, curve: 1.25, essential: true });
    map.once("moveend", function () { setTimeout(then, M.pending ? 350 : 0); });
    setTimeout(function () { $("map").classList.remove("intro"); }, 4500);
  }

  function renderMarkers() {
    if (!M.map) return;
    var n = now(), seen = {};
    stations().forEach(function (s) {
      if (typeof s.lat !== "number" || typeof s.lon !== "number") return;
      seen[s.id] = true;
      var cur = L.stationCurrent(s, n), c = cat(cur ? s.api : null);
      var m = M.markers[s.id];
      if (!m) {
        var wrap = document.createElement("div");
        wrap.className = "stn-wrap";
        var b = document.createElement("button");
        b.type = "button"; b.className = "stn"; b.tabIndex = -1;
        b.innerHTML = '<span class="n"></span>';
        b.addEventListener("click", function (ev) { ev.stopPropagation(); hideTip(); select({ type: "station", id: s.id }); });
        b.addEventListener("mouseenter", function (ev) {
          var st = M.markers[s.id].station, cc = L.stationCurrent(st, now());
          showTip("<b>" + esc(st.name) + "</b>, " + esc(st.state) + "<br>" +
            (cc ? i18("IPU ") + st.api + " (" + esc(cat(st.api).label) + i18(") at ") + esc(readingTime(st.observed, now())) : i18("No current reading")), ev.clientX, ev.clientY);
        });
        b.addEventListener("mouseleave", hideTip);
        wrap.appendChild(b);
        m = M.markers[s.id] = { marker: new maplibregl.Marker({ element: wrap, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(M.map), btn: b };
      }
      m.station = s;
      m.btn.classList.toggle("off", !cur);
      m.btn.classList.toggle("unusual", !!S.unusual[s.id]);
      m.btn.style.setProperty("--c", c ? c.color : "var(--paper)");
      m.btn.style.setProperty("--ci", c ? c.ink : T().offInk);
      m.btn.style.setProperty("--d", Math.round(700 + (s.lon - 99.6) / 19.7 * 1300) + "ms");
      m.btn.querySelector(".n").textContent = cur ? s.api : "–";
      m.btn.setAttribute("aria-label", s.name + ", " + s.state + ": " + (cur ? i18("IPU ") + s.api + ", " + c.label : i18("no current reading")));
    });
    Object.keys(M.markers).forEach(function (id) {
      if (!seen[id]) { M.markers[id].marker.remove(); delete M.markers[id]; }
    });
    if (M.styleReady && M.map.getSource("stations")) M.map.getSource("stations").setData(stationsGeo());
    markRef(M.refId);
    markSim();
  }

  function markRef(id) {
    M.refId = id || null;
    Object.keys(M.markers).forEach(function (k) {
      var on = k === M.refId;
      M.markers[k].btn.classList.toggle("is-ref", on);
      M.markers[k].marker.getElement().style.zIndex = on ? 4 : "";
    });
  }

  /* Put the location pin, the dashed line to the reference station and the distance label on the map. */
  function showPlace(point, label, ref) {
    if (!M.map) return;
    if (M.pin) { M.pin.remove(); M.pin = null; }
    if (M.km) { M.km.remove(); M.km = null; }
    M.link = { type: "FeatureCollection", features: [] };
    if (point) {
      var w = document.createElement("div");
      w.className = "pin-wrap";
      w.innerHTML = '<div class="pin"></div><div class="pin-label"></div>';
      w.querySelector(".pin-label").textContent = label || i18("Selected location");
      M.pin = new maplibregl.Marker({ element: w, anchor: "center" }).setLngLat(point).addTo(M.map);
      if (ref && ref.km >= 0.5) {
        var rp = [ref.station.lon, ref.station.lat];
        M.link.features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [point, rp] }, properties: {} });
        var k = document.createElement("div");
        k.className = "km-wrap";
        k.innerHTML = '<div class="km"></div>';
        k.querySelector(".km").textContent = Math.round(ref.km) + i18(" km");
        M.km = new maplibregl.Marker({ element: k, anchor: "center" })
          .setLngLat([(point[0] + rp[0]) / 2, (point[1] + rp[1]) / 2]).addTo(M.map);
      }
    }
    if (M.styleReady && M.map.getSource("link")) M.map.getSource("link").setData(M.link);
  }

  /* Fly the camera. target: {center, zoom} or {bounds, maxZoom}. */
  function flyTo(target) {
    if (!M.map) return;
    if (!M.styleReady || !M.introDone) { M.pending = target; return; }
    var cam = target.bounds
      ? M.map.cameraForBounds(target.bounds, { padding: target.padding || pad(true), maxZoom: target.maxZoom || 12 })
      : { center: target.center, zoom: target.zoom };
    if (!cam) return;
    if (REDUCE) M.map.jumpTo({ center: cam.center, zoom: cam.zoom });
    else M.map.flyTo({ center: cam.center, zoom: cam.zoom, speed: 0.75, curve: 1.55, essential: true });
  }

  function boundsOf(points) {
    var w = 180, s = 90, e = -180, n = -90;
    points.forEach(function (p) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); });
    return [[w, s], [e, n]];
  }

  function flyHome() {
    if (!M.map) return;
    var cam = M.map.cameraForBounds(MY_BOUNDS, { padding: pad() });
    if (!cam) return;
    if (REDUCE) M.map.jumpTo(cam); else M.map.flyTo({ center: cam.center, zoom: cam.zoom, speed: 0.9, curve: 1.4, essential: true });
  }

  function renderLegend() {
    var html = L.categories().map(function (c) {
      return '<span><i style="' + swatch(T().cats[c.key]) + '"></i>' + esc(c.label) + "</span>";
    }).join("");
    if (M.sourcesOn) {
      html += '<span><i style="' + swatch(T().fireCore) + i18('"></i>Fire hotspot, last 24 h</span>') +
              (M.traceShown ? '<span><i class="wind-key" style="background:' + T().trace + i18(';height:3px"></i>Air path to the selected place (model)</span>')
                            : '<span><i class="wind-key" style="background:' + T().wind + i18('"></i>Surface wind (model)</span>'));
    }
    if (M.sourcesOn && M.smokeShown) html += '<span><i class="wind-key" style="height:0;background:none;border-top:3px dashed ' + T().forecast + i18('"></i>Smoke paths, next 48 h (forecast estimate)</span>');
    if (SIM.onMap) html += i18('<span><i class="sim-key"></i>Meets the simulated rule today</span>');
    if (M.pair) html += '<span><i class="wind-key" style="background:' + T().closedLine + ';height:3px"></i>' + (M.pairType === "official" ? i18("Officially closed side") : i18("Side where the closure level was reached")) + '</span>' +
      '<span><i class="wind-key" style="background:' + T().zoneLine + i18(';height:3px"></i>Other side</span>');
    $("map-legend").innerHTML = html;
  }

  // ================================================================ unusual readings

  function unusualNote(st) {
    var u = st && S.unusual[st.id];
    if (!u) return "";
    var dir = u.diff < 0 ? i18("below") : i18("above");
    return i18('<p class="note unusual-note"><b>Unusual reading.</b> ') + esc(st.name) + i18(" reads ") + esc(st.api) + ", " + Math.abs(u.diff) + " " + dir +
      i18(" the middle value (") + u.median + i18(") of the ") + u.count + i18(" other stations within ") + u.km + i18(" km. This may be a local effect or a temporary instrument issue. ") +
      i18("The reading is shown exactly as DOE published it.</p>");
  }

  // ================================================================ air right now (official 1-hour PM2.5)

  function nowAirHTML(st) {
    var pt = L.pm25Time(st, now());
    if (!pt || typeof st.pm25_1h !== "number") return "";
    var a = st.pm25_1h, d = st.pm25_24h, ratio = d > 0 ? a / d : 1, word, cls;
    var lag = pm25Lag(st, pt);
    var rn = lag ? "" : i18(" right now");
    if (ratio >= 1.25) { word = i18("worse") + rn + i18(" than the IPU suggests"); cls = "worse"; }
    else if (ratio <= 0.75) { word = i18("better") + rn + i18(" than the IPU suggests"); cls = "better"; }
    else { word = i18("about the same as the IPU suggests"); cls = "same"; }
    var max = Math.max(a, d, 1);
    return '<div class="nowair ' + cls + i18('"><div class="fc-head"><h3>Air right now</h3><span class="fc-tag nowair-tag">Official DOE measurement</span></div>') +
      '<div class="nowair-grid"><div><span class="na-v">' + Math.round(a) + i18('</span><span class="na-u">µg/m³</span><span class="na-k">PM2.5 ') + (lag ? i18("at ") + esc(L.fmtTime(pt)) : i18("this hour")) + '</span>' +
      '<span class="na-bar"><i style="width:' + (a / max * 100).toFixed(1) + '%"></i></span></div>' +
      '<div><span class="na-v">' + Math.round(d) + i18('</span><span class="na-u">µg/m³</span><span class="na-k">PM2.5 24-hour average (what the IPU uses)</span>') +
      '<span class="na-bar avg"><i style="width:' + (d / max * 100).toFixed(1) + '%"></i></span></div></div>' +
      '<p class="nowair-lead">' + (lag ? i18("At ") + esc(L.fmtTime(pt)) + i18(", the air at ") : i18("The air at ")) + esc(st.name) + (lag ? i18(" was <b>") : i18(" is <b>")) + word + "</b>. " +
      (cls === "worse" ? i18("The IPU is a 24-hour average, so it will usually keep rising for a while if the air stays like this.")
        : cls === "better" ? i18("The IPU is a 24-hour average, so it will usually fall over the next hours if the air stays like this.")
        : lag ? i18("The air that hour was close to its 24-hour average.") : i18("The air this hour is close to its 24-hour average.")) + "</p>" +
      (lag ? i18('<p class="fc-note">DOE has published the IPU for ') + esc(L.fmtTime(L.parseTime(st.observed))) + i18(" but its PM2.5 values only up to ") + esc(L.fmtTime(pt)) + i18(", so these show ") + esc(L.fmtTime(pt)) + ".</p>" : "") + "</div>";
  }

  /* True when the PM2.5 values are from an earlier hour than the IPU shown. */
  function pm25Lag(st, pt) {
    var o = L.parseTime(st.observed);
    return !!(o && pt && o.getTime() - pt.getTime() >= 30 * 60000);
  }

  // ================================================================ school-day dose (estimate)

  function roundTo(v, step) { return Math.round(v / step) * step; }

  function doseHTML(st) {
    var pt = L.pm25Time(st, now());
    if (!pt) return "";
    var d = L.schoolDayDose(st.pm25_24h), k = cat(st.api), p = d.primary, sc = d.secondary;
    var times = d.ratio >= 1.15 ? i18("about <b>") + (d.ratio >= 10 ? Math.round(d.ratio) : Math.round(d.ratio * 10) / 10) + i18(" times</b> as much as on a day at the WHO guideline level")
              : d.ratio >= 0.85 ? i18("about the same as on a day at the WHO guideline level") : i18("less than on a day at the WHO guideline level");
    var max = Math.max(sc.dose, sc.whoDose);
    var bar = function (label, v, color, cls) {
      return '<div class="dose-row ' + cls + '"><span class="dose-lbl">' + label + '</span><span class="dose-track"><span class="dose-fill" style="width:' +
        Math.max(1.5, v / max * 100).toFixed(1) + "%;background:" + color + ";--c:" + color + '"></span></span><span class="dose-val">' + roundTo(v, 10) + " µg</span></div>";
    };
    return i18('<div class="dose"><div class="fc-head"><h3>School-day dose</h3><span class="fc-tag dose-tag">Estimate</span></div>') +
      i18('<p class="dose-lead">At ') + esc(st.name) + i18("'s fine-particle level today (PM2.5 24-hour average <b>") + st.pm25_24h + i18(" µg/m³</b>, official DOE measurement") + (pm25Lag(st, pt) ? i18(" for ") + esc(L.fmtTime(pt)) : "") + "), " +
      i18("a primary pupil breathes in about <b>") + roundTo(p.dose, 10) + i18(" µg</b> of fine particles in a ") + p.hours + i18("-hour school day, and a secondary student about <b>") +
      roundTo(sc.dose, 10) + i18(" µg</b> in ") + sc.hours + i18(" hours. That is ") + times + " (" + d.who + " µg/m³).</p>" +
      '<div class="dose-bars" role="img" aria-label="Secondary student: ' + roundTo(sc.dose, 10) + i18(' micrograms today, ') + roundTo(sc.whoDose, 10) + ' at the WHO guideline level">' +
      bar(i18("Today (secondary)"), sc.dose, k.color, "today") + bar(i18("WHO guideline day"), sc.whoDose, "var(--muted)", "who") + "</div>" +
      i18('<p class="fc-note">Estimate. It assumes classroom air is like the air outside, which is usual with open windows and fans, and typical breathing rates for children sitting and moving lightly ') +
      i18('(<a href="https://www.epa.gov/expobox/exposure-factors-handbook-chapter-6" rel="noopener">US EPA Exposure Factors Handbook</a>, chapter 6). Rooms with air filters would be lower. Not medical advice.</p></div>');
  }

  // ================================================================ rising fastest & unusual list (overview)

  function sparkline(series, color) {
    if (!series || series.length < 2) return "";
    var w = 72, h = 22, ys = series.map(function (p) { return p[1]; });
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), span = Math.max(10, hi - lo);
    var pts = series.map(function (p, i) { return (i / (series.length - 1) * (w - 4) + 2).toFixed(1) + "," + (h - 3 - (p[1] - lo) / span * (h - 6)).toFixed(1); });
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" aria-hidden="true"><polyline points="' + pts.join(" ") +
      '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" class="series" style="color:' + color + '"/></svg>';
  }

  function renderWatch() {
    var box = $("watch"), n = now();
    if (!box) return;
    var list = L.risingFastest(stations(), n, 6), up = list.filter(function (r) { return r.delta >= 5; }).slice(0, 5);
    var down = list.slice().reverse().filter(function (r) { return r.delta <= -5; })[0];
    var html = i18('<div class="watch-col"><h3>Rising fastest now</h3>');
    if (!list.length) html += i18('<p class="muted">Not enough hourly readings yet.</p>');
    else if (!up.length) html += i18('<p class="off-none">No station has risen by 5 or more in the last 6 hours.</p>');
    else {
      html += '<div class="watch-list">' + up.map(function (r) {
        var k = cat(r.to);
        return '<button type="button" class="watch-row" data-station="' + esc(r.station.id) + '"><span class="w-name">' + esc(r.station.name) +
          '<span class="sub">' + esc(r.station.state) + ", " + r.from + i18(" to ") + r.to + "</span></span>" + sparkline(r.series, k.color) +
          '<span class="w-delta">+' + r.delta + "</span></button>";
      }).join("") + "</div>";
    }
    if (down) html += i18('<p class="small muted">Falling fastest: ') + esc(down.station.name) + ", " + down.from + i18(" to ") + down.to + " (" + down.delta + ").</p>";
    if (list.length) html += i18('<p class="small muted">Change in the official IPU between ') + esc(L.fmtTime(L.parseTime(list[0].fromKey))) + i18(" and ") + esc(L.fmtTime(L.parseTime(list[0].toKey))) +
      i18(". The IPU is a 24-hour average, so a steady rise means the air has been getting worse for hours.</p>");
    html += "</div>";
    var un = Object.keys(S.unusual).map(function (id) { return S.unusual[id]; }).sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
    html += i18('<div class="watch-col"><h3>Unusual readings</h3>');
    if (!un.length) html += i18('<p class="off-none">No station differs sharply from the stations around it right now.</p>');
    else {
      html += '<div class="watch-list">' + un.map(function (u) {
        return '<button type="button" class="watch-row" data-station="' + esc(u.station.id) + '"><span class="w-name">' + esc(u.station.name) +
          '<span class="sub">' + esc(u.station.state) + i18(", nearby stations around ") + u.median + "</span></span>" +
          '<span class="w-delta unusual-delta">' + u.station.api + "</span></button>";
      }).join("") + "</div>";
    }
    html += i18('<p class="small muted">Flagged when a reading differs by 40 or more (and by at least a third) from the middle value of the other stations within 60 km. Readings are never changed.</p></div>');
    box.innerHTML = html;
  }

  // ================================================================ hear the haze (accessibility)

  var A11Y_KEY = "ipu-a11y-sound";
  var SOUND = { on: false, ac: null, nodes: [], timers: [] };
  try { SOUND.on = localStorage.getItem(A11Y_KEY) === "1"; } catch (e) { SOUND.on = false; }

  function announce(text) { var el = $("a11y-live"); if (el) { el.textContent = ""; setTimeout(function () { el.textContent = text; }, 30); } }

  function audioCtx() {
    if (!SOUND.ac) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      SOUND.ac = new C();
    }
    if (SOUND.ac.state === "suspended") SOUND.ac.resume();
    return SOUND.ac;
  }

  function stopSound() {
    SOUND.nodes.forEach(function (n) { try { n.stop(); } catch (e) { /* already stopped */ } });
    SOUND.timers.forEach(clearTimeout);
    SOUND.nodes = []; SOUND.timers = [];
    Array.prototype.forEach.call(document.querySelectorAll(".listen-btn[aria-pressed='true']"), function (b) {
      b.setAttribute("aria-pressed", "false"); b.textContent = b.getAttribute("data-label");
    });
  }

  /* Play values as tones: one per hour, 0.22 s apart. */
  function playTones(values, opts) {
    var ac = audioCtx();
    if (!ac) { announce(i18("This browser cannot play sound.")); return false; }
    stopSound();
    var step = 0.22, dur = 0.18, t0 = ac.currentTime + 0.12, lead = (t0 - ac.currentTime) * 1000;
    values.forEach(function (v, i) {
      var tone = L.toneFor(v), osc = ac.createOscillator(), g = ac.createGain(), at = t0 + i * step;
      var vol = tone.wave === "square" ? 0.05 : tone.wave === "triangle" ? 0.12 : 0.16;
      osc.type = tone.wave; osc.frequency.value = tone.freq;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.02);
      g.gain.setValueAtTime(vol, at + dur - 0.04); g.gain.linearRampToValueAtTime(0, at + dur);
      osc.connect(g); g.connect(ac.destination);
      osc.start(at); osc.stop(at + dur + 0.02);
      SOUND.nodes.push(osc);
      if (opts && opts.onStep) SOUND.timers.push(setTimeout(function () { opts.onStep(i); }, lead + i * step * 1000));
    });
    SOUND.timers.push(setTimeout(function () { if (opts && opts.onEnd) opts.onEnd(); }, lead + values.length * step * 1000 + 120));
    return true;
  }

  function whenShort(t) { return L.fmtTime(t) + " " + L.dayName(L.mytDateKey(t)); }

  function listenControls(allPts, st, markAll) {
    var pts = allPts.slice(-24), offset = allPts.length - pts.length;
    var mark = function (i) { markAll(i < 0 ? -1 : i + offset); };
    var wrap = document.createElement("div");
    wrap.className = "listen";
    var first = pts[0], last = pts[pts.length - 1], hi = pts[0], lo = pts[0];
    pts.forEach(function (p) { if (p.y > hi.y) hi = p; if (p.y < lo.y) lo = p; });
    var summary = i18("Highest ") + hi.y + i18(" at ") + whenShort(hi.t) + i18(". Lowest ") + lo.y + i18(" at ") + whenShort(lo.t) + i18(". Latest ") + last.y + ", " + cat(last.y).label + ".";
    var label = i18("Listen to the last ") + pts.length + i18(" hours");
    wrap.innerHTML = '<button type="button" class="listen-btn" aria-pressed="false" data-label="' + esc(label) + '">' + esc(label) + "</button>" +
      '<p class="listen-desc">' + esc(pts.length + i18(" tones, one per hour, from ") + whenShort(first.t) + i18(" to ") + whenShort(last.t) + i18(". Higher pitch means worse air. ") +
      i18("A soft buzz means Unhealthy (above 100); a harsh buzz means 200 or above. ") + summary) + "</p>";
    var btn = wrap.querySelector("button");
    btn.addEventListener("click", function () {
      if (btn.getAttribute("aria-pressed") === "true") { stopSound(); mark(-1); announce(i18("Stopped.")); return; }
      announce(i18("Playing ") + pts.length + i18(" hours at ") + st.name + i18(", from ") + whenShort(first.t) + i18(" to ") + whenShort(last.t) + i18(". Higher pitch means worse air."));
      var ok = playTones(pts.map(function (p) { return p.y; }), {
        onStep: function (i) { mark(i); },
        onEnd: function () { mark(-1); btn.setAttribute("aria-pressed", "false"); btn.textContent = label; announce(i18("Finished. ") + summary); }
      });
      if (ok) { btn.setAttribute("aria-pressed", "true"); btn.textContent = i18("Stop"); }
    });
    return wrap;
  }

  function setSoundOption(on) {
    SOUND.on = on;
    try { localStorage.setItem(A11Y_KEY, on ? "1" : "0"); } catch (e) { /* not saved in private mode */ }
    if (!on) stopSound();
    $("a11y-sound").checked = on;
    $("a11y-btn").classList.toggle("is-on", on);
    renderSelection(false);
    announce(on ? i18("Hear the haze is on. Each 24-hour chart now has a Listen button.") : i18("Hear the haze is off."));
  }

  // ================================================================ rule vs reality

  var RR_LABEL = { beyond: "Went further than the national rule", matches: "In line with the national rule",
                   partly: "Partly in line with the national rule", no_data: "Not enough data to compare", no_area: "Not compared" };

  function rrFor(c) { return S.rr && S.rr.closures ? S.rr.closures[c.id] || null : null; }

  function rrLine(c, withLink) {
    var r = rrFor(c);
    if (!r || !r.verdict) return "";
    var v = r.verdict, part = r.before24 && !r.before24.complete && r.before24.max;
    return '<p class="rr-line"><span class="rr-chip ' + esc(v.kind) + '">' + esc(i18(RR_LABEL[v.kind] || "Rule vs reality")) + "</span>" + esc(loc(v, "text")) +
      (part ? i18(" Based on ") + r.before24.hours + i18(" of 24 hours of readings.") : "") +
      (withLink ? i18(' <a href="#closures" class="rr-link">See the day-by-day chart</a>') : "") + "</p>";
  }

  function rrBlock(c) {
    var r = rrFor(c);
    if (!r) return i18('<p class="off-none">Rule vs reality: the comparison with official readings is added by the next hourly update.</p>');
    return i18('<div class="rr"><h4>Rule vs reality</h4>') + rrLine(c, false) +
      (r.days && r.days.length ? '<div class="chart rr-chart" data-rr="' + esc(c.id) + '"></div>' : "") +
      i18('<p class="small muted">Compared with official DOE readings at ') + esc(loc(r, "basis")) + " (" + (r.stations ? r.stations.length : 0) + i18(" station") + (r.stations && r.stations.length === 1 ? "" : i18("s")) +
      i18("). The national rule closes schools in the affected area once the IPU reaches ") + ((S.rr.rule && S.rr.rule.threshold) || 200) +
      i18(". States can also decide on other grounds, such as health data or the weather outlook.</p></div>");
  }

  function drawRR(el) {
    var id = el.getAttribute("data-rr"), r = S.rr && S.rr.closures[id];
    var c = ((S.ann && S.ann.closures) || []).filter(function (x) { return x.id === id; })[0];
    if (!r || !r.days || !r.days.length || !c) return;
    var days = r.days, thr = (S.rr.rule && S.rr.rule.threshold) || 200;
    var W2 = Math.max(280, el.clientWidth || 400), H = 200, padL = 32, padR = 8, padT = 22, padB = 36;
    var n = days.length, step = (W2 - padL - padR) / n, bw = Math.min(34, step * 0.62);
    var ymax = Math.ceil(Math.max(thr + 30, Math.max.apply(null, days.map(function (d) { return d.max.api; }))) / 50) * 50;
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var cx = function (i) { return padL + step * i + step / 2; };
    var svg = svgEl("svg", { viewBox: "0 0 " + W2 + " " + H, width: W2, height: H, role: "img",
      "aria-label": i18("Highest official IPU each day in the closed area, with the closure days marked") });
    var defs = svgEl("defs", {}), pat = svgEl("pattern", { id: "rrhatch-" + id, width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    pat.appendChild(svgEl("rect", { width: 8, height: 8, fill: T().closedLine, opacity: 0.06 }));
    pat.appendChild(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 8, stroke: T().closedLine, "stroke-width": 2, opacity: 0.28 }));
    defs.appendChild(pat); svg.appendChild(defs);
    // closure days background
    days.forEach(function (d, i) {
      if (d.closed) svg.appendChild(svgEl("rect", { x: padL + step * i, y: padT - 14, width: step, height: H - padB - padT + 14, fill: "url(#rrhatch-" + id + ")" }));
    });
    var firstClosed = days.map(function (d) { return d.closed; }).indexOf(true);
    if (firstClosed >= 0) svg.appendChild(svgEl("text", { x: padL + step * firstClosed + 4, y: padT - 4, "font-size": 10.5, fill: T().closedLine, "font-weight": 700 }, i18("Schools closed")));
    for (var g = 0; g <= ymax; g += 50) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W2 - padR, y1: sy(g), y2: sy(g), stroke: T().grid }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: T().axis, "text-anchor": "end" }, String(g)));
    }
    svg.appendChild(svgEl("line", { x1: padL, x2: W2 - padR, y1: sy(thr), y2: sy(thr), stroke: T().closure, "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
    days.forEach(function (d, i) {
      var k = cat(d.max.api), h = H - padB - sy(d.max.api), x = cx(i) - bw / 2;
      var bar = svgEl("path", { d: "M" + x + " " + (H - padB) + " V" + (sy(d.max.api) + 4) + " Q" + x + " " + sy(d.max.api) + " " + (x + 4) + " " + sy(d.max.api) +
        " H" + (x + bw - 4) + " Q" + (x + bw) + " " + sy(d.max.api) + " " + (x + bw) + " " + (sy(d.max.api) + 4) + " V" + (H - padB) + " Z",
        fill: k.color, opacity: d.partial_day ? 0.5 : 1 });
      svg.appendChild(bar);
      svg.appendChild(svgEl("text", { x: cx(i), y: sy(d.max.api) - 5, "font-size": 11, fill: T().ink, "text-anchor": "middle", "font-weight": 700,
        stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, String(d.max.api)));
      var dk = d.date, wd = L.dayName(dk), dn = String(Number(dk.slice(8, 10)));
      svg.appendChild(svgEl("text", { x: cx(i), y: H - padB + 14, "font-size": 10.5, fill: T().axis, "text-anchor": "middle" }, wd));
      svg.appendChild(svgEl("text", { x: cx(i), y: H - padB + 27, "font-size": 10.5, fill: T().axis, "text-anchor": "middle" }, dn));
      var hit = svgEl("rect", { x: padL + step * i, y: padT, width: step, height: H - padT - padB, fill: "transparent" });
      hit.addEventListener("mousemove", function (ev) {
        showTip("<b>" + esc(L.fmtDayKey(dk)) + i18("</b><br>Highest ") + d.max.api + " (" + esc(k.label) + i18(") at ") + esc(d.max.name) + ", " + esc(d.max.time.slice(11)) +
          "<br>" + d.reached200 + i18(" station") + (d.reached200 === 1 ? "" : i18("s")) + i18(" at ") + thr + i18(" or more") + (d.closed ? i18("<br>Schools officially closed") : "") +
          (d.partial_day ? i18("<br>Day not complete (") + d.hours + i18(" hours)") : ""), ev.clientX, ev.clientY);
      });
      hit.addEventListener("mouseleave", hideTip);
      svg.appendChild(hit);
    });
    // announcement marker
    var at = L.parseTime(r.announced_at);
    if (at) {
      var ak = L.mytDateKey(at), ai = days.map(function (d) { return d.date; }).indexOf(ak);
      if (ai >= 0) {
        var hr = Number(L.fmtTime(at).slice(0, 2)) + Number(L.fmtTime(at).slice(3)) / 60;
        var ax = padL + step * ai + step * (hr / 24);
        svg.appendChild(svgEl("line", { x1: ax, x2: ax, y1: padT - 14, y2: H - padB, stroke: T().ink, "stroke-width": 1.2, "stroke-dasharray": "2 3" }));
        svg.appendChild(svgEl("text", { x: ax - 4, y: padT - 4, "font-size": 10.5, fill: T().ink, "text-anchor": "end", stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, i18("Announced")));
      }
    }
    el.innerHTML = "";
    el.appendChild(svg);
    var leg = document.createElement("div");
    leg.className = "legend-row";
    leg.innerHTML = i18('<span><i class="rr-key-closed"></i>Schools officially closed</span><span><i class="rr-key-line"></i>National closure level (') + thr + ')</span>' +
      (days.some(function (d) { return d.partial_day; }) ? i18('<span><i class="rr-key-faded"></i>Day not complete</span>') : "");
    el.appendChild(leg);
    var det = document.createElement("details");
    det.className = "inline-details";
    det.innerHTML = i18("<summary>Show as a table</summary><div class='table-wrap'><table class='mini'><thead><tr><th>Day</th><th class='num'>Highest</th><th>Station</th><th class='num'>At 200+</th><th>Schools</th></tr></thead><tbody>") +
      days.map(function (d) {
        return "<tr><td>" + esc(dayShort(d.date)) + (d.partial_day ? i18(" (so far)") : "") + "</td><td class='num'>" + d.max.api + "</td><td>" + esc(d.max.name) + "</td><td class='num'>" + d.reached200 +
          "</td><td>" + (d.closed ? i18("Officially closed") : i18("Open or weekend")) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    el.appendChild(det);
  }

  function drawAllRR() { Array.prototype.forEach.call(document.querySelectorAll(".rr-chart"), drawRR); }

  // ================================================================ official closures: overview and map

  function renderClosures() {
    var box = $("closures"), n = now();
    if (!S.ann) { box.innerHTML = ""; return; }
    var list = L.activeClosures(S.ann, n);
    var html = i18('<h3>Official school closures</h3>');
    if (!list.length) {
      html += i18('<p class="off-none">No current or upcoming haze closures have been reported by Bernama (last checked ') + esc(checkedText()) + ").</p>";
    } else {
      list.forEach(function (c) {
        var started = c.from <= L.mytDateKey(n);
        html += i18('<div class="closure-item"><p class="ci-head"><span class="off-chip">Official</span><b>') + esc(L.areaLabel(c)) + i18("</b>: schools ") +
          (started ? i18("closed ") + esc(untilText(c)) : i18("close ") + (c.until_further_notice ? i18("from ") + esc(dayShort(c.from)) + i18(" until further notice") : esc(rangeText(c.from, c.to)))) + "</p>" +
          '<p class="pred-detail">' + esc(loc(c, "covers")) + (c.learning ? " " + esc(loc(c, "learning")) : "") + "</p>" + sourceLine(c) + rrBlock(c) + "</div>";
      });
      html += i18('<p class="small muted">From Bernama reports only, checked every hour from 6 am to 7 pm, June to November (last checked ') + esc(checkedText()) + i18("). Confirm with your school or JPN.</p>");
    }
    var tk = L.mytDateKey(n), recent = ((S.ann && S.ann.closures) || []).filter(function (c) {
      return L.validClosure(c, S.ann.source_policy) && c.to < tk && c.to >= L.addDaysKey(tk, -14);
    });
    if (recent.length) {
      html += i18('<h3 class="rr-past-h">Recently ended</h3>') + recent.map(function (c) {
        return '<div class="closure-item ended"><p class="ci-head"><b>' + esc(L.areaLabel(c)) + i18("</b>: schools were closed ") + esc(rangeText(c.from, c.to)) + "</p>" + sourceLine(c) + rrBlock(c) + "</div>";
      }).join("");
    }
    if (annStale()) html += i18('<p class="note">Announcements have not been checked as often as planned (last check ') + esc(checkedText()) + i18('), so a newer announcement may be missing.</p>');
    if (annPaused()) html += i18('<p class="note">The Bernama check is paused from December to May, outside the haze season, so announcements made now are not added until June. Confirm with your school or JPN.</p>');
    html += calendarHTML();
    box.innerHTML = html;
    drawAllRR();
    bindCalendar();
  }

  // ---- calendar feeds of official closures (docs/data/cal, built from the Bernama-only list)

  function calFeeds() { return (S.calIndex && S.calIndex.feeds) || []; }

  function calDefault() {
    var feeds = calFeeds(), want = S.calState || (S.sel && (S.sel.state || (S.view && S.view.station && S.view.station.state))) || null;
    if (!want && S.ann) {
      var act = L.activeClosures(S.ann, now())[0], a = act && act.area;
      want = a ? ((a.states && a.states[0]) || a.state || null) : null;
    }
    var f = want ? feeds.filter(function (x) { return x.state && L.sameState(x.state, want); })[0] : null;
    return f || feeds[0] || null;
  }

  function calendarHTML() {
    var feeds = calFeeds();
    if (!feeds.length) return "";
    var d = calDefault();
    return i18('<div class="cal" id="cal"><h3>Get official closures in your calendar</h3>') +
      i18('<p class="small muted">A calendar you subscribe to: new closures, extensions and early reopenings reported by Bernama appear by themselves.</p>') +
      '<div class="cal-row"><select id="cal-state" aria-label="State for the calendar">' + feeds.map(function (f) {
        return '<option value="' + esc(f.file) + '"' + (d && f.file === d.file ? " selected" : "") + ">" + esc(f.name) + "</option>";
      }).join("") + '</select><div class="cal-btns" id="cal-btns"></div></div>' +
      i18('<p class="small muted">Calendar apps check subscribed calendars on their own schedule, from every few minutes to about once a day (Google). Confirm with your school or JPN.</p></div>');
  }

  function calLinks(file) {
    var base = location.origin + location.pathname.replace(/[^/]*$/, ""), https = base + "data/cal/" + file;
    var webcal = https.replace(/^https?:/, "webcal:"), feed = calFeeds().filter(function (f) { return f.file === file; })[0];
    var name = i18("Haze school closures: ") + (feed ? feed.name : "Malaysia");
    return '<a class="cal-btn" href="' + esc(webcal) + i18('">Subscribe (iPhone, Mac, Android apps)</a>') +
      '<a class="cal-btn" target="_blank" rel="noopener" href="https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(webcal) + i18('">Google Calendar</a>') +
      '<a class="cal-btn" target="_blank" rel="noopener" href="https://outlook.live.com/calendar/0/addfromweb?url=' + encodeURIComponent(https) + "&name=" + encodeURIComponent(name) + i18('">Outlook</a>') +
      '<a class="cal-btn" href="' + esc(https) + i18('" download>Download .ics</a>');
  }

  function bindCalendar() {
    var sel = $("cal-state");
    if (!sel) return;
    var draw = function () { $("cal-btns").innerHTML = calLinks(sel.value); };
    sel.addEventListener("change", function () {
      var f = calFeeds().filter(function (x) { return x.file === sel.value; })[0];
      S.calState = f ? f.state : null;
      draw();
    });
    draw();
  }

  function openCalendarFor(state) {
    S.calState = state;
    renderClosures();
    var c = $("cal");
    if (c) c.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "center" });
  }

  /* Districts covered by a closure today or tomorrow, as map features. */
  function closedAreasGeo() {
    var out = { type: "FeatureCollection", features: [] }, labels = [], n = now();
    if (!S.ann || !S.bounds) return { geo: out, labels: labels };
    var t = L.mytDateKey(n), tm = L.addDaysKey(t, 1);
    L.activeClosures(S.ann, n).filter(function (c) { return c.from <= tm; }).forEach(function (c) {
      var w = 180, so = 90, e = -180, no = -90, hit = 0;
      S.bounds.districts.forEach(function (d) {
        if (!L.closureCovers(c, { state: d.state, district: d.district })) return;
        hit++;
        out.features.push({ type: "Feature", properties: { id: c.id },
          geometry: { type: "MultiPolygon", coordinates: d.polygons } });
        w = Math.min(w, d.bbox[0]); so = Math.min(so, d.bbox[1]); e = Math.max(e, d.bbox[2]); no = Math.max(no, d.bbox[3]);
      });
      if (hit) labels.push({ lon: e + 0.12, lat: (so + no) / 2, text: i18("Schools closed ") + untilText(c) });
    });
    return { geo: out, labels: labels };
  }

  function hatchImage() {
    var size = 16, c = document.createElement("canvas");
    c.width = c.height = size * 2;
    var x = c.getContext("2d");
    x.strokeStyle = T().closedLine; x.globalAlpha = themeName() === "neon" ? 0.7 : 0.45; x.lineWidth = 3;
    x.beginPath();
    for (var k = -2; k <= 2; k++) { x.moveTo(k * size, size * 2); x.lineTo(k * size + size * 2, 0); }
    x.stroke();
    return x.getImageData(0, 0, size * 2, size * 2);
  }

  function updateClosedAreas() {
    if (!M.map || !M.styleReady) return;
    var r = closedAreasGeo();
    if (M.map.getSource("closed")) M.map.getSource("closed").setData(r.geo);
    M.closedLabels.forEach(function (m) { m.remove(); });
    M.closedLabels = r.labels.map(function (l) {
      var el = document.createElement("div");
      el.className = "closed-wrap";
      el.innerHTML = '<div class="closed-label"></div>';
      el.querySelector(".closed-label").textContent = l.text;
      return new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat([l.lon, l.lat]).addTo(M.map);
    });
  }

  // ================================================================ haze sources: fires & wind

  function freshFires() {
    var f = S.sources && S.sources.fires, nowMin = Date.now() / 60000;
    if (!f || !f.points) return [];
    return f.points.filter(function (p) { return p.length > 3 && nowMin - p[3] <= FIRE_MAX_AGE_MIN; });
  }

  function firesGeo() {
    return { type: "FeatureCollection", features: freshFires().map(function (p) {
      return { type: "Feature", geometry: { type: "Point", coordinates: [p[0], p[1]] }, properties: { frp: p[2] } };
    }) };
  }

  function windData() {
    var w = S.sources && S.sources.wind;
    if (!w || !w.u || !w.grid || !w.fetched_at) return null;
    var age = (Date.now() - new Date(w.fetched_at).getTime()) / 3600000;
    return age <= 12 ? w : null;          // older wind is not shown as current
  }

  function windAt(lon, lat) {
    var w = W.grid, g = w.grid, fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    var i = Math.floor(fx), j = Math.floor(fy), i1 = Math.min(i + 1, g.nx - 1), j1 = Math.min(j + 1, g.ny - 1), tx = fx - i, ty = fy - j;
    function bl(arr) {
      var a = arr[j * g.nx + i], b = arr[j * g.nx + i1], c = arr[j1 * g.nx + i], d = arr[j1 * g.nx + i1];
      if (a === null || b === null || c === null || d === null) return null;
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
    var u = bl(w.u), v = bl(w.v);
    return u === null || v === null ? null : { u: u, v: v };
  }

  function sizeWindCanvas() {
    if (!W.canvas || !M.map) return;
    var box = M.map.getContainer().getBoundingClientRect();   // the canvas container itself has no size
    W.dpr = Math.min(2, window.devicePixelRatio || 1);
    W.canvas.width = Math.max(1, Math.round(box.width * W.dpr));
    W.canvas.height = Math.max(1, Math.round(box.height * W.dpr));
    W.canvas.style.width = box.width + "px";
    W.canvas.style.height = box.height + "px";
  }

  function spawn(p) {
    var g = W.grid.grid;
    p.lon = g.lon0 + Math.random() * (g.nx - 1) * g.dlon;
    p.lat = g.lat0 + Math.random() * (g.ny - 1) * g.dlat;
    p.age = Math.floor(Math.random() * 90);
  }

  function windStep() { return 0.0035 * Math.pow(2, 5 - M.map.getZoom()); }   // degrees per (m/s) per frame

  function windFrame() {
    if (!W.running) return;
    var ctx = W.ctx, map = M.map, d = W.dpr, k = windStep();
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.fillRect(0, 0, W.canvas.width, W.canvas.height);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = T().wind;
    ctx.lineWidth = 1.3 * d;
    ctx.beginPath();
    W.parts.forEach(function (p) {
      var w = windAt(p.lon, p.lat);
      if (!w || p.age++ > 100) { spawn(p); p.age = 0; return; }
      var a = map.project([p.lon, p.lat]);
      p.lon += w.u * k / Math.cos(p.lat * Math.PI / 180);
      p.lat += w.v * k;
      var b = map.project([p.lon, p.lat]);
      ctx.moveTo(a.x * d, a.y * d);
      ctx.lineTo(b.x * d, b.y * d);
    });
    ctx.stroke();
    W.raf = requestAnimationFrame(windFrame);
  }

  /* With reduced motion: short still streamlines instead of moving particles. */
  function drawStaticWind() {
    if (!W.ctx || !W.grid) return;
    var ctx = W.ctx, map = M.map, d = W.dpr, k = windStep() * 6, g = W.grid.grid;
    ctx.clearRect(0, 0, W.canvas.width, W.canvas.height);
    ctx.strokeStyle = T().wind; ctx.lineWidth = 1.3 * d; ctx.beginPath();
    for (var lat = g.lat0; lat <= g.lat0 + (g.ny - 1) * g.dlat; lat += g.dlat / 2) {
      for (var lon = g.lon0; lon <= g.lon0 + (g.nx - 1) * g.dlon; lon += g.dlon / 2) {
        var pl = lon, pa = lat, first = map.project([pl, pa]);
        ctx.moveTo(first.x * d, first.y * d);
        for (var s = 0; s < 6; s++) {
          var w = windAt(pl, pa);
          if (!w) break;
          pl += w.u * k / Math.cos(pa * Math.PI / 180); pa += w.v * k;
          var q = map.project([pl, pa]);
          ctx.lineTo(q.x * d, q.y * d);
        }
      }
    }
    ctx.stroke();
  }

  function startWind() {
    W.grid = windData();
    if (!W.ctx || !W.grid) return;
    sizeWindCanvas();
    if (REDUCE) { drawStaticWind(); return; }
    var n = isMobile() ? 450 : 900;
    W.parts = [];
    for (var i = 0; i < n; i++) { var p = {}; spawn(p); W.parts.push(p); }
    if (!W.running) { W.running = true; W.raf = requestAnimationFrame(windFrame); }
  }

  function stopWind() {
    W.running = false;
    cancelAnimationFrame(W.raf);
    if (W.ctx) W.ctx.clearRect(0, 0, W.canvas.width, W.canvas.height);
  }

  function setSources(on, fly) {
    M.sourcesOn = on;
    var b = $("src-btn");
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.textContent = on ? i18("Hide haze sources") : i18("Where the haze comes from");
    if (M.map && M.styleReady) {
      ["fires-glow", "fires"].forEach(function (id) { if (M.map.getLayer(id)) M.map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); });
    }
    renderLegend();
    renderSourcesSection();
    var traced = updateTraceDisplay();
    if (on) loadWindFc().then(updateSmokeOnMap); else updateSmokeOnMap();
    if (on && fly) {
      if (traced) flyToTrace();
      else flyTo({ bounds: isMobile() ? [[96.5, -4.5], [118.5, 7.5]] : REGION_BOUNDS, maxZoom: 6, padding: isMobile() ? { top: 56, bottom: 64, left: 6, right: 6 } : null });
    }
  }

  function updateSourcesOnMap() {
    if (M.map && M.styleReady && M.map.getSource("fires")) M.map.getSource("fires").setData(firesGeo());
    updateTraceDisplay();
    updateSmokeOnMap();
  }

  // ================================================================ air path (where the air came from)

  function selPoint(sel) {
    if (!sel || sel.type === "state" || sel.type === "school-code") return null;
    if (sel.type === "station") {
      var st = stationById(sel.id);
      return st && typeof st.lat === "number" ? { lon: st.lon, lat: st.lat } : null;
    }
    return typeof sel.lat === "number" ? { lon: sel.lon, lat: sel.lat } : null;
  }

  function loadWindHist() {
    if (S.windHist) return Promise.resolve(S.windHist);
    if (S.windHistLoading) return S.windHistLoading;
    S.windHistLoading = getJSON("data/wind_history.json").then(function (h) {
      var age = (Date.now() / 60000) - h.times[h.times.length - 1];
      S.windHist = h && h.times && h.times.length > 2 && age < 12 * 60 ? h : false;   // older history is not used
      return S.windHist;
    }).catch(function () { S.windHist = false; return false; })
      .then(function (h) { S.windHistLoading = null; return h; });
    return S.windHistLoading;
  }

  /* Compute (and cache) the air path for the current selection. */
  function currentTrace() {
    var pt = selPoint(S.sel);
    if (!pt || !S.windHist) return null;
    var k = pt.lon.toFixed(4) + "," + pt.lat.toFixed(4) + "," + S.windHist.times[S.windHist.times.length - 1];
    if (S.trace && S.trace.key === k) return S.trace;
    var tr = L.backTrajectory(S.windHist, pt.lon, pt.lat, 72, 15);
    if (tr.hourly.length < 7) { S.trace = { key: k, failed: true }; return S.trace; }
    var fires = freshFires();
    S.trace = { key: k, tr: tr, regions: L.pathRegions(tr.hourly, 3), near: L.firesNearPath(tr.dense, fires, 25, 2), fires: fires };
    return S.trace;
  }

  function traceGeo() {
    var t = M.sourcesOn && S.trace && S.trace.tr && selPoint(S.sel) ? S.trace : null;
    return { type: "FeatureCollection", features: t ? [{ type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: t.tr.dense.map(function (p) { return [p[0], p[1]]; }) } }] : [] };
  }

  function fireHitsGeo() {
    var t = M.sourcesOn && S.trace && S.trace.near && selPoint(S.sel) ? S.trace : null;
    return { type: "FeatureCollection", features: t ? t.near.indexes.map(function (i) {
      var f = t.fires[i];
      return { type: "Feature", geometry: { type: "Point", coordinates: [f[0], f[1]] }, properties: {} };
    }) : [] };
  }

  /* Haze-sources map: the selected place's air path if there is one, otherwise the general wind flow.
     Returns true when a path is shown. */
  function updateTraceDisplay() {
    M.dayMarkers.forEach(function (m) { m.remove(); });
    M.dayMarkers = [];
    var t = M.sourcesOn && selPoint(S.sel) ? currentTrace() : null;
    var show = !!(t && t.tr);
    if (M.map && M.styleReady) {
      if (M.map.getSource("trace")) M.map.getSource("trace").setData(traceGeo());
      if (M.map.getSource("fire-hits")) M.map.getSource("fire-hits").setData(fireHitsGeo());
    }
    if (show) {
      stopWind();
      [24, 48, 72].forEach(function (h) {
        var p = t.tr.hourly[h];
        if (!p || !M.map) return;
        var el = document.createElement("div");
        el.className = "day-wrap";
        el.innerHTML = '<div class="day"></div>';
        el.querySelector(".day").textContent = h / 24 + (h === 24 ? i18(" day ago") : i18(" days ago"));
        M.dayMarkers.push(new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([p[0], p[1]]).addTo(M.map));
      });
    } else if (M.sourcesOn) {
      startWind();
    } else {
      stopWind();
    }
    if (M.traceShown !== show) { M.traceShown = show; renderLegend(); }
    return show;
  }

  function flyToTrace() {
    var t = S.trace, pt = selPoint(S.sel);
    if (!t || !t.tr || !pt) return;
    var pts = t.tr.hourly.map(function (p) { return [p[0], p[1]]; }).concat([[pt.lon, pt.lat]]);
    flyTo({ bounds: boundsOf(pts), maxZoom: 8, padding: isMobile() ? { top: 70, bottom: 130, left: 40, right: 40 } : { top: 90, bottom: 120, left: 110, right: 110 } });
  }

  function listNames(arr) {
    if (arr.length <= 1) return arr.join("");
    return arr.slice(0, -1).join(", ") + i18(" and ") + arr[arr.length - 1];
  }

  function renderAirPath() {
    var box = $("airpath"), pt = selPoint(S.sel);
    if (!pt) { box.innerHTML = ""; box.className = ""; return; }
    box.className = "airpath";
    var head = i18('<div class="fc-head"><h3>Where this air came from</h3><span class="fc-tag">Model estimate</span></div>');
    if (S.windHist === null) {
      box.innerHTML = head + i18('<p class="muted">Loading wind history…</p>');
      loadWindHist().then(function () { renderAirPath(); updateTraceDisplay(); });
      return;
    }
    if (!S.windHist) { box.innerHTML = head + i18('<p class="muted">The wind history needed to trace the air is not available right now. It is refreshed with the hourly update.</p>'); return; }
    var t = currentTrace();
    if (!t || !t.tr) { box.innerHTML = head + i18('<p class="muted">The air path could not be traced here: this place is at the edge of the wind data.</p>'); return; }
    var days = Math.round(t.tr.hoursCovered / 24 * 10) / 10;
    var over = t.regions.filter(function (r) { return r.hours >= 6; }).slice(0, 3).map(function (r) { return r.name; });
    var start = t.tr.hourly[t.tr.hourly.length - 1], startRegion = L.regionOf(start[0], start[1]);
    var html = head + i18('<p class="lead">Over the last ') + (days >= 2.9 ? i18("3 days") : days + i18(" days")) + i18(", the air now arriving here travelled about <b>") +
      Math.round(t.tr.km / 10) * 10 + i18(" km</b>") + (over.length ? i18(", mostly over ") + esc(listNames(over)) : "") + ". " +
      (days >= 2.9 ? i18("Three days ago it was over ") : i18("At the start of the trace it was over ")) + esc(startRegion) + ".</p>";
    if (t.near.count) {
      html += i18('<p class="lead">Along the way it passed within 25 km of <b>') + t.near.count.toLocaleString("en-MY") + i18(" fire hotspot") + (t.near.count > 1 ? i18("s") : "") +
        i18("</b> detected by satellites in the last 24 hours") + (t.near.byRegion.length ? i18(", mostly in ") + esc(t.near.byRegion[0].name) : "") + ".</p>";
    } else if (t.fires.length) {
      html += i18('<p class="lead">It did not pass near any of the fire hotspots detected by satellites in the last 24 hours.</p>');
    } else {
      html += i18('<p class="lead">No recent satellite fire detections are available to compare with the path.</p>');
    }
    html += '<button type="button" class="trace-btn" id="trace-show">' + (M.sourcesOn ? i18("Show the path on the map") : i18("Show the path and fires on the map")) + "</button>" +
      i18('<p class="fc-note">Traced backwards through modelled winds about 800 m up, where smoke travels (Open-Meteo). The fire detections are from the last 24 hours while the air passed those areas up to 3 days ago, so this shows fires along the route, not proof that a particular fire caused today\'s haze. Not official data.</p>');
    box.innerHTML = html;
  }

  // ================================================================ smoke on the way (forecast winds, an estimate)

  var SMOKE_KM = 50;

  function loadWindFc() {
    if (S.windFc !== null) return Promise.resolve(S.windFc);
    if (S.windFcLoading) return S.windFcLoading;
    S.windFcLoading = getJSON("data/wind_forecast.json").then(function (f) {
      var nowMin = Date.now() / 60000;
      // used only while it covers now and at least 12 hours ahead
      S.windFc = f && f.times && f.times.length > 2 && f.times[0] <= nowMin && f.times[f.times.length - 1] - nowMin >= 12 * 60 ? f : false;
      return S.windFc;
    }).catch(function () { S.windFc = false; return false; })
      .then(function (f) { S.windFcLoading = null; return f; });
    return S.windFcLoading;
  }

  /* Forward paths from today's fire areas and their arrivals at every station (cached ~10 min). */
  function smokeAll() {
    if (!S.windFc) return null;
    var fires = freshFires(), key = S.windFc.fetched_at + "|" + fires.length + "|" + Math.floor(Date.now() / 600000);
    if (S.smoke && S.smoke.key === key) return S.smoke;
    var clusters = L.fireClusters(fires, 0.5, 3);
    var targets = stations().filter(function (st) { return typeof st.lat === "number"; })
      .map(function (st) { return { id: st.id, lon: st.lon, lat: st.lat, state: st.state, name: st.name }; });
    var res = clusters.length ? L.smokeArrivals(clusters, S.windFc, targets, now(), { km: SMOKE_KM, hours: 48, maxClusters: 400 }) : null;
    S.smoke = { key: key, clusters: clusters, res: res, fires: fires.length };
    return S.smoke;
  }

  function smokeByState(sm) {
    var by = {}, totals = {};
    stations().forEach(function (st) { var k = L.stateKey(st.state); totals[k] = (totals[k] || 0) + 1; });
    sm.res.results.forEach(function (r) {
      if (r.earliest === null) return;
      var k = L.stateKey(r.target.state), b = by[k] || (by[k] = { state: r.target.state, earliest: r.earliest, stations: 0, total: totals[k] || 0, regions: {} });
      b.earliest = Math.min(b.earliest, r.earliest); b.stations += 1;
      r.regions.forEach(function (g) { b.regions[g.name] = Math.max(b.regions[g.name] || 0, g.count); });
    });
    return Object.keys(by).map(function (k) {
      var b = by[k];
      b.regionList = Object.keys(b.regions).sort(function (x, y) { return b.regions[y] - b.regions[x]; });
      return b;
    }).sort(function (a, b) { return a.earliest - b.earliest; });
  }

  /* "around Mon 03:00 (in about 15 hours)", rounded to the hour: these are rough estimates. */
  function arriveText(tMin, t0) {
    var d = new Date(Math.round(tMin / 60) * 3600000), h = Math.max(1, Math.round((tMin - t0) / 60));
    return i18("around ") + L.dayName(L.mytDateKey(d)) + " " + L.fmtTime(d) + i18(" (in about ") + h + i18(" hour") + (h === 1 ? "" : i18("s")) + ")";
  }

  function smokeTag() { return i18('<span class="fc-tag">Forecast estimate</span>'); }
  function smokeNote() {
    return i18('<p class="fc-note">Estimate from forecast winds about 800 m up (Open-Meteo), starting from fire areas NASA satellites detected in the last 24 hours. ') +
      i18("It follows where the air now over those fires is heading; it does not say how much smoke it carries or what the IPU will be, and paths are less certain further ahead. Not official.</p>");
  }

  function renderSmoke() {
    var box = $("smoke");
    if (!box) return;
    var sel = S.sel, pt = selPoint(sel), isState = sel && sel.type === "state";
    if (!sel || (!pt && !isState)) { box.innerHTML = ""; box.className = ""; return; }
    box.className = "smoke";
    var head = i18('<div class="fc-head"><h3>Smoke on the way</h3>') + smokeTag() + "</div>";
    if (S.windFc === null) { box.innerHTML = head + i18('<p class="muted">Loading the wind forecast…</p>'); loadWindFc().then(function () { renderSmoke(); updateSmokeOnMap(); }); return; }
    if (!S.windFc) { box.innerHTML = head + i18('<p class="muted">The wind forecast is not available right now. It is refreshed with the hourly update.</p>'); return; }
    var sm = smokeAll();
    if (!sm || !sm.fires) { box.innerHTML = head + i18('<p class="muted">No recent satellite fire detections are available to follow.</p>'); return; }
    if (!sm.res) { box.innerHTML = head + i18('<p class="muted">No fire areas with 3 or more hotspots were detected in the last 24 hours.</p>') + smokeNote(); return; }
    var html = head, t0 = sm.res.t0;
    if (isState) {
      var st = smokeByState(sm).filter(function (b) { return L.sameState(b.state, sel.state); })[0];
      html += st ? i18('<p class="lead">Air now over fire areas in <b>') + esc(listNames(st.regionList.slice(0, 3))) + i18("</b> is forecast to pass within ") + SMOKE_KM + i18(" km of ") +
          st.stations + i18(" of the ") + st.total + i18(" monitoring stations in ") + esc(sel.state) + i18(", first ") + esc(arriveText(st.earliest, t0)) + ".</p>"
        : i18('<p class="lead">In the forecast winds for the next 48 hours, air now over today\'s fire areas does not pass within ') + SMOKE_KM + i18(" km of any monitoring station in ") + esc(sel.state) + ".</p>";
    } else {
      var r = L.smokeHitsFor(sm.res.paths, { lon: pt.lon, lat: pt.lat }, SMOKE_KM);
      S.smokeHere = r;
      if (r.earliest !== null) {
        html += i18('<p class="lead">Air now over fire areas in <b>') + esc(r.regions[0].name) + "</b> (" + r.regions[0].count.toLocaleString("en-MY") + i18(" hotspots) is forecast to pass within ") +
          SMOKE_KM + i18(" km of here ") + esc(arriveText(r.regions[0].first, t0)) + ".</p>";
        if (r.regions.length > 1) {
          html += i18('<p class="lead">Also from ') + r.regions.slice(1, 3).map(function (g) { return "<b>" + esc(g.name) + "</b> (" + g.count.toLocaleString("en-MY") + i18(" hotspots, ") + esc(arriveText(g.first, t0).replace(/ \(.*\)$/, "")) + ")"; }).join(i18(" and ")) + ".</p>";
        }
      } else {
        html += i18('<p class="lead">In the forecast winds for the next 48 hours, air now over today\'s ') + sm.clusters.length + i18(" fire areas does not pass within ") + SMOKE_KM + i18(" km of here.</p>");
      }
    }
    html += i18('<button type="button" class="trace-btn" id="smoke-show">Show smoke paths on the map</button>') + smokeNote();
    box.innerHTML = html;
    if (M.sourcesOn) updateSmokeOnMap();
  }

  function renderSmokeOverview() {
    var box = $("smoke-ov");
    if (!box) return;
    var head = i18('<div class="fc-head"><h3>Smoke on the way, next 48 hours</h3>') + smokeTag() + "</div>";
    if (S.windFc === null) { box.innerHTML = head + i18('<p class="muted">Loading the wind forecast…</p>'); loadWindFc().then(function () { renderSmokeOverview(); updateSmokeOnMap(); }); return; }
    if (!S.windFc) { box.innerHTML = head + i18('<p class="muted">The wind forecast is not available right now.</p>'); return; }
    var sm = smokeAll();
    if (!sm || !sm.res) { box.innerHTML = head + i18('<p class="muted">No fire areas to follow right now.</p>'); return; }
    var list = smokeByState(sm), t0 = sm.res.t0;
    var html = head;
    if (!list.length) {
      html += i18('<p class="lead">In the forecast winds, air now over today\'s ') + sm.clusters.length + i18(" fire areas does not reach any Malaysian monitoring station in the next 48 hours.</p>");
    } else {
      html += '<div class="smoke-list">' + list.map(function (b) {
        return '<div class="smoke-row"><b>' + esc(b.state) + i18("</b><span>from ") + esc(listNames(b.regionList.slice(0, 2))) + "</span><span class=\"smoke-when\">" + esc(arriveText(b.earliest, t0)) + "</span>" +
          '<span class="muted small">' + b.stations + i18(" of ") + b.total + i18(" station") + (b.total === 1 ? "" : i18("s")) + "</span></div>";
      }).join("") + "</div>";
    }
    box.innerHTML = html + smokeNote();
  }

  /* Forward paths on the map (with the haze-sources view): the ones reaching the selected place,
     or with no place selected, the ones reaching any Malaysian station. */
  function smokeGeo() {
    var out = { type: "FeatureCollection", features: [] };
    if (!M.sourcesOn || !S.windFc) return out;
    var sm = smokeAll();
    if (!sm || !sm.res) return out;
    var idx = {}, pt = selPoint(S.sel);
    if (pt) {
      L.smokeHitsFor(sm.res.paths, { lon: pt.lon, lat: pt.lat }, SMOKE_KM).hits.forEach(function (h) { idx[h.path] = true; });
    } else {
      sm.res.results.forEach(function (r) { r.hits.forEach(function (h) { idx[h.path] = true; }); });
    }
    Object.keys(idx).forEach(function (i) {
      var d = sm.res.paths[i].dense;
      if (d.length < 2) return;
      out.features.push({ type: "Feature", properties: { end: 0 }, geometry: { type: "LineString", coordinates: d.map(function (q) { return [q[0], q[1]]; }) } });
      out.features.push({ type: "Feature", properties: { end: 1 }, geometry: { type: "Point", coordinates: [d[d.length - 1][0], d[d.length - 1][1]] } });
    });
    return out;
  }

  function updateSmokeOnMap() {
    var g = smokeGeo();
    M.smokeShown = g.features.length > 0;
    if (M.map && M.styleReady && M.map.getSource("smoke")) M.map.getSource("smoke").setData(g);
    renderLegend();
  }

  // ================================================================ coverage zones ("which station covers me")

  function updateZones() {
    var sel = S.sel, n = now(), data = { type: "FeatureCollection", features: [] }, info = null;
    if (sel && sel.source === "device" && typeof sel.lat === "number") {
      var cur = stations().filter(function (s) { return typeof s.lat === "number" && L.stationCurrent(s, n); });
      if (cur.length) {
        var zones = L.coverageZones(cur.map(function (s) { return { id: s.id, lon: s.lon, lat: s.lat }; }), [[98.5, 0.2], [120.5, 8.2]]);
        cur.forEach(function (s) {
          if (!zones[s.id]) return;
          var mine = L.inPoly(sel.lon, sel.lat, zones[s.id]);
          if (mine) info = { station: s, ring: zones[s.id] };
          data.features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [zones[s.id]] },
                               properties: { id: s.id, mine: mine, color: cat(s.api).color } });
        });
      }
    }
    M.zones = data;
    if (M.map && M.styleReady && M.map.getSource("zones")) M.map.getSource("zones").setData(data);
    return info;
  }

  function renderSourcesSection() {
    var box = $("sources-body"), src = S.sources;
    if (!src) { box.innerHTML = i18('<p class="muted">Fire and wind data has not been downloaded yet. It is added by the hourly update.</p>'); return; }
    var f = src.fires || {}, pts = freshFires(), w = windData(), html = '<div class="src-stats">';
    if (pts.length) {
      var newest = f.newest_recent_detection ? L.parseTime(f.newest_recent_detection) : null;
      html += '<div class="src-stat"><span class="v fire">' + pts.length.toLocaleString("en-MY") + i18("</span><p>fire hotspots detected by NASA satellites around Malaysia, Sumatra and Borneo in the last 24 hours") +
        (newest ? i18(" (latest pass ") + esc(L.fmtDateTime(newest)) + ")" : "") + ".</p></div>";
    } else if (f.newest_detection) {
      html += i18('<div class="src-stat"><span class="v fire">0</span><p>No satellite fire detections from the last 36 hours are available. The newest detections NASA has published for this region are from ') +
        esc(L.fmtDateTime(L.parseTime(f.newest_detection))) + i18(", so none are shown as current.</p></div>");
    } else {
      html += i18('<div class="src-stat"><span class="v fire">–</span><p>Satellite fire data could not be read on the last update.</p></div>');
    }
    if (w) {
      // prevailing wind between Sumatra and the Peninsula
      var su = 0, sv = 0, cnt = 0, g = w.grid;
      for (var j = 0; j < g.ny; j++) for (var i = 0; i < g.nx; i++) {
        var lon = g.lon0 + i * g.dlon, lat = g.lat0 + j * g.dlat, u = w.u[j * g.nx + i], v = w.v[j * g.nx + i];
        if (lon >= 96 && lon <= 104 && lat >= -4 && lat <= 6 && u !== null && v !== null) { su += u; sv += v; cnt++; }
      }
      if (cnt) {
        var mu = su / cnt, mv = sv / cnt, spd = Math.sqrt(mu * mu + mv * mv) * 3.6;
        html += '<div class="src-stat"><span class="v">' + Math.round(spd) + i18('</span><p>km/h: surface wind over Sumatra and the Strait of Malacca, mostly from the <b>') +
          esc(L.windFrom(mu, mv)) + i18("</b> (weather model, ") + esc(L.fmtDateTime(L.parseTime(w.fetched_at))) + ").</p></div>";
      }
    }
    html += i18("</div><p>Smoke from fires upwind can be carried to Malaysia by these winds. The fires and winds on the map are as they are now; the dashed smoke paths are a forecast of where the air over fire areas is heading. None of this traces actual smoke, and fire detections do not show how much smoke a fire makes.</p>") +
      '<button type="button" class="src-btn2" id="src-show">' + (M.sourcesOn ? i18("Hide fires and wind on the map") : i18("Show fires and wind on the map")) + "</button>" +
      i18('<p class="small muted">Fires: <a href="https://firms.modaps.eosdis.nasa.gov/" rel="noopener">NASA FIRMS</a> near-real-time VIIRS detections. ') + esc(i18(f.note || "")) +
      i18(" Wind: Open-Meteo 10 m wind, a model estimate. Neither is official IPU data.</p>") +
      '<div id="smoke-ov" class="smoke smoke-ov"></div>';
    box.innerHTML = html;
    renderSmokeOverview();
  }

  // ================================================================ forecast (estimate, never official)

  function whenText(k) {
    var t = L.parseTime(k);
    return L.fmtTime(t) + i18(" on ") + L.fmtDayKey(L.mytDateKey(t)).replace(/ \d{4}$/, "");
  }

  function forecastNote() {
    var f = S.forecast;
    return i18('<p class="fc-note">This estimate is <b>not from DOE</b>. It is not the official IPU and is not used for the school closure check. ') +
      i18("It scales the CAMS air-quality model forecast (Copernicus, via Open-Meteo) to this station's official readings, so it can be wrong, especially when weather changes quickly.</p>") +
      (f && f.method ? i18('<details class="inline-details"><summary>How this estimate is made</summary><div><ul>') +
        f.method.map(function (m) { return "<li>" + esc(i18(m)) + "</li>"; }).join("") + "</ul></div></details>" : "");
  }

  function renderForecast(box, st) {
    box.innerHTML = "";
    if (!st) return;
    var fcAll = S.forecast, fc = fcAll && fcAll.stations ? fcAll.stations[st.id] : null, n = now();
    var head = i18('<div class="fc-head"><h3>Forecast for ') + esc(st.name) + i18('</h3><span class="fc-tag">Estimate, not official</span></div>');
    if (!fcAll) { box.innerHTML = head + i18('<p class="muted">The forecast estimate has not been made yet. It is added by the hourly update.</p>'); return; }
    var stat = L.forecastStatus(fc, st, n);
    if (!stat.ok) { box.innerHTML = head + '<p class="muted">' + esc(fcAll.skipped && fcAll.skipped[st.id] ? i18("No estimate: ") + i18(fcAll.skipped[st.id]) + "." : stat.reason) + "</p>" + forecastNote(); return; }
    var reach = { likely: i18("Likely"), possible: i18("Possible"), unlikely: i18("Unlikely") }[fc.reach200_24h] || "—";
    var pk = fc.peak24;
    var html = head +
      i18('<p class="fc-lead">Estimated peak in the next 24 hours: <b>') + pk.est + i18("</b> (range ") + pk.lo + i18(" to ") + pk.hi + i18("), around ") + esc(whenText(pk.time)) + ".</p>" +
      i18('<dl class="facts"><dt>Could reach 200 in the next 24 hours</dt><dd>') + reach + "</dd>" +
      (fc.morning ? i18("<dt>Around 07:00 tomorrow</dt><dd>") + fc.morning.est + i18(" (range ") + fc.morning.lo + i18(" to ") + fc.morning.hi + ")</dd>" : "") +
      i18("<dt>Confidence</dt><dd>") + (fc.confidence === "low" ? i18("Low") : i18("Normal")) + "</dd>" +
      (fcAll.model_stale ? i18("<dt>Model data</dt><dd>More than a day old</dd>") : "") + "</dl>" +
      (fc.confidence === "low" ? i18('<p class="note">Low confidence: here the model sees much less haze than DOE measures, or the two have not matched well over the last day. Treat this as a rough guide.</p>') : "");
    box.innerHTML = html;
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    drawForecastChart(chart, st, fc);
    box.insertAdjacentHTML("beforeend", i18('<div class="fc-legend"><span><i class="k-dot"></i>Official reading now (DOE)</span><span><i class="k-dash"></i>Estimate</span><span><i class="k-band"></i>Range</span></div>') + forecastNote());
  }

  function drawForecastChart(chart, st, fc) {
    var t0 = L.parseTime(fc.anchor), times = [], i;
    for (i = 0; i < fc.est.length; i++) times.push(L.parseTime(fc.start).getTime() + i * 3600000);
    var W2 = Math.max(280, chart.clientWidth || 400), H = 190, padL = 32, padR = 8, padT = 14, padB = 26;
    var x0 = t0.getTime(), x1 = times[times.length - 1];
    var ymax = niceMax(Math.max(st.api, Math.max.apply(null, fc.hi)), 220);
    var sx = function (t) { return padL + ((t - x0) / Math.max(1, x1 - x0)) * (W2 - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W2 + " " + H, width: W2, height: H, role: "img", "aria-label": i18("Forecast estimate for ") + st.name + i18(", next ") + fc.est.length + i18(" hours") });
    for (var g = 0; g <= ymax; g += 50) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W2 - padR, y1: sy(g), y2: sy(g), stroke: T().grid }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: T().axis, "text-anchor": "end" }, String(g)));
    }
    var step = 12 * 3600000;
    for (var tt = Math.ceil(x0 / step) * step; tt <= x1; tt += step) {
      var dt = new Date(tt);
      svg.appendChild(svgEl("text", { x: sx(tt), y: H - 6, "font-size": 11, fill: T().axis, "text-anchor": "middle" },
        L.fmtTime(dt) === "00:00" ? L.fmtDayKey(L.mytDateKey(dt)).slice(0, 3) : L.fmtTime(dt)));
    }
    [[S.rule.outdoor.threshold, T().outdoor], [S.rule.closure.threshold, T().closure]].forEach(function (r) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W2 - padR, y1: sy(r[0]), y2: sy(r[0]), stroke: r[1], "stroke-dasharray": "4 4" }));
    });
    svg.appendChild(svgEl("text", { x: W2 - padR - 2, y: sy(S.rule.closure.threshold) + 14, "font-size": 11, fill: T().closure, "text-anchor": "end", stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, i18("200: closure level")));
    var t24 = x0 + 24 * 3600000;
    if (t24 < x1) {
      svg.appendChild(svgEl("line", { x1: sx(t24), x2: sx(t24), y1: padT, y2: H - padB, stroke: T().axis, "stroke-dasharray": "2 3", opacity: 0.7 }));
      svg.appendChild(svgEl("text", { x: sx(t24) - 4, y: padT + 10, "font-size": 10.5, fill: T().axis, "text-anchor": "end", stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, i18("next 24 h")));
    }
    // range band, then dashed estimate line, both starting at the official reading
    var top = [[x0, st.api]].concat(times.map(function (t, k) { return [t, fc.hi[k]]; }));
    var bot = [[x0, st.api]].concat(times.map(function (t, k) { return [t, fc.lo[k]]; })).reverse();
    var band = top.concat(bot).map(function (p, k) { return (k ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1); }).join(" ") + " Z";
    svg.appendChild(svgEl("path", { d: band, fill: T().forecast, opacity: 0.16 }));
    var line = [[x0, st.api]].concat(times.map(function (t, k) { return [t, fc.est[k]]; }));
    svg.appendChild(svgEl("path", { d: line.map(function (p, k) { return (k ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1); }).join(" "),
      fill: "none", stroke: T().forecast, color: T().forecast, "stroke-width": 2.2, "stroke-dasharray": "6 4", "stroke-linecap": "round", "class": "series" }));
    svg.appendChild(svgEl("circle", { cx: sx(x0), cy: sy(st.api), r: 5, fill: T().ink, stroke: T().halo, "stroke-width": 2 }));
    svg.appendChild(svgEl("text", { x: sx(x0) + 8, y: sy(st.api) - 8, "font-size": 11, fill: T().ink, stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, i18("Official now: ") + st.api));
    var cross = svgEl("line", { y1: padT, y2: H - padB, stroke: T().ink, opacity: 0 });
    svg.appendChild(cross);
    var overlay = svgEl("rect", { x: padL, y: padT, width: W2 - padL - padR, height: H - padT - padB, fill: "transparent" });
    function hover(ev) {
      var rect = svg.getBoundingClientRect(), px = (ev.clientX - rect.left) * (W2 / rect.width), best = 0;
      times.forEach(function (t, k) { if (Math.abs(sx(t) - px) < Math.abs(sx(times[best]) - px)) best = k; });
      cross.setAttribute("x1", sx(times[best])); cross.setAttribute("x2", sx(times[best])); cross.setAttribute("opacity", 0.3);
      showTip(i18("<b>Estimate ") + fc.est[best] + i18("</b> (range ") + fc.lo[best] + i18(" to ") + fc.hi[best] + ")<br>" + esc(L.fmtDateTime(new Date(times[best]))) + i18("<br>Not official IPU"), ev.clientX, ev.clientY);
    }
    overlay.addEventListener("mousemove", hover);
    overlay.addEventListener("touchstart", function (ev) { if (ev.touches[0]) hover(ev.touches[0]); }, { passive: true });
    overlay.addEventListener("mouseleave", function () { cross.setAttribute("opacity", 0); hideTip(); });
    svg.appendChild(overlay);
    chart.appendChild(svg);
  }

  function renderOutlook() {
    var box = $("outlook"), fc = S.forecast, n = now();
    if (!fc || !fc.stations) { box.innerHTML = ""; return; }
    var rows = stations().filter(function (s) { return L.forecastStatus(fc.stations[s.id], s, n).ok; })
      .map(function (s) { return { s: s, f: fc.stations[s.id] }; })
      .sort(function (a, b) { return b.f.peak24.est - a.f.peak24.est; });
    var head = i18('<div class="fc-head"><h3>Next 24 hours</h3><span class="fc-tag">Estimate, not official</span></div>');
    if (!rows.length) { box.innerHTML = head + i18('<p class="muted">No forecast estimate is available right now.</p>'); return; }
    var likely = rows.filter(function (r) { return r.f.reach200_24h === "likely"; }).length;
    var possible = rows.filter(function (r) { return r.f.reach200_24h === "possible"; }).length;
    var lead = likely || possible
      ? i18("The estimate suggests ") + (likely ? likely + i18(" station") + (likely > 1 ? i18("s are") : i18(" is")) + i18(" likely") + (possible ? i18(" and ") : "") : "") +
        (possible ? possible + i18(" station") + (possible > 1 ? i18("s") : "") + i18(" could possibly") : "") + i18(" reach 200 in the next 24 hours.")
      : i18("The estimate does not expect any station to reach 200 in the next 24 hours.");
    var label = { likely: i18("200 likely"), possible: i18("200 possible"), unlikely: "" };
    box.innerHTML = head + '<p class="fc-lead">' + esc(lead) + '</p><div class="fc-list">' + rows.slice(0, 5).map(function (r) {
      return '<button type="button" class="fc-row" data-station="' + esc(r.s.id) + '"><span class="nm">' + esc(r.s.name) + '</span><span class="pk">' + r.f.peak24.est + "</span>" +
        '<span class="sub">' + esc(r.s.state) + i18(", estimated peak ") + r.f.peak24.lo + i18(" to ") + r.f.peak24.hi + i18(" around ") + esc(whenText(r.f.peak24.time)) +
        (label[r.f.reach200_24h] ? ". " + label[r.f.reach200_24h] : "") + (r.f.confidence === "low" ? i18(", low confidence") : "") + "</span></button>";
    }).join("") + i18('</div><p class="fc-note">Highest estimated peaks. These are model estimates, not DOE readings, and are not used for the school closure check.</p>');
  }

  // ================================================================ tooltip

  function showTip(html, x, y) {
    var t = $("tip");
    t.innerHTML = html; t.hidden = false;
    var w = t.offsetWidth, h = t.offsetHeight;
    var left = Math.min(x + 14, window.innerWidth - w - 8), top = y + 14;
    if (top + h > window.innerHeight - 8) top = y - h - 10;
    t.style.left = Math.max(8, left) + "px"; t.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { $("tip").hidden = true; }

  // ================================================================ overview

  function renderOverview() {
    var n = now(), sum = L.nationalSummary(stations(), n);
    function who(list) {
      if (!list.length) return "";
      var first = list[0];
      return '<button type="button" data-station="' + esc(first.id) + '">' + esc(first.name + ", " + first.state) + "</button>" +
        (list.length > 1 ? i18('<span class="small muted">and ') + (list.length - 1) + i18(" more</span>") : "");
    }
    var reached = sum.current.filter(function (s) { return S.rule && L.meets(s.api, S.rule.closure); });
    var html = "";
    if (sum.highest) {
      html += i18('<span class="k">Highest</span><span class="v" style="--c:') + cat(sum.highest.api).color + '" data-count="' + sum.highest.api + '">' + sum.highest.api + '</span><span class="p">' + badge(sum.highest.api) + who(sum.highestAll) + "</span>";
      html += i18('<span class="k">Lowest</span><span class="v" style="--c:') + cat(sum.lowest.api).color + '" data-count="' + sum.lowest.api + '">' + sum.lowest.api + '</span><span class="p">' + badge(sum.lowest.api) + who(sum.lowestAll) + "</span>";
    } else {
      html += i18('<span class="summary-foot">No station has a current reading.</span>');
    }
    var threshold = S.rule ? S.rule.closure.threshold : 200;
    html += '<p class="summary-foot">' + sum.current.length + i18(" of ") + stations().length + i18(" stations have a current reading. ") +
      (reached.length ? "<b>" + reached.length + " " + (reached.length > 1 ? i18("are") : i18("is")) + i18(" at the school-closure level of ") + threshold + i18(" or more.</b>")
                      : i18("None is at the school-closure level of ") + threshold + ".") + "</p>";
    $("summary").innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll("#summary [data-count]"), function (el) { countUp(el, Number(el.dataset.count)); });

    // distribution bar
    var total = sum.current.length || 1;
    var dist = '<div class="dist-bar" role="img" aria-label="Stations by category">' + L.categories().map(function (c) {
      return sum.counts[c.key] ? '<span data-w="' + (sum.counts[c.key] / total * 100) + '" style="' + swatch(T().cats[c.key]) + '"></span>' : "";
    }).join("") + '</div><div class="dist-legend">' + L.categories().map(function (c) {
      var range = c.max === Infinity ? "300+" : c.min + "–" + c.max;
      return '<span><i style="' + swatch(T().cats[c.key]) + '"></i>' + esc(c.label) + ' <span class="muted">' + range + "</span> <b>" + sum.counts[c.key] + "</b></span>";
    }).join("") + "</div>";
    $("dist").innerHTML = dist;
    Array.prototype.forEach.call(document.querySelectorAll(".dist-bar span"), function (el) { growTo(el, Number(el.dataset.w)); });

    // states
    var rows = Object.keys(sum.byState).map(function (k) { return sum.byState[k]; })
      .sort(function (a, b) { return b.api - a.api || a.state.localeCompare(b.state); });
    var max = Math.max(250, rows.length ? rows[0].api : 0);
    var o = S.rule ? S.rule.outdoor.threshold : 100, cl = S.rule ? S.rule.closure.threshold : 200;
    $("state-bars").innerHTML = rows.length ? rows.map(function (r) {
      var c = cat(r.api);
      return '<button type="button" class="srow" data-state="' + esc(r.state) + '" aria-label="' + esc(r.state + i18(": highest ") + r.api + ", " + c.label + i18(", at ") + r.name) + '">' +
        '<span class="s-name">' + esc(r.state) + '</span><span class="track"><span class="fill" data-w="' + (r.api / max * 100) + '" style="' + swatch(c.color) + '"></span>' +
        '<span class="tick" style="left:' + (o / max * 100) + '%"></span><span class="tick closure" style="left:' + (cl / max * 100) + '%"></span></span>' +
        '<span class="s-val">' + r.api + "</span></button>";
    }).join("") + i18('<p class="bars-key">Dashed marks: ') + o + i18(" (outdoor activities stop above this) and ") + cl + i18(" (school-closure level). Tap a state to see it on the map.</p>")
      : i18('<p class="muted">No current readings to show.</p>');
    Array.prototype.forEach.call(document.querySelectorAll(".srow .fill"), function (el) { growTo(el, Number(el.dataset.w)); });
  }

  // ================================================================ station table

  function populateStateFilter() {
    var sel = $("f-state"), cur = sel.value, names = {};
    stations().forEach(function (s) { if (s.state) names[s.state] = true; });
    sel.innerHTML = i18('<option value="">All states</option>') + Object.keys(names).sort().map(function (nm) {
      return '<option value="' + esc(nm) + '">' + esc(nm) + "</option>";
    }).join("");
    sel.value = cur;
  }

  function renderTable() {
    var n = now(), fs = $("f-state").value, sort = $("f-sort").value, ft = L.norm($("f-text").value);
    var list = stations().filter(function (s) {
      if (fs && s.state !== fs) return false;
      if (ft && L.norm([s.name, s.location, s.place, s.id, s.state].join(" ")).indexOf(ft) < 0) return false;
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
    var html = "", last = null;
    list.forEach(function (s) {
      if (sort === "state" && s.state !== last) { last = s.state; html += '<tr class="group-row"><td colspan="4">' + esc(s.state) + "</td></tr>"; }
      var cur = L.stationCurrent(s, n), c = cat(cur ? s.api : null), pol = L.pollutantName(s.pollutant);
      html += '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + ">" +
        '<td><span class="dot" style="' + swatch(c ? c.color : T().off) + '"></span>' + esc(s.name) +
        '<span class="sub">' + (sort === "state" ? "" : esc(s.state) + ", ") + esc(s.id) + (s.place ? ", " + esc(L.tidy(s.place)) : "") + "</span></td>" +
        '<td class="num api">' + (cur ? esc(s.api) : "—") + "</td>" +
        '<td class="hide-sm">' + (cur ? badge(s.api) + (pol ? '<span class="sub">' + esc(pol) + "</span>" : "") : badge(null)) +
        (S.unusual[s.id] ? i18('<span class="sub unusual-tag">Unusual vs nearby stations</span>') : "") + "</td>" +
        "<td>" + esc(readingTime(s.observed, n)) + (!cur && s.api !== null && s.observed ? i18('<span class="sub">last ') + esc(s.api) + i18(", outdated</span>") : "") + "</td></tr>";
    });
    if (!list.length) html = i18('<tr><td colspan="4" class="muted">No stations match.</td></tr>');
    document.querySelector("#station-table tbody").innerHTML = html;
  }

  // ================================================================ selection

  var SOURCE_TEXT = {
    kpm: "School location from the official KPM school list",
    "kpm-town": "Town centre estimated from the official KPM school list",
    osm: "Location found with OpenStreetMap place search (not an official source)",
    device: "Your device's location",
    link: "Location from a shared link"
  };

  function select(sel, opts) {
    opts = opts || {};
    if ($("share-panel")) $("share-panel").hidden = true;
    clearSplit();
    S.sel = sel;
    if (!opts.keepHash) setHash(sel);
    $("results").innerHTML = "";
    renderSelection(true);
    if (!opts.noScroll) {
      var target = isMobile() ? document.querySelector(".map-wrap") : $("selection");
      target.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
    }
  }

  function clearSelection() {
    S.sel = null; setHash(null);
    clearSplit();
    renderSelection(false);
    showPlace(null); markRef(null); updateZones(); updateTraceDisplay(); updateSmokeOnMap();
    if (M.sourcesOn) flyTo({ bounds: isMobile() ? [[96.5, -4.5], [118.5, 7.5]] : REGION_BOUNDS, maxZoom: 6, padding: isMobile() ? { top: 56, bottom: 64, left: 6, right: 6 } : null });
    else flyHome();
  }

  function setHash(sel) {
    var h = "";
    if (sel) {
      if (sel.type === "station") h = "station=" + encodeURIComponent(sel.id);
      else if (sel.type === "state") h = "state=" + encodeURIComponent(sel.state);
      else if (sel.type === "school" && sel.code) h = "school=" + encodeURIComponent(sel.code);
      else if (typeof sel.lat === "number") h = "at=" + sel.lat.toFixed(5) + "," + sel.lon.toFixed(5) +
        "&label=" + encodeURIComponent(sel.label || "") + "&src=" + encodeURIComponent(sel.source || "") +
        (sel.state ? "&st=" + encodeURIComponent(sel.state) : "");
    }
    if (I18.lang === "ms") h += (h ? "&" : "") + "lang=ms";
    try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch (e) { /* ignore */ }
  }

  function readHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h) return null;
    var q = {};
    h.split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
    S.lobbyWanted = q.screen === "1";
    if (q.station) return { type: "station", id: q.station };
    if (q.state) return { type: "state", state: q.state };
    if (q.school) return { type: "school-code", code: q.school };
    if (q.at) {
      var p = q.at.split(",").map(Number);
      if (p.length === 2 && isFinite(p[0]) && isFinite(p[1])) {
        return { type: "place", lat: p[0], lon: p[1], label: q.label || i18("Selected location"), source: q.src || "link", state: q.st || null };
      }
    }
    return null;
  }

  function schoolSel(r) {
    return { type: "school", code: r[0], label: L.tidy(r[1]), state: L.tidy(r[2]), district: L.tidy(r[3]), town: L.tidy(r[4]),
             lat: r[5], lon: r[6], source: "kpm" };
  }

  function renderSelection(moveMap) {
    var box = $("selection"), sel = S.sel, n = now();
    if (!sel) { box.hidden = true; return; }
    box.hidden = false;
    if (sel.type === "school-code") {
      $("sel-title").textContent = i18("Loading school…");
      $("loc-info").innerHTML = ""; $("prediction").innerHTML = ""; $("trend").innerHTML = ""; $("forecast").innerHTML = ""; $("airpath").innerHTML = "";
      loadSchools().then(function () {
        var r = (S.schools || []).filter(function (x) { return x[0] === sel.code; })[0];
        if (r) select(schoolSel(r), { keepHash: true, noScroll: true });
        else { S.sel = null; renderSelection(false); }
      });
      return;
    }
    if (sel.type === "state") { renderStateSelection(sel, n, moveMap); return; }

    var st = null, lat, lon, title, sub;
    if (sel.type === "station") {
      st = stationById(sel.id);
      if (!st) { $("sel-title").textContent = i18("Station not found"); $("loc-info").innerHTML = i18('<p class="muted">This station is not in the current data.</p>'); $("prediction").innerHTML = ""; $("trend").innerHTML = ""; return; }
      title = st.name; sub = i18("DOE monitoring station in ") + st.state + (st.place ? i18(", at ") + L.tidy(st.place) : "") + " (" + st.id + ")";
      lat = st.lat; lon = st.lon;
    } else {
      title = sel.label; lat = sel.lat; lon = sel.lon;
      var kind = sel.type === "school" ? i18("School") : sel.type === "locality" ? i18("Town") : i18("Place");
      var where = S.bounds ? L.locate(lon, lat, S.bounds) : null;
      var loc = sel.type === "school" ? [sel.town, sel.district, sel.state].filter(Boolean).join(", ")
              : where ? where.district + (where.district !== where.state ? i18(" district, ") + where.state : "") : [sel.town, sel.state].filter(Boolean).join(", ");
      sub = kind + (loc ? i18(" in ") + loc : "") + (sel.code ? " (" + sel.code + ")" : "");
    }
    $("sel-title").textContent = title;

    var m = (typeof lat === "number" && typeof lon === "number") ? L.matchStations(lat, lon, stations(), n, { state: sel.state }) : null;
    var ref = m && m.reference;
    var html = '<p class="sel-sub">' + esc(sub) + "</p>";
    if (!m) {
      html += i18('<p class="note">No station coordinates are available, so a reference station cannot be chosen.</p>');
    } else if (!ref) {
      html += i18('<p class="note">No station near here has a current reading. Readings may be outdated; see the notice at the top of the page.</p>');
      if (st && st.api !== null && st.observed) {
        html += i18('<p class="note">Last reading at this station: ') + esc(st.api) + i18(" at ") + esc(L.fmtDateTime(L.parseTime(st.observed))) + i18(". This is outdated, not a current reading.</p>");
      }
    } else {
      var rs = ref.station, self = sel.type === "station" && rs.id === sel.id;
      html += '<div class="reading" style="--c:' + cat(rs.api).color + '"><span class="big">' + esc(rs.api) + '</span><span class="meta">' + badge(rs.api) +
        '<span class="where">' + (self ? i18("IPU at this station") : i18("IPU at ") + esc(rs.name) + i18(" station, ") + (ref.km < 1 ? i18("under 1 km") : Math.round(ref.km) + i18(" km")) + i18(" away")) +
        "</span></span></div>" +
        i18('<p class="small muted">Reading for ') + esc(L.fmtDateTime(L.parseTime(rs.observed))) +
        (L.pollutantName(rs.pollutant) ? i18(". Main pollutant: ") + esc(L.pollutantName(rs.pollutant)) : "") + ".</p>";
      if (!self) {
        html += i18('<p class="ref-note">This is the reading at the DOE monitoring station ') + esc(rs.name) + " (" + esc(rs.id) + i18("), not a measurement taken at ") +
          (sel.type === "school" ? i18("the school") : i18("this location")) + i18(" itself.</p>");
      }
      if (st && !self) {
        html += i18('<p class="note">This station has no current reading, so the nearest station with one is shown.</p>');
      }
      m.notes.forEach(function (t) { html += '<p class="note">' + esc(t) + "</p>"; });
      html += unusualNote(rs);
    }
    if (sel.type !== "station" && sel.source) {
      html += '<p class="small muted">' + esc(i18(SOURCE_TEXT[sel.source]) || sel.source) + (sel.sub && sel.source === "device" ? ". " + esc(sel.sub) : "") + ".</p>";
    }
    if (ref) html += nowAirHTML(ref.station) + doseHTML(ref.station);
    $("loc-info").innerHTML = html;

    // prediction, then nearest stations, then trend
    var predBox = $("prediction");
    var place = placeFor(sel, st, lon, lat);
    predBox.innerHTML = predictionHTML(ref ? ref.station : st, place.state || sel.state || (ref && ref.station.state) || (st && st.state), m, place);
    if (m && m.shown.length) {
      predBox.insertAdjacentHTML("beforeend", nearHTML(m, ref, n));
    }
    if (ref) renderTrend($("trend"), ref.station, i18("Last 24 hours at ") + ref.station.name);
    else if (st) renderTrend($("trend"), st, i18("Last 24 hours at ") + st.name);
    else $("trend").innerHTML = "";
    renderForecast($("forecast"), ref ? ref.station : st);
    renderAirPath();
    renderSmoke();
    S.view = makeView(sel, title, sub, ref ? ref.station : (st && L.stationCurrent(st, n) ? st : null), ref ? ref.km : 0,
                      place, place.state || sel.state || (ref && ref.station.state) || (st && st.state), n, sel.type === "station");
    if (S.lobbyOn) renderLobby();
    var zone = updateZones();
    if (zone) {
      $("loc-info").insertAdjacentHTML("beforeend", i18('<p class="zone-note">You are inside the area covered by <b>') + esc(zone.station.name) +
        i18("</b> station: everywhere in the highlighted zone on the map is closer to ") + esc(zone.station.name) +
        i18(" than to any other station with a current reading. The dashed lines between zones are where two stations are equally far away.</p>"));
    }

    // map
    if (moveMap) {
      var point = [lon, lat];
      markRef(ref ? ref.station.id : (st ? st.id : null));
      if (sel.type === "station") showPlace(null); else showPlace(point, title, ref);
      if (M.sourcesOn) {
        loadWindHist().then(function () { renderAirPath(); if (updateTraceDisplay()) flyToTrace(); });
      } else if (zone) {
        flyTo({ bounds: boundsOf(zone.ring), maxZoom: 11 });
      } else if (sel.type === "station") {
        flyTo({ center: point, zoom: 10.5 });
      } else if (ref && ref.km > 2.5) {
        flyTo({ bounds: boundsOf([point, [ref.station.lon, ref.station.lat]]), maxZoom: 12.5 });
      } else {
        flyTo({ center: point, zoom: 12.5 });
      }
    }
  }

  function nearHTML(m, ref, n) {
    return i18('<div class="near"><h3>Nearest stations</h3><div class="table-wrap"><table class="mini"><thead><tr><th>Station</th><th class="num">Distance</th><th class="num">IPU</th><th class="hide-sm">Time</th></tr></thead><tbody>') +
      m.shown.map(function (x) {
        var s = x.station, cur = L.stationCurrent(s, n), c = cat(cur ? s.api : null);
        return '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + ">" +
          '<td><span class="dot" style="' + swatch(c ? c.color : T().off) + '"></span>' + esc(s.name) + (ref && x === ref ? i18(" (reference)") : "") +
          '<span class="sub">' + esc(s.state) + "</span></td>" +
          '<td class="num">' + (x.km < 1 ? "&lt;1" : Math.round(x.km)) + i18(" km</td>") +
          '<td class="num api">' + (cur ? esc(s.api) : "—") + '</td><td class="hide-sm">' + esc(readingTime(s.observed, n)) + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
  }

  function disclaimer(official) {
    var r = S.rule;
    return '<div class="disclaimer">' + (official
      ? i18("<b>Official closures shown here are taken from Bernama reports</b> of announcements by KPM or the state. Confirm details with your school or the State Education Department (JPN). The IPU check is a prediction, not an announcement. ")
      : i18("<b>This is a prediction, not an official closure announcement.</b> It is worked out from official DOE readings. Closures are decided and announced by KPM, the State Education Department (JPN) or the District Education Office (PPD), so check their announcements. ")) +
      i18("Rule used: ") + esc(loc(r.closure, "summary")) + " (" + esc(loc(r, "name")) + i18(", in force from ") + esc(L.fmtDayKey(r.effective_from)) + i18('). <a href="#about">How the prediction works</a></div>');
  }

  function dayShort(key) { return L.fmtDayKey(key).replace(/ \d{4}$/, ""); }
  function untilText(c, last) { return c.until_further_notice ? i18("until further notice") : i18("until ") + dayShort(last || c.to); }
  function rangeText(from, to) { return from === to ? dayShort(from) : dayShort(from) + i18(" to ") + dayShort(to); }

  function checkedText() {
    var t = S.ann && L.parseTime(S.ann.checked_at);
    return t ? L.fmtDateTime(t) : i18("never");
  }
  /* The Bernama check runs only in the months listed in announcements.json (the haze season). */
  function annPaused() {
    var months = S.ann && S.ann.check_months;
    if (!months || !months.length) return false;
    return months.indexOf(Number(L.mytDateKey(new Date()).slice(5, 7))) < 0;
  }
  function annStale() {
    if (annPaused()) return false;
    var t = S.ann && L.parseTime(S.ann.checked_at);
    if (!t) return true;
    // checks run hourly from about 6 am to 7 pm, so a gap overnight is expected
    var hour = Number(L.fmtTime(new Date()).slice(0, 2)), age = (Date.now() - t.getTime()) / 3600000;
    return age > (hour >= 7 && hour <= 19 ? 3 : 13);
  }

  /* State and district of the selected place, from the official boundaries when loaded. */
  function placeFor(sel, st, lon, lat) {
    var loc = S.bounds && typeof lon === "number" ? L.locate(lon, lat, S.bounds) : null;
    var place = loc ? { state: loc.state, district: loc.district, located: true }
                    : { state: sel.state || (st && st.state) || null, located: false };
    if (sel.type === "school" && sel.code) place.code = sel.code;
    return place;
  }

  function sourceLine(c) {
    // the Bernama report in the page language first, when there is one
    var list = c.sources.slice(), want = I18.lang === "ms" ? "ms" : "en";
    list.sort(function (a, b) { return (a.language === want ? 0 : 1) - (b.language === want ? 0 : 1); });
    var src = list[0], other = list[1], t = L.parseTime(src.published);
    var otherName = !other ? "" : other.language === "ms" ? i18("Bahasa Melayu") : other.language === "en" ? i18("English") : i18("another report");
    return i18('<p class="off-src">Reported by Bernama') + (t ? ", " + esc(L.fmtDateTime(t)) : "") + ': <a href="' + esc(src.url) + '" rel="noopener">' + esc(src.title) + "</a>" +
      (other ? i18(' (also in <a href="') + esc(other.url) + '" rel="noopener">' + otherName + "</a>)" : "") + "</p>";
  }

  function closureDetails(c) {
    return '<p class="pred-detail">' + esc(loc(c, "covers")) + (c.learning ? " " + esc(loc(c, "learning")) : "") + "</p>" + sourceLine(c) +
      i18('<details class="inline-details"><summary>More about this announcement</summary><div><dl class="facts">') +
      i18("<dt>Announced</dt><dd>") + esc(dayShort(c.announced_on)) + i18(", by ") + esc(loc(c, "announced_by")) + "</dd>" +
      (c.not_covered ? i18("<dt>Not covered</dt><dd>") + esc(loc(c, "not_covered")) + "</dd>" : "") +
      (c.exceptions ? i18("<dt>Exceptions</dt><dd>") + esc(loc(c, "exceptions")) + "</dd>" : "") +
      (c.dates_note ? i18("<dt>Dates</dt><dd>") + esc(loc(c, "dates_note")) + "</dd>" : "") +
      (c.previous ? i18("<dt>Before this</dt><dd>") + esc(loc(c, "previous")) + "</dd>" : "") + "</dl></div></details>";
  }

  /* Official closure part of the closure check. closed = schools here are officially closed tomorrow. */
  function officialHTML(place, n) {
    if (!S.ann || !place || !place.state) return { closed: false, any: false, html: "" };
    var o = L.officialStatus(place, n, S.ann), html = "", stale = annStale();
    var staleNote = (stale ? i18('<p class="note">Announcements were last checked ') + esc(checkedText()) + i18(", later than planned, so a newer announcement may be missing.</p>") : "") +
      (calFeeds().length ? '<p class="cal-link-p"><button type="button" class="link-btn cal-link" data-cal-state="' + esc(place.state) + i18('">Get official ') + esc(place.state) + i18(" closures in your calendar</button></p>") : "");
    if (o.tomorrow) {
      var c = o.tomorrow, last = o.lastDay || c.to;
      var ufn = c.until_further_notice || (o.today && o.today.until_further_notice);
      html = i18('<div class="pred-status official_closed"><span class="off-chip">Official</span>Schools closed ') +
        esc(ufn ? i18("from ") + dayShort(o.today ? o.today.from : c.from) + i18(" until further notice") : rangeText(o.today ? o.today.from : c.from, last)) + "</div>" +
        '<p class="pred-detail"><b>' + (o.today ? i18("Schools here are closed today and tomorrow") : i18("Schools here are closed from tomorrow")) + ".</b> " +
        i18("An official closure covers ") + esc(L.areaLabel(c)) + " " + esc(ufn ? i18("until further notice") : i18("until ") + dayShort(last)) + "." + (last !== c.to && !ufn ? i18(" It includes a later extension.") : "") + "</p>" +
        closureDetails(c) + rrLine(c, true) + staleNote;
      return { closed: true, any: true, html: html };
    }
    if (o.today) {
      html = i18('<div class="pred-status official_info"><span class="off-chip">Official</span>Announced closure ends today</div>') +
        i18('<p class="pred-detail">The official closure for ') + esc(L.areaLabel(o.today)) + " (" + esc(rangeText(o.today.from, o.today.to)) + i18(") ends today. ") +
        i18("No extension had been reported by Bernama when announcements were last checked (") + esc(checkedText()) + i18("). The IPU check below is for tomorrow.</p>") + sourceLine(o.today) + rrLine(o.today, true) + staleNote;
      return { closed: false, any: true, html: html };
    }
    if (o.upcoming) {
      html = i18('<p class="off-note"><span class="off-chip">Official</span> Schools here are announced to close ') + esc(rangeText(o.upcoming.from, o.upcoming.to)) + ".</p>" + sourceLine(o.upcoming);
      return { closed: false, any: true, html: html + staleNote };
    }
    if (o.ended) {
      html = i18('<p class="off-note"><span class="off-chip">Official</span> The announced closure here ended on ') + esc(dayShort(o.ended.to)) +
        i18(". No extension had been reported by Bernama when announcements were last checked (") + esc(checkedText()) + ").</p>" + sourceLine(o.ended) + rrLine(o.ended, true);
      return { closed: false, any: true, html: html + staleNote };
    }
    return { closed: false, any: false, html: i18('<p class="off-none">No official closure reported by Bernama for ') +
      esc(place.district && place.district !== place.state ? place.district + ", " + place.state : place.state) + i18(" (last checked ") + esc(checkedText()) + ").</p>" + staleNote };
  }

  /* Said when tomorrow is past the dates the site's school calendar fully covers. */
  function calendarNote(dayKey) {
    return S.rule && L.calendarIncomplete(dayKey, S.rule) && S.rule.calendar_note ? '<p class="note">' + esc(loc(S.rule, "calendar_note")) + "</p>" : "";
  }

  function predictionHTML(st, stateName, m, place) {
    var n = now();
    if (!S.rule) return i18("<h3>School closure check</h3><p class='muted'>The closure rule file could not be loaded.</p>");
    var off = officialHTML(place, n);
    var p = L.predict(st, S.rule, n, stateName);
    var html = i18("<h3>School closure check</h3>") + off.html;
    if (off.closed) {
      html += i18('<details class="inline-details ipu-ref"><summary>IPU check, for reference</summary><div>') +
        (p.available ? i18('<dl class="facts"><dt>Reference station</dt><dd>') + esc(st.name) + ", " + esc(st.state) + "</dd>" +
          i18("<dt>Current IPU</dt><dd>") + esc(p.latest) + i18(" at ") + esc(L.fmtTime(p.latestAt)) + "</dd>" +
          i18("<dt>Reached ") + S.rule.closure.threshold + i18(" today</dt><dd>") + (p.reachedToday ? i18("Yes") : i18("No")) + "</dd>" +
          i18("<dt>Outdoor activities</dt><dd>") + (p.outdoorStop ? i18("Should stop (IPU above ") + S.rule.outdoor.threshold + ")" : i18("No restriction at this reading")) + "</dd></dl>" +
          i18('<p class="small muted">The official closure applies whatever the IPU reading is.</p>')
          : '<p class="muted">' + esc(p.reason) + "</p>") + "</div></details>";
      return html + disclaimer(true);
    }
    if (!p.available) {
      return html + i18('<div class="pred-status unavailable">Prediction unavailable</div><p class="pred-detail">') + esc(p.reason) + "</p>" + disclaimer(off.any);
    }
    html += '<div class="pred-status ' + p.level + '">' + esc(p.status) + "</div>" +
      '<p class="pred-detail"><b>' + esc(p.headline) + ".</b> " + esc(p.detail) + "</p>" +
      '<dl class="facts">' +
      i18("<dt>Reference station</dt><dd>") + esc(st.name) + ", " + esc(st.state) + "</dd>" +
      i18("<dt>Reading time</dt><dd>") + esc(L.fmtDateTime(p.latestAt)) + "</dd>" +
      i18("<dt>Highest today</dt><dd>") + (p.todayMax !== null ? esc(p.todayMax) + i18(" at ") + esc(L.fmtTime(p.todayMaxAt)) : "—") + "</dd>" +
      i18("<dt>Reached ") + S.rule.closure.threshold + i18(" today</dt><dd>") + (p.reachedToday ? i18("Yes") : i18("No")) + "</dd>" +
      i18("<dt>Predicted for ") + esc(L.fmtDayKey(p.tomorrowKey).replace(/ \d{4}$/, "")) + "</dt><dd>" + esc(p.status) + "</dd>" +
      i18("<dt>Outdoor activities</dt><dd>") + (p.outdoorStop ? i18("Should stop now (IPU above ") + S.rule.outdoor.threshold + ")" : i18("No restriction at this reading")) + "</dd>" +
      "</dl>" + calendarNote(p.tomorrowKey);
    if (m && m.all && !p.reachedToday) {
      m.all.filter(function (x) {
        if (x.station === st || x.km > 30 || !L.stationCurrent(x.station, n)) return false;
        var q = L.predict(x.station, S.rule, n, stateName);
        return q.available && q.reachedToday;
      }).forEach(function (x) {
        html += '<p class="note">' + esc(x.station.name) + " (" + Math.round(x.km) + i18(" km away) reached the closure level today. Schools in its area may close, which may include this location.</p>");
      });
    }
    return html + disclaimer(off.any);
  }

  function renderStateSelection(sel, n, moveMap) {
    var sum = L.stateSummary(sel.state, stations(), S.rule, n);
    $("sel-title").textContent = sel.state;
    if (!sum.stations.length) {
      $("loc-info").innerHTML = i18('<p class="muted">No stations found for this state.</p>');
      $("prediction").innerHTML = ""; $("trend").innerHTML = ""; return;
    }
    var html = '<p class="sel-sub">' + sum.stations.length + i18(" monitoring station") + (sum.stations.length > 1 ? i18("s") : "") + ", " + sum.current.length + i18(" with a current reading</p>");
    if (sum.highest) {
      html += '<div class="reading" style="--c:' + cat(sum.highest.api).color + '"><span class="big">' + esc(sum.highest.api) + '</span><span class="meta">' + badge(sum.highest.api) +
        i18('<span class="where">Highest now, at ') + esc(sum.highest.name) + "</span></span></div>" +
        (sum.lowest && sum.lowest !== sum.highest ? i18('<p class="small muted">Lowest now: ') + esc(sum.lowest.api) + i18(" at ") + esc(sum.lowest.name) + ".</p>" : "");
    }
    html += i18('<p class="ref-note">Air quality differs across a state, so each station is listed separately. Search a town or school to use its nearest station.</p>');
    $("loc-info").innerHTML = html;

    var noSchool = sum.tomorrowNoSchool, day = L.fmtDayKey(sum.tomorrowKey);
    var noTxt = noSchool ? (noSchool.kind === "weekend" ? i18("No school (weekend)") : i18("No school (holiday)")) : null;
    var off = officialHTML({ state: sel.state }, n);
    var p = i18("<h3>School closure check</h3>") + off.html;
    // closures for parts of this state (districts or listed schools)
    if (S.ann) {
      L.activeClosures(S.ann, n).filter(function (c) {
        var a = c.area || {};
        return !(a.states && a.states.some(function (x) { return L.sameState(x, sel.state); })) && a.state && L.sameState(a.state, sel.state);
      }).forEach(function (c) {
        p += i18('<p class="off-note"><span class="off-chip">Official</span> Schools in ') + esc(L.areaLabel(c)) + i18(" are closed ") + esc(rangeText(c.from, c.to)) + ".</p>" + sourceLine(c);
      });
    }
    if (off.closed) {
      p += i18('<details class="inline-details ipu-ref"><summary>IPU check, for reference</summary><div><p class="small muted">') +
        (sum.reached.length ? sum.reached.length + i18(" station") + (sum.reached.length > 1 ? i18("s") : "") + i18(" reached ") + S.rule.closure.threshold + i18(" today.") : i18("No station has reached ") + S.rule.closure.threshold + i18(" today.")) +
        i18(" The official closure applies whatever the IPU reading is.</p></div></details>");
    } else if (!sum.current.length) {
      p += i18('<div class="pred-status unavailable">Prediction unavailable</div><p class="pred-detail">No station in this state has a current reading.</p>');
    } else if (sum.reached.length) {
      p += '<div class="pred-status may_close">' + esc(noTxt || i18("Schools in some areas may be closed")) + "</div>" +
        i18('<p class="pred-detail"><b>The closure level of ') + S.rule.closure.threshold + i18(" was reached today at ") + sum.reached.length + i18(" station") + (sum.reached.length > 1 ? i18("s") : "") + ".</b> " +
        (noSchool ? i18("Under the current rule, schools in the affected areas close immediately at this level. Tomorrow (") + esc(day) + i18(") is not a school day in ") + esc(sel.state) + "."
                  : i18("Schools in the affected areas may be closed tomorrow (") + esc(day) + ").") +
        i18(" Closure applies to affected areas, not necessarily the whole state.</p><ul class='pred-detail'>") +
        sum.reached.map(function (r) { return "<li>" + esc(r.station.name) + i18(": highest ") + esc(r.p.todayMax) + i18(" at ") + esc(L.fmtTime(r.p.todayMaxAt)) + i18(", latest ") + esc(r.p.latest) + "</li>"; }).join("") + "</ul>";
    } else {
      p += '<div class="pred-status ' + (noSchool ? "no_school" : "not_reached") + '">' + esc(noTxt || i18("Not predicted to close")) + "</div>" +
        i18('<p class="pred-detail"><b>Closure threshold not reached.</b> No station in ') + esc(sel.state) + i18(" has reached ") + S.rule.closure.threshold + i18(" today at the latest readings.") +
        (noSchool ? i18(" Tomorrow (") + esc(day) + i18(") is not a school day in ") + esc(sel.state) + "."
                  : i18(" Based on readings so far, no haze closure is predicted for ") + esc(day) + i18(". This can change if readings rise later today.")) + "</p>";
    }
    if (sum.current.length && !off.closed) {
      var outdoor = sum.current.filter(function (s) { return L.meets(s.api, S.rule.outdoor); }).length;
      p += i18('<dl class="facts"><dt>Reached ') + S.rule.closure.threshold + i18(" today</dt><dd>") + (sum.reached.length ? i18("Yes, at ") + sum.reached.length + i18(" station") + (sum.reached.length > 1 ? i18("s") : "") : i18("No")) + "</dd>" +
        i18("<dt>Above ") + S.rule.outdoor.threshold + i18(" now</dt><dd>") + outdoor + i18(" of ") + sum.current.length + i18(" stations (outdoor activities stop in those areas)</dd></dl>");
    }
    p += calendarNote(sum.tomorrowKey);
    p += disclaimer(off.any);
    p += i18('<div class="near"><h3>Stations in ') + esc(sel.state) + i18('</h3><div class="table-wrap"><table class="mini"><thead><tr><th>Station</th><th class="num">IPU</th><th class="hide-sm">Category</th><th>Time</th></tr></thead><tbody>') +
      sum.stations.slice().sort(function (a, b) {
        return (L.stationCurrent(b, n) ? b.api : -1) - (L.stationCurrent(a, n) ? a.api : -1);
      }).map(function (s) {
        var cur = L.stationCurrent(s, n), c = cat(cur ? s.api : null);
        return '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + '><td><span class="dot" style="' + swatch(c ? c.color : T().off) + '"></span>' + esc(s.name) + "</td>" +
          '<td class="num api">' + (cur ? esc(s.api) : "—") + '</td><td class="hide-sm">' + badge(cur ? s.api : null) + "</td><td>" + esc(readingTime(s.observed, n)) + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
    $("prediction").innerHTML = p;
    if (sum.highest) renderTrend($("trend"), sum.highest, i18("Last 24 hours at ") + sum.highest.name + i18(", the highest station in ") + sel.state);
    else $("trend").innerHTML = "";
    renderForecast($("forecast"), sum.highest);
    S.view = makeView(sel, sel.state, sum.current.length + i18(" stations with a current reading"), sum.highest, 0, { state: sel.state }, sel.state, n, false, true);
    if (S.lobbyOn) renderLobby();
    renderAirPath();
    renderSmoke();
    updateZones();
    if (moveMap) { updateTraceDisplay(); updateSmokeOnMap(); }

    if (moveMap) {
      showPlace(null);
      markRef(sum.highest ? sum.highest.id : null);
      var pts = sum.stations.filter(function (s) { return typeof s.lat === "number"; }).map(function (s) { return [s.lon, s.lat]; });
      if (pts.length) flyTo({ bounds: boundsOf(pts), maxZoom: 9.5 });
    }
  }

  // ================================================================ across the border

  function bxSide(side, day) {
    var st = side.status, tk = L.addDaysKey(L.mytDateKey(now()), 1);
    if (st.kind === "official") {
      var c = st.closure;
      return i18('<span class="off-chip">Official</span><b>Schools closed</b><span class="bx-note">') + esc(c.until_further_notice ? i18("until further notice") : rangeText(c.from, c.to)) + "</span>";
    }
    if (st.kind === "may_close") return i18('<span class="pred-chip">Prediction</span><b>May close</b><span class="bx-note">its station reached the closure level today</span>');
    if (st.kind === "not_reached" && day === tk) return i18("<b>Open</b><span class=\"bx-note\">no closure announced; closure level not reached</span>");
    return i18("<b>Open</b><span class=\"bx-note\">no closure announced</span>");
  }

  function stnTxt(r) { return r ? esc(r.station.name) + i18(" (IPU <b>") + esc(r.station.api) + "</b>)" : i18("no station with a current reading"); }

  function bxItem(x, i) {
    var c = x.closed.ref, o = x.open.ref, why;
    if (c && o && c.station.id === o.station.id) {
      why = i18("Both districts' nearest DOE station is ") + stnTxt(c) + i18(", yet the status differs.");
    } else if (x.reversed) {
      why = i18("The open side's nearest station reads higher: ") + stnTxt(o) + i18(", against ") + stnTxt(c) + i18(" for the closed side.");
    } else {
      why = i18("Nearest stations: ") + stnTxt(c) + i18(" for ") + esc(x.closed.district) + ", " + stnTxt(o) + i18(" for ") + esc(x.open.district) + ".";
    }
    return '<article class="bx ' + x.type + (x.reversed ? " reversed" : "") + '">' +
      '<p class="bx-day">' + (x.type === "official" ? i18("Official status") : i18("IPU rule")) + i18(" for ") + esc(dayShort(x.day)) +
      (x.crossState ? i18(" · across a state border") : i18(" · within ") + esc(x.closed.state)) + "</p>" +
      '<div class="bx-sides"><div class="bx-side shut"><span class="bx-name">' + esc(x.closed.district) + '</span><span class="bx-state">' + esc(x.closed.state) + "</span>" +
      '<span class="bx-st">' + bxSide(x.closed, x.day) + "</span></div>" +
      '<div class="bx-mid" aria-hidden="true"><span class="bx-rule"></span><span class="bx-km">' + Math.round(x.km) + i18(" km<br>border</span></div>") +
      '<div class="bx-side open"><span class="bx-name">' + esc(x.open.district) + '</span><span class="bx-state">' + esc(x.open.state) + "</span>" +
      '<span class="bx-st">' + bxSide(x.open, x.day) + "</span></div></div>" +
      '<p class="bx-why">' + why + "</p>" +
      '<button type="button" class="text-btn bx-map" data-i="' + i + i18('">See on map</button></article>');
  }

  function renderBorders() {
    var box = $("borders-body");
    if (!box) return;
    if (!S.borders || !S.rule || !S.data) { box.innerHTML = i18('<p class="muted">The district borders are not available right now.</p>'); return; }
    var list = L.borderSplits(S.borders, stations(), S.ann, S.rule, now());
    S.splits = list;
    var html = i18('<p class="lead-p">Haze does not stop at a district or state line, but school decisions do. Here, neighbouring districts have a different school status for the same day.</p>');
    if (!list.length) {
      html += i18('<p class="off-none">Right now no neighbouring districts have a different school status.</p>');
    } else {
      var shown = S.bordersAll ? list : list.slice(0, 4);
      html += '<div class="bx-list">' + shown.map(bxItem).join("") + "</div>";
      if (list.length > 4) html += '<button type="button" class="text-btn bx-more" id="bx-more">' + (S.bordersAll ? i18("Show fewer") : i18("Show all ") + list.length) + "</button>";
    }
    html += i18('<p class="small muted">Official status: Bernama reports only. "May close" is a prediction from the IPU rule, not an announcement. ') +
      i18("Neighbours come from the data.gov.my district boundaries; each district's station is the nearest DOE station with a current reading to a point well inside the district.</p>");
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll(".bx-map"), function (b) {
      b.addEventListener("click", function () { showSplit(S.splits[+b.getAttribute("data-i")]); });
    });
    if ($("bx-more")) $("bx-more").addEventListener("click", function () { S.bordersAll = !S.bordersAll; renderBorders(); });
  }

  function districtShape(state, district) {
    if (!S.bounds) return null;
    return S.bounds.districts.filter(function (d) { return L.sameState(d.state, state) && L.norm(d.district) === L.norm(district); })[0] || null;
  }

  function showSplit(x) {
    if (!x) return;
    var a = districtShape(x.closed.state, x.closed.district), b = districtShape(x.open.state, x.open.district);
    var feats = [], pts = [];
    [[a, "shut"], [b, "open"]].forEach(function (p) {
      if (!p[0]) return;
      feats.push({ type: "Feature", properties: { side: p[1] }, geometry: { type: "MultiPolygon", coordinates: p[0].polygons } });
      pts.push([p[0].bbox[0], p[0].bbox[1]], [p[0].bbox[2], p[0].bbox[3]]);
    });
    M.pair = { type: "FeatureCollection", features: feats };
    M.pairType = x.type;
    renderLegend();
    if (M.map && M.styleReady && M.map.getSource("pair")) M.map.getSource("pair").setData(M.pair);
    if (!pts.length) pts = [x.point];
    var target = isMobile() ? document.querySelector(".map-wrap") : $("map");
    if (target) target.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
    flyTo({ bounds: boundsOf(pts), maxZoom: 9 });
  }

  function clearSplit() {
    if (!M.pair) return;
    M.pair = null;
    renderLegend();
    if (M.map && M.styleReady && M.map.getSource("pair")) M.map.getSource("pair").setData({ type: "FeatureCollection", features: [] });
  }

  // ================================================================ rule simulator (a "what if", never a prediction)

  var SIM = { key: "interim", threshold: 180, days: 1, onMap: false, built: false };

  function simRule() {
    if (SIM.key === "custom") return { key: "custom", threshold: SIM.threshold, comparison: ">=", days: SIM.days };
    return L.SIM_RULES[SIM.key];
  }
  function baseRule() { return { key: "ptjk", threshold: S.rule.closure.threshold, comparison: S.rule.closure.comparison, days: 1 }; }

  function ruleWords(r) {
    if (r.key === "interim") return i18("a reading over 180, or over 150 on 3 days in a row");
    var cmp = r.comparison === ">" ? i18("over ") + r.threshold : r.threshold + i18(" or more");
    return i18("a reading of ") + cmp + (r.days > 1 ? i18(" on ") + r.days + i18(" days in a row") : "");
  }

  function buildSim() {
    var box = $("sim-body");
    if (!box || SIM.built) return;
    SIM.built = true;
    var opts = [["ptjk", i18("Current rule"), i18("200 or more")], ["interim", i18("Earlier rule"), i18("8 to 14 Oct")], ["t150", i18("Stricter"), i18("150 or more")], ["custom", i18("Your own"), i18("set a level")]];
    box.innerHTML = i18('<p class="lead-p">Apply a different closure rule to the same official DOE readings and see where it would have been met, today and over the last 7 days.</p>') +
      '<div class="sim-opts" role="group" aria-label="Rule to try">' + opts.map(function (o) {
        return '<button type="button" class="sim-opt" data-k="' + o[0] + '" aria-pressed="false"><b>' + o[1] + "</b><span>" + o[2] + "</span></button>";
      }).join("") + "</div>" +
      i18('<div class="sim-custom" id="sim-custom" hidden><label>Closure level <output id="sim-t-out"></output>') +
      '<input type="range" id="sim-t" min="101" max="300" step="1"></label>' +
      i18('<label>Days in a row <select id="sim-d"><option value="1">1 (any reading that day)</option><option value="2">2</option><option value="3">3</option></select></label></div>') +
      '<div id="sim-out" aria-live="polite"></div>';
    Array.prototype.forEach.call(box.querySelectorAll(".sim-opt"), function (b) {
      b.addEventListener("click", function () { SIM.key = b.getAttribute("data-k"); renderSim(); });
    });
    $("sim-t").value = SIM.threshold;
    $("sim-t").addEventListener("input", function () { SIM.threshold = +this.value; renderSim(); });
    $("sim-d").addEventListener("change", function () { SIM.days = +this.value; renderSim(); });
  }

  function renderSim() {
    var box = $("sim-body");
    if (!box || !S.rule || !S.data) return;
    buildSim();
    Array.prototype.forEach.call(box.querySelectorAll(".sim-opt"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-k") === SIM.key)); });
    $("sim-custom").hidden = SIM.key !== "custom";
    $("sim-t-out").textContent = SIM.threshold;
    var r = simRule(), b = baseRule(), res = L.simulateRule(stations(), S.daily, r, b, now(), 7);
    S.simRes = res;
    var t = res.days[res.days.length - 1], isBase = r.key === "ptjk";
    var plural = function (n, w) { return n + " " + w + (n === 1 ? "" : i18("s")); };
    var html = '<div class="fc-head"><h3>' + (isBase ? i18("The current rule") : i18("If the rule were ") + esc(ruleWords(r))) + i18('</h3><span class="fc-tag">Simulation, not official</span></div>');
    html += i18('<p class="sim-head">Today: <b>') + plural(t.sim, i18("station")) + "</b>" + (t.sim ? i18(" in ") + plural(t.simStates.length, i18("state")) : "") + " " + (t.sim === 1 ? i18("meets") : i18("meet")) + " " + (isBase ? i18("the current rule (") + esc(ruleWords(b)) + ")" : i18("this rule")) +
      (isBase ? "." : i18(". Under the current rule: <b>") + plural(t.base, i18("station")) + "</b>" + (t.base ? i18(" in ") + plural(t.baseStates.length, i18("state")) : "") + ".") + "</p>";
    if (t.sim) html += '<p class="sim-states">' + t.simStates.map(esc).join(" · ") + "</p>";
    var chip = function (row) { return '<button type="button" class="sim-chip" data-id="' + esc(row.station.id) + '">' + esc(row.station.name) + " <b>" + esc(row.high) + "</b></button>"; };
    if (!isBase && res.added.length) {
      html += i18('<p class="sim-lbl">Met only under this rule (') + res.added.length + i18('), highest reading today:</p><div class="sim-chips">') + res.added.slice(0, 12).map(chip).join("") +
        (res.added.length > 12 ? i18('<span class="muted small">and ') + (res.added.length - 12) + i18(" more</span>") : "") + "</div>";
    }
    if (!isBase && res.removed.length) {
      html += i18('<p class="sim-lbl">Met under the current rule but not this one (') + res.removed.length + "):</p><div class=\"sim-chips\">" + res.removed.slice(0, 12).map(chip).join("") + "</div>";
    }
    if (isBase && res.both.length) html += '<div class="sim-chips">' + res.both.slice(0, 12).map(chip).join("") + "</div>";
    html += '<div class="sim-chart" id="sim-chart"></div>';
    var thin = res.days.filter(function (d) { return d.unknown > 0 && d.key !== res.todayKey; }).length;
    if (thin) html += i18('<p class="small muted">Days marked with a dot had too few hourly readings at some stations to tell; those stations are not counted. Days without data fill in from DOE\'s hourly tables over the next hourly updates.</p>');
    html += '<button type="button" class="text-btn sim-map" id="sim-map" aria-pressed="' + SIM.onMap + '">' + (SIM.onMap ? i18("Hide from the map") : i18("Show today's stations on the map")) + "</button>";
    html += i18('<p class="disclaimer"><b>A "what if", not a prediction.</b> This applies a different rule to the same official DOE readings. It counts monitoring stations, not schools: closures are decided for whole districts or states, and only by KPM, state governments, JPN and PPD.</p>');
    $("sim-out").innerHTML = html;
    drawSimChart($("sim-chart"), res, r, b);
    Array.prototype.forEach.call($("sim-out").querySelectorAll(".sim-chip"), function (c) {
      c.addEventListener("click", function () { select({ type: "station", id: c.getAttribute("data-id") }); });
    });
    $("sim-map").addEventListener("click", function () {
      SIM.onMap = !SIM.onMap; renderSim();
      if (SIM.onMap) { var target = isMobile() ? document.querySelector(".map-wrap") : $("map"); if (target) target.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" }); flyHome(); }
    });
    markSim();
  }

  function markSim() {
    var hits = {};
    if (SIM.onMap && S.simRes) S.simRes.today.forEach(function (r) { if (r.sim === true) hits[r.station.id] = true; });
    Object.keys(M.markers).forEach(function (k) { M.markers[k].btn.classList.toggle("sim-hit", !!hits[k]); });
    renderLegend();
  }

  function drawSimChart(box, res, r, b) {
    if (!box) return;
    var days = res.days, W = Math.max(300, box.clientWidth || 520), H = 190, padL = 28, padR = 6, padT = 18, padB = 34;
    var max = Math.max(4, Math.max.apply(null, days.map(function (d) { return Math.max(d.sim, d.base); })));
    max = Math.ceil(max / 4) * 4;
    var gw = (W - padL - padR) / days.length, bw = Math.min(22, gw * 0.32);
    var sy = function (v) { return H - padB - v / max * (H - padT - padB); };
    var same = r.key === "ptjk";
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img",
      "aria-label": i18("Stations meeting the rule each day, last 7 days: ") + days.map(function (d) { return L.dayName(d.key) + " " + d.sim + (same ? "" : i18(" (current rule ") + d.base + ")"); }).join(", ") });
    for (var g = 0; g <= max; g += max / 4) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(g), y2: sy(g), stroke: T().grid }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: T().axis, "text-anchor": "end" }, String(g)));
    }
    var total = res.today.length;
    days.forEach(function (d, i) {
      var cx = padL + gw * (i + 0.5), isToday = d.key === res.todayKey;
      var lbl0 = L.dayName(d.key) + " " + parseInt(d.key.slice(8), 10);
      if (!isToday && total && d.unknown >= total / 2) {
        // most stations have no saved readings for this day: show no bars rather than zeros
        svg.appendChild(svgEl("text", { x: cx, y: sy(0) - 6, "font-size": 11, fill: T().axis, "text-anchor": "middle" }, gw < 60 ? "–" : i18("no data")));
        svg.appendChild(svgEl("text", { x: cx, y: H - 16, "font-size": 11, fill: T().axis, "text-anchor": "middle" }, lbl0));
        return;
      }
      var bars = same ? [[d.sim, "var(--fc)", 0]] : [[d.sim, "var(--fc)", -bw / 2 - 1], [d.base, "var(--marker-off)", bw / 2 + 1]];
      bars.forEach(function (bb) {
        var x = cx + bb[2] - bw / 2, y = sy(bb[0]), h = Math.max(bb[0] ? 2 : 0, sy(0) - y);
        svg.appendChild(svgEl("rect", { x: x, y: sy(0) - h, width: bw, height: h, rx: 3, fill: bb[1], "class": bb[1] === "var(--fc)" ? "series sim-bar" : "" }));
        svg.appendChild(svgEl("text", { x: x + bw / 2, y: sy(0) - h - 4, "font-size": 11, "font-weight": 700, fill: T().ink, "text-anchor": "middle" }, String(bb[0])));
      });
      var lbl = L.dayName(d.key) + " " + parseInt(d.key.slice(8), 10);
      svg.appendChild(svgEl("text", { x: cx, y: H - 16, "font-size": 11, fill: isToday ? T().ink : T().axis, "font-weight": isToday ? 700 : 400, "text-anchor": "middle" }, isToday ? i18("Today") : lbl));
      if (d.unknown > 0 && !isToday) svg.appendChild(svgEl("circle", { cx: cx, cy: H - 5, r: 2.4, fill: T().axis }));
    });
    box.innerHTML = "";
    var cap = document.createElement("p");
    cap.className = "sim-legend-row small";
    cap.innerHTML = '<span><i style="background:var(--fc)"></i>' + (same ? i18("Current rule") : i18("This rule")) + "</span>" + (same ? "" : i18('<span><i style="background:var(--marker-off)"></i>Current rule (') + esc(ruleWords(b)) + ")</span>") +
      i18('<span class="muted">Stations meeting the rule each day</span>');
    box.appendChild(cap);
    var wrap = document.createElement("div"); wrap.className = "chart"; wrap.appendChild(svg); box.appendChild(wrap);
  }

  // ================================================================ share & lobby screen

  /* Plain facts about the current selection, used by the share card and the lobby screen. */
  function makeView(sel, title, sub, st, km, place, stateName, n, isStation, isState) {
    var v = { title: title, sub: sub, url: location.origin + location.pathname + (location.hash || ""), station: st, km: km,
              isStation: isStation, isState: !!isState, api: st ? st.api : null, cat: st ? cat(st.api) : null,
              at: st ? L.parseTime(st.observed) : null, status: null, statusKind: "none", statusNote: "" };
    var o = S.ann && place && place.state ? L.officialStatus(place, n, S.ann) : null;
    if (o && o.tomorrow) {
      var c = o.tomorrow;
      v.statusKind = "official";
      v.status = i18("Schools officially closed ") + (c.until_further_notice ? i18("until further notice") : (o.today ? i18("until ") + dayShort(o.lastDay || c.to) : rangeText(c.from, o.lastDay || c.to)));
      v.statusNote = i18("Announced by ") + (loc(c, "announced_by").split(",")[0]) + i18(", reported by Bernama");
    } else if (o && o.today) {
      v.statusKind = "official";
      v.status = i18("Official closure ends today");
      v.statusNote = i18("Reported by Bernama");
    } else if (st && S.rule && !isState) {
      var p = L.predict(st, S.rule, n, stateName);
      if (p.available) {
        v.statusKind = p.level === "may_close" ? "may_close" : "predicted";
        v.status = p.status;
        v.statusNote = i18("Prediction from the IPU rule, not an announcement");
      }
    } else if (isState && S.rule) {
      var sum = L.stateSummary(stateName, stations(), S.rule, n);
      v.statusKind = sum.reached.length ? "may_close" : "predicted";
      v.status = sum.reached.length ? i18("Closure level reached at ") + sum.reached.length + i18(" station") + (sum.reached.length > 1 ? i18("s") : "") : i18("Closure level not reached");
      v.statusNote = i18("Prediction from the IPU rule, not an announcement");
    }
    return v;
  }

  function shareText(v) {
    var lines = [v.title + (v.sub ? " (" + v.sub + ")" : "")];
    if (v.station) {
      lines.push(i18("IPU ") + v.api + " (" + v.cat.label + ")" + (v.isStation ? "" : v.isState ? i18(" at ") + v.station.name + i18(", the highest station now") :
        i18(" at ") + v.station.name + i18(" station, ") + (v.km < 1 ? i18("under 1 km") : Math.round(v.km) + i18(" km")) + i18(" away")) +
        i18(". Official DOE reading for ") + L.fmtDateTime(v.at) + ".");
    }
    if (v.status) lines.push(i18("Schools: ") + v.status + (v.statusKind === "official" ? " (" + v.statusNote + ")" : i18(" (prediction, not an official announcement)")) + ".");
    lines.push(i18("Live: ") + v.url);
    return lines.join("\n");
  }

  function sharePanelHTML() {
    var canShare = !!navigator.share;
    return '<p class="share-preview"></p><div class="share-btns">' +
      i18('<a class="share-wa" id="share-wa" target="_blank" rel="noopener">Send on WhatsApp</a>') +
      '<button type="button" id="share-img">' + (canShare ? i18("Share as image") : i18("Download image")) + "</button>" +
      i18('<button type="button" id="share-copy">Copy text</button>') +
      (canShare ? i18('<button type="button" id="share-native">More…</button>') : "") + "</div>" +
      '<p class="small muted share-note" id="share-msg"></p>';
  }

  function openShare() {
    var v = S.view, panel = $("share-panel");
    if (!v) return;
    if (!panel.hidden) { panel.hidden = true; $("share-btn").setAttribute("aria-expanded", "false"); return; }
    panel.innerHTML = sharePanelHTML();
    var text = shareText(v);
    panel.querySelector(".share-preview").textContent = text;
    $("share-wa").href = "https://wa.me/?text=" + encodeURIComponent(text);
    $("share-copy").addEventListener("click", function () {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { $("share-msg").textContent = i18("Copied."); })
        .catch(function () { $("share-msg").textContent = i18("Copy is not available here; select the text above instead."); });
    });
    if ($("share-native")) $("share-native").addEventListener("click", function () {
      navigator.share({ title: v.title + i18(": IPU ") + (v.api || ""), text: text }).catch(function () { /* cancelled */ });
    });
    $("share-img").addEventListener("click", function () { shareImage(v); });
    panel.hidden = false;
    $("share-btn").setAttribute("aria-expanded", "true");
  }

  function wrapText(ctx, text, maxW) {
    var words = String(text).split(" "), lines = [], line = "";
    words.forEach(function (w) {
      var t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }

  /* A 1080 x 1350 image card, drawn on a canvas in the current theme. */
  function drawCard(v) {
    var W = 1080, H = 1350, c = document.createElement("canvas");
    c.width = W; c.height = H;
    var x = c.getContext("2d"), neon = themeName() === "neon";
    var paper = neon ? "#070b18" : "#ffffff", ink = neon ? "#eaf3ff" : "#172a35", ink2 = neon ? "#b9c8e8" : "#3c505a";
    var disp = "'Bricolage Grotesque', 'Segoe UI', sans-serif", text = "'Instrument Sans', 'Segoe UI', sans-serif";
    var col = v.cat ? v.cat.color : (neon ? "#4b5a80" : "#9aa9ae"), band = 0;
    x.fillStyle = col; x.fillRect(0, 0, W, 14);
    x.fillStyle = ink2; x.font = "600 34px " + text; x.fillText(i18("IPU Malaysia"), 72, 96);
    x.fillStyle = ink; x.font = "800 64px " + disp;
    var ty = 180;
    wrapText(x, v.title, W - 144).slice(0, 2).forEach(function (l) { x.fillText(l, 72, ty); ty += 72; });
    if (v.station) {
      if (neon) { x.shadowColor = col; x.shadowBlur = 40; }
      x.fillStyle = neon ? col : ink; x.font = "800 260px " + disp; x.fillText(String(v.api), 60, ty + 230);
      x.shadowBlur = 0;
      var nw = x.measureText(String(v.api)).width;
      x.fillStyle = col; x.beginPath(); x.arc(60 + nw + 50, ty + 150, 22, 0, Math.PI * 2); x.fill();
      x.fillStyle = ink; x.font = "700 52px " + disp;
      wrapText(x, v.cat.label, W - (60 + nw + 86) - 60).slice(0, 2).forEach(function (l, i) { x.fillText(l, 60 + nw + 86, ty + 168 + i * 58); });
      ty += 300;
      x.fillStyle = ink2; x.font = "500 36px " + text;
      var where = v.isStation ? i18("IPU at this DOE station.") : v.isState ? i18("Highest now, at ") + v.station.name + i18(" station.") : i18("IPU at ") + v.station.name + i18(" station, ") + (v.km < 1 ? i18("under 1 km") : Math.round(v.km) + i18(" km")) + i18(" away. Not measured at the place itself.");
      wrapText(x, where, W - 144).slice(0, 2).forEach(function (l) { x.fillText(l, 72, ty); ty += 46; });
      x.fillText(i18("Official DOE reading for ") + L.fmtDateTime(v.at) + ".", 72, ty);
      band = ty + 34;
      ty += 76;
    }
    if (v.status) {
      var off = v.statusKind === "official", warn = v.statusKind === "may_close";
      var bg = off || warn ? (neon ? "rgba(255,61,129,.16)" : "#fbeae6") : (neon ? "rgba(25,227,177,.10)" : "#e8f4ec");
      var bd = off || warn ? (neon ? "#ff3d81" : "#b42318") : (neon ? "#19e3b1" : "#6fae7e");
      x.font = "700 50px " + disp;
      var sl = wrapText(x, v.status, W - 200).slice(0, 3);
      x.font = "500 30px " + text;
      var nl = wrapText(x, v.statusNote, W - 200).slice(0, 2);
      var bh = (off ? 120 : 50) + sl.length * 60 + 16 + nl.length * 40 + 30;
      x.fillStyle = bg; x.strokeStyle = bd; x.lineWidth = 5;
      x.beginPath(); x.roundRect ? x.roundRect(60, ty, W - 120, bh, 28) : x.rect(60, ty, W - 120, bh); x.fill(); x.stroke();
      if (off) {
        x.fillStyle = bd; x.beginPath(); x.roundRect ? x.roundRect(96, ty + 34, 190, 54, 27) : x.rect(96, ty + 34, 190, 54); x.fill();
        x.fillStyle = neon ? "#1a0410" : "#ffffff"; x.font = "700 30px " + text; x.fillText(i18("OFFICIAL"), 128, ty + 72);
      }
      var sy = ty + (off ? 120 : 50) + 44;
      x.fillStyle = ink; x.font = "700 50px " + disp;
      sl.forEach(function (l) { x.fillText(l, 96, sy); sy += 60; });
      sy += 6;
      x.fillStyle = ink2; x.font = "500 30px " + text;
      nl.forEach(function (l) { x.fillText(l, 96, sy); sy += 40; });
      ty += bh + 50;
    }
    x.fillStyle = ink2; x.font = "500 30px " + text;
    wrapText(x, i18("Readings: Department of Environment Malaysia (APIMS). Official closures: Bernama reports. Predictions are not closure announcements."), W - 144)
      .forEach(function (l) { x.fillText(l, 72, ty); ty += 42; });
    x.fillStyle = ink2; x.font = "500 28px " + text; x.fillText(i18("Live, updated every hour:"), 72, H - 124);
    x.fillStyle = ink; x.font = "700 34px " + text; x.fillText(location.host + location.pathname.replace(/\/$/, ""), 72, H - 80);
    // background last, behind everything drawn above
    x.globalCompositeOperation = "destination-over";
    x.fillStyle = col; x.globalAlpha = neon ? 0.18 : 0.12; x.fillRect(0, 0, W, band || 300); x.globalAlpha = 1;
    x.fillStyle = paper; x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = "source-over";
    return c;
  }

  function shareImage(v) {
    var go = function () {
      var c = drawCard(v), name = "ipu-" + String(v.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".png";
      c.toBlob(function (blob) {
        if (!blob) { $("share-msg").textContent = i18("The image could not be made on this device."); return; }
        var file = typeof File === "function" ? new File([blob], name, { type: "image/png" }) : null;
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: v.title, text: shareText(v) }).catch(function () { /* cancelled */ });
        } else {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob); a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
          $("share-msg").textContent = i18("Image saved. You can attach it in WhatsApp.");
        }
      }, "image/png");
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go); else go();
  }

  // ---- lobby screen: one place, full screen, refreshes itself

  var WAKE = null;
  function keepAwake() {
    if (!navigator.wakeLock || !S.lobbyOn) return;
    navigator.wakeLock.request("screen").then(function (l) { WAKE = l; }).catch(function () { WAKE = null; });
  }

  function openLobby() {
    if (!S.view) return;
    S.lobbyOn = true;
    document.body.classList.add("lobby-open");
    $("lobby").hidden = false;
    renderLobby();
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(function () { /* not allowed: stay as an overlay */ });
    keepAwake();
    if (location.hash.indexOf("screen=1") < 0) { try { history.replaceState(null, "", location.hash + (location.hash ? "&" : "#") + "screen=1"); } catch (e) { /* ignore */ } }
    $("lobby-exit").focus();
  }

  function closeLobby() {
    S.lobbyOn = false;
    document.body.classList.remove("lobby-open");
    $("lobby").hidden = true;
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    if (WAKE) { WAKE.release().catch(function () {}); WAKE = null; }
    try { history.replaceState(null, "", location.hash.replace(/&?screen=1/, "") || location.pathname); } catch (e) { /* ignore */ }
  }

  function renderLobby() {
    var v = S.view, box = $("lobby-body"), n = now();
    if (!v || !box) return;
    var col = v.cat ? v.cat.color : "var(--marker-off)";
    $("lobby").style.setProperty("--lc", col);
    var stale = S.data && L.freshness(S.data, n).stale;
    box.innerHTML = '<p class="lb-title">' + esc(v.title) + "</p>" +
      (v.station ? '<div class="lb-reading"><span class="lb-num">' + esc(v.api) + '</span><span class="lb-meta"><span class="lb-cat"><i></i>' + esc(v.cat.label) + "</span>" +
        '<span class="lb-where">' + esc(v.isStation ? i18("IPU at this DOE station") : v.isState ? i18("Highest now, at ") + v.station.name : i18("IPU at ") + v.station.name + i18(" station, ") + (v.km < 1 ? i18("under 1 km") : Math.round(v.km) + i18(" km")) + i18(" away")) +
        "</span></span></div>" : i18('<p class="lb-none">No current official reading</p>')) +
      (v.status ? '<div class="lb-status ' + esc(v.statusKind) + '">' + (v.statusKind === "official" ? i18('<span class="off-chip">Official</span>') : "") +
        "<b>" + esc(v.status) + "</b><span>" + esc(v.statusNote) + "</span></div>" : "") +
      '<p class="lb-foot">' + (v.at ? i18("Official DOE reading for ") + esc(L.fmtDateTime(v.at)) + ". " : "") +
      (stale ? i18("<b>Data may be outdated.</b> ") : "") + i18("Refreshes by itself. ") + esc(location.host + location.pathname) + "</p>";
    $("lobby-clock").textContent = L.fmtTime(n);
  }

  // ================================================================ charts

  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function niceMax(v, floor) { return Math.ceil(Math.max(v, floor) / 50) * 50; }

  function renderTrend(box, st, titleText) {
    box.innerHTML = "";
    box.className = "trend";
    var h = document.createElement("h3"); h.textContent = titleText; box.appendChild(h);
    var n = now();
    var pts = (st.hourly || []).filter(function (p) { return p[1] !== null && p[1] !== undefined; })
      .map(function (p) { return { t: L.parseTime(p[0]), y: p[1] }; })
      .filter(function (p) { return p.t && (n - p.t) <= 30 * 3600000; });
    if (pts.length < 2) {
      var p0 = document.createElement("p"); p0.className = "muted"; p0.textContent = i18("Not enough hourly readings yet to draw a trend for this station.");
      box.appendChild(p0); return;
    }
    var lastPt = pts[pts.length - 1];
    if ((n - lastPt.t) / 3600000 > L.STALE_HOURS) {
      var warn = document.createElement("p"); warn.className = "note";
      warn.textContent = i18("Outdated: the newest reading in this chart is from ") + L.fmtDateTime(lastPt.t) + " (" + L.ago(lastPt.t, n) + ").";
      box.appendChild(warn);
    }
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    var W = Math.max(280, chart.clientWidth || 400), H = 200, padL = 32, padR = 8, padT = 14, padB = 26;
    var t0 = pts[0].t.getTime(), t1 = lastPt.t.getTime();
    var ymax = niceMax(Math.max.apply(null, pts.map(function (p) { return p.y; })), 220);
    var sx = function (t) { return padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": i18("Hourly IPU at ") + st.name + i18(" over the last 24 hours") });
    for (var g = 0; g <= ymax; g += 50) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(g), y2: sy(g), stroke: T().grid }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: T().axis, "text-anchor": "end" }, String(g)));
    }
    var step = 6 * 3600000;
    for (var tt = Math.ceil(t0 / step) * step; tt <= t1; tt += step) {
      svg.appendChild(svgEl("text", { x: sx(tt), y: H - 6, "font-size": 11, fill: T().axis, "text-anchor": "middle" }, L.fmtTime(new Date(tt))));
    }
    if (S.rule) {
      [[S.rule.outdoor.threshold, i18("100: outdoor activities stop above this"), T().outdoor], [S.rule.closure.threshold, i18("200: school-closure level"), T().closure]].forEach(function (r) {
        svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(r[0]), y2: sy(r[0]), stroke: r[2], "stroke-dasharray": "4 4" }));
        svg.appendChild(svgEl("text", { x: padL + 4, y: sy(r[0]) - 5, "font-size": 11, fill: r[2], stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, r[1]));
      });
    }
    var area = "M" + sx(t0).toFixed(1) + " " + sy(0).toFixed(1) + " " + pts.map(function (p) { return "L" + sx(p.t.getTime()).toFixed(1) + " " + sy(p.y).toFixed(1); }).join(" ") + " L" + sx(t1).toFixed(1) + " " + sy(0).toFixed(1) + " Z";
    svg.appendChild(svgEl("path", { d: area, fill: T().series, opacity: T().area }));
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + sx(p.t.getTime()).toFixed(1) + " " + sy(p.y).toFixed(1); }).join(" ");
    var line = svgEl("path", { d: d, fill: "none", stroke: T().series, color: T().series, "stroke-width": 2.2, "class": "series", "stroke-linejoin": "round", "stroke-linecap": "round" });
    svg.appendChild(line);
    svg.appendChild(svgEl("circle", { cx: sx(t1), cy: sy(lastPt.y), r: 4.5, fill: T().series, stroke: T().halo, "stroke-width": 2 }));
    var cross = svgEl("line", { x1: 0, x2: 0, y1: padT, y2: H - padB, stroke: T().ink, "stroke-width": 1, opacity: 0 });
    var dot = svgEl("circle", { r: 4.5, fill: T().series, stroke: T().halo, "stroke-width": 2, opacity: 0 });
    svg.appendChild(cross); svg.appendChild(dot);
    var overlay = svgEl("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
    function hover(ev) {
      var rect = svg.getBoundingClientRect(), px = (ev.clientX - rect.left) * (W / rect.width), best = pts[0];
      pts.forEach(function (p) { if (Math.abs(sx(p.t.getTime()) - px) < Math.abs(sx(best.t.getTime()) - px)) best = p; });
      var x = sx(best.t.getTime());
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("opacity", 0.3);
      dot.setAttribute("cx", x); dot.setAttribute("cy", sy(best.y)); dot.setAttribute("opacity", 1);
      showTip("<b>" + best.y + "</b> " + esc(cat(best.y).label) + "<br>" + esc(L.fmtDateTime(best.t)), ev.clientX, ev.clientY);
    }
    overlay.addEventListener("mousemove", hover);
    overlay.addEventListener("touchstart", function (ev) { if (ev.touches[0]) hover(ev.touches[0]); }, { passive: true });
    overlay.addEventListener("mouseleave", function () { cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip(); });
    svg.appendChild(overlay);
    chart.appendChild(svg);
    if (SOUND.on) {
      box.insertBefore(listenControls(pts, st, function (i) {
        if (i < 0) { cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); return; }
        var p = pts[i], x = sx(p.t.getTime());
        cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("opacity", 0.45);
        dot.setAttribute("cx", x); dot.setAttribute("cy", sy(p.y)); dot.setAttribute("opacity", 1);
      }), chart);
    }
    if (!REDUCE) {
      var len = line.getTotalLength ? line.getTotalLength() : 0;
      if (len) {
        line.style.strokeDasharray = len; line.style.strokeDashoffset = len;
        line.getBoundingClientRect();
        line.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)";
        line.style.strokeDashoffset = "0";
      }
    }
    var det = document.createElement("details");
    det.className = "inline-details";
    det.innerHTML = i18("<summary>Show these readings as a table</summary><div class='table-wrap'><table class='mini'><thead><tr><th>Hour</th><th class='num'>IPU</th><th>Category</th></tr></thead><tbody>") +
      pts.slice().reverse().map(function (p) { return "<tr><td>" + esc(L.fmtDateTime(p.t)) + "</td><td class='num'>" + p.y + "</td><td>" + badge(p.y) + "</td></tr>"; }).join("") +
      "</tbody></table></div>";
    box.appendChild(det);
    var src = document.createElement("p"); src.className = "small muted";
    src.textContent = i18("Source: DOE APIMS hourly table for ") + st.name + " (" + st.id + i18("). Each value is DOE's 24-hour running average for that hour.");
    box.appendChild(src);
  }

  function renderDosm() {
    var box = $("dosm"), d = S.dosm;
    if (!d || !d.rows || !d.rows.length) { box.innerHTML = i18('<p class="muted">DOSM history has not been downloaded yet. It is added by the hourly update.</p>'); return; }
    var want = [["pm25", "PM2.5", T().series], ["pm10", "PM10", T().seriesB]];
    var series = want.map(function (w) {
      return { name: w[1], color: w[2], pts: d.rows.filter(function (r) { return r[1] === w[0] && r[2] !== null; })
        .map(function (r) { return { t: new Date(r[0] + "T00:00:00Z"), y: r[2], date: r[0] }; }) };
    }).filter(function (s) { return s.pts.length > 1; });
    var month = function (key) { return L.fmtDayKey(key).replace(/^\w+ \d+ /, ""); };
    box.innerHTML = i18("<p>Monthly national average of fine particles in the air (µg/m³), from DOSM. Haze years stand out as peaks. ") +
      i18("This is background only: it is not IPU, not per station and not current. Latest month: ") + esc(d.last_month ? month(d.last_month) : "—") + ".</p>";
    if (!series.length) { box.insertAdjacentHTML("beforeend", i18('<p class="muted">No PM2.5 or PM10 values in the DOSM file.</p>')); return; }
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    var all = []; series.forEach(function (s) { all = all.concat(s.pts); });
    var W = Math.max(280, chart.clientWidth || 400), H = 210, padL = 30, padR = 46, padT = 10, padB = 24;
    var t0 = Math.min.apply(null, all.map(function (p) { return p.t.getTime(); })), t1 = Math.max.apply(null, all.map(function (p) { return p.t.getTime(); }));
    var ymax = Math.ceil(Math.max.apply(null, all.map(function (p) { return p.y; })) / 10) * 10;
    var sx = function (t) { return padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": i18("Monthly national average PM2.5 and PM10, DOSM") });
    var gstep = ymax > 60 ? 20 : 10;
    for (var g = 0; g <= ymax; g += gstep) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(g), y2: sy(g), stroke: T().grid }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: T().axis, "text-anchor": "end" }, String(g)));
    }
    var y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    var ystep = Math.max(1, Math.ceil((y1 - y0 + 1) / Math.max(2, Math.floor(W / 70))));
    for (var yr = y0; yr <= y1; yr += ystep) {
      var tx = Date.UTC(yr, 0, 1);
      if (tx >= t0) svg.appendChild(svgEl("text", { x: sx(tx), y: H - 5, "font-size": 11, fill: T().axis, "text-anchor": "middle" }, String(yr)));
    }
    series.forEach(function (s) {
      var dd = s.pts.map(function (p, i) { return (i ? "L" : "M") + sx(p.t.getTime()).toFixed(1) + " " + sy(p.y).toFixed(1); }).join(" ");
      svg.appendChild(svgEl("path", { d: dd, fill: "none", stroke: s.color, color: s.color, "stroke-width": 2, "stroke-linejoin": "round", "class": "series" }));
      var last = s.pts[s.pts.length - 1];
      svg.appendChild(svgEl("text", { x: sx(last.t.getTime()) + 5, y: sy(last.y) + 4, "font-size": 11.5, fill: T().ink }, s.name));
    });
    var cross = svgEl("line", { y1: padT, y2: H - padB, stroke: T().ink, opacity: 0 });
    svg.appendChild(cross);
    var overlay = svgEl("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
    function hover(ev) {
      var rect = svg.getBoundingClientRect(), px = (ev.clientX - rect.left) * (W / rect.width), ref = series[0].pts, best = ref[0];
      ref.forEach(function (p) { if (Math.abs(sx(p.t.getTime()) - px) < Math.abs(sx(best.t.getTime()) - px)) best = p; });
      cross.setAttribute("x1", sx(best.t.getTime())); cross.setAttribute("x2", sx(best.t.getTime())); cross.setAttribute("opacity", 0.3);
      showTip("<b>" + esc(month(best.date)) + "</b><br>" + series.map(function (s) {
        var mm = s.pts.filter(function (p) { return p.date === best.date; })[0];
        return esc(s.name) + ": " + (mm ? mm.y.toFixed(1) + " µg/m³" : "—");
      }).join("<br>"), ev.clientX, ev.clientY);
    }
    overlay.addEventListener("mousemove", hover);
    overlay.addEventListener("touchstart", function (ev) { if (ev.touches[0]) hover(ev.touches[0]); }, { passive: true });
    overlay.addEventListener("mouseleave", function () { cross.setAttribute("opacity", 0); hideTip(); });
    svg.appendChild(overlay);
    chart.appendChild(svg);
    box.insertAdjacentHTML("beforeend", '<div class="legend-row">' + series.map(function (s) {
      return '<span><i style="' + swatch(s.color) + '"></i>' + esc(s.name) + "</span>";
    }).join("") + i18('</div><p class="small muted" style="margin-top:8px">Source: <a href="') + esc(d.source.page) + i18('" rel="noopener">OpenDOSM, Monthly Air Pollution</a> (') + esc(d.source.licence) +
      i18("). Source agencies: DOE and DOSM.</p>"));
  }

  // ================================================================ how the IPU works

  var LAG = { hours: 6, level: 200 };

  function renderExplainer() {
    var box = $("explainer-body"), r = S.rule;
    var o = r ? r.outdoor.threshold : 100, c = r ? r.closure.threshold : 200;
    var syms = [["**", i18("PM2.5, fine particles (the main cause of haze)")], ["*", i18("PM10, larger particles")], ["a", i18("Sulphur dioxide (SO\u2082)")],
                ["b", i18("Nitrogen dioxide (NO\u2082)")], ["c", i18("Ozone (O\u2083)")], ["d", i18("Carbon monoxide (CO)")], ["&", i18("Two or more pollutants with the same index")]];
    var rows = L.categories().map(function (k) {
      var range = k.max === Infinity ? "300+" : k.min + "–" + k.max;
      var school = k.max <= 50 ? i18("Normal") : k.max <= 100 ? i18("Normal") : k.max <= 200 ? i18("Outdoor activities stop above ") + o + i18("; schools close once it reaches ") + c : i18("Schools closed");
      return "<tr><td>" + badge(k.min === 0 ? 0 : k.min) + '</td><td class="num">' + range + "</td><td>" + esc(school) + "</td></tr>";
    }).join("");
    box.innerHTML = '<div class="explain-grid">' +
      i18("<div><h3>One number from six pollutants</h3><p>Each DOE station measures six pollutants. Each gets its own sub-index, and the IPU you see is the highest of them. ") +
      i18("The small symbol APIMS shows beside a reading says which pollutant set it:</p><dl class=\"sym-list\">") +
      syms.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("") + "</dl></div>" +
      i18("<div><h3>Why it lags behind the haze you see</h3><p>For PM2.5 and PM10, the particles that make haze, DOE uses a <b>24-hour running average</b>: every hourly IPU reflects the whole last day. ") +
      i18("So thick smoke takes hours to push the IPU up, and the IPU stays high for hours after the air clears. Gases use shorter averages: one hour for ozone, sulphur dioxide and nitrogen dioxide, eight hours for carbon monoxide.</p>") +
      i18("<p>Try it. This is an illustration with made-up numbers, not real readings:</p>") +
      i18('<div class="lag-controls"><label>Thick smoke lasts <output id="lag-h-out"></output><input id="lag-h" type="range" min="1" max="24" step="1" value="') + LAG.hours + '"></label>' +
      i18('<label>Smoke level in the air <output id="lag-l-out"></output><input id="lag-l" type="range" min="60" max="300" step="10" value="') + LAG.level + '"></label></div>' +
      '<div id="lag-chart" class="chart"></div><p class="lag-result" id="lag-result"></p></div>' +
      i18("<div><h3>What the numbers mean</h3><div class='table-wrap'><table class='cat-table'><thead><tr><th>Category</th><th class='num'>IPU</th><th>For schools (current rule)</th></tr></thead><tbody>") +
      rows + i18("</tbody></table></div><p class='small muted' style='margin-top:8px'>School rule: ") + esc(r ? loc(r, "name") : "") + ".</p></div>" +
      "</div>";
    drawLag();
  }

  function drawLag() {
    var chart = $("lag-chart");
    if (!chart) return;
    var base = 25, start = 10, H = LAG.hours, lvl = LAG.level, N = 60;
    var hourly = [];
    for (var h = 0; h < N; h++) hourly.push(h >= start && h < start + H ? lvl : base);
    var avg = hourly.map(function (_, h) {
      var a = 0;
      for (var k = 0; k < 24; k++) a += h - k >= 0 ? hourly[h - k] : base;
      return a / 24;
    });
    var peakAvg = Math.max.apply(null, avg), peakAt = avg.indexOf(peakAvg);
    var backDown = -1;
    for (var h2 = peakAt; h2 < N; h2++) if (avg[h2] <= base + 0.5) { backDown = h2; break; }
    $("lag-h-out").textContent = " " + H + i18(" hour") + (H > 1 ? i18("s") : "");
    $("lag-l-out").textContent = " " + lvl + " µg/m³";
    chart.innerHTML = "";
    var W2 = Math.max(280, chart.clientWidth || 400), Ht = 190, padL = 34, padR = 8, padT = 12, padB = 26;
    var ymax = Math.ceil(Math.max(lvl, 60) / 50) * 50;
    var sx = function (h) { return padL + (h / (N - 1)) * (W2 - padL - padR); };
    var sy = function (v) { return Ht - padB - (v / ymax) * (Ht - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W2 + " " + Ht, width: W2, height: Ht, role: "img",
      "aria-label": i18("Illustration: hourly smoke level and its 24-hour average") });
    for (var g = 0; g <= ymax; g += 50) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W2 - padR, y1: sy(g), y2: sy(g), stroke: T().grid }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: T().axis, "text-anchor": "end" }, String(g)));
    }
    for (var t = 0; t < N; t += 12) svg.appendChild(svgEl("text", { x: sx(t), y: Ht - 6, "font-size": 11, fill: T().axis, "text-anchor": "middle" }, i18("hour ") + t));
    svg.appendChild(svgEl("rect", { x: sx(start), y: padT, width: Math.max(1, sx(start + H) - sx(start)), height: Ht - padT - padB, fill: T().series, opacity: 0.08 }));
    var line = function (arr) { return arr.map(function (v, h) { return (h ? "L" : "M") + sx(h).toFixed(1) + " " + sy(v).toFixed(1); }).join(" "); };
    svg.appendChild(svgEl("path", { d: line(hourly), fill: "none", stroke: T().series, color: T().series, "stroke-width": 1.8, "class": "series" }));
    svg.appendChild(svgEl("path", { d: line(avg), fill: "none", stroke: T().ink, "stroke-width": 3, "stroke-linejoin": "round" }));
    svg.appendChild(svgEl("text", { x: sx(start + H / 2), y: sy(lvl) - 6, "font-size": 11, fill: T().series, "text-anchor": "middle", stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, i18("smoke right now")));
    svg.appendChild(svgEl("text", { x: Math.min(sx(peakAt) + 6, W2 - 120), y: sy(peakAvg) - 8, "font-size": 11, fill: T().ink, stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, i18("24-hour average (what the IPU follows)")));
    chart.appendChild(svg);
    var after = backDown > 0 ? backDown - (start + H) : null;
    $("lag-result").innerHTML = i18("The air reaches <b>") + lvl + i18("</b> µg/m³ for ") + H + i18(" hour") + (H > 1 ? i18("s") : "") + i18(", but the 24-hour average only climbs to <b>") + Math.round(peakAvg) +
      "</b>, " + Math.round(peakAvg / lvl * 100) + i18("% of the real level") + (after !== null ? i18(", and it stays raised for <b>") + after + i18(" hours</b> after the smoke has gone.") : ".") +
      (H >= 24 ? i18(" Only smoke lasting a full day pushes the average all the way up.") : i18(" Haze has to last most of a day to push the IPU all the way up."));
  }

  // ================================================================ about

  function renderAbout() {
    var r = S.rule, d = S.data;
    if (!r) { $("about-body").innerHTML = ""; return; }
    var schoolsLine = S.schoolsMeta && S.schoolsMeta.available
      ? i18("School locations come from the official KPM list (") + esc(S.schoolsMeta.count) + i18(" schools with coordinates") +
        (S.schoolsMeta.skipped_no_coordinates ? "; " + esc(S.schoolsMeta.skipped_no_coordinates) + i18(" without coordinates cannot be searched") : "") + ")."
      : i18("The official KPM school list has not been added yet. Until it is, schools and towns are found with OpenStreetMap, which is community-made and may be incomplete or wrong.");
    $("about-body").innerHTML =
      i18("<details><summary>Where the readings come from</summary><div>") +
      i18("<p>Every hour an automated job reads the Department of Environment's Air Pollutant Index Management System (APIMS), using the same public data the official portal at ") +
      i18('<a href="https://eqms.doe.gov.my/APIMS/main" rel="noopener">eqms.doe.gov.my/APIMS</a> shows: each station\'s latest reading and its last 24 hourly readings. ') +
      i18("The site is then republished, and an open page re-reads the data every 10 minutes. Nothing is estimated or filled in: a station without a recent reading is shown as having no current reading.</p>") +
      i18("<p>The IPU (API) is DOE's 24-hour running average of the dominant pollutant, so it changes slowly and lags sudden changes in haze.</p></div></details>") +
      i18("<details><summary>How a place is matched to a station</summary><div>") +
      i18("<p>For a school, town or place, the dashboard uses the nearest DOE monitoring station that has a current reading (straight-line distance), and shows that distance on the map. ") +
      i18("It lists the next nearest stations and says when stations close by disagree. The station's reading is never presented as a measurement at the school or place itself.</p>") +
      i18("<p>On the map, the soft glow around each station grows with its reading. It is a visual cue only, not a measured area of haze.</p></div></details>") +
      i18("<details><summary>The school-closure rule</summary><div>") +
      "<p><b>" + esc(loc(r, "name")) + i18("</b>, in force from ") + esc(L.fmtDayKey(r.effective_from)) + ".</p><ul>" +
      "<li>" + esc(loc(r.closure, "summary")) + " " + esc(loc(r.closure, "note")) + "</li><li>" + esc(loc(r.outdoor, "summary")) + "</li></ul>" +
      i18("<p>How the dashboard applies it:</p><ul>") + (loc(r, "how_applied") || []).map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" +
      "<p>" + esc(loc(r, "who_decides")) + "</p>" +
      i18("<p>Earlier rule: ") + r.previous_rules.map(function (p) { return esc(L.fmtDayKey(p.from)) + i18(" to ") + esc(L.fmtDayKey(p.to)) + ": " + esc(loc(p, "summary")); }).join(" ") + "</p>" +
      i18("<p>Sources:</p><ul>") + r.sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.title) + "</a> (" + esc(s.date) + ")</li>"; }).join("") + "</ul></div></details>" +
      i18("<details><summary>Official closure announcements</summary><div>") +
      i18("<p>When a state or KPM announces that schools are closed, the closure check shows it as <b>officially closed</b> for the area and dates announced, instead of the IPU prediction. ") +
      i18("Announcements are added only from <b>Bernama</b> reports, and every one links to the Bernama article. A scheduled check reads Bernama every hour from 6 am to 7 pm, June to November (the haze season), and adds new closures and extensions. From December to May the check is paused.</p>") +
      i18("<p>The site works out which state and district a school or place is in from the official district boundaries published by data.gov.my, so a closure for a state or district is applied to every place inside it. ") +
      i18("Announcements reported between 6 am and 7 pm usually appear within an hour; ones reported later in the evening appear after the 6 am check. Always confirm with your school or the State Education Department (JPN).</p></div></details>") +
      i18("<details><summary>Rule vs reality</summary><div>") +
      i18("<p>For every official closure, the site compares the official DOE readings in the closed area with the national rule, under which schools in the affected area close once the IPU reaches 200. ") +
      i18("It looks at the 24 hours and the 3 days before the announcement, and at the highest reading each day from 2 days before until the closure ends. ") +
      i18("A closure that \"went further than the national rule\" is not wrong: states can decide on other grounds, such as health data or the weather outlook. The comparison only shows how the decision relates to the readings.</p></div></details>") +
      i18("<details><summary>The forecast and the haze sources</summary><div>") +
      i18("<p>The forecast is an estimate made by this site, kept apart from the official readings. It takes the CAMS air-quality model's PM2.5 forecast (Copernicus Atmosphere Monitoring Service, via Open-Meteo) at each station and scales it to that station's official IPU over the last 24 hours. ") +
      i18("It is shown only next to a current official reading, always labelled as an estimate, and never used for the school closure check, which uses DOE APIMS readings only.</p>") +
      i18("<p>Fire hotspots are NASA FIRMS satellite detections (VIIRS) from the last 24 hours; detections older than 36 hours are never shown. Wind is the current 10 m wind from the Open-Meteo weather model. Together they show where fires are and which way the wind blows, not the actual path of the smoke.</p></div></details>") +
      i18("<details><summary>Limitations</summary><div><ul>") +
      i18("<li>Malaysia has about 68 DOE stations. Many schools are far from one, and a single station cannot show local differences.</li>") +
      i18("<li>Official closures are added from Bernama reports only, checked every hour from 6 am to 7 pm from June to November. A school may also be closed or open for reasons this site cannot see, such as a district or school decision that Bernama did not report.</li>") +
      i18("<li>Weekends, school holidays and public holidays come from the official calendars. For 2027, term breaks and KPM's extra festive holidays are not included yet.</li>") +
      i18("<li>The APIMS data endpoints are not a documented public API. If DOE changes them, updates stop and this page marks its readings as outdated.</li>") +
      i18("<li>Updates run on GitHub Actions at minute ") + UPDATE_MINUTE + i18(" of every hour; GitHub sometimes starts them a few minutes late.</li>") +
      i18("<li>DOSM history is national monthly averages of pollutant concentrations, not IPU and not per station.</li>") +
      "<li>" + schoolsLine + "</li></ul>" +
      (d && d.source ? i18('<p class="small muted">Data endpoints: ') + esc(d.source.current_endpoint) + i18(" and ") + esc(d.source.hourly_endpoint) + ".</p>" : "") +
      "</div></details>";
  }

  // ================================================================ search

  function loadSchools() {
    if (S.schoolsLoading) return S.schoolsLoading;
    S.schoolsLoading = getJSON("data/schools.json").then(function (d) {
      S.schoolsMeta = d; S.schools = d && d.available ? d.schools : [];
    }).catch(function () { S.schools = []; S.schoolsMeta = { available: false }; })
      .then(function () { renderSearchNote(); renderAbout(); });
    return S.schoolsLoading;
  }

  function renderSearchNote() {
    var m = S.schoolsMeta, el = $("search-note");
    if (!m) { el.textContent = ""; return; }
    el.textContent = m.available
      ? i18("Schools and towns come from the official KPM school list. Press Search for any other place.")
      : i18("Press Search to find any town or school in Malaysia (OpenStreetMap). The official KPM school list has not been added yet.");
  }

  var GROUPS = { state: "States", station: "Monitoring stations", locality: "Towns and districts", school: "Schools", place: "Places (OpenStreetMap)" };

  function renderResults(items, extraMsg, q) {
    var html = "", last = null;
    items.forEach(function (r, i) {
      if (r.type !== last) { html += '<div class="group">' + esc(i18(GROUPS[r.type] || r.type)) + "</div>"; last = r.type; }
      html += '<button type="button" role="option" data-i="' + i + '">' + esc(r.label) + '<span class="sub">' + esc(r.sub || "") + "</span></button>";
    });
    if (extraMsg) html += '<div class="msg">' + extraMsg + "</div>";
    if (q && q.length >= 3 && !items.some(function (r) { return r.type === "place"; })) {
      html += i18('<button type="button" role="option" data-place="1">Search all places for “') + esc(q) + i18('”<span class="sub">Towns, neighbourhoods and schools, from OpenStreetMap</span></button>');
    }
    $("results").innerHTML = html;
    $("results")._items = items;
  }

  function onSearchInput() {
    var q = $("q").value.trim();
    if (q.length < 2) { $("results").innerHTML = ""; return; }
    var items = L.searchLocal(q, stations(), S.schools);
    renderResults(items, "", q);
  }

  function chooseResult(r) {
    if (r.type === "state") select({ type: "state", state: r.state });
    else if (r.type === "station") select({ type: "station", id: r.id });
    else if (r.type === "school") select({ type: "school", code: r.code, label: r.label, state: r.state, district: r.district, town: r.town, lat: r.lat, lon: r.lon, source: "kpm" });
    else if (r.type === "locality") select({ type: "locality", label: r.label, lat: r.lat, lon: r.lon, state: r.state, source: "kpm-town" });
    else if (r.type === "place") select({ type: "place", label: r.label, lat: r.lat, lon: r.lon, state: r.state, town: r.area, source: "osm" });
  }

  function placeSearch() {
    var q = $("q").value.trim();
    if (q.length < 3) { $("q").focus(); return; }
    var wait = Math.max(0, 1100 - (Date.now() - S.lastPlaceQuery));   // Nominatim allows 1 request per second
    $("results").innerHTML = i18('<div class="msg">Searching places in Malaysia…</div>');
    setTimeout(function () {
      S.lastPlaceQuery = Date.now();
      var url = NOMINATIM + "?format=jsonv2&addressdetails=1&limit=8&countrycodes=my&accept-language=en&q=" + encodeURIComponent(q);
      fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (list) {
          var local = L.searchLocal(q, stations(), S.schools);
          var places = (list || []).map(function (p) {
            var a = p.address || {}, name = p.name || String(p.display_name || "").split(",")[0];
            var area = a.suburb || a.village || a.town || a.city || a.county || "";
            var kind = (p.type || p.category || "place").replace(/_/g, " ");
            return { type: "place", label: name, area: area, state: a.state || null, lat: Number(p.lat), lon: Number(p.lon),
                     sub: kind.charAt(0).toUpperCase() + kind.slice(1) + ([area, a.state].filter(Boolean).length ? ", " + [area, a.state].filter(Boolean).join(", ") : "") };
          }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lon); });
          renderResults(local.concat(places), places.length ? i18('<span class="small muted">Place results © OpenStreetMap contributors. Check it is the place you mean.</span>')
            : i18("No places found for “") + esc(q) + i18("”. Try another spelling or a nearby town."), null);
        })
        .catch(function () { $("results").innerHTML = i18('<div class="msg">Place search is not available right now. You can still search states and stations, or use your location.</div>'); });
    }, wait);
  }

  function useMyLocation() {
    var btn = $("loc-btn");
    if (!navigator.geolocation) { msg(i18("This browser does not share its location. Search for your town or school instead.")); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      var acc = Math.round(pos.coords.accuracy || 0);
      select({ type: "place", label: i18("Your location"), lat: pos.coords.latitude, lon: pos.coords.longitude, source: "device",
               sub: acc ? i18("Accurate to about ") + (acc > 1000 ? Math.round(acc / 1000) + i18(" km") : acc + " m") : null });
    }, function () {
      btn.disabled = false;
      msg(i18("Location was not shared. Search for your town or school instead."));
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }
  function msg(text) { $("results").innerHTML = '<div class="msg">' + esc(text) + "</div>"; }

  // ================================================================ language

  /* Static text in index.html marked with data-t (inner HTML) or data-t-attr (attributes). */
  function translateStatic() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-t]"), function (el) {
      if (!el.hasAttribute("data-t-en")) el.setAttribute("data-t-en", el.innerHTML.trim());
      el.innerHTML = i18(el.getAttribute("data-t-en"));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-t-attr]"), function (el) {
      el.getAttribute("data-t-attr").split(" ").forEach(function (a) {
        var k = "data-t-" + a;
        if (!el.hasAttribute(k)) el.setAttribute(k, el.getAttribute(a) || "");
        el.setAttribute(a, i18(el.getAttribute(k)));
      });
    });
    document.title = i18("IPU Malaysia");
    if ($("src-btn")) $("src-btn").textContent = M.sourcesOn ? i18("Hide haze sources") : i18("Where the haze comes from");
    var b = $("lang-btn");
    if (b) {
      var ms = I18.lang === "ms";
      b.textContent = ms ? "EN" : "BM";
      b.setAttribute("lang", ms ? "en" : "ms");
      b.title = ms ? "Switch to English" : "Tukar ke Bahasa Melayu";
      b.setAttribute("aria-label", b.title);
    }
  }

  function applyLang(lang) {
    I18.set(lang);
    L.setLang(I18.lang, i18);
    S.smoke = null; S.trace = null; S.smokeHere = null;   // cached text with place names
    SIM.built = false;
    if ($("share-panel")) { $("share-panel").hidden = true; $("share-btn").setAttribute("aria-expanded", "false"); }
    translateStatic();
    setThemeButton();
    $("src-btn").textContent = M.sourcesOn ? i18("Hide haze sources") : i18("Where the haze comes from");
    renderLegend();
    if (S.data) renderAll();
    if (S.sel) renderSelection(false);
    renderExplainer();
    renderDosm();
    renderSearchNote();
    if (S.lobbyOn) renderLobby();
    setHash(S.sel);
    if (S.lobbyOn && location.hash.indexOf("screen=1") < 0) { try { history.replaceState(null, "", location.hash + "&screen=1"); } catch (e) { /* ignore */ } }
  }

  // ================================================================ theme

  function setThemeButton() {
    var on = themeName() === "neon";
    var b = $("theme-btn");
    if (!b) return;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.querySelector(".theme-label").textContent = on ? i18("Neon on") : i18("Neon");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", T().meta);
  }

  function applyTheme(name) {
    var root = document.documentElement;
    if (!REDUCE) {
      root.classList.add("theme-anim");
      setTimeout(function () { root.classList.remove("theme-anim"); }, 700);
    }
    if (name === "neon") root.setAttribute("data-theme", "neon"); else root.removeAttribute("data-theme");
    try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* private mode: keep for this visit only */ }
    setThemeButton();
    // redraw everything that carries theme colours
    renderLegend();
    if (S.data) { renderStatus(); renderOverview(); renderTable(); renderMarkers(); renderSelection(false); renderOutlook(); renderClosures(); renderWatch(); renderSim(); }
    renderSourcesSection();
    renderExplainer();
    renderDosm();
    if (M.map) {
      M.styleReady = false;
      try { M.map.setStyle(M.fallbackUsed ? fallbackStyle() : T().style, { diff: false }); }
      catch (e) { useFallback(); }
    }
  }

  // ================================================================ wiring

  function renderAll() {
    S.unusual = S.data ? L.unusualReadings(stations(), now()) : {};
    renderStatus();
    populateStateFilter();
    renderOverview();
    renderTable();
    renderMarkers();
    renderSelection(false);
    renderClosures();
    renderWatch();
    renderBorders();
    renderSim();
    renderOutlook();
    renderSourcesSection();
    updateSourcesOnMap();
    updateClosedAreas();
    if (S.firstPaint || !$("lag-chart")) renderExplainer();
    renderAbout();
    S.firstPaint = false;
  }

  function loadExtras() {
    return Promise.all([
      getJSON("data/forecast.json").catch(function () { return null; }),
      getJSON("data/sources.json").catch(function () { return null; }),
      getJSON("data/announcements.json").catch(function () { return null; }),
      getJSON("data/rule_reality.json").catch(function () { return null; }),
      getJSON("data/daily.json").catch(function () { return null; }),
      S.borders ? Promise.resolve(S.borders) : getJSON("data/borders.json").catch(function () { return null; }),
      S.calIndex ? Promise.resolve(S.calIndex) : getJSON("data/cal/index.json").catch(function () { return null; })
    ]).then(function (r) {
      S.rr = r[3]; S.daily = r[4]; S.borders = r[5]; S.calIndex = r[6];
      var newHist = r[1] && S.sources && r[1].generated_at !== S.sources.generated_at;
      S.forecast = r[0]; S.sources = r[1]; S.ann = r[2];
      if (newHist) { S.windHist = null; S.trace = null; S.windFc = null; S.smoke = null; }
    });
  }

  function refresh() {
    Promise.all([getJSON("data/latest.json"), loadExtras()]).then(function (res) {
      var d = res[0], changed = !S.data || d.last_attempt !== S.data.last_attempt;
      S.data = d;
      if (changed) renderAll();
      else { renderStatus(); renderClosures(); renderBorders(); updateClosedAreas(); if (S.sel) renderSelection(false); }
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
      var r = ($("results")._items || [])[Number(b.dataset.i)];
      if (r) chooseResult(r);
    });
    $("results").addEventListener("keydown", function (ev) {
      var list = Array.prototype.slice.call($("results").querySelectorAll("button")), i = list.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" && i < list.length - 1) { ev.preventDefault(); list[i + 1].focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); if (i > 0) list[i - 1].focus(); else $("q").focus(); }
      if (ev.key === "Escape") { $("results").innerHTML = ""; $("q").focus(); }
    });
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest(".search")) $("results").innerHTML = "";
      var st = ev.target.closest("[data-station]");
      if (st && !ev.target.closest("#results")) { select({ type: "station", id: st.dataset.station }); return; }
      var sr = ev.target.closest("[data-state]");
      if (sr) select({ type: "state", state: sr.dataset.state });
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      var el = ev.target.closest && ev.target.closest("tr[data-station]");
      if (el) select({ type: "station", id: el.dataset.station });
    });
    $("places-btn").addEventListener("click", placeSearch);
    $("loc-btn").addEventListener("click", useMyLocation);
    $("sel-close").addEventListener("click", function () { $("share-panel").hidden = true; clearSelection(); });
    $("share-btn").addEventListener("click", openShare);
    $("lobby-btn").addEventListener("click", openLobby);
    $("lobby-exit").addEventListener("click", closeLobby);
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && S.lobbyOn) closeLobby(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && S.lobbyOn) { keepAwake(); renderLobby(); } });
    setInterval(function () { if (S.lobbyOn) $("lobby-clock").textContent = L.fmtTime(now()); }, 15000);
    $("map-home").addEventListener("click", flyHome);
    $("theme-btn").addEventListener("click", function () { applyTheme(themeName() === "neon" ? "light" : "neon"); });
    $("a11y-btn").addEventListener("click", function (ev) {
      ev.stopPropagation();
      var p = $("a11y-panel"), open = p.hidden;
      p.hidden = !open;
      $("a11y-btn").setAttribute("aria-expanded", open ? "true" : "false");
      if (open) $("a11y-sound").focus();
    });
    $("a11y-sound").addEventListener("change", function () { setSoundOption($("a11y-sound").checked); });
    $("a11y-close").addEventListener("click", function () { $("a11y-panel").hidden = true; $("a11y-btn").setAttribute("aria-expanded", "false"); $("a11y-btn").focus(); });
    $("a11y-sample").addEventListener("click", function () {
      var vals = [50, 100, 150, 200, 300], names = vals.map(function (v) { return v + " (" + cat(v).label + ")"; });
      announce(i18("Sample tones: ") + names.join(", ") + ".");
      var lbl = $("a11y-sample-now");
      playTones(vals.map(function (v) { return v; }).reduce(function (acc, v) { return acc.concat([v, v, v]); }, []), {
        onStep: function (i) { lbl.textContent = i18("Now playing: ") + names[Math.floor(i / 3)]; },
        onEnd: function () { lbl.textContent = ""; }
      });
    });
    document.addEventListener("click", function (ev) {
      var p = $("a11y-panel");
      if (!p.hidden && !ev.target.closest("#a11y-panel") && !ev.target.closest("#a11y-btn")) { p.hidden = true; $("a11y-btn").setAttribute("aria-expanded", "false"); }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("a11y-panel").hidden) { $("a11y-panel").hidden = true; $("a11y-btn").setAttribute("aria-expanded", "false"); $("a11y-btn").focus(); }
    });
    $("src-btn").addEventListener("click", function () { setSources(!M.sourcesOn, true); });
    $("lang-btn").addEventListener("click", function () { applyLang(I18.lang === "ms" ? "en" : "ms"); });
    document.addEventListener("click", function (ev) {
      if (ev.target.closest("#trace-show")) {
        if (!M.sourcesOn) setSources(true, false);
        updateTraceDisplay();
        flyToTrace();
        renderAirPath();
        document.querySelector(".map-wrap").scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
      }
      var calBtn = ev.target.closest(".cal-link");
      if (calBtn) openCalendarFor(calBtn.getAttribute("data-cal-state"));
      if (ev.target.closest("#smoke-show")) {
        if (!M.sourcesOn) setSources(true, false);
        loadWindFc().then(function () {
          updateSmokeOnMap();
          var g = smokeGeo(), pts = [];
          g.features.forEach(function (f) { if (f.geometry.type === "LineString") pts = pts.concat(f.geometry.coordinates); });
          var pt = selPoint(S.sel);
          var hasPaths = g.features.length > 0;
          if (pt) pts.push([pt.lon, pt.lat]);
          if (hasPaths) flyTo({ bounds: boundsOf(pts), maxZoom: 7, padding: isMobile() ? { top: 70, bottom: 130, left: 30, right: 30 } : { top: 90, bottom: 120, left: 110, right: 110 } });
          else flyTo({ bounds: isMobile() ? [[96.5, -4.5], [118.5, 7.5]] : REGION_BOUNDS, maxZoom: 6, padding: isMobile() ? { top: 56, bottom: 64, left: 6, right: 6 } : null });
        });
        document.querySelector(".map-wrap").scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
      }
      if (ev.target.closest("#src-show")) {
        setSources(!M.sourcesOn, true);
        document.querySelector(".map-wrap").scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { W.running = false; cancelAnimationFrame(W.raf); }
      else if (M.sourcesOn) startWind();
    });
    ["f-state", "f-sort"].forEach(function (id) { $(id).addEventListener("change", renderTable); });
    $("f-text").addEventListener("input", renderTable);
    document.addEventListener("input", function (ev) {
      if (ev.target.id === "lag-h") { LAG.hours = Number(ev.target.value); drawLag(); }
      if (ev.target.id === "lag-l") { LAG.level = Number(ev.target.value); drawLag(); }
    });
    var rt = null, lastW = window.innerWidth;
    window.addEventListener("resize", function () {
      if (window.innerWidth === lastW) return;          // ignore mobile toolbar show/hide
      lastW = window.innerWidth;
      clearTimeout(rt);
      rt = setTimeout(function () { renderSelection(false); renderDosm(); drawLag(); drawAllRR(); }, 200);
    });
    window.addEventListener("hashchange", function () { var h = readHash(); if (h) select(h, { keepHash: true }); });
  }

  function init() {
    translateStatic();
    setThemeButton();
    $("a11y-sound").checked = SOUND.on;
    $("a11y-btn").classList.toggle("is-on", SOUND.on);
    bind();
    initMap();
    Promise.all([
      getJSON("data/latest.json").catch(function () { return null; }),
      getJSON("data/rule.json").catch(function () { return null; }),
      loadExtras()
    ]).then(function (res) {
      S.data = res[0]; S.rule = res[1];
      S.sel = readHash();
      renderAll();
      if (S.sel) renderSelection(true);
      if (S.sel && S.lobbyWanted) setTimeout(function () { if (S.view) openLobby(); }, 800);
      getJSON("data/dosm_monthly.json").then(function (d) { S.dosm = d; }).catch(function () { S.dosm = null; }).then(renderDosm);
      getJSON("data/boundaries.json").then(function (b) {
        S.bounds = b;
        updateClosedAreas();
        if (S.sel) renderSelection(false);
      }).catch(function () { S.bounds = null; });
      loadSchools();
    });
    setInterval(refresh, REFRESH_MS);
    setInterval(renderStatus, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  }

  init();
})();
