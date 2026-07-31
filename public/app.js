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
  var NAIP = null;       // imagery/naip.json, if the tiles have been built

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
  // Water mains get their own pane above the other linework: they are the
  // subject of the map, so they should never be crossed out by a ranch road.
  // The pane also carries a dark halo (see .water-line-pane) that keeps the
  // bright line colors legible against both the pale topo sheet and the busy
  // aerial -- the standard casing treatment, done once per pane instead of by
  // drawing every line twice.
  // Trace highlight sits UNDER the water lines so it reads as a glow behind the
  // pipe rather than painting over its colour.
  map.createPane("traceGlow");    map.getPane("traceGlow").style.zIndex = 412;
  // Isolation is painted OVER the pipes (see drawTrace), so it needs a pane
  // above the water lines rather than the glow pane beneath them.
  map.createPane("traceTop");     map.getPane("traceTop").style.zIndex = 418;
  map.createPane("waterlines");   map.getPane("waterlines").style.zIndex = 415;
  map.getPane("waterlines").classList.add("water-line-pane");
  map.createPane("points");       map.getPane("points").style.zIndex = 420;
  map.createPane("emphasis");     map.getPane("emphasis").style.zIndex = 430;

  // ---------------------------------------------------------------- styling
  // Water is the subject of this map, so the three distribution systems get
  // the three most distinct hues and the heaviest line weights; utilities and
  // ranch context recede into ambers, browns and greys.
  // Same three hues as before, pushed up in saturation so they read as
  // pipelines rather than basemap furniture -- but each one checked against
  // BOTH backgrounds it has to survive, since the aerial is now the default on
  // phones. Contrast ratios vs. pale topo ground / mid aerial vegetation:
  //
  //   Yancey      #2b8cf0   2.99 / 2.61     (was #0b5cab: 5.84 / 1.34)
  //   Ranch Water #06b8c9   2.10 / 3.72     (was #00a3b4: 2.65 / 2.95)
  //   Irrigation  #25bf50   2.12 / 3.70     (was #2f9e4f: 2.99 / 2.62)
  //
  // The old Yancey blue was the real problem: at 1.34 against aerial it was
  // essentially invisible there. Brighter is not just prettier here. The dark
  // halo on the waterlines pane carries whichever side of each pair is weaker.
  var SYSTEM_COLOR = {
    "Yancey": "#2b8cf0",          // vivid azure
    "Ranch Water": "#06b8c9",     // bright turquoise
    "Irrigation": "#25bf50"       // bright green
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
    // Valves are coloured by the system they shut off, not by being valves --
    // knowing which main a valve belongs to is the whole question in the field.
    // colorBySystem makes pointToLayer read each feature's System; fillColor is
    // the fallback for the few with none recorded.
    valves:            { radius: 7, fillColor: "#9aa1a8", stroke: "#20262c", weight: 1.6,
                         colorBySystem: true },
    cutoffs:           { radius: 7, fillColor: "#f59f00", stroke: "#5c3c00", weight: 1.3, shape: "diamond" },
    irrigation_pivots: { radius: 8.5, fillColor: "#2f9e4f", stroke: "#0d3d1f", weight: 1.5, shape: "square" },

    // Water lines -- the heaviest linework on the map, drawn in the haloed
    // waterlines pane above roads and fences
    yancey_water:          { color: SYSTEM_COLOR["Yancey"], weight: 4.2 },
    ranch_water:           { color: SYSTEM_COLOR["Ranch Water"], weight: 4 },
    lake_irrigation_water: { color: SYSTEM_COLOR["Irrigation"], weight: 3.8 },

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
  // The three water distribution systems -- drawn in their own haloed pane.
  var WATER_LINES = { yancey_water: 1, ranch_water: 1, lake_irrigation_water: 1 };

  function paneFor(cfg) {
    if (WATER_LINES[cfg.id]) return "waterlines";
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
      // Water mains draw at full opacity with rounded joins; the context
      // linework stays slightly translucent so it sits back.
      var isWater = !!WATER_LINES[cfg.id];
      return function () {
        return { color: s.color || c, weight: s.weight || 2,
                 opacity: isWater ? 1 : 0.9,
                 lineCap: "round", lineJoin: "round",
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
        var sys = s.colorBySystem ? (feat.properties || {}).System : null;
        var m = L.marker(latlng, {
          icon: iconFor(cfg.id, scaleBucket, sys), pane: pane, keyboard: false
        });
        m._styleId = cfg.id;      // so applyZoomScaling can re-issue its icon
        m._sysKey = sys || null;
        return m;
      }
      var base = s.radius || 5;
      var sysc = s.colorBySystem
        ? SYSTEM_COLOR[(feat.properties || {}).System] || s.fillColor
        : s.fillColor;
      var c = L.circleMarker(latlng, {
        radius: base * currentScale, color: s.stroke || "#0b1017", weight: s.weight || 1,
        fillColor: sysc || colorFor(cfg.id),
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

  function iconFor(id, scale, system) {
    var key = id + "@" + scale + "@" + (system || "");
    if (iconCache[key]) return iconCache[key];
    var s = styleOf(id);
    var scaled = {};
    for (var k in s) scaled[k] = s[k];
    scaled.radius = (s.radius || 6) * scale;
    // Outlines thicken far more slowly than the glyph, or a zoomed-in symbol
    // turns into mostly stroke.
    scaled.weight = (s.weight || 1.4) * Math.min(1.5, scale);
    if (s.colorBySystem && system && SYSTEM_COLOR[system]) scaled.fillColor = SYSTEM_COLOR[system];
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

    // Lines thicken more gently than point symbols -- a pipeline at full icon
    // scale would read as a corridor rather than a line.
    var lineScale = Math.min(1.9, Math.max(0.9, 1 + (currentScale - 1) * 0.7));

    Object.keys(state).forEach(function (id) {
      var s = state[id];
      if (!s.loaded || !s.subs) return;
      s.subs.forEach(function (sub) {
        if (sub._baseRadius && sub.setRadius) {
          sub.setRadius(sub._baseRadius * currentScale);
        } else if (bucketChanged && sub._styleId && sub.setIcon) {
          sub.setIcon(iconFor(sub._styleId, bucket, sub._sysKey));
        } else if (bucketChanged && sub._baseWeight && sub.setStyle) {
          sub.setStyle({ weight: sub._baseWeight * lineScale });
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
    // Water mains get the two network questions attached directly to the
    // feature, which is where a user is already looking when they ask them.
    var actions = "";
    if (WATER_LINES[cfg.id] && props.name) {
      actions =
        '<div class="popup-actions">' +
        '<button type="button" class="secondary" data-trace="' + esc(props.name) + '">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 7h6l4 10h6"/><circle cx="4" cy="7" r="1.6"/><circle cx="20" cy="17" r="1.6"/></svg>' +
        "Trace system</button>" +
        '<button type="button" class="danger" data-isolate="' + esc(props.name) + '">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
        '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/></svg>' +
        "Isolate</button></div>";
    }

    return head + '<div class="popup-bd">' +
      (rows || '<div class="popup-row"><span class="v" style="color:#8a94a3">No recorded attributes.</span></div>') +
      pv + actions + "</div>";
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

  // ------------------------------------------------- stacked-point carousel
  // Assets genuinely occupy the same spot: a valve inside its valve box, or two
  // valves capping different systems in one trench. Whichever marker Leaflet
  // happens to draw on top would otherwise be the only one you could ever open,
  // silently hiding the rest. So a click gathers every visible point within a
  // few pixels and, when there's more than one, pages through them.
  var STACK_PX = 18;

  function pointsNear(latlng) {
    var origin = map.latLngToContainerPoint(latlng);
    var hits = [];
    Object.keys(state).forEach(function (id) {
      var s = state[id];
      if (!s.loaded || !s.layer || !map.hasLayer(s.layer)) return;
      if (s.cfg.geometry !== "point") return;
      (s.subs || []).forEach(function (sub) {
        if (!s.layer.hasLayer(sub) || !sub.getLatLng) return;
        var p = map.latLngToContainerPoint(sub.getLatLng());
        var d = Math.hypot(p.x - origin.x, p.y - origin.y);
        if (d <= STACK_PX) hits.push({ cfg: s.cfg, sub: sub, d: d });
      });
    });
    hits.sort(function (a, b) { return a.d - b.d; });
    return hits;
  }

  function openStackPopup(hits, latlng) {
    var i = 0;
    var el = document.createElement("div");
    function render() {
      var h = hits[i];
      var props = (h.sub.feature && h.sub.feature.properties) || {};
      el.innerHTML =
        '<div class="stack-nav">' +
          '<button type="button" class="stack-prev" title="Previous">&#8249;</button>' +
          '<span class="stack-count">' + (i + 1) + " of " + hits.length + " here</span>" +
          '<button type="button" class="stack-next" title="Next">&#8250;</button>' +
        "</div>" + popupHtml(h.cfg, props);
      el.querySelector(".stack-prev").onclick = function (ev) {
        ev.stopPropagation(); i = (i - 1 + hits.length) % hits.length; render();
      };
      el.querySelector(".stack-next").onclick = function (ev) {
        ev.stopPropagation(); i = (i + 1) % hits.length; render();
      };
      // Nudge the focus glow onto whichever asset is currently showing.
      if (focused && focused._icon) focused._icon.classList.remove("focus-glow");
      if (h.sub._icon) { h.sub._icon.classList.add("focus-glow"); focused = h.sub; }
    }
    render();
    L.popup({
      offset: [0, -10],
      minWidth: Math.min(300, window.innerWidth - 80),
      maxWidth: Math.min(400, window.innerWidth - 40),
      autoPanPaddingTopLeft: [20, 20], autoPanPaddingBottomRight: [20, 20]
    }).setLatLng(latlng).setContent(el).openOn(map);
  }

  // Bound to each point feature, because Leaflet stops a marker click before it
  // reaches the map -- a map-level handler would never see clicks that land on
  // a marker, which is exactly the case that matters here.
  function onPointClick(e) {
    var hits = pointsNear(e.latlng);
    if (hits.length < 2) return;          // single point: its own popup is fine
    // Stop the DOM event, not the Leaflet one: L.DomEvent.stop expects a real
    // event, and passing the Leaflet wrapper silently does nothing useful.
    if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
    // This handler is registered after bindPopup, so Leaflet has already opened
    // the single-feature popup by now. Closing and reopening happens in one
    // synchronous tick, so the swap is never painted.
    map.closePopup();
    openStackPopup(hits, e.latlng);
  }

  // ------------------------------------------------------------ pipe network
  // network.json is the pipe graph derived from the line geometry by
  // build_data.py: junctions, segments split at every valve/cut-off, and the
  // connected components those form. It answers the two questions this map
  // exists for -- "what else is on this line?" and "which valves shut it off?".
  var NET = null;
  var netAdj = null;        // node id -> [[edge id, other node id], ...]
  var netClosing = null;    // set of node ids carrying a device that can close
  var traceLayer = L.layerGroup();
  var traceMode = null;     // "system" | "isolate"

  function initNetwork(net) {
    NET = net;
    netAdj = {};
    netClosing = {};
    net.edges.forEach(function (e, ei) {
      (netAdj[e.a] = netAdj[e.a] || []).push([ei, e.b]);
      (netAdj[e.b] = netAdj[e.b] || []).push([ei, e.a]);
    });
    net.nodes.forEach(function (n, ni) {
      if ((n.devs || []).some(function (d) { return net.devices[d].closes; })) netClosing[ni] = 1;
    });
    traceLayer.addTo(map);
  }

  function edgesOfFeature(featureName) {
    var out = [];
    NET.edges.forEach(function (e, ei) { if (e.feature === featureName) out.push(ei); });
    return out;
  }

  // Everything hydraulically continuous with this line: its whole connected
  // component, ignoring whether valves along the way happen to be shut.
  function traceSystem(featureName) {
    var seed = edgesOfFeature(featureName);
    if (!seed.length) return null;
    var comp = NET.components[NET.edges[seed[0]].comp];
    if (!comp) return null;
    var devs = comp.devices.map(function (d) { return NET.devices[d]; });
    return {
      kind: "system",
      edges: comp.edges,
      devices: devs.map(function (d, i) { return { dev: d, idx: comp.devices[i] }; }),
      len_ft: comp.len_ft,
      systems: comp.systems,
      comp: comp.id
    };
  }

  // The valves that isolate this run: walk outward from the clicked line and
  // stop at the first closing device on every branch. Deliberately NOT
  // "upstream/downstream" -- the survey records no flow direction, so naming a
  // direction would be inventing information. This set is what you actually
  // need to close, in any direction.
  function isolate(featureName) {
    var seed = edgesOfFeature(featureName);
    if (!seed.length) return null;
    var affected = {};
    var frontier = [];
    seed.forEach(function (ei) {
      affected[ei] = 1;
      frontier.push(NET.edges[ei].a, NET.edges[ei].b);
    });
    var valves = {}, seenNode = {};
    while (frontier.length) {
      var nd = frontier.pop();
      if (seenNode[nd]) continue;
      seenNode[nd] = 1;
      if (netClosing[nd]) {
        (NET.nodes[nd].devs || []).forEach(function (d) {
          if (NET.devices[d].closes) valves[d] = nd;
        });
        continue;          // a shut valve stops the water here
      }
      (netAdj[nd] || []).forEach(function (pair) {
        if (affected[pair[0]]) return;
        affected[pair[0]] = 1;
        frontier.push(pair[1]);
      });
    }
    var ids = Object.keys(valves).map(Number);
    var len = 0;
    Object.keys(affected).forEach(function (ei) { len += NET.edges[ei].len_ft; });

    // Split the valves by which side of the run they sit on. "depth" is hops
    // from the system's inlet, derived from the ranch's own account of water
    // entering at the north road intersection -- so a valve shallower than the
    // run is between it and the supply, and closing that one is what actually
    // stops water arriving. Anything deeper only stops water continuing past.
    var runDepth = null;
    seed.forEach(function (ei) {
      [NET.edges[ei].a, NET.edges[ei].b].forEach(function (nd) {
        var d = NET.nodes[nd].depth;
        if (d != null && (runDepth === null || d < runDepth)) runDepth = d;
      });
    });
    var list = ids.map(function (d) {
      var nd = NET.nodes[valves[d]];
      var side = "unknown";
      if (runDepth !== null && nd.depth != null) {
        side = nd.depth < runDepth ? "supply" : "down";
      }
      return { dev: NET.devices[d], idx: d, node: valves[d], side: side, depth: nd.depth };
    });
    // Supply-side first, and nearest the inlet first within that -- the order
    // someone would actually work in.
    list.sort(function (a, b) {
      if (a.side !== b.side) return a.side === "supply" ? -1 : 1;
      return (a.depth || 0) - (b.depth || 0);
    });

    return {
      kind: "isolate", edges: Object.keys(affected).map(Number),
      valves: list, len_ft: len, runDepth: runDepth
    };
  }

  function clearTrace() {
    traceLayer.clearLayers();
    traceMode = null;
    document.getElementById("trace-pane").classList.remove("open");
  }

  function drawTrace(res) {
    traceLayer.clearLayers();
    var iso = res.kind === "isolate";

    res.edges.forEach(function (ei) {
      var e = NET.edges[ei];
      var latlngs = e.coords.map(function (c) { return [c[1], c[0]]; });
      if (iso) {
        // Isolation answers an urgent question, so it is painted OVER the pipes
        // rather than glowing behind them: a dark casing, then a bright red
        // core with marching ants. A soft glow underneath (the trace treatment)
        // reads as "some context is highlighted"; this reads as "this is dry".
        L.polyline(latlngs, {
          color: "#3d0000", weight: 13, opacity: 0.5, lineCap: "round",
          lineJoin: "round", pane: "traceTop", interactive: false
        }).addTo(traceLayer);
        L.polyline(latlngs, {
          color: "#ff1f1f", weight: 6, opacity: 1, lineCap: "butt",
          lineJoin: "round", pane: "traceTop", interactive: false,
          className: e.inferred ? "" : "iso-run",
          dashArray: e.inferred ? "6,7" : null
        }).addTo(traceLayer);
      } else {
        L.polyline(latlngs, {
          color: "#ffd21f", weight: 12, opacity: 0.5, lineCap: "round",
          lineJoin: "round", pane: "traceGlow", interactive: false,
          dashArray: e.inferred ? "10,8" : null
        }).addTo(traceLayer);
      }
    });

    // Numbered pins on the isolation valves so the list maps onto the map.
    (res.valves || []).forEach(function (v, i) {
      var n = NET.nodes[v.node];
      L.marker([n.lat, n.lon], {
        pane: "emphasis", keyboard: false, zIndexOffset: 1000,
        title: "Close: " + v.dev.name,
        icon: L.divIcon({
          className: "shape-marker",
          html: '<div class="iso-badge" style="width:26px;height:26px">' + (i + 1) + "</div>",
          iconSize: [26, 26], iconAnchor: [13, 13]
        })
      }).addTo(traceLayer);
    });
  }

  function fitTrace(res) {
    var pts = [];
    res.edges.forEach(function (ei) {
      NET.edges[ei].coords.forEach(function (c) { pts.push([c[1], c[0]]); });
    });
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 17 });
  }

  var LAYER_TITLE = {};   // layer id -> title, filled once layers.json is in

  function traceRowHtml(d, n) {
    var color = colorFor(d.layer);
    var badge = n != null ? '<span class="num">' + n + "</span>"
                          : '<span class="sw" style="background:' + color + '"></span>';
    // Where the system was guessed from proximity and a second system's pipe is
    // within 2 m, say so rather than presenting the guess as fact -- these
    // pipes share trenches, so the nearest line is not reliable evidence.
    var sysTxt = d.system ? " &middot; " + esc(d.system) : "";
    if (d.system && d.system_ambiguous != null) {
      sysTxt = ' &middot; <span title="Assigned from the nearest pipe, but another system runs ' +
        d.system_ambiguous + ' m away in the same trench — unconfirmed">' +
        esc(d.system) + "?</span>";
    }
    return badge + '<span class="nm">' + esc(d.name) +
      "<small>" + esc(LAYER_TITLE[d.layer] || d.layer) + sysTxt + "</small></span>" +
      (d.photos && d.photos.length
        ? '<span class="cam" title="' + d.photos.length + ' photo(s)">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<rect x="2" y="6" width="20" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/></svg>' +
          d.photos.length + "</span>"
        : "");
  }

  function showTrace(res, featureName) {
    var pane = document.getElementById("trace-pane");
    var body = document.getElementById("trace-body");
    document.getElementById("trace-title").textContent =
      res.kind === "isolate" ? "Isolation valves" : "Connected system";
    document.getElementById("trace-sub").textContent = featureName;

    var html = "";
    if (res.kind === "isolate") {
      var v = res.valves;
      html += '<div class="trace-stats">' +
        '<div class="trace-stat"><div class="v">' + v.length + '</div><div class="l">Valves to close</div></div>' +
        '<div class="trace-stat"><div class="v">' + res.edges.length + '</div><div class="l">Segments</div></div>' +
        '<div class="trace-stat"><div class="v">' + Math.round(res.len_ft / 100) / 10 +
          'k</div><div class="l">Feet affected</div></div>' +
        "</div>";
      html += '<div class="trace-note">Closing these ' + v.length +
        (v.length === 1 ? " device" : " devices") +
        " cuts water to the highlighted run. Walked outward from this line and stopped at the first device that can close on every branch." +
        "</div>";
      if (!v.length) {
        html += '<div class="trace-note warn">No closing device was found on any branch out of this run &mdash; ' +
          "the survey records no valve or cut-off that would isolate it.</div>";
      }
      var supply = v.filter(function (x) { return x.side === "supply"; });
      var down = v.filter(function (x) { return x.side !== "supply"; });
      var num = 0;
      if (supply.length) {
        html += '<div class="trace-sec">Supply side &mdash; stops water reaching it</div>';
        supply.forEach(function (x) {
          num++;
          html += '<div class="trace-row" data-layer="' + esc(x.dev.layer) + '" data-name="' +
            esc(x.dev.name) + '">' + traceRowHtml(x.dev, num) + "</div>";
        });
      }
      if (down.length) {
        html += '<div class="trace-sec">' +
          (supply.length ? "Downstream &mdash; stops water continuing past" : "Close these") + "</div>";
        down.forEach(function (x) {
          num++;
          html += '<div class="trace-row" data-layer="' + esc(x.dev.layer) + '" data-name="' +
            esc(x.dev.name) + '">' + traceRowHtml(x.dev, num) + "</div>";
        });
      }
      if (supply.length || down.length) {
        html += '<div class="trace-note warn" style="border-top:1px solid var(--border)">' +
          "Which side is which is <em>derived</em>, not surveyed: it assumes water enters at the " +
          "northernmost junction of the system and runs outward from there. The valve list itself " +
          "does not depend on that assumption &mdash; only the grouping does.</div>";
      }
    } else {
      var closing = res.devices.filter(function (x) { return x.dev.closes; });
      html += '<div class="trace-stats">' +
        '<div class="trace-stat"><div class="v">' + (Math.round(res.len_ft / 100) / 10) +
          'k</div><div class="l">Feet of pipe</div></div>' +
        '<div class="trace-stat"><div class="v">' + res.edges.length + '</div><div class="l">Segments</div></div>' +
        '<div class="trace-stat"><div class="v">' + res.devices.length + '</div><div class="l">Assets</div></div>' +
        "</div>";
      html += '<div class="trace-note">Everything physically connected to this line' +
        (res.systems && res.systems.length > 1
          ? ". This run carries " + res.systems.map(esc).join(" + ") +
            " water &mdash; the systems are tied together here."
          : ".") + "</div>";
      var inferred = res.edges.filter(function (ei) { return NET.edges[ei].inferred; }).length;
      if (inferred) {
        html += '<div class="trace-note warn">' + inferred + " connection" + (inferred > 1 ? "s in" : " in") +
          " this trace " + (inferred > 1 ? "are" : "is") + " inferred: the survey left a gap of a few metres " +
          "between line ends, shown dashed. Verify before relying on it.</div>";
      }
      html += '<div class="trace-sec">' + closing.length + " valves &amp; cut-offs on this system</div>";
      closing.forEach(function (x) {
        html += '<div class="trace-row" data-layer="' + esc(x.dev.layer) + '" data-name="' +
          esc(x.dev.name) + '">' + traceRowHtml(x.dev) + "</div>";
      });
      var fittings = res.devices.filter(function (x) { return !x.dev.closes; });
      if (fittings.length) {
        html += '<div class="trace-sec">' + fittings.length + " other fittings</div>";
        fittings.forEach(function (x) {
          html += '<div class="trace-row" data-layer="' + esc(x.dev.layer) + '" data-name="' +
            esc(x.dev.name) + '">' + traceRowHtml(x.dev) + "</div>";
        });
      }
    }
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll(".trace-row"), function (row) {
      row.onclick = function () {
        focusAsset(row.getAttribute("data-layer"), row.getAttribute("data-name"));
      };
    });
    pane.classList.add("open");
    pane.classList.toggle("iso", res.kind === "isolate");
    traceMode = res.kind;
    drawTrace(res);
    fitTrace(res);
  }

  // Jump to a named asset in a named layer, reusing the search index so the
  // behaviour (reveal layer, zoom, open popup, glow) is identical to searching.
  function focusAsset(layerId, name) {
    var hit = null;
    for (var i = 0; i < index.length; i++) {
      if (index[i].id === layerId && index[i].label === name) { hit = index[i]; break; }
    }
    if (hit) goTo(hit, { keepTrace: true });
  }

  // ------------------------------------------------------------------ gallery
  // Every survey photo in one grid. Without this the photos are only reachable
  // by finding the right marker on the map, which is backwards when the photo
  // is the thing you remember and the location is what you're trying to recall.
  var galFilter = "all";

  function galleryPhotos() {
    var all = Object.keys(photoMeta).map(function (k) { return photoMeta[k]; });
    all.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    if (galFilter === "all") return all;
    return all.filter(function (p) { return (p.layer || "") === galFilter; });
  }

  function renderGallery() {
    var grid = document.getElementById("gal-grid");
    var list = galleryPhotos();
    document.getElementById("gal-count").textContent =
      list.length + " of " + Object.keys(photoMeta).length;
    if (!list.length) {
      grid.innerHTML = '<div class="gal-empty">No photos on that asset type.</div>';
      return;
    }
    var files = list.map(function (p) { return p.file; });
    grid.innerHTML = list.map(function (p) {
      return '<button type="button" class="gal-item" data-file="' + esc(p.file) + '">' +
        '<img loading="lazy" src="photos/thumb/' + encodeURIComponent(p.file) +
        '" alt="' + esc(p.title) + '">' +
        '<span class="gal-cap">' + esc(p.title) +
        "<small>" + esc(LAYER_TITLE[p.layer] || "Unmatched") +
        (p.date ? " &middot; " + esc(p.date) : "") + "</small></span></button>";
    }).join("");
    Array.prototype.forEach.call(grid.querySelectorAll(".gal-item"), function (b) {
      b.onclick = function () { lb.open(b.getAttribute("data-file"), files); };
    });
  }

  function buildGalleryFilters() {
    var counts = {};
    Object.keys(photoMeta).forEach(function (k) {
      var l = photoMeta[k].layer || "";
      counts[l] = (counts[l] || 0) + 1;
    });
    var wrap = document.getElementById("gal-filter");
    var opts = [["all", "All"]].concat(
      Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
        .map(function (l) { return [l, (LAYER_TITLE[l] || "Unmatched") + " (" + counts[l] + ")"]; }));
    wrap.innerHTML = opts.map(function (o) {
      return '<button type="button" class="gal-chip' + (o[0] === galFilter ? " active" : "") +
        '" data-f="' + esc(o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("");
    Array.prototype.forEach.call(wrap.querySelectorAll(".gal-chip"), function (c) {
      c.onclick = function () {
        galFilter = c.getAttribute("data-f");
        Array.prototype.forEach.call(wrap.querySelectorAll(".gal-chip"), function (x) {
          x.classList.toggle("active", x === c);
        });
        renderGallery();
      };
    });
  }

  function openGallery() {
    buildGalleryFilters();
    renderGallery();
    document.getElementById("gallery").classList.add("open");
  }
  function closeGallery() { document.getElementById("gallery").classList.remove("open"); }

  function initGallery() {
    document.getElementById("gallery-btn").onclick = openGallery;
    document.getElementById("gal-close").onclick = closeGallery;
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !lb.el.classList.contains("open")) closeGallery();
    });
    // "Show on map" jumps from a photo to the asset it belongs to.
    document.getElementById("lb-locate").onclick = function () {
      var file = lb.set[lb.i];
      var m = photoMeta[file];
      lb.close();
      closeGallery();
      if (!m) return;
      if (m.layer) {
        // Prefer the asset the photo documents; fall back to the photo point.
        var owner = null;
        for (var i = 0; i < index.length; i++) {
          if (index[i].id === m.layer &&
              Math.abs(index[i].lat - m.lat) < 0.0009 &&
              Math.abs(index[i].lon - m.lon) < 0.0009) { owner = index[i]; break; }
        }
        if (owner) { goTo(owner); return; }
      }
      var cfg = state.photos && state.photos.cfg;
      if (cfg) showLayer(cfg, true);
      map.setView([m.lat, m.lon], Math.max(map.getZoom(), 18));
    };
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
        // Remember each line's unscaled weight so applyZoomScaling can thicken
        // it with zoom from the baseline rather than compounding.
        if (cfg.geometry !== "point" && lyr.options && lyr.options.weight) {
          lyr._baseWeight = lyr.options.weight;
        }
        if (cfg.geometry === "point") lyr.on("click", onPointClick);
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
        // A layer drawn in per-system colours gets a tri-colour swatch, so the
        // legend doesn't claim a single colour the map never uses.
        var swStyle = styleOf(l.id).colorBySystem
          ? "background:linear-gradient(135deg," + SYSTEM_COLOR["Yancey"] + " 0 33%," +
            SYSTEM_COLOR["Ranch Water"] + " 33% 66%," + SYSTEM_COLOR["Irrigation"] + " 66% 100%)"
          : "background:" + color + ";color:" + color;
        row.innerHTML =
          '<input type="checkbox" data-id="' + l.id + '"' +
            (DEFAULT_ON[l.id] && l.count ? " checked" : "") + (l.count ? "" : " disabled") + ">" +
          '<span class="swatch swatch-' + shape + '" style="' + swStyle + '"></span>' +
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

    // Ranch imagery is reference material, not inventory, so it gets its own
    // group. Only the full-resolution NAIP re-export is offered -- the 7.5 m/px
    // version that shipped in the KMZ was dropped once this replaced it.
    var overlayDefs = [];
    if (NAIP) {
      overlayDefs.push({
        label: "Ranch Aerial — June 2018",
        sub: "USDA NAIP · 0.6 m/px",
        make: function () {
          return L.tileLayer(NAIP.url, {
            minZoom: NAIP.minZoom, maxNativeZoom: NAIP.maxNativeZoom, maxZoom: 22,
            bounds: L.latLngBounds(NAIP.bounds), pane: "ranchImagery",
            attribution: NAIP.attribution, crossOrigin: true
          });
        }
      });
    }
    if (!overlayDefs.length) return;

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

    overlayDefs.forEach(function (def) {
      var row = document.createElement("label");
      row.className = "layer-row";
      row.innerHTML = '<input type="checkbox">' +
        '<span class="swatch swatch-polygon" style="background:#6b7d8f"></span>' +
        '<span class="nm">' + esc(def.label) +
        '<small style="display:block;color:var(--muted);font-size:10.5px">' + esc(def.sub) + "</small></span>";
      var layer = null;
      row.querySelector("input").addEventListener("change", function () {
        if (!layer) layer = def.make();          // built on first use, not at boot
        if (this.checked) layer.addTo(map);
        else map.removeLayer(layer);
      });
      b.appendChild(row);

      var slider = document.createElement("div");
      slider.className = "basemap-opacity-wrap";
      slider.innerHTML = '<input type="range" class="basemap-opacity-slider" min="0" max="100" value="100" ' +
        'aria-label="' + esc(def.label) + ' transparency">';
      slider.querySelector("input").addEventListener("input", function () {
        var v = (+this.value) / 100;
        if (!layer) return;
        // A tileLayer sets its own opacity; the KMZ pair is a group of
        // imageOverlays that each need setting individually.
        if (layer.setOpacity) layer.setOpacity(v);
        else layer.eachLayer(function (o) { o.setOpacity(v); });
      });
      b.appendChild(slider);
    });

    g.appendChild(b);
    document.getElementById("layers").appendChild(g);
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
  function goTo(hit, opts) {
    if (!hit) return;
    var cfg = state[hit.id] && state[hit.id].cfg;
    if (!cfg) return;
    // A fresh search is a new line of enquiry, so it drops any active trace --
    // but clicking through a trace result's own list must keep it on screen.
    if (!(opts && opts.keepTrace)) clearTrace();
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

    document.getElementById("trace-close").onclick = clearTrace;

    // Popup content is rebuilt on every open, so the trace/isolate buttons are
    // handled by one delegated listener rather than per-popup handlers.
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-trace],[data-isolate]");
      if (!b || !NET) return;
      e.preventDefault();
      var isIso = b.hasAttribute("data-isolate");
      var name = b.getAttribute(isIso ? "data-isolate" : "data-trace");
      var res = isIso ? isolate(name) : traceSystem(name);
      map.closePopup();
      if (!res) {
        showNoNetwork(name, isIso);
        return;
      }
      showTrace(res, name);
    });
  }

  // A line that never made it into the graph (too far from any junction) still
  // has to say so, rather than the button appearing to do nothing.
  function showNoNetwork(name, isIso) {
    document.getElementById("trace-title").textContent = isIso ? "Isolation valves" : "Connected system";
    document.getElementById("trace-sub").textContent = name;
    document.getElementById("trace-body").innerHTML =
      '<div class="trace-empty">This line isn\'t connected to the derived pipe network, so there\'s ' +
      "nothing to " + (isIso ? "isolate" : "trace") + " from it.<br><br>The network is built from where " +
      "surveyed line ends meet, and this run's ends don't reach another line.</div>";
    var p = document.getElementById("trace-pane");
    p.classList.add("open");
    p.classList.toggle("iso", !!isIso);
    traceLayer.clearLayers();
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
      fetchJson("data/photos.json"),
      // The pipe graph is small (~37 KB) and both network features need it the
      // instant a popup opens, so it loads up front rather than on demand.
      fetchJson("data/network.json").catch(function (e) {
        console.warn("Pipe network unavailable; trace/isolate disabled.", e);
        return null;
      }),
      // Optional: only present once scripts/build_imagery.py has been run
      // against the GIS share, so its absence must not break the map.
      fetchJson("imagery/naip.json").catch(function () { return null; })
    ]).then(function (out) {
      CFG = out[0];
      index = out[1];
      (out[2] || []).forEach(function (p) { photoMeta[p.file] = p; });
      CFG.layers.forEach(function (l) { LAYER_TITLE[l.id] = l.title; });
      if (out[3]) initNetwork(out[3]);
      NAIP = out[4] || null;

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
      initGallery();
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
