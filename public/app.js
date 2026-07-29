/* Los Amigos Ranch -- infrastructure & water systems map.

   Reads layers.json plus data/*.geojson produced by scripts/build_data.py.
   Structure mirrors the Jonah Operations Map (same panel/TOC/search/popup
   conventions) with three additions this inventory needs:
     - water lines symbolized and filterable by distribution system,
     - a searchable index that also matches each asset's alternate names,
     - survey photos as a first-class layer, shown inline in feature popups
       and browsable in a lightbox. */
(function () {
  "use strict";

  var CFG = null;        // layers.json
  var state = {};        // layer id -> { cfg, layer, loaded, loading, byLabel, subs }
  var index = [];        // search index
  var photoMeta = {};    // photo filename -> record from photos.json

  // -------------------------------------------------------------- basemaps
  var ESRI_ATTR = "Tiles &copy; Esri";
  // maxNativeZoom is the deepest level Esri actually has imagery for HERE, and
  // it is not the service's advertised maximum. Measured over this ranch,
  // World_Imagery returns real tiles through z19 and an identical 2.5 KB
  // "not available" placeholder at z20+. Requesting those made the aerial go
  // blank past z19; capping native at 19 and letting maxZoom run to 22 upscales
  // the real tile instead, so zooming in stays useful.
  var topo = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 22, maxNativeZoom: 19, attribution: ESRI_ATTR, crossOrigin: true });
  var aerial = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 22, maxNativeZoom: 19, attribution: ESRI_ATTR, crossOrigin: true });

  // Phones open on the aerial, desktops on the topo sheet. On a phone the map is
  // most often being read in the field against what the user can actually see,
  // and imagery orients you far better than a topo basemap on a small screen.
  // Matches the CSS drawer breakpoint. Read once at load: after that the user's
  // own basemap choice wins, so rotating a phone must not undo it.
  var IS_NARROW = window.matchMedia("(max-width: 860px)").matches;

  var map = L.map("map", {
    center: [29.1783, -99.2182], zoom: 14, minZoom: 11, maxZoom: 22,
    zoomSnap: 0.5, zoomDelta: 0.5, layers: [IS_NARROW ? aerial : topo], zoomControl: true
  });

  // z-order panes: ranch imagery < polygons < lines < points < emphasis.
  // The ranch aerial is a supplied ground overlay, so it needs its own pane
  // just above the basemap tiles rather than competing with vector overlays.
  map.createPane("ranchImagery"); map.getPane("ranchImagery").style.zIndex = 250;
  map.createPane("polys");        map.getPane("polys").style.zIndex = 405;
  map.createPane("lines");        map.getPane("lines").style.zIndex = 410;
  map.createPane("points");       map.getPane("points").style.zIndex = 420;
  map.createPane("emphasis");     map.getPane("emphasis").style.zIndex = 430;

  // ---------------------------------------------------------------- styling
  // Water is the subject of this map, so the three distribution systems get
  // the three most distinct hues and the heaviest line weights; utilities and
  // ranch context recede into ambers, browns and greys.
  var SYSTEM_COLOR = {
    "Yancey": "#0b5cab",          // deep blue
    "Ranch Water": "#00a3b4",     // teal
    "Irrigation": "#2f9e4f"       // green
  };

  // Base sizes are for the opening extent (~z14.5); everything scales up from
  // here as you zoom in -- see applyZoomScaling.
  var LAYER_STYLE = {
    // Water infrastructure (points) -- the subject of the map, so these are the
    // largest symbols on it
    water_wells:       { radius: 9, fillColor: "#0b5cab", stroke: "#04294d", weight: 2, shape: "well" },
    water_pumps:       { radius: 8, fillColor: "#1f7fc4", stroke: "#04294d", weight: 1.5, shape: "square" },
    meters:            { radius: 7.5, fillColor: "#6f42c1", stroke: "#2b1a4d", weight: 1.5, shape: "square" },
    manifolds:         { radius: 9, fillColor: "#d6336c", stroke: "#5c122f", weight: 1.5, shape: "star" },
    risers:            { radius: 8, fillColor: "#0f9d8f", stroke: "#053b35", weight: 1.5, shape: "triangle" },
    transfer_points:   { radius: 9, fillColor: "#e8590c", stroke: "#5c2103", weight: 1.5, shape: "star" },
    valves:            { radius: 7, fillColor: "#e03131", stroke: "#4d0f0f", weight: 1.4 },
    cutoffs:           { radius: 7, fillColor: "#f59f00", stroke: "#5c3c00", weight: 1.3, shape: "diamond" },
    irrigation_pivots: { radius: 8.5, fillColor: "#2f9e4f", stroke: "#0d3d1f", weight: 1.5, shape: "square" },

    // Water lines -- weight is the visual hierarchy: mains read boldest
    yancey_water:          { color: SYSTEM_COLOR["Yancey"], weight: 3.2 },
    ranch_water:           { color: SYSTEM_COLOR["Ranch Water"], weight: 3 },
    lake_irrigation_water: { color: SYSTEM_COLOR["Irrigation"], weight: 2.8 },

    // Utilities
    buried_electric: { color: "#e8a33d", weight: 2.2, dashArray: "7,4" },
    fiber:           { color: "#9b59b6", weight: 2.2, dashArray: "2,4",
                       fillColor: "#9b59b6", fillOpacity: 0.12 },
    electric_boxes:  { radius: 6.5, fillColor: "#e8a33d", stroke: "#5c3c00", weight: 1.3, shape: "square" },

    // Ranch context
    ranch_sites:     { radius: 7.5, fillColor: "#495057", stroke: "#14181c", weight: 1.5, shape: "square" },
    lakes:           { radius: 7, fillColor: "#3aa0d6", stroke: "#0b3e5c", weight: 1.3 },
    blinds:          { radius: 6, fillColor: "#7f5539", stroke: "#33200f", weight: 1.1, shape: "triangle" },
    feeders:         { radius: 5.5, fillColor: "#b08968", stroke: "#4a3421", weight: 1.1 },
    cattle_troughs:  { radius: 5.5, fillColor: "#4c9f9c", stroke: "#123d3c", weight: 1.1 },
    cattle_guards:   { radius: 6, fillColor: "#868e96", stroke: "#2b3035", weight: 1.1, shape: "square" },

    // Transportation & boundaries
    roads:       { color: "#a8967a", weight: 2.4 },
    fences:      { color: "#7d6b4f", weight: 1.6, dashArray: "5,4" },
    fence_posts: { radius: 3.2, fillColor: "#7d6b4f", stroke: "#3b3123", weight: 0.8 },

    // Photos
    photos: { radius: 10, fillColor: "#ffc300", stroke: "#5c4600", weight: 1.5, shape: "camera" }
  };

  // Layers on at first load: the water inventory this map exists for, plus the
  // photos and enough ranch context (roads, sites) to orient by. Everything
  // else stays one click away rather than arriving as clutter.
  var DEFAULT_ON = {
    water_wells: 1, water_pumps: 1, meters: 1, manifolds: 1, risers: 1,
    transfer_points: 1, valves: 1, cutoffs: 1, irrigation_pivots: 1,
    yancey_water: 1, ranch_water: 1, lake_irrigation_water: 1,
    buried_electric: 1, fiber: 1, electric_boxes: 1,
    ranch_sites: 1, lakes: 1, roads: 1, photos: 1
  };

  // Points drawn in the "emphasis" pane so they stay clickable above the
  // denser point layers around them.
  var EMPHASIS = { water_wells: 1, manifolds: 1, transfer_points: 1, meters: 1, photos: 1 };

  // Permanent map labels, zoom-gated by class (see .show-*-labels in the CSS).
  // Only layers whose features carry genuinely descriptive names are labelled --
  // labelling "Cut-Off 14 (Yancey)" 30 times would be noise, not information.
  var LABELS = {
    water_wells:     "map-label lbl-water",
    transfer_points: "map-label lbl-water",
    manifolds:       "map-label lbl-water",
    risers:          "map-label lbl-water",
    ranch_sites:     "map-label lbl-site",
    lakes:           "map-label lbl-lake",
    blinds:          "map-label lbl-hunt"
  };
  // Named infrastructure labels come in just above the opening extent, so they
  // appear as soon as you start zooming toward an asset rather than only at
  // very close range.
  var LABEL_ZOOM = { infra: 15.5, site: 14 };

  function styleOf(id) { return LAYER_STYLE[id] || {}; }
  function colorFor(id) {
    var s = styleOf(id);
    return s.fillColor || s.color || "#7d848c";
  }
  function paneFor(cfg) {
    if (cfg.geometry === "line") return "lines";
    if (cfg.geometry === "polygon") return "polys";
    return EMPHASIS[cfg.id] ? "emphasis" : "points";
  }
  // The TOC swatch must read as the same symbol the map draws, including
  // whether a line is solid or dashed.
  function swatchShape(cfg) {
    var s = styleOf(cfg.id);
    if (cfg.geometry === "line") return s.dashArray ? "dashed" : "line";
    if (cfg.geometry === "polygon") return "polygon";
    if (s.shape === "well") return "point";   // drawn as a circle in the legend
    return s.shape || "point";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Fetch + parse JSON without trusting the response's content-type. Static
  // hosts disagree about the MIME type for .geojson (python's http.server and
  // S3 both default to application/octet-stream), so gating on content-type
  // rejects good data. Parsing is the real test; on failure the first bytes of
  // the body identify what actually arrived -- e.g. an HTML error page.
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.text().then(function (txt) {
        try {
          return JSON.parse(txt);
        } catch (err) {
          throw new Error("not valid JSON for " + url + "; starts with: " + txt.slice(0, 80));
        }
      });
    });
  }

  // ------------------------------------------------------------ marker icons
  function markerSvg(s) {
    var r = s.radius || 6, fill = s.fillColor || "#2f9e6d";
    var stroke = s.stroke || "#0b1017", w = s.weight || 1.4;
    var size = Math.round(r * 2.4);
    function wrap(inner, sz) {
      return { html: '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 24 24">' + inner + "</svg>", size: sz };
    }
    if (s.shape === "square") {
      return wrap('<rect x="3.5" y="3.5" width="17" height="17" rx="2" fill="' + fill +
        '" stroke="' + stroke + '" stroke-width="' + (w * 1.4) + '"/>', size);
    }
    if (s.shape === "diamond") {
      return wrap('<path d="M12 2.5 21.5 12 12 21.5 2.5 12z" fill="' + fill +
        '" stroke="' + stroke + '" stroke-width="' + (w * 1.4) + '"/>', size);
    }
    if (s.shape === "triangle") {
      return wrap('<path d="M12 3 22 20.5H2z" fill="' + fill + '" stroke="' + stroke +
        '" stroke-width="' + (w * 1.4) + '" stroke-linejoin="round"/>', size);
    }
    if (s.shape === "star") {
      return wrap('<path d="M12 1.6l3.09 6.26 6.91 1-5 4.87 1.18 6.88L12 17.3l-6.18 3.31L7 13.73l-5-4.87 6.91-1z" fill="' +
        fill + '" stroke="' + stroke + '" stroke-width="' + (w * 1.1) + '" stroke-linejoin="round"/>', size);
    }
    if (s.shape === "well") {
      // Survey-style well symbol: filled circle with a centred cross.
      return wrap('<circle cx="12" cy="12" r="8" fill="' + fill + '" stroke="' + stroke +
        '" stroke-width="' + (w * 1.3) + '"/><path d="M12 3.2v17.6M3.2 12h17.6" stroke="' + stroke +
        '" stroke-width="1.4"/>', size);
    }
    if (s.shape === "camera") {
      return wrap('<rect x="1.5" y="5.5" width="21" height="15" rx="2.5" fill="' + fill +
        '" stroke="' + stroke + '" stroke-width="1.5"/>' +
        '<path d="M8.5 5.5l1.4-2.2h4.2l1.4 2.2z" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>' +
        '<circle cx="12" cy="13" r="4" fill="none" stroke="' + stroke + '" stroke-width="1.7"/>', size);
    }
    return null;
  }

  function makeIcon(s) {
    var svg = markerSvg(s);
    if (!svg) return null;
    return L.divIcon({
      className: "shape-marker", html: svg.html,
      iconSize: [svg.size, svg.size], iconAnchor: [svg.size / 2, svg.size / 2],
      tooltipAnchor: [0, -svg.size / 2]
    });
  }

  function styleFn(cfg) {
    var s = styleOf(cfg.id), pane = paneFor(cfg), c = colorFor(cfg.id);
    if (cfg.geometry === "line") {
      // The Fiber layer mixes 2 lines with 1 polygon, so a "line" layer still
      // has to carry fill settings for any polygon feature inside it.
      return function () {
        return { color: s.color || c, weight: s.weight || 2, opacity: 0.92,
                 dashArray: s.dashArray || null, pane: pane,
                 fillColor: s.fillColor || c,
                 fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0.12 };
      };
    }
    if (cfg.geometry === "polygon") {
      return function () {
        return { color: s.color || c, weight: s.weight || 1.5, fillColor: s.fillColor || c,
                 fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0.15, pane: pane };
      };
    }
    return {};
  }

  function pointToLayer(cfg) {
    var s = styleOf(cfg.id), pane = paneFor(cfg);
    var hasIcon = !!markerSvg(s);
    return function (feat, latlng) {
      if (hasIcon) {
        var m = L.marker(latlng, {
          icon: iconFor(cfg.id, scaleBucket), pane: pane, keyboard: false
        });
        m._styleId = cfg.id;      // so applyZoomScaling can re-issue its icon
        return m;
      }
      var base = s.radius || 5;
      var c = L.circleMarker(latlng, {
        radius: base * currentScale, color: s.stroke || "#0b1017", weight: s.weight || 1,
        fillColor: s.fillColor || colorFor(cfg.id),
        fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0.95, pane: pane
      });
      // Remember the unscaled radius so rescaling recomputes from the baseline
      // instead of compounding on every zoom step.
      c._baseRadius = base;
      return c;
    };
  }

  // ------------------------------------------------ zoom-responsive symbology
  // Symbols sized for the opening extent become uselessly small relative to the
  // imagery once you zoom in on a single valve, so glyphs and labels grow with
  // zoom.
  //
  // Marker icons are genuinely rebuilt at the new size rather than CSS-scaled:
  // a CSS transform would enlarge the drawing but leave the marker element --
  // and therefore its click target -- at the original size, so a big-looking
  // valve would still only be clickable in a small patch at its centre. On a map
  // whose whole purpose is clicking assets to read their photos, that matters.
  //
  // Rebuilds are quantised to scale buckets and the icons cached per
  // layer+bucket, so a zoom step is a few hundred setIcon calls against a
  // handful of shared L.divIcon instances, not 380 fresh SVG builds.
  var SIZE_REF_ZOOM = 15;      // scale is 1.0 here
  var currentScale = 1;
  var scaleBucket = 1;
  var iconCache = {};

  function sizeScale(z) {
    return Math.max(0.85, Math.min(2.3, 1 + (z - SIZE_REF_ZOOM) * 0.24));
  }

  function iconFor(id, scale) {
    var key = id + "@" + scale;
    if (iconCache[key]) return iconCache[key];
    var s = styleOf(id);
    var scaled = {};
    for (var k in s) scaled[k] = s[k];
    scaled.radius = (s.radius || 6) * scale;
    // Outlines thicken far more slowly than the glyph, or a zoomed-in symbol
    // turns into mostly stroke.
    scaled.weight = (s.weight || 1.4) * Math.min(1.5, scale);
    iconCache[key] = makeIcon(scaled);
    return iconCache[key];
  }

  function applyZoomScaling() {
    currentScale = sizeScale(map.getZoom());
    var bucket = Math.round(currentScale / 0.15) * 0.15;
    bucket = Math.round(bucket * 100) / 100;      // avoid float-noise cache keys

    var el = map.getContainer();
    // Labels grow more gently than the glyphs -- at full icon scale they would
    // collide across the whole map.
    el.style.setProperty("--label-scale", Math.min(1.7, Math.max(1, currentScale)).toFixed(3));
    // Lift labels clear of the markers that have grown underneath them.
    el.style.setProperty("--label-lift", Math.round(Math.max(0, currentScale - 1) * 11) + "px");

    var bucketChanged = bucket !== scaleBucket;
    scaleBucket = bucket;

    Object.keys(state).forEach(function (id) {
      var s = state[id];
      if (!s.loaded || !s.subs) return;
      s.subs.forEach(function (sub) {
        if (sub._baseRadius && sub.setRadius) {
          sub.setRadius(sub._baseRadius * currentScale);
        } else if (bucketChanged && sub._styleId && sub.setIcon) {
          sub.setIcon(iconFor(sub._styleId, bucket));
        }
      });
    });
  }

  // ------------------------------------------------------------------ popups
  function prettify(name) {
    var SPECIAL = { CreationDa: "Surveyed", Length_ft: "Length", TypeString: "Type",
                    Notes: "Notes", Source: "Source" };
    if (SPECIAL[name]) return SPECIAL[name];
    return String(name).replace(/_/g, " ").replace(/\s+/g, " ").trim()
      .replace(/\b\w/g, function (m) { return m.toUpperCase(); });
  }

  function popupHtml(cfg, props) {
    var title = props[cfg.label_field] || cfg.title;
    var head = '<div class="popup-hd">' + esc(title) +
      '<span class="popup-hd-sub">' + esc(cfg.title) + "</span></div>";

    var rows = "";
    (cfg.popup_fields || []).forEach(function (f) {
      var v = props[f];
      if (v === null || v === undefined || v === "") return;
      // The display name already comes from Name/Notes, so repeating the same
      // string as a field row just pads the popup.
      if (String(v).trim().toLowerCase() === String(title).trim().toLowerCase()) return;
      if (f === "Length_ft") v = Number(v).toLocaleString() + " ft";
      rows += '<div class="popup-row"><span class="k">' + esc(prettify(f)) +
        '</span><span class="v">' + esc(v) + "</span></div>";
    });

    var photos = props.photos || [];
    var pv = "";
    if (photos.length) {
      pv = '<div class="popup-sec">' + photos.length +
        (photos.length === 1 ? " Photo" : " Photos") + "</div>" +
        '<div class="popup-photos">' +
        photos.map(function (p) {
          return '<button type="button" class="popup-photo" data-photo="' + esc(p) + '" ' +
            'data-set="' + esc(photos.join("|")) + '" title="' + esc(photoTitle(p)) + '">' +
            '<img loading="lazy" src="photos/thumb/' + encodeURIComponent(p) + '" alt="' + esc(photoTitle(p)) + '"></button>';
        }).join("") + "</div>";
    }
    return head + '<div class="popup-bd">' + (rows || '<div class="popup-row"><span class="v" style="color:#8a94a3">No recorded attributes.</span></div>') + pv + "</div>";
  }

  function photoTitle(file) {
    var m = photoMeta[file];
    return (m && m.title) || file.replace(/\.jpg$/i, "").replace(/-/g, " ");
  }

  // --------------------------------------------------------------- lightbox
  var lb = {
    el: null, img: null, set: [], i: 0,
    open: function (file, set) {
      this.set = set && set.length ? set : [file];
      this.i = Math.max(0, this.set.indexOf(file));
      this.el.classList.add("open");
      this.render();
    },
    close: function () { this.el.classList.remove("open"); this.img.src = ""; },
    step: function (d) {
      this.i = (this.i + d + this.set.length) % this.set.length;
      this.render();
    },
    render: function () {
      var file = this.set[this.i];
      var m = photoMeta[file] || {};
      this.img.src = "photos/" + encodeURIComponent(file);
      this.img.alt = photoTitle(file);
      document.getElementById("lb-title").textContent = photoTitle(file);
      var bits = [];
      if (m.date) bits.push(m.date);
      if (m.width) bits.push(m.width + " x " + m.height);
      if (m.geotag) bits.push("Located by " + m.geotag.toLowerCase());
      if (m.lat) {
        bits.push('<a href="https://www.google.com/maps?q=' + m.lat + "," + m.lon +
          '" target="_blank" rel="noopener">' + m.lat.toFixed(5) + ", " + m.lon.toFixed(5) + "</a>");
      }
      document.getElementById("lb-meta").innerHTML = bits.join(" &nbsp;&middot;&nbsp; ");
      document.getElementById("lb-count").textContent =
        this.set.length > 1 ? (this.i + 1) + " / " + this.set.length : "";
      var multi = this.set.length > 1;
      document.getElementById("lb-prev").disabled = !multi;
      document.getElementById("lb-next").disabled = !multi;
    }
  };

  function initLightbox() {
    lb.el = document.getElementById("lightbox");
    lb.img = document.getElementById("lb-img");
    document.getElementById("lb-close").onclick = function () { lb.close(); };
    document.getElementById("lb-prev").onclick = function () { lb.step(-1); };
    document.getElementById("lb-next").onclick = function () { lb.step(1); };
    // Click the backdrop (but not the image or a button) to dismiss.
    lb.el.addEventListener("click", function (e) {
      if (e.target === lb.el || e.target.classList.contains("lb-stage") ||
          e.target.classList.contains("lb-bar")) lb.close();
    });
    document.addEventListener("keydown", function (e) {
      if (!lb.el.classList.contains("open")) return;
      if (e.key === "Escape") lb.close();
      else if (e.key === "ArrowLeft") lb.step(-1);
      else if (e.key === "ArrowRight") lb.step(1);
    });
    // Swipe between photos on touch devices -- the arrow buttons are small
    // targets on a phone, and a swipe is what a photo viewer is expected to do.
    (function () {
      var x0 = null, y0 = null;
      lb.el.addEventListener("touchstart", function (e) {
        if (e.touches.length !== 1) { x0 = null; return; }
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      }, { passive: true });
      lb.el.addEventListener("touchend", function (e) {
        if (x0 === null || !e.changedTouches.length) return;
        var dx = e.changedTouches[0].clientX - x0;
        var dy = e.changedTouches[0].clientY - y0;
        // Horizontal intent only, so a vertical scroll/dismiss gesture doesn't
        // page the photo.
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) lb.step(dx < 0 ? 1 : -1);
        x0 = null;
      }, { passive: true });
    })();
    // Popup content is rebuilt on every open, so thumbnails are handled by one
    // delegated listener rather than per-element handlers.
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".popup-photo");
      if (!b) return;
      e.preventDefault();
      lb.open(b.getAttribute("data-photo"), (b.getAttribute("data-set") || "").split("|").filter(Boolean));
    });
  }

  // ----------------------------------------------------------- water filter
  // Selecting a system hides every feature -- line OR point -- not on it, so
  // "show me just the Yancey system" is one click across the whole inventory.
  var activeSystem = null;

  function featureSystem(sub) {
    var p = (sub.feature && sub.feature.properties) || {};
    return p.System || "";
  }

  function applySystemFilter() {
    Object.keys(state).forEach(function (id) {
      var s = state[id];
      if (!s.loaded || !s.layer) return;
      var onMap = map.hasLayer(s.layer);
      (s.subs || []).forEach(function (sub) {
        var sys = featureSystem(sub);
        // Features with no System recorded stay visible: filtering them out
        // would silently hide most of the ranch context (roads, sites, photos)
        // the moment any system is selected.
        var want = !activeSystem || !sys || sys === activeSystem;
        var has = s.layer.hasLayer(sub);
        if (onMap && want && !has) s.layer.addLayer(sub);
        else if (!want && has) s.layer.removeLayer(sub);
      });
    });
  }

  function buildSystemFilter() {
    var wrap = document.getElementById("sysfilter-pills");
    var systems = ["Yancey", "Ranch Water", "Irrigation"];
    function pill(label, value, color) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "sysfilter-pill" + (value === activeSystem ? " active" : "");
      b.innerHTML = (color ? '<span class="dot" style="background:' + color + '"></span>' : "") + esc(label);
      b.onclick = function () {
        activeSystem = value;
        Array.prototype.forEach.call(wrap.children, function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        applySystemFilter();
      };
      wrap.appendChild(b);
    }
    pill("All systems", null, null);
    systems.forEach(function (s) { pill(s, s, SYSTEM_COLOR[s]); });
  }

  // ------------------------------------------------------------------ layers
  function buildLayer(cfg, gj) {
    var byLabel = {}, subs = [];
    var labelCls = LABELS[cfg.id];
    var layer = L.geoJSON(gj, {
      style: styleFn(cfg),
      pointToLayer: pointToLayer(cfg),
      onEachFeature: function (feat, lyr) {
        var props = feat.properties || {};
        subs.push(lyr);
        // Popup width is clamped to the viewport: a fixed 300px minimum
        // overflows a narrow phone and pushes the close button off-screen.
        lyr.bindPopup(popupHtml(cfg, props), {
          offset: [0, -10],
          minWidth: Math.min(300, window.innerWidth - 80),
          maxWidth: Math.min(400, window.innerWidth - 40),
          autoPanPaddingTopLeft: [20, 20], autoPanPaddingBottomRight: [20, 20]
        });
        var lv = props[cfg.label_field];
        if (lv != null && !(lv in byLabel)) byLabel[String(lv)] = lyr;
        // Only label features whose name means something: one surveyed in the
        // field, or one named for its type ("Boat House 2"). The pure fallback
        // labels ("Cut-Off 14 (Yancey)") carry no information and would just
        // bury the map in text -- build_data.py tags which is which.
        if (labelCls && lv && props.name_src !== "seq") {
          lyr.bindTooltip('<span class="lbl-inner">' + esc(String(lv)) + "</span>",
            { permanent: true, direction: "top", offset: [0, -4], className: labelCls });
        }
      }
    });
    layer._subs = subs;
    return { layer: layer, byLabel: byLabel, subs: subs };
  }

  function ensureLayer(cfg) {
    var s = state[cfg.id];
    if (s.loaded) return Promise.resolve(s);
    if (s.loading) return s.loading;
    s.loading = fetchJson("data/" + cfg.id + ".geojson")
      .then(function (gj) {
        var built = buildLayer(cfg, gj);
        s.layer = built.layer; s.byLabel = built.byLabel; s.subs = built.subs;
        s.loaded = true;
        return s;
      })
      .catch(function (e) {
        console.error('Layer "' + cfg.id + '" failed to load:', e.message || e);
        // Never leave a layer stuck "loading" -- every toggle would re-fetch and
        // re-throw. An empty layer keeps the rest of the map working.
        s.layer = L.layerGroup(); s.byLabel = {}; s.subs = []; s.loaded = true;
        return s;
      });
    return s.loading;
  }

  // Group visibility is tracked separately from each layer's own checkbox, so
  // toggling a category off and back on restores exactly what was checked.
  var groupVisible = {};

  function applyLayerVisibility(cfg) {
    var cb = document.querySelector('input[data-id="' + cfg.id + '"]');
    var want = cb ? cb.checked : false;
    var groupOn = groupVisible[cfg.category] !== false;
    if (want && groupOn) {
      ensureLayer(cfg).then(function (s) {
        if (!map.hasLayer(s.layer)) s.layer.addTo(map);
        applySystemFilter();
        // A layer switched on while already zoomed in must adopt the current
        // symbol scale, not the z15 baseline it was built at.
        applyZoomScaling();
      });
    } else {
      var s = state[cfg.id];
      if (s && s.layer && map.hasLayer(s.layer)) map.removeLayer(s.layer);
    }
  }

  function showLayer(cfg, on) {
    if (on && groupVisible[cfg.category] === false) setGroupVisible(cfg.category, true);
    var cb = document.querySelector('input[data-id="' + cfg.id + '"]');
    if (cb) cb.checked = on;
    applyLayerVisibility(cfg);
  }

  function setGroupVisible(cat, on) {
    groupVisible[cat] = on;
    var gcb = document.querySelector('input[data-group="' + cat.replace(/["\\]/g, "\\$&") + '"]');
    if (gcb) gcb.checked = on;
    CFG.layers.forEach(function (l) { if (l.category === cat) applyLayerVisibility(l); });
  }

  function buildLayerPanel() {
    var container = document.getElementById("layers");
    var byCat = {};
    CFG.layers.forEach(function (l) { (byCat[l.category] = byCat[l.category] || []).push(l); });

    (CFG.categories || Object.keys(byCat)).forEach(function (cat) {
      var list = byCat[cat];
      if (!list) return;
      var total = list.reduce(function (a, l) { return a + (l.count || 0); }, 0);

      var group = document.createElement("div");
      group.className = "cat-group";
      var head = document.createElement("div");
      head.className = "cat-head";
      head.innerHTML =
        '<label class="cat-head-label">' +
          '<input type="checkbox" data-group="' + esc(cat) + '" checked>' +
          '<span class="cat-name">' + esc(cat) + "</span>" +
          '<span class="cat-count">' + total + "</span>" +
        "</label>" +
        '<button type="button" class="cat-collapse-btn" aria-label="Collapse group" title="Collapse">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
        "</button>";
      head.querySelector("input").addEventListener("change", function () {
        setGroupVisible(cat, this.checked);
      });
      head.querySelector(".cat-collapse-btn").addEventListener("click", function () {
        group.classList.toggle("collapsed");
      });
      group.appendChild(head);

      var body = document.createElement("div");
      body.className = "cat-body";
      list.forEach(function (l) {
        state[l.id] = { cfg: l, loaded: false, loading: null };
        var row = document.createElement("label");
        // A layer the survey captured no features for (Water Pumps) is shown
        // greyed rather than hidden, so its absence is visible instead of
        // looking like the map forgot about it.
        row.className = "layer-row" + (l.count ? "" : " is-empty");
        var shape = swatchShape(l);
        var color = colorFor(l.id);
        row.innerHTML =
          '<input type="checkbox" data-id="' + l.id + '"' +
            (DEFAULT_ON[l.id] && l.count ? " checked" : "") + (l.count ? "" : " disabled") + ">" +
          '<span class="swatch swatch-' + shape + '" style="background:' + color + ';color:' + color + '"></span>' +
          '<span class="nm">' + esc(l.title) + "</span>" +
          '<span class="ct">' + (l.count || 0) + "</span>";
        row.querySelector("input").addEventListener("change", function () {
          showLayer(l, this.checked);
        });
        body.appendChild(row);
      });
      group.appendChild(body);
      container.appendChild(group);
    });

    // Ranch aerial (2018 NAIP ground overlays out of the supplied KMZ) is a
    // reference image, not an inventory layer, so it lives in its own group.
    if ((CFG.imagery || []).length) {
      var g = document.createElement("div");
      g.className = "cat-group";
      g.innerHTML =
        '<div class="cat-head"><span class="cat-head-label"><span class="cat-name">Reference Imagery</span></span>' +
        '<button type="button" class="cat-collapse-btn" aria-label="Collapse group" title="Collapse">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
        "</button></div>";
      g.querySelector(".cat-collapse-btn").addEventListener("click", function () { g.classList.toggle("collapsed"); });
      var b = document.createElement("div");
      b.className = "cat-body";
      var row = document.createElement("label");
      row.className = "layer-row";
      row.innerHTML = '<input type="checkbox"><span class="swatch swatch-polygon" style="background:#6b7d8f"></span>' +
        '<span class="nm">Ranch Aerial (June 2018)</span>';
      var overlays = null;
      row.querySelector("input").addEventListener("change", function () {
        if (!overlays) {
          overlays = CFG.imagery.map(function (im) {
            return L.imageOverlay("imagery/" + im.file, im.bounds,
              { opacity: 1, pane: "ranchImagery", crossOrigin: true });
          });
        }
        var on = this.checked;
        overlays.forEach(function (o) { if (on) o.addTo(map); else map.removeLayer(o); });
      });
      b.appendChild(row);
      var slider = document.createElement("div");
      slider.className = "basemap-opacity-wrap";
      slider.innerHTML = '<input type="range" class="basemap-opacity-slider" min="0" max="100" value="100" aria-label="Ranch aerial transparency">';
      slider.querySelector("input").addEventListener("input", function () {
        var v = (+this.value) / 100;
        if (overlays) overlays.forEach(function (o) { o.setOpacity(v); });
      });
      b.appendChild(slider);
      g.appendChild(b);
      document.getElementById("layers").appendChild(g);
    }
  }

  // ------------------------------------------------------------------ search
  // Matches the display name AND every alternate name the survey recorded for
  // an asset, so a field name like "North Field Cutoff" finds the feature even
  // when its Name attribute reads "Upstream Cutoff".
  function scoreHit(h, q) {
    var lbl = h._lbl || (h._lbl = String(h.label).toLowerCase());
    var i = lbl.indexOf(q);
    if (i === 0) return 100;
    if (i > 0) return 70;
    var alts = h._alts || (h._alts = (h.alt || []).map(function (a) { return String(a).toLowerCase(); }));
    for (var k = 0; k < alts.length; k++) {
      var j = alts[k].indexOf(q);
      if (j === 0) return 55;
      if (j > 0) return 40;
    }
    if (String(h.layer).toLowerCase().indexOf(q) !== -1) return 20;
    if (String(h.system || "").toLowerCase().indexOf(q) !== -1) return 15;
    return -1;
  }

  var LIMIT = 60;
  var searchHits = [], activeHit = -1;

  function buildSearch() {
    var input = document.getElementById("search");
    var wrap = document.getElementById("banner-search");
    var results = document.getElementById("results");
    var listEl = document.getElementById("results-list");
    var meta = document.getElementById("search-meta");
    var clear = document.getElementById("search-clear");

    function close() { results.classList.remove("open"); activeHit = -1; }

    var render = debounce(function () {
      var q = input.value.trim().toLowerCase();
      wrap.classList.toggle("has-q", !!q);
      if (!q) { close(); listEl.innerHTML = ""; return; }

      var scored = [];
      for (var i = 0; i < index.length; i++) {
        var sc = scoreHit(index[i], q);
        if (sc > 0) scored.push([sc, i, index[i]]);
      }
      // Highest-scoring match first, then alphabetical so repeat searches are
      // stable rather than ordered by whatever the file happened to contain.
      scored.sort(function (a, b) {
        return b[0] - a[0] || String(a[2].label).localeCompare(String(b[2].label));
      });
      searchHits = scored.slice(0, LIMIT).map(function (x) { return x[2]; });
      activeHit = -1;

      meta.textContent = scored.length.toLocaleString() +
        (scored.length === 1 ? " match" : " matches") +
        (scored.length > LIMIT ? " (showing " + LIMIT + ")" : "");
      if (!searchHits.length) {
        listEl.innerHTML = '<div class="empty">Nothing matches &ldquo;' + esc(q) + '&rdquo;</div>';
        results.classList.add("open");
        return;
      }
      listEl.innerHTML = "";
      searchHits.forEach(function (h, n) {
        var el = document.createElement("div");
        el.className = "result";
        var sub = h.layer + (h.system ? " &middot; " + esc(h.system) : "");
        var altHit = (h.alt || []).filter(function (a) { return String(a).toLowerCase().indexOf(q) !== -1; })[0];
        if (altHit && String(h.label).toLowerCase().indexOf(q) === -1) {
          sub += ' &middot; also "' + highlight(altHit, q) + '"';
        }
        el.innerHTML =
          '<div class="r-body"><div class="lbl">' + highlight(h.label, q) + "</div>" +
          '<div class="cat">' + sub + "</div></div>" +
          (h.photos ? '<span class="r-cam" title="' + h.photos + ' photo(s)">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="2" y="6" width="20" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/></svg>' +
            h.photos + "</span>" : "");
        el.onclick = function () { goTo(h); close(); };
        el.onmouseenter = function () { setActive(n, false); };
        listEl.appendChild(el);
      });
      results.classList.add("open");
    }, 80);

    function setActive(n, scroll) {
      activeHit = n;
      Array.prototype.forEach.call(listEl.children, function (c, i) {
        c.classList.toggle("active", i === n);
        if (i === n && scroll && c.scrollIntoView) c.scrollIntoView({ block: "nearest" });
      });
    }

    input.addEventListener("input", render);
    input.addEventListener("focus", function () { if (input.value.trim()) results.classList.add("open"); });
    input.addEventListener("keydown", function (e) {
      if (!results.classList.contains("open") || !searchHits.length) {
        if (e.key === "Escape") { input.value = ""; wrap.classList.remove("has-q"); close(); }
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(activeHit + 1, searchHits.length - 1), true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(activeHit - 1, 0), true); }
      else if (e.key === "Enter") {
        e.preventDefault();
        goTo(searchHits[activeHit >= 0 ? activeHit : 0]);
        close();
      } else if (e.key === "Escape") { close(); input.blur(); }
    });
    clear.onclick = function () {
      input.value = ""; wrap.classList.remove("has-q"); listEl.innerHTML = ""; close(); input.focus();
    };
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) close();
    });
  }

  // Pan/zoom to a search hit, revealing its layer (and its category) if either
  // is currently switched off -- otherwise clicking a result would appear to do
  // nothing at all.
  var focused = null;
  function goTo(hit) {
    if (!hit) return;
    var cfg = state[hit.id] && state[hit.id].cfg;
    if (!cfg) return;
    showLayer(cfg, true);
    // A system filter that excludes the hit would hide it on arrival.
    if (activeSystem && hit.system && hit.system !== activeSystem) {
      activeSystem = null;
      var pills = document.getElementById("sysfilter-pills");
      Array.prototype.forEach.call(pills.children, function (x, i) { x.classList.toggle("active", i === 0); });
      applySystemFilter();
    }
    ensureLayer(cfg).then(function (s) {
      var lyr = s.byLabel[String(hit.label)];
      if (lyr && lyr.getBounds && lyr.getBounds().isValid() && cfg.geometry !== "point") {
        map.fitBounds(lyr.getBounds(), { maxZoom: 18, padding: [60, 60] });
      } else {
        map.setView([hit.lat, hit.lon], Math.max(map.getZoom(), 17));
      }
      if (lyr) {
        lyr.openPopup();
        if (focused && focused._icon) focused._icon.classList.remove("focus-glow");
        if (lyr._icon) { lyr._icon.classList.add("focus-glow"); focused = lyr; }
      }
      if (window.innerWidth <= 860) closePanel();
    });
  }

  function highlight(text, q) {
    text = String(text);
    var i = text.toLowerCase().indexOf(q);
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) +
      "</mark>" + esc(text.slice(i + q.length));
  }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // --------------------------------------------------------------- basemaps
  function swapBase(layer, btn) {
    [topo, aerial].forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
    map.addLayer(layer);
    if (layer.bringToBack) layer.bringToBack();
    document.querySelectorAll(".basemap button").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    // Transparency always reflects the now-active basemap rather than a
    // remembered per-basemap value.
    var sl = document.getElementById("bm-opacity");
    if (sl) sl.value = 100;
    layer.setOpacity(1);
  }

  function initChrome() {
    var topoBtn = document.getElementById("bm-topo");
    var aerialBtn = document.getElementById("bm-aerial");
    topoBtn.onclick = function () { swapBase(topo, this); };
    aerialBtn.onclick = function () { swapBase(aerial, this); };
    // The markup marks Topographic active by default; point the highlight at
    // whichever basemap the map was actually constructed with.
    if (IS_NARROW) {
      topoBtn.classList.remove("active");
      aerialBtn.classList.add("active");
    }
    document.getElementById("bm-opacity").addEventListener("input", function () {
      (map.hasLayer(aerial) ? aerial : topo).setOpacity((+this.value) / 100);
    });
    // Mobile layer drawer: the toggle, its backdrop, and Escape all close it.
    var panel = document.getElementById("panel");
    var backdrop = document.getElementById("panel-backdrop");
    function setPanel(open) {
      panel.classList.toggle("open", open);
      backdrop.classList.toggle("open", open);
    }
    document.getElementById("panel-toggle").onclick = function () {
      setPanel(!panel.classList.contains("open"));
    };
    backdrop.onclick = function () { setPanel(false); };
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open")) setPanel(false);
    });
    // Leaving mobile width with the drawer open would otherwise leave the
    // backdrop covering the map, since the drawer becomes static again.
    window.addEventListener("resize", function () {
      if (window.innerWidth > 860) setPanel(false);
    });
    closePanel = function () { setPanel(false); };
  }
  // Set by initChrome; used by search navigation to get the drawer out of the
  // way once the user has picked a result.
  var closePanel = function () {};

  function updateLabelZoom() {
    var z = map.getZoom(), el = map.getContainer();
    el.classList.toggle("show-infra-labels", z >= LABEL_ZOOM.infra);
    el.classList.toggle("show-site-labels", z >= LABEL_ZOOM.site);
  }

  // ------------------------------------------------------------------- boot
  function hideSplash() {
    var o = document.getElementById("splash");
    if (!o || o.classList.contains("hide")) return;
    o.classList.add("hide");
    setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 600);
  }

  function boot() {
    // Safety net: never let the splash trap the user if a fetch stalls.
    var guard = setTimeout(hideSplash, 15000);

    Promise.all([
      fetchJson("layers.json"),
      fetchJson("data/search_index.json"),
      fetchJson("data/photos.json")
    ]).then(function (out) {
      CFG = out[0];
      index = out[1];
      (out[2] || []).forEach(function (p) { photoMeta[p.file] = p; });

      document.title = CFG.title || "Los Amigos Ranch";
      var bt = document.querySelector(".banner-title");
      if (bt) bt.textContent = CFG.title || "Los Amigos Ranch";

      // Open on the surveyed extent rather than a hardcoded centre. No
      // maxBounds: the ranch is only ~2 mi across, so any bounds tight enough
      // to be useful is smaller than the viewport at low zoom, which makes
      // Leaflet fight the user's panning instead of helping.
      if (CFG.bounds) map.fitBounds(CFG.bounds, { padding: [30, 30] });
      else if (CFG.center) map.setView(CFG.center, CFG.zoom || 14);

      var featureCount = CFG.layers.reduce(function (a, l) { return a + (l.count || 0); }, 0);
      var photoCount = (out[2] || []).length;
      var bs = document.querySelector(".banner-sub");
      if (bs) bs.textContent = CFG.subtitle || "";
      document.getElementById("panel-foot").innerHTML =
        featureCount.toLocaleString() + " features across " + CFG.layers.length + " layers &middot; " +
        photoCount + " geotagged photos<br>2022 field survey &amp; Feb 2023 revision, " +
        "2017 ranch infrastructure, 2018 NAIP imagery.";
      document.getElementById("search").placeholder =
        "Search " + featureCount.toLocaleString() + " features\u2026";

      buildSystemFilter();
      buildLayerPanel();
      buildSearch();
      initLightbox();
      initChrome();
      updateLabelZoom();
      applyZoomScaling();
      map.on("zoomend", function () { updateLabelZoom(); applyZoomScaling(); });

      attachMapChrome(map, {
        exportName: "los-amigos-ranch-map",
        legendRoot: document.getElementById("layers")
      });

      var pending = CFG.layers
        .filter(function (l) { return DEFAULT_ON[l.id] && l.count; })
        .map(function (l) { showLayer(l, true); return ensureLayer(l); });

      Promise.all(pending.map(function (p) { return p.catch(function () {}); })).then(function () {
        clearTimeout(guard);
        applySystemFilter();
        applyZoomScaling();
        hideSplash();
      });
    }).catch(function (e) {
      console.error("Failed to load map configuration/data", e);
      document.getElementById("splashMessage").textContent =
        "Couldn't load the map data. See the browser console for details.";
      clearTimeout(guard);
      setTimeout(hideSplash, 2500);
    });
  }

  boot();
})();
