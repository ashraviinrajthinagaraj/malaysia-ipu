/* Page language: English or Bahasa Melayu.
   All text in app.js and logic.js is written in English and passed through I18N.t().
   docs/i18n.ms.js holds the Bahasa Melayu text for each English string; anything
   without a translation stays in English (and is listed in I18N.missing for checking).
   The language comes from the link (lang=ms or lang=en), then the visitor's saved
   choice, then the browser language. */
(function (root) {
  "use strict";
  var KEY = "ipu-lang";
  function pick() {
    var m = /[?#&]lang=(ms|en)(?:&|$)/.exec((location.search || "") + (location.hash || ""));
    if (m) return m[1];
    try {
      var s = localStorage.getItem(KEY);
      if (s === "ms" || s === "en") return s;
    } catch (e) { /* storage blocked: use the browser language */ }
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    return /^ms(-|$)/i.test(nav) ? "ms" : "en";
  }
  var has = Object.prototype.hasOwnProperty;
  var I = { lang: pick(), missing: {} };
  I.t = function (s) {
    if (I.lang !== "ms" || typeof s !== "string") return s;
    var d = root.I18N_MS || {};
    if (has.call(d, s)) return d[s];
    I.missing[s] = (I.missing[s] || 0) + 1;
    return s;
  };
  I.set = function (lang) {
    I.lang = lang === "ms" ? "ms" : "en";
    try { localStorage.setItem(KEY, I.lang); } catch (e) { /* keep for this visit only */ }
    document.documentElement.lang = I.lang;
  };
  document.documentElement.lang = I.lang;
  root.I18N = I;
})(window);
