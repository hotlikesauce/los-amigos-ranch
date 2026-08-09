/* analytics.js -- Google Analytics 4 for the ranch map.

   Loads gtag.js and exposes one function, window.track(name, params), which the
   map calls at the handful of places where a user does something worth knowing
   about. Everything here is deliberately fail-soft: an ad blocker, an offline
   laptop in the field, or this file simply not loading must never break the map,
   so callers pick up a no-op stub and gtag is only ever touched through track().

   Loading is skipped entirely on localhost and file://, so running
   `npm run dev` doesn't pollute the property with developer traffic. Append
   ?ga_debug=1 to any URL to see every event echoed to the console (locally that
   is the only thing that happens, which is how you verify the wiring without
   sending a hit). */
(function () {
  "use strict";

  var MEASUREMENT_ID = "G-K6L1JRMY7K";

  var DEBUG = /[?&]ga_debug=1\b/.test(location.search);
  var LOCAL = location.protocol === "file:" ||
    /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname) ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  if (!LOCAL) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(MEASUREMENT_ID);
    (document.head || document.documentElement).appendChild(s);
    gtag("js", new Date());
    gtag("config", MEASUREMENT_ID);
  }

  // GA4 caps event-parameter strings at 100 characters and silently drops the
  // whole event on a non-finite number, so values are normalised here rather
  // than trusted from ~20 call sites. Empty/absent values are omitted so a
  // parameter is either meaningful or missing, never "".
  function clean(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return isFinite(v) ? Math.round(v * 100) / 100 : undefined;
    var str = String(v).trim();
    return str ? str.slice(0, 100) : undefined;
  }

  function track(name, params) {
    var out = {};
    if (params) {
      Object.keys(params).forEach(function (k) {
        var v = clean(params[k]);
        if (v !== undefined) out[k] = v;
      });
    }
    if (DEBUG) console.log("[ga]", name, out);
    if (LOCAL) return;
    try { gtag("event", name, out); } catch (e) { /* never break the map */ }
  }

  // Typing "cut off" fires eight input events; only the query someone stopped
  // on is interesting. Keyed by event name so each kind of event debounces
  // independently, and the last call wins.
  var timers = {};
  track.later = function (name, params, ms) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(function () { track(name, params); }, ms || 1200);
  };
  track.cancel = function (name) { clearTimeout(timers[name]); };

  window.track = track;
})();
