/* IPU Malaysia – page behaviour: map, search, selection, prediction, charts.
   All rules (categories, matching, prediction) live in logic.js (window.IPU). */
(function () {
  "use strict";
  var L = window.IPU;
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
      forecast: "#b5179e", fireCore: "#d9480f", fireGlow: "#ff922b", wind: "rgba(23, 42, 53, 0.55)"
    },
    neon: {
      style: "https://tiles.openfreemap.org/styles/dark",
      cats: { good: "#4a9dff", moderate: "#19e3b1", unhealthy: "#ffd23f", very: "#ff7f2a", hazardous: "#ff3d81" },
      inks: { good: "#041019", moderate: "#041019", unhealthy: "#041019", very: "#041019", hazardous: "#041019" },
      off: "#33406a", offInk: "#8394ba", haze: 0.34, link: "#47f3ff",
      grid: "#162043", axis: "#8394ba", ink: "#eaf3ff", halo: "#070b18", outdoor: "#5b6fa8", closure: "#ff3d81",
      series: "#47f3ff", seriesB: "#ff5ce1", area: 0.14,
      fallback: { sea: "#04060d", land: "#0f1730", coast: "#2b3d70" }, meta: "#070b18",
      forecast: "#c084fc", fireCore: "#ffd08a", fireGlow: "#ff3d81", wind: "rgba(71, 243, 255, 0.8)"
    }
  };
  var THEME_KEY = "ipu-theme";
  var MY_BOUNDS = [[99.6, 0.85], [119.3, 7.4]];
  var REGION_BOUNDS = [[94.5, -6], [120.5, 8.5]];     // Sumatra and Borneo around Malaysia
  var FIRE_MAX_AGE_MIN = 36 * 60;
  var REDUCE = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  var S = { data: null, rule: null, dosm: null, forecast: null, sources: null, schools: null, schoolsMeta: null, schoolsLoading: null,
            sel: null, lastPlaceQuery: 0, firstPaint: true };
  var M = { map: null, styleReady: false, introDone: false, markers: {}, pin: null, km: null,
            fallbackUsed: false, tileOk: false, tileErr: 0, pending: null, link: null, refId: null, homeZoom: 5, sourcesOn: false };
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
    if (!c) return '<span class="cat none">No current reading</span>';
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
      box.innerHTML = '<span class="live-dot"></span><div class="banner bad">The readings file could not be loaded. If the site was just set up, wait for the first hourly update, then reload.</div>';
      return;
    }
    var f = L.freshness(S.data, n);
    var fresh = stations().length && !f.stale;
    box.classList.add(fresh ? "is-live" : "is-stale");
    var html = '<span class="live-dot" aria-hidden="true"></span><span class="status-lines">' +
      "<span>Readings for <b>" + esc(f.observation ? L.fmtDateTime(f.observation) : "—") + "</b></span>" +
      "<span>Updated " + esc(f.lastSuccess ? L.ago(f.lastSuccess, n) : "never") + ", next around " + esc(L.fmtTime(nextUpdate(n))) + "</span></span>";
    if (!stations().length) {
      html += '<div class="banner">No readings have been retrieved yet. The first hourly update has not run or has not succeeded, so nothing here is a current reading.</div>';
    } else if (f.stale) {
      html += '<div class="banner bad"><b>Data may be outdated.</b> ' + esc(f.reasons.join(" ")) +
        " The page shows the last successful update and marks old readings as outdated.</div>";
    } else if (f.partial) {
      html += '<div class="banner">Part of the last update failed. Affected stations keep their previous reading and show its time.</div>';
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
    if (!window.maplibregl) { mapUnavailable("The map could not be loaded. Search and the station list below still work."); return; }
    try {
      M.map = new maplibregl.Map({
        container: "map", style: T().style,
        center: REDUCE ? [109.4, 4.1] : [106, 9], zoom: REDUCE ? 4.6 : 2.3,
        attributionControl: { compact: true }, cooperativeGestures: isMobile(),
        dragRotate: false, pitchWithRotate: false, touchPitch: false, minZoom: 2, maxZoom: 16.5
      });
    } catch (e) {
      mapUnavailable("This device cannot show the map (WebGL is turned off). Search and the station list below still work.");
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
    try { M.map.setStyle(fallbackStyle()); } catch (e) { mapUnavailable("The map could not be loaded."); }
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
    var cam = map.cameraForBounds(MY_BOUNDS, { padding: pad() });
    if (cam) M.homeZoom = cam.zoom;
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
            (cc ? "IPU " + st.api + " (" + esc(cat(st.api).label) + ") at " + esc(readingTime(st.observed, now())) : "No current reading"), ev.clientX, ev.clientY);
        });
        b.addEventListener("mouseleave", hideTip);
        wrap.appendChild(b);
        m = M.markers[s.id] = { marker: new maplibregl.Marker({ element: wrap, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(M.map), btn: b };
      }
      m.station = s;
      m.btn.classList.toggle("off", !cur);
      m.btn.style.setProperty("--c", c ? c.color : "var(--paper)");
      m.btn.style.setProperty("--ci", c ? c.ink : T().offInk);
      m.btn.style.setProperty("--d", Math.round(700 + (s.lon - 99.6) / 19.7 * 1300) + "ms");
      m.btn.querySelector(".n").textContent = cur ? s.api : "–";
      m.btn.setAttribute("aria-label", s.name + ", " + s.state + ": " + (cur ? "IPU " + s.api + ", " + c.label : "no current reading"));
    });
    Object.keys(M.markers).forEach(function (id) {
      if (!seen[id]) { M.markers[id].marker.remove(); delete M.markers[id]; }
    });
    if (M.styleReady && M.map.getSource("stations")) M.map.getSource("stations").setData(stationsGeo());
    markRef(M.refId);
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
      w.querySelector(".pin-label").textContent = label || "Selected location";
      M.pin = new maplibregl.Marker({ element: w, anchor: "center" }).setLngLat(point).addTo(M.map);
      if (ref && ref.km >= 0.5) {
        var rp = [ref.station.lon, ref.station.lat];
        M.link.features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [point, rp] }, properties: {} });
        var k = document.createElement("div");
        k.className = "km-wrap";
        k.innerHTML = '<div class="km"></div>';
        k.querySelector(".km").textContent = Math.round(ref.km) + " km";
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
    var html = L.CATEGORIES.map(function (c) {
      return '<span><i style="' + swatch(T().cats[c.key]) + '"></i>' + esc(c.label) + "</span>";
    }).join("");
    if (M.sourcesOn) {
      html += '<span><i style="' + swatch(T().fireCore) + '"></i>Fire hotspot, last 24 h</span>' +
              '<span><i class="wind-key" style="background:' + T().wind + '"></i>Surface wind (model)</span>';
    }
    $("map-legend").innerHTML = html;
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
    b.textContent = on ? "Hide haze sources" : "Where the haze comes from";
    if (M.map && M.styleReady) {
      ["fires-glow", "fires"].forEach(function (id) { if (M.map.getLayer(id)) M.map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); });
    }
    if (on) startWind(); else stopWind();
    renderLegend();
    renderSourcesSection();
    if (on && fly) flyTo({ bounds: isMobile() ? [[96.5, -4.5], [118.5, 7.5]] : REGION_BOUNDS, maxZoom: 6, padding: isMobile() ? { top: 56, bottom: 64, left: 6, right: 6 } : null });
  }

  function updateSourcesOnMap() {
    if (M.map && M.styleReady && M.map.getSource("fires")) M.map.getSource("fires").setData(firesGeo());
    if (M.sourcesOn) startWind();
  }

  function renderSourcesSection() {
    var box = $("sources-body"), src = S.sources;
    if (!src) { box.innerHTML = '<p class="muted">Fire and wind data has not been downloaded yet. It is added by the hourly update.</p>'; return; }
    var f = src.fires || {}, pts = freshFires(), w = windData(), html = '<div class="src-stats">';
    if (pts.length) {
      var newest = f.newest_recent_detection ? L.parseTime(f.newest_recent_detection) : null;
      html += '<div class="src-stat"><span class="v fire">' + pts.length.toLocaleString("en-MY") + "</span><p>fire hotspots detected by NASA satellites around Malaysia, Sumatra and Borneo in the last 24 hours" +
        (newest ? " (latest pass " + esc(L.fmtDateTime(newest)) + ")" : "") + ".</p></div>";
    } else if (f.newest_detection) {
      html += '<div class="src-stat"><span class="v fire">0</span><p>No satellite fire detections from the last 36 hours are available. The newest detections NASA has published for this region are from ' +
        esc(L.fmtDateTime(L.parseTime(f.newest_detection))) + ", so none are shown as current.</p></div>";
    } else {
      html += '<div class="src-stat"><span class="v fire">–</span><p>Satellite fire data could not be read on the last update.</p></div>';
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
        html += '<div class="src-stat"><span class="v">' + Math.round(spd) + '</span><p>km/h: surface wind over Sumatra and the Strait of Malacca, mostly from the <b>' +
          esc(L.windFrom(mu, mv)) + "</b> (weather model, " + esc(L.fmtDateTime(L.parseTime(w.fetched_at))) + ").</p></div>";
      }
    }
    html += "</div><p>Smoke from fires upwind can be carried to Malaysia by these winds. The map shows where fires and winds are now; it does not trace actual smoke, and fire detections do not show how much smoke a fire makes.</p>" +
      '<button type="button" class="src-btn2" id="src-show">' + (M.sourcesOn ? "Hide fires and wind on the map" : "Show fires and wind on the map") + "</button>" +
      '<p class="small muted">Fires: <a href="https://firms.modaps.eosdis.nasa.gov/" rel="noopener">NASA FIRMS</a> near-real-time VIIRS detections. ' + esc(f.note || "") +
      " Wind: Open-Meteo 10 m wind, a model estimate. Neither is official IPU data.</p>";
    box.innerHTML = html;
  }

  // ================================================================ forecast (estimate, never official)

  function whenText(k) {
    var t = L.parseTime(k);
    return L.fmtTime(t) + " on " + L.fmtDayKey(L.mytDateKey(t)).replace(/ \d{4}$/, "");
  }

  function forecastNote() {
    var f = S.forecast;
    return '<p class="fc-note">This estimate is <b>not from DOE</b>. It is not the official IPU and is not used for the school closure check. ' +
      "It scales the CAMS air-quality model forecast (Copernicus, via Open-Meteo) to this station's official readings, so it can be wrong, especially when weather changes quickly.</p>" +
      (f && f.method ? '<details class="inline-details"><summary>How this estimate is made</summary><div><ul>' +
        f.method.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul></div></details>" : "");
  }

  function renderForecast(box, st) {
    box.innerHTML = "";
    if (!st) return;
    var fcAll = S.forecast, fc = fcAll && fcAll.stations ? fcAll.stations[st.id] : null, n = now();
    var head = '<div class="fc-head"><h3>Forecast for ' + esc(st.name) + '</h3><span class="fc-tag">Estimate, not official</span></div>';
    if (!fcAll) { box.innerHTML = head + '<p class="muted">The forecast estimate has not been made yet. It is added by the hourly update.</p>'; return; }
    var stat = L.forecastStatus(fc, st, n);
    if (!stat.ok) { box.innerHTML = head + '<p class="muted">' + esc(fcAll.skipped && fcAll.skipped[st.id] ? "No estimate: " + fcAll.skipped[st.id] + "." : stat.reason) + "</p>" + forecastNote(); return; }
    var reach = { likely: "Likely", possible: "Possible", unlikely: "Unlikely" }[fc.reach200_24h] || "—";
    var pk = fc.peak24;
    var html = head +
      '<p class="fc-lead">Estimated peak in the next 24 hours: <b>' + pk.est + "</b> (range " + pk.lo + " to " + pk.hi + "), around " + esc(whenText(pk.time)) + ".</p>" +
      '<dl class="facts"><dt>Could reach 200 in the next 24 hours</dt><dd>' + reach + "</dd>" +
      (fc.morning ? "<dt>Around 07:00 tomorrow</dt><dd>" + fc.morning.est + " (range " + fc.morning.lo + " to " + fc.morning.hi + ")</dd>" : "") +
      "<dt>Confidence</dt><dd>" + (fc.confidence === "low" ? "Low" : "Normal") + "</dd>" +
      (fcAll.model_stale ? "<dt>Model data</dt><dd>More than a day old</dd>" : "") + "</dl>" +
      (fc.confidence === "low" ? '<p class="note">Low confidence: here the model sees much less haze than DOE measures, or the two have not matched well over the last day. Treat this as a rough guide.</p>' : "");
    box.innerHTML = html;
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    drawForecastChart(chart, st, fc);
    box.insertAdjacentHTML("beforeend", '<div class="fc-legend"><span><i class="k-dot"></i>Official reading now (DOE)</span><span><i class="k-dash"></i>Estimate</span><span><i class="k-band"></i>Range</span></div>' + forecastNote());
  }

  function drawForecastChart(chart, st, fc) {
    var t0 = L.parseTime(fc.anchor), times = [], i;
    for (i = 0; i < fc.est.length; i++) times.push(L.parseTime(fc.start).getTime() + i * 3600000);
    var W2 = Math.max(280, chart.clientWidth || 400), H = 190, padL = 32, padR = 8, padT = 14, padB = 26;
    var x0 = t0.getTime(), x1 = times[times.length - 1];
    var ymax = niceMax(Math.max(st.api, Math.max.apply(null, fc.hi)), 220);
    var sx = function (t) { return padL + ((t - x0) / Math.max(1, x1 - x0)) * (W2 - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W2 + " " + H, width: W2, height: H, role: "img", "aria-label": "Forecast estimate for " + st.name + ", next " + fc.est.length + " hours" });
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
    svg.appendChild(svgEl("text", { x: padL + 4, y: sy(S.rule.closure.threshold) - 5, "font-size": 11, fill: T().closure, stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, "200: school-closure level"));
    var t24 = x0 + 24 * 3600000;
    if (t24 < x1) {
      svg.appendChild(svgEl("line", { x1: sx(t24), x2: sx(t24), y1: padT, y2: H - padB, stroke: T().axis, "stroke-dasharray": "2 3", opacity: 0.7 }));
      svg.appendChild(svgEl("text", { x: sx(t24) - 4, y: padT + 10, "font-size": 10.5, fill: T().axis, "text-anchor": "end", stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, "next 24 h"));
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
    svg.appendChild(svgEl("text", { x: sx(x0) + 8, y: sy(st.api) - 8, "font-size": 11, fill: T().ink, stroke: T().halo, "stroke-width": 3, "paint-order": "stroke" }, "Official now: " + st.api));
    var cross = svgEl("line", { y1: padT, y2: H - padB, stroke: T().ink, opacity: 0 });
    svg.appendChild(cross);
    var overlay = svgEl("rect", { x: padL, y: padT, width: W2 - padL - padR, height: H - padT - padB, fill: "transparent" });
    function hover(ev) {
      var rect = svg.getBoundingClientRect(), px = (ev.clientX - rect.left) * (W2 / rect.width), best = 0;
      times.forEach(function (t, k) { if (Math.abs(sx(t) - px) < Math.abs(sx(times[best]) - px)) best = k; });
      cross.setAttribute("x1", sx(times[best])); cross.setAttribute("x2", sx(times[best])); cross.setAttribute("opacity", 0.3);
      showTip("<b>Estimate " + fc.est[best] + "</b> (range " + fc.lo[best] + " to " + fc.hi[best] + ")<br>" + esc(L.fmtDateTime(new Date(times[best]))) + "<br>Not official IPU", ev.clientX, ev.clientY);
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
    var head = '<div class="fc-head"><h3>Next 24 hours</h3><span class="fc-tag">Estimate, not official</span></div>';
    if (!rows.length) { box.innerHTML = head + '<p class="muted">No forecast estimate is available right now.</p>'; return; }
    var likely = rows.filter(function (r) { return r.f.reach200_24h === "likely"; }).length;
    var possible = rows.filter(function (r) { return r.f.reach200_24h === "possible"; }).length;
    var lead = likely || possible
      ? "The estimate suggests " + (likely ? likely + " station" + (likely > 1 ? "s are" : " is") + " likely" + (possible ? " and " : "") : "") +
        (possible ? possible + " station" + (possible > 1 ? "s" : "") + " could possibly" : "") + " reach 200 in the next 24 hours."
      : "The estimate does not expect any station to reach 200 in the next 24 hours.";
    var label = { likely: "200 likely", possible: "200 possible", unlikely: "" };
    box.innerHTML = head + '<p class="fc-lead">' + esc(lead) + '</p><div class="fc-list">' + rows.slice(0, 5).map(function (r) {
      return '<button type="button" class="fc-row" data-station="' + esc(r.s.id) + '"><span class="nm">' + esc(r.s.name) + '</span><span class="pk">' + r.f.peak24.est + "</span>" +
        '<span class="sub">' + esc(r.s.state) + ", estimated peak " + r.f.peak24.lo + " to " + r.f.peak24.hi + " around " + esc(whenText(r.f.peak24.time)) +
        (label[r.f.reach200_24h] ? ". " + label[r.f.reach200_24h] : "") + (r.f.confidence === "low" ? ", low confidence" : "") + "</span></button>";
    }).join("") + '</div><p class="fc-note">Highest estimated peaks. These are model estimates, not DOE readings, and are not used for the school closure check.</p>';
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
        (list.length > 1 ? '<span class="small muted">and ' + (list.length - 1) + " more</span>" : "");
    }
    var reached = sum.current.filter(function (s) { return S.rule && L.meets(s.api, S.rule.closure); });
    var html = "";
    if (sum.highest) {
      html += '<span class="k">Highest</span><span class="v" style="--c:' + cat(sum.highest.api).color + '" data-count="' + sum.highest.api + '">' + sum.highest.api + '</span><span class="p">' + badge(sum.highest.api) + who(sum.highestAll) + "</span>";
      html += '<span class="k">Lowest</span><span class="v" style="--c:' + cat(sum.lowest.api).color + '" data-count="' + sum.lowest.api + '">' + sum.lowest.api + '</span><span class="p">' + badge(sum.lowest.api) + who(sum.lowestAll) + "</span>";
    } else {
      html += '<span class="summary-foot">No station has a current reading.</span>';
    }
    var threshold = S.rule ? S.rule.closure.threshold : 200;
    html += '<p class="summary-foot">' + sum.current.length + " of " + stations().length + " stations have a current reading. " +
      (reached.length ? "<b>" + reached.length + " " + (reached.length > 1 ? "are" : "is") + " at the school-closure level of " + threshold + " or more.</b>"
                      : "None is at the school-closure level of " + threshold + ".") + "</p>";
    $("summary").innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll("#summary [data-count]"), function (el) { countUp(el, Number(el.dataset.count)); });

    // distribution bar
    var total = sum.current.length || 1;
    var dist = '<div class="dist-bar" role="img" aria-label="Stations by category">' + L.CATEGORIES.map(function (c) {
      return sum.counts[c.key] ? '<span data-w="' + (sum.counts[c.key] / total * 100) + '" style="' + swatch(T().cats[c.key]) + '"></span>' : "";
    }).join("") + '</div><div class="dist-legend">' + L.CATEGORIES.map(function (c) {
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
      return '<button type="button" class="srow" data-state="' + esc(r.state) + '" aria-label="' + esc(r.state + ": highest " + r.api + ", " + c.label + ", at " + r.name) + '">' +
        '<span class="s-name">' + esc(r.state) + '</span><span class="track"><span class="fill" data-w="' + (r.api / max * 100) + '" style="' + swatch(c.color) + '"></span>' +
        '<span class="tick" style="left:' + (o / max * 100) + '%"></span><span class="tick closure" style="left:' + (cl / max * 100) + '%"></span></span>' +
        '<span class="s-val">' + r.api + "</span></button>";
    }).join("") + '<p class="bars-key">Dashed marks: ' + o + " (outdoor activities stop above this) and " + cl + " (school-closure level). Tap a state to see it on the map.</p>"
      : '<p class="muted">No current readings to show.</p>';
    Array.prototype.forEach.call(document.querySelectorAll(".srow .fill"), function (el) { growTo(el, Number(el.dataset.w)); });
  }

  // ================================================================ station table

  function populateStateFilter() {
    var sel = $("f-state"), cur = sel.value, names = {};
    stations().forEach(function (s) { if (s.state) names[s.state] = true; });
    sel.innerHTML = '<option value="">All states</option>' + Object.keys(names).sort().map(function (nm) {
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
        '<td class="hide-sm">' + (cur ? badge(s.api) + (pol ? '<span class="sub">' + esc(pol) + "</span>" : "") : badge(null)) + "</td>" +
        "<td>" + esc(readingTime(s.observed, n)) + (!cur && s.api !== null && s.observed ? '<span class="sub">last ' + esc(s.api) + ", outdated</span>" : "") + "</td></tr>";
    });
    if (!list.length) html = '<tr><td colspan="4" class="muted">No stations match.</td></tr>';
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
    renderSelection(false);
    showPlace(null); markRef(null); flyHome();
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

  function schoolSel(r) {
    return { type: "school", code: r[0], label: L.tidy(r[1]), state: L.tidy(r[2]), district: L.tidy(r[3]), town: L.tidy(r[4]),
             lat: r[5], lon: r[6], source: "kpm" };
  }

  function renderSelection(moveMap) {
    var box = $("selection"), sel = S.sel, n = now();
    if (!sel) { box.hidden = true; return; }
    box.hidden = false;
    if (sel.type === "school-code") {
      $("sel-title").textContent = "Loading school…";
      $("loc-info").innerHTML = ""; $("prediction").innerHTML = ""; $("trend").innerHTML = ""; $("forecast").innerHTML = "";
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
      if (!st) { $("sel-title").textContent = "Station not found"; $("loc-info").innerHTML = '<p class="muted">This station is not in the current data.</p>'; $("prediction").innerHTML = ""; $("trend").innerHTML = ""; return; }
      title = st.name; sub = "DOE monitoring station in " + st.state + (st.place ? ", at " + L.tidy(st.place) : "") + " (" + st.id + ")";
      lat = st.lat; lon = st.lon;
    } else {
      title = sel.label; lat = sel.lat; lon = sel.lon;
      var kind = sel.type === "school" ? "School" : sel.type === "locality" ? "Town" : "Place";
      var loc = [sel.town, sel.district, sel.state].filter(Boolean).join(", ");
      sub = kind + (loc ? " in " + loc : "") + (sel.code ? " (" + sel.code + ")" : "");
    }
    $("sel-title").textContent = title;

    var m = (typeof lat === "number" && typeof lon === "number") ? L.matchStations(lat, lon, stations(), n, { state: sel.state }) : null;
    var ref = m && m.reference;
    var html = '<p class="sel-sub">' + esc(sub) + "</p>";
    if (!m) {
      html += '<p class="note">No station coordinates are available, so a reference station cannot be chosen.</p>';
    } else if (!ref) {
      html += '<p class="note">No station near here has a current reading. Readings may be outdated; see the notice at the top of the page.</p>';
      if (st && st.api !== null && st.observed) {
        html += '<p class="note">Last reading at this station: ' + esc(st.api) + " at " + esc(L.fmtDateTime(L.parseTime(st.observed))) + ". This is outdated, not a current reading.</p>";
      }
    } else {
      var rs = ref.station, self = sel.type === "station" && rs.id === sel.id;
      html += '<div class="reading" style="--c:' + cat(rs.api).color + '"><span class="big">' + esc(rs.api) + '</span><span class="meta">' + badge(rs.api) +
        '<span class="where">' + (self ? "IPU at this station" : "IPU at " + esc(rs.name) + " station, " + (ref.km < 1 ? "under 1 km" : Math.round(ref.km) + " km") + " away") +
        "</span></span></div>" +
        '<p class="small muted">Reading for ' + esc(L.fmtDateTime(L.parseTime(rs.observed))) +
        (L.pollutantName(rs.pollutant) ? ". Main pollutant: " + esc(L.pollutantName(rs.pollutant)) : "") + ".</p>";
      if (!self) {
        html += '<p class="ref-note">This is the reading at the DOE monitoring station ' + esc(rs.name) + " (" + esc(rs.id) + "), not a measurement taken at " +
          (sel.type === "school" ? "the school" : "this location") + " itself.</p>";
      }
      if (st && !self) {
        html += '<p class="note">This station has no current reading, so the nearest station with one is shown.</p>';
      }
      m.notes.forEach(function (t) { html += '<p class="note">' + esc(t) + "</p>"; });
    }
    if (sel.type !== "station" && sel.source) {
      html += '<p class="small muted">' + esc(SOURCE_TEXT[sel.source] || sel.source) + (sel.sub && sel.source === "device" ? ". " + esc(sel.sub) : "") + ".</p>";
    }
    $("loc-info").innerHTML = html;

    // prediction, then nearest stations, then trend
    var predBox = $("prediction");
    predBox.innerHTML = predictionHTML(ref ? ref.station : st, sel.state || (ref && ref.station.state) || (st && st.state), m);
    if (m && m.shown.length) {
      predBox.insertAdjacentHTML("beforeend", nearHTML(m, ref, n));
    }
    if (ref) renderTrend($("trend"), ref.station, "Last 24 hours at " + ref.station.name);
    else if (st) renderTrend($("trend"), st, "Last 24 hours at " + st.name);
    else $("trend").innerHTML = "";
    renderForecast($("forecast"), ref ? ref.station : st);

    // map
    if (moveMap) {
      var point = [lon, lat];
      markRef(ref ? ref.station.id : (st ? st.id : null));
      if (sel.type === "station") {
        showPlace(null);
        flyTo({ center: point, zoom: 10.5 });
      } else {
        showPlace(point, title, ref);
        if (ref && ref.km > 2.5) flyTo({ bounds: boundsOf([point, [ref.station.lon, ref.station.lat]]), maxZoom: 12.5 });
        else flyTo({ center: point, zoom: 12.5 });
      }
    }
  }

  function nearHTML(m, ref, n) {
    return '<div class="near"><h3>Nearest stations</h3><div class="table-wrap"><table class="mini"><thead><tr><th>Station</th><th class="num">Distance</th><th class="num">IPU</th><th class="hide-sm">Time</th></tr></thead><tbody>' +
      m.shown.map(function (x) {
        var s = x.station, cur = L.stationCurrent(s, n), c = cat(cur ? s.api : null);
        return '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + ">" +
          '<td><span class="dot" style="' + swatch(c ? c.color : T().off) + '"></span>' + esc(s.name) + (ref && x === ref ? " (reference)" : "") +
          '<span class="sub">' + esc(s.state) + "</span></td>" +
          '<td class="num">' + (x.km < 1 ? "&lt;1" : Math.round(x.km)) + " km</td>" +
          '<td class="num api">' + (cur ? esc(s.api) : "—") + '</td><td class="hide-sm">' + esc(readingTime(s.observed, n)) + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
  }

  function disclaimer() {
    var r = S.rule;
    return '<div class="disclaimer"><b>This is a prediction, not an official closure announcement.</b> It is worked out from official DOE readings. ' +
      "Closures are decided and announced by KPM, the State Education Department (JPN) or the District Education Office (PPD), so check their announcements. " +
      "Rule used: " + esc(r.closure.summary) + " (" + esc(r.name) + ", in force from " + esc(L.fmtDayKey(r.effective_from)) + '). <a href="#about">How the prediction works</a></div>';
  }

  function predictionHTML(st, stateName, m) {
    var n = now();
    if (!S.rule) return "<h3>School closure check</h3><p class='muted'>The closure rule file could not be loaded.</p>";
    var p = L.predict(st, S.rule, n, stateName);
    var html = "<h3>School closure check</h3>";
    if (!p.available) {
      return html + '<div class="pred-status unavailable">Prediction unavailable</div><p class="pred-detail">' + esc(p.reason) + "</p>" + disclaimer();
    }
    html += '<div class="pred-status ' + p.level + '">' + esc(p.status) + "</div>" +
      '<p class="pred-detail"><b>' + esc(p.headline) + ".</b> " + esc(p.detail) + "</p>" +
      '<dl class="facts">' +
      "<dt>Reference station</dt><dd>" + esc(st.name) + ", " + esc(st.state) + "</dd>" +
      "<dt>Reading time</dt><dd>" + esc(L.fmtDateTime(p.latestAt)) + "</dd>" +
      "<dt>Highest today</dt><dd>" + (p.todayMax !== null ? esc(p.todayMax) + " at " + esc(L.fmtTime(p.todayMaxAt)) : "—") + "</dd>" +
      "<dt>Reached " + S.rule.closure.threshold + " today</dt><dd>" + (p.reachedToday ? "Yes" : "No") + "</dd>" +
      "<dt>Predicted for " + esc(L.fmtDayKey(p.tomorrowKey).replace(/ \d{4}$/, "")) + "</dt><dd>" + esc(p.status) + "</dd>" +
      "<dt>Outdoor activities</dt><dd>" + (p.outdoorStop ? "Should stop now (IPU above " + S.rule.outdoor.threshold + ")" : "No restriction at this reading") + "</dd>" +
      "</dl>";
    if (m && m.all && !p.reachedToday) {
      m.all.filter(function (x) {
        if (x.station === st || x.km > 30 || !L.stationCurrent(x.station, n)) return false;
        var q = L.predict(x.station, S.rule, n, stateName);
        return q.available && q.reachedToday;
      }).forEach(function (x) {
        html += '<p class="note">' + esc(x.station.name) + " (" + Math.round(x.km) + " km away) reached the closure level today. Schools in its area may close, which may include this location.</p>";
      });
    }
    return html + disclaimer();
  }

  function renderStateSelection(sel, n, moveMap) {
    var sum = L.stateSummary(sel.state, stations(), S.rule, n);
    $("sel-title").textContent = sel.state;
    if (!sum.stations.length) {
      $("loc-info").innerHTML = '<p class="muted">No stations found for this state.</p>';
      $("prediction").innerHTML = ""; $("trend").innerHTML = ""; return;
    }
    var html = '<p class="sel-sub">' + sum.stations.length + " monitoring station" + (sum.stations.length > 1 ? "s" : "") + ", " + sum.current.length + " with a current reading</p>";
    if (sum.highest) {
      html += '<div class="reading" style="--c:' + cat(sum.highest.api).color + '"><span class="big">' + esc(sum.highest.api) + '</span><span class="meta">' + badge(sum.highest.api) +
        '<span class="where">Highest now, at ' + esc(sum.highest.name) + "</span></span></div>" +
        (sum.lowest && sum.lowest !== sum.highest ? '<p class="small muted">Lowest now: ' + esc(sum.lowest.api) + " at " + esc(sum.lowest.name) + ".</p>" : "");
    }
    html += '<p class="ref-note">Air quality differs across a state, so each station is listed separately. Search a town or school to use its nearest station.</p>';
    $("loc-info").innerHTML = html;

    var noSchool = sum.tomorrowNoSchool, day = L.fmtDayKey(sum.tomorrowKey);
    var noTxt = noSchool ? (noSchool.kind === "weekend" ? "No school (weekend)" : "No school (holiday)") : null;
    var p = "<h3>School closure check</h3>";
    if (!sum.current.length) {
      p += '<div class="pred-status unavailable">Prediction unavailable</div><p class="pred-detail">No station in this state has a current reading.</p>';
    } else if (sum.reached.length) {
      p += '<div class="pred-status may_close">' + esc(noTxt || "Schools in some areas may be closed") + "</div>" +
        '<p class="pred-detail"><b>The closure level of ' + S.rule.closure.threshold + " was reached today at " + sum.reached.length + " station" + (sum.reached.length > 1 ? "s" : "") + ".</b> " +
        (noSchool ? "Under the current rule, schools in the affected areas close immediately at this level. Tomorrow (" + esc(day) + ") is not a school day in " + esc(sel.state) + "."
                  : "Schools in the affected areas may be closed tomorrow (" + esc(day) + ").") +
        " Closure applies to affected areas, not necessarily the whole state.</p><ul class='pred-detail'>" +
        sum.reached.map(function (r) { return "<li>" + esc(r.station.name) + ": highest " + esc(r.p.todayMax) + " at " + esc(L.fmtTime(r.p.todayMaxAt)) + ", latest " + esc(r.p.latest) + "</li>"; }).join("") + "</ul>";
    } else {
      p += '<div class="pred-status ' + (noSchool ? "no_school" : "not_reached") + '">' + esc(noTxt || "Not predicted to close") + "</div>" +
        '<p class="pred-detail"><b>Closure threshold not reached.</b> No station in ' + esc(sel.state) + " has reached " + S.rule.closure.threshold + " today at the latest readings." +
        (noSchool ? " Tomorrow (" + esc(day) + ") is not a school day in " + esc(sel.state) + "."
                  : " Based on readings so far, no haze closure is predicted for " + esc(day) + ". This can change if readings rise later today.") + "</p>";
    }
    if (sum.current.length) {
      var outdoor = sum.current.filter(function (s) { return L.meets(s.api, S.rule.outdoor); }).length;
      p += '<dl class="facts"><dt>Reached ' + S.rule.closure.threshold + " today</dt><dd>" + (sum.reached.length ? "Yes, at " + sum.reached.length + " station" + (sum.reached.length > 1 ? "s" : "") : "No") + "</dd>" +
        "<dt>Above " + S.rule.outdoor.threshold + " now</dt><dd>" + outdoor + " of " + sum.current.length + " stations (outdoor activities stop in those areas)</dd></dl>";
    }
    p += disclaimer();
    p += '<div class="near"><h3>Stations in ' + esc(sel.state) + '</h3><div class="table-wrap"><table class="mini"><thead><tr><th>Station</th><th class="num">IPU</th><th class="hide-sm">Category</th><th>Time</th></tr></thead><tbody>' +
      sum.stations.slice().sort(function (a, b) {
        return (L.stationCurrent(b, n) ? b.api : -1) - (L.stationCurrent(a, n) ? a.api : -1);
      }).map(function (s) {
        var cur = L.stationCurrent(s, n), c = cat(cur ? s.api : null);
        return '<tr tabindex="0" data-station="' + esc(s.id) + '"' + (cur ? "" : ' class="outdated"') + '><td><span class="dot" style="' + swatch(c ? c.color : T().off) + '"></span>' + esc(s.name) + "</td>" +
          '<td class="num api">' + (cur ? esc(s.api) : "—") + '</td><td class="hide-sm">' + badge(cur ? s.api : null) + "</td><td>" + esc(readingTime(s.observed, n)) + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
    $("prediction").innerHTML = p;
    if (sum.highest) renderTrend($("trend"), sum.highest, "Last 24 hours at " + sum.highest.name + ", the highest station in " + sel.state);
    else $("trend").innerHTML = "";
    renderForecast($("forecast"), sum.highest);

    if (moveMap) {
      showPlace(null);
      markRef(sum.highest ? sum.highest.id : null);
      var pts = sum.stations.filter(function (s) { return typeof s.lat === "number"; }).map(function (s) { return [s.lon, s.lat]; });
      if (pts.length) flyTo({ bounds: boundsOf(pts), maxZoom: 9.5 });
    }
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
      var p0 = document.createElement("p"); p0.className = "muted"; p0.textContent = "Not enough hourly readings yet to draw a trend for this station.";
      box.appendChild(p0); return;
    }
    var lastPt = pts[pts.length - 1];
    if ((n - lastPt.t) / 3600000 > L.STALE_HOURS) {
      var warn = document.createElement("p"); warn.className = "note";
      warn.textContent = "Outdated: the newest reading in this chart is from " + L.fmtDateTime(lastPt.t) + " (" + L.ago(lastPt.t, n) + ").";
      box.appendChild(warn);
    }
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    var W = Math.max(280, chart.clientWidth || 400), H = 200, padL = 32, padR = 8, padT = 14, padB = 26;
    var t0 = pts[0].t.getTime(), t1 = lastPt.t.getTime();
    var ymax = niceMax(Math.max.apply(null, pts.map(function (p) { return p.y; })), 220);
    var sx = function (t) { return padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "Hourly IPU at " + st.name + " over the last 24 hours" });
    for (var g = 0; g <= ymax; g += 50) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: sy(g), y2: sy(g), stroke: T().grid }));
      svg.appendChild(svgEl("text", { x: padL - 6, y: sy(g) + 4, "font-size": 11, fill: T().axis, "text-anchor": "end" }, String(g)));
    }
    var step = 6 * 3600000;
    for (var tt = Math.ceil(t0 / step) * step; tt <= t1; tt += step) {
      svg.appendChild(svgEl("text", { x: sx(tt), y: H - 6, "font-size": 11, fill: T().axis, "text-anchor": "middle" }, L.fmtTime(new Date(tt))));
    }
    if (S.rule) {
      [[S.rule.outdoor.threshold, "100: outdoor activities stop above this", T().outdoor], [S.rule.closure.threshold, "200: school-closure level", T().closure]].forEach(function (r) {
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
    det.innerHTML = "<summary>Show these readings as a table</summary><div class='table-wrap'><table class='mini'><thead><tr><th>Hour</th><th class='num'>IPU</th><th>Category</th></tr></thead><tbody>" +
      pts.slice().reverse().map(function (p) { return "<tr><td>" + esc(L.fmtDateTime(p.t)) + "</td><td class='num'>" + p.y + "</td><td>" + badge(p.y) + "</td></tr>"; }).join("") +
      "</tbody></table></div>";
    box.appendChild(det);
    var src = document.createElement("p"); src.className = "small muted";
    src.textContent = "Source: DOE APIMS hourly table for " + st.name + " (" + st.id + "). Each value is DOE's 24-hour running average for that hour.";
    box.appendChild(src);
  }

  function renderDosm() {
    var box = $("dosm"), d = S.dosm;
    if (!d || !d.rows || !d.rows.length) { box.innerHTML = '<p class="muted">DOSM history has not been downloaded yet. It is added by the hourly update.</p>'; return; }
    var want = [["pm25", "PM2.5", T().series], ["pm10", "PM10", T().seriesB]];
    var series = want.map(function (w) {
      return { name: w[1], color: w[2], pts: d.rows.filter(function (r) { return r[1] === w[0] && r[2] !== null; })
        .map(function (r) { return { t: new Date(r[0] + "T00:00:00Z"), y: r[2], date: r[0] }; }) };
    }).filter(function (s) { return s.pts.length > 1; });
    var month = function (key) { return L.fmtDayKey(key).replace(/^\w+ \d+ /, ""); };
    box.innerHTML = "<p>Monthly national average of fine particles in the air (µg/m³), from DOSM. Haze years stand out as peaks. " +
      "This is background only: it is not IPU, not per station and not current. Latest month: " + esc(d.last_month ? month(d.last_month) : "—") + ".</p>";
    if (!series.length) { box.insertAdjacentHTML("beforeend", '<p class="muted">No PM2.5 or PM10 values in the DOSM file.</p>'); return; }
    var chart = document.createElement("div"); chart.className = "chart"; box.appendChild(chart);
    var all = []; series.forEach(function (s) { all = all.concat(s.pts); });
    var W = Math.max(280, chart.clientWidth || 400), H = 210, padL = 30, padR = 46, padT = 10, padB = 24;
    var t0 = Math.min.apply(null, all.map(function (p) { return p.t.getTime(); })), t1 = Math.max.apply(null, all.map(function (p) { return p.t.getTime(); }));
    var ymax = Math.ceil(Math.max.apply(null, all.map(function (p) { return p.y; })) / 10) * 10;
    var sx = function (t) { return padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR); };
    var sy = function (v) { return H - padB - (v / ymax) * (H - padT - padB); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "Monthly national average PM2.5 and PM10, DOSM" });
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
    }).join("") + '</div><p class="small muted" style="margin-top:8px">Source: <a href="' + esc(d.source.page) + '" rel="noopener">OpenDOSM, Monthly Air Pollution</a> (' + esc(d.source.licence) +
      "). Source agencies: DOE and DOSM.</p>");
  }

  // ================================================================ about

  function renderAbout() {
    var r = S.rule, d = S.data;
    if (!r) { $("about-body").innerHTML = ""; return; }
    var schoolsLine = S.schoolsMeta && S.schoolsMeta.available
      ? "School locations come from the official KPM list (" + esc(S.schoolsMeta.count) + " schools with coordinates" +
        (S.schoolsMeta.skipped_no_coordinates ? "; " + esc(S.schoolsMeta.skipped_no_coordinates) + " without coordinates cannot be searched" : "") + ")."
      : "The official KPM school list has not been added yet. Until it is, schools and towns are found with OpenStreetMap, which is community-made and may be incomplete or wrong.";
    $("about-body").innerHTML =
      "<details><summary>Where the readings come from</summary><div>" +
      "<p>Every hour an automated job reads the Department of Environment's Air Pollutant Index Management System (APIMS), using the same public data the official portal at " +
      '<a href="https://eqms.doe.gov.my/APIMS/main" rel="noopener">eqms.doe.gov.my/APIMS</a> shows: each station\'s latest reading and its last 24 hourly readings. ' +
      "The site is then republished, and an open page re-reads the data every 10 minutes. Nothing is estimated or filled in: a station without a recent reading is shown as having no current reading.</p>" +
      "<p>The IPU (API) is DOE's 24-hour running average of the dominant pollutant, so it changes slowly and lags sudden changes in haze.</p></div></details>" +
      "<details><summary>How a place is matched to a station</summary><div>" +
      "<p>For a school, town or place, the dashboard uses the nearest DOE monitoring station that has a current reading (straight-line distance), and shows that distance on the map. " +
      "It lists the next nearest stations and says when stations close by disagree. The station's reading is never presented as a measurement at the school or place itself.</p>" +
      "<p>On the map, the soft glow around each station grows with its reading. It is a visual cue only, not a measured area of haze.</p></div></details>" +
      "<details><summary>The school-closure rule</summary><div>" +
      "<p><b>" + esc(r.name) + "</b>, in force from " + esc(L.fmtDayKey(r.effective_from)) + ".</p><ul>" +
      "<li>" + esc(r.closure.summary) + " " + esc(r.closure.note) + "</li><li>" + esc(r.outdoor.summary) + "</li></ul>" +
      "<p>How the dashboard applies it:</p><ul>" + r.how_applied.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" +
      "<p>" + esc(r.who_decides) + "</p>" +
      "<p>Earlier rule: " + r.previous_rules.map(function (p) { return esc(L.fmtDayKey(p.from)) + " to " + esc(L.fmtDayKey(p.to)) + ": " + esc(p.summary); }).join(" ") + "</p>" +
      "<p>Sources:</p><ul>" + r.sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.title) + "</a> (" + esc(s.date) + ")</li>"; }).join("") + "</ul></div></details>" +
      "<details><summary>The forecast and the haze sources</summary><div>" +
      "<p>The forecast is an estimate made by this site, kept apart from the official readings. It takes the CAMS air-quality model's PM2.5 forecast (Copernicus Atmosphere Monitoring Service, via Open-Meteo) at each station and scales it to that station's official IPU over the last 24 hours. " +
      "It is shown only next to a current official reading, always labelled as an estimate, and never used for the school closure check, which uses DOE APIMS readings only.</p>" +
      "<p>Fire hotspots are NASA FIRMS satellite detections (VIIRS) from the last 24 hours; detections older than 36 hours are never shown. Wind is the current 10 m wind from the Open-Meteo weather model. Together they show where fires are and which way the wind blows, not the actual path of the smoke.</p></div></details>" +
      "<details><summary>Limitations</summary><div><ul>" +
      "<li>Malaysia has about 68 DOE stations. Many schools are far from one, and a single station cannot show local differences.</li>" +
      "<li>The dashboard cannot see official announcements. A school may be closed or open for reasons this rule does not capture, such as a state directive.</li>" +
      "<li>Weekends and the year-end school holidays are included; public holidays and state holidays are not.</li>" +
      "<li>The APIMS data endpoints are not a documented public API. If DOE changes them, updates stop and this page marks its readings as outdated.</li>" +
      "<li>Updates run on GitHub Actions at minute " + UPDATE_MINUTE + " of every hour; GitHub sometimes starts them a few minutes late.</li>" +
      "<li>DOSM history is national monthly averages of pollutant concentrations, not IPU and not per station.</li>" +
      "<li>" + schoolsLine + "</li></ul>" +
      (d && d.source ? '<p class="small muted">Data endpoints: ' + esc(d.source.current_endpoint) + " and " + esc(d.source.hourly_endpoint) + ".</p>" : "") +
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
      ? "Schools and towns come from the official KPM school list. Press Search for any other place."
      : "Press Search to find any town or school in Malaysia (OpenStreetMap). The official KPM school list has not been added yet.";
  }

  var GROUPS = { state: "States", station: "Monitoring stations", locality: "Towns and districts", school: "Schools", place: "Places (OpenStreetMap)" };

  function renderResults(items, extraMsg, q) {
    var html = "", last = null;
    items.forEach(function (r, i) {
      if (r.type !== last) { html += '<div class="group">' + esc(GROUPS[r.type] || r.type) + "</div>"; last = r.type; }
      html += '<button type="button" role="option" data-i="' + i + '">' + esc(r.label) + '<span class="sub">' + esc(r.sub || "") + "</span></button>";
    });
    if (extraMsg) html += '<div class="msg">' + extraMsg + "</div>";
    if (q && q.length >= 3 && !items.some(function (r) { return r.type === "place"; })) {
      html += '<button type="button" role="option" data-place="1">Search all places for “' + esc(q) + '”<span class="sub">Towns, neighbourhoods and schools, from OpenStreetMap</span></button>';
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
    $("results").innerHTML = '<div class="msg">Searching places in Malaysia…</div>';
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
          renderResults(local.concat(places), places.length ? '<span class="small muted">Place results © OpenStreetMap contributors. Check it is the place you mean.</span>'
            : "No places found for “" + esc(q) + "”. Try another spelling or a nearby town.", null);
        })
        .catch(function () { $("results").innerHTML = '<div class="msg">Place search is not available right now. You can still search states and stations, or use your location.</div>'; });
    }, wait);
  }

  function useMyLocation() {
    var btn = $("loc-btn");
    if (!navigator.geolocation) { msg("This browser does not share its location. Search for your town or school instead."); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      var acc = Math.round(pos.coords.accuracy || 0);
      select({ type: "place", label: "Your location", lat: pos.coords.latitude, lon: pos.coords.longitude, source: "device",
               sub: acc ? "Accurate to about " + (acc > 1000 ? Math.round(acc / 1000) + " km" : acc + " m") : null });
    }, function () {
      btn.disabled = false;
      msg("Location was not shared. Search for your town or school instead.");
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }
  function msg(text) { $("results").innerHTML = '<div class="msg">' + esc(text) + "</div>"; }

  // ================================================================ theme

  function setThemeButton() {
    var on = themeName() === "neon";
    var b = $("theme-btn");
    if (!b) return;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.querySelector(".theme-label").textContent = on ? "Neon on" : "Neon";
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
    if (S.data) { renderOverview(); renderTable(); renderMarkers(); renderSelection(false); renderOutlook(); }
    renderSourcesSection();
    renderDosm();
    if (M.map) {
      M.styleReady = false;
      try { M.map.setStyle(M.fallbackUsed ? fallbackStyle() : T().style, { diff: false }); }
      catch (e) { useFallback(); }
    }
  }

  // ================================================================ wiring

  function renderAll() {
    renderStatus();
    populateStateFilter();
    renderOverview();
    renderTable();
    renderMarkers();
    renderSelection(false);
    renderOutlook();
    renderSourcesSection();
    updateSourcesOnMap();
    renderAbout();
    S.firstPaint = false;
  }

  function loadExtras() {
    return Promise.all([
      getJSON("data/forecast.json").catch(function () { return null; }),
      getJSON("data/sources.json").catch(function () { return null; })
    ]).then(function (r) { S.forecast = r[0]; S.sources = r[1]; });
  }

  function refresh() {
    Promise.all([getJSON("data/latest.json"), loadExtras()]).then(function (res) {
      var d = res[0], changed = !S.data || d.last_attempt !== S.data.last_attempt;
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
    $("sel-close").addEventListener("click", clearSelection);
    $("map-home").addEventListener("click", flyHome);
    $("theme-btn").addEventListener("click", function () { applyTheme(themeName() === "neon" ? "light" : "neon"); });
    $("src-btn").addEventListener("click", function () { setSources(!M.sourcesOn, true); });
    document.addEventListener("click", function (ev) {
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
    var rt = null, lastW = window.innerWidth;
    window.addEventListener("resize", function () {
      if (window.innerWidth === lastW) return;          // ignore mobile toolbar show/hide
      lastW = window.innerWidth;
      clearTimeout(rt);
      rt = setTimeout(function () { renderSelection(false); renderDosm(); }, 200);
    });
    window.addEventListener("hashchange", function () { var h = readHash(); if (h) select(h, { keepHash: true }); });
  }

  function init() {
    setThemeButton();
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
      getJSON("data/dosm_monthly.json").then(function (d) { S.dosm = d; }).catch(function () { S.dosm = null; }).then(renderDosm);
      loadSchools();
    });
    setInterval(refresh, REFRESH_MS);
    setInterval(renderStatus, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  }

  init();
})();
