/* map_chrome.js -- reusable Leaflet map controls for the Los Amigos Ranch map:
   coordinate + scale readouts, measure tool, drop-a-pin, and PNG export with a
   composited title/date/scale-bar/north-arrow/legend panel.

   Ported from the Jonah Operations Map's shared chrome so the two maps behave
   identically; the region/auth/telemetry plumbing that map carries is not
   relevant here and was left out. */
(function () {
  "use strict";

  // Analytics, if analytics.js loaded; a stub otherwise, so the controls work
  // identically when it hasn't.
  var track = window.track || function () {};

  function attachMapChrome(map, opts) {
    opts = opts || {};

    // ---- Coordinate readout (bottom-left) ----
    var CoordControl = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd: function () {
        this._div = L.DomUtil.create("div", "coord-box");
        L.DomEvent.disableClickPropagation(this._div);
        this._set(map.getCenter());
        return this._div;
      },
      _set: function (ll) { this._div.textContent = ll.lat.toFixed(6) + ", " + ll.lng.toFixed(6); }
    });
    var coordCtl = new CoordControl();
    map.addControl(coordCtl);
    map.on("mousemove", function (e) { coordCtl._set(e.latlng); });

    // ---- Representative-fraction scale readout ("1:24,000") ----
    // Computed from real on-screen pixel distance at the map centre, so it's
    // exact at any latitude/zoom rather than a per-zoom-level approximation.
    var ScaleControl = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd: function () {
        this._div = L.DomUtil.create("div", "scale-box");
        L.DomEvent.disableClickPropagation(this._div);
        this._update();
        return this._div;
      },
      _update: function () {
        if (!map.getSize().y) return;
        var p1 = map.latLngToContainerPoint(map.getCenter());
        var p2 = p1.add([100, 0]);
        var mpp = map.containerPointToLatLng(p1).distanceTo(map.containerPointToLatLng(p2)) / 100;
        this._div.textContent = "1:" + Math.round(mpp / 0.0254 * 96).toLocaleString();
      }
    });
    var scaleCtl = new ScaleControl();
    map.addControl(scaleCtl);
    map.on("zoomend move", function () { scaleCtl._update(); });

    // ---- Measure tool: click points to draw a line, live distance in ft / mi ----
    (function () {
      var active = false, unit = "ft", pts = [], line = null, verts = [];
      var panel, readout, btn;

      function fmt(meters) {
        var ft = meters * 3.28084;
        if (unit === "mi") return (ft / 5280).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " mi";
        return Math.round(ft).toLocaleString() + " ft";
      }
      function totalMeters(extra) {
        var m = 0;
        for (var i = 1; i < pts.length; i++) m += pts[i - 1].distanceTo(pts[i]);
        if (extra && pts.length) m += pts[pts.length - 1].distanceTo(extra);
        return m;
      }
      function render(extra) { readout.textContent = pts.length ? fmt(totalMeters(extra)) : "0 " + unit; }
      var lastClickTs = 0;
      function addPointAt(ll) {
        pts.push(ll);
        verts.push(L.circleMarker(ll, {
          radius: 3, color: "#e2554b", fillColor: "#fff", fillOpacity: 1, weight: 2, pane: "emphasis"
        }).addTo(map));
        if (line) line.setLatLngs(pts);
        else line = L.polyline(pts, { color: "#e2554b", weight: 3, dashArray: "5,4", pane: "emphasis" }).addTo(map);
        render();
      }
      function onMove(e) { if (pts.length) { if (line) line.setLatLngs(pts.concat([e.latlng])); render(e.latlng); } }
      // Clicks are captured at the DOM level so a click ALWAYS becomes a measure
      // point -- even over a line or marker -- instead of Leaflet routing it to
      // that feature's popup. Control clicks are left alone.
      function domClick(e) {
        if (e.target.closest && e.target.closest(".leaflet-control")) return;
        L.DomEvent.stop(e);
        var now = Date.now();
        if (now - lastClickTs < 300) finish();     // quick second click = finish
        else addPointAt(map.mouseEventToLatLng(e));
        lastClickTs = now;
      }
      function domStopDbl(e) { if (!(e.target.closest && e.target.closest(".leaflet-control"))) L.DomEvent.stop(e); }
      function activateCapture() {
        deactivateCapture();
        map.closePopup();
        var el = map.getContainer();
        el.addEventListener("click", domClick, true);
        el.addEventListener("dblclick", domStopDbl, true);
        map.on("mousemove", onMove);
        map.doubleClickZoom.disable();
        L.DomUtil.addClass(el, "measuring");
      }
      function deactivateCapture() {
        var el = map.getContainer();
        el.removeEventListener("click", domClick, true);
        el.removeEventListener("dblclick", domStopDbl, true);
        map.off("mousemove", onMove);
        map.doubleClickZoom.enable();
        L.DomUtil.removeClass(el, "measuring");
      }
      function finish() {
        deactivateCapture();
        if (line) line.setLatLngs(pts);
        // The completed measurement, not every intermediate click: one point is
        // a mis-click, two or more is an answer someone wanted.
        if (pts.length > 1) {
          track("measure_complete", {
            points: pts.length,
            feet: Math.round(totalMeters() * 3.28084),
            unit: unit
          });
        }
      }
      function clearAll() {
        pts = [];
        if (line) { map.removeLayer(line); line = null; }
        verts.forEach(function (v) { map.removeLayer(v); }); verts = [];
        render();
      }
      function open() {
        var pb = document.querySelector(".coordpin-btn.active"); if (pb) pb.click();
        track("measure_open");
        active = true; panel.style.display = "block"; btn.classList.add("active");
        clearAll(); activateCapture();
      }
      function close() {
        active = false; panel.style.display = "none"; btn.classList.remove("active");
        deactivateCapture(); clearAll();
      }

      var Ctl = L.Control.extend({
        options: { position: "topleft" },
        onAdd: function () {
          var w = L.DomUtil.create("div", "measure-ctl");
          w.innerHTML =
            '<button class="measure-btn" title="Measure distance">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
              '<rect x="2" y="8" width="20" height="8" rx="1"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/></svg>' +
            '</button>' +
            '<div class="measure-panel">' +
              '<div class="measure-head"><span>Measure</span>' +
                '<span class="measure-units"><button data-u="ft" class="active">ft</button><button data-u="mi">mi</button></span>' +
              '</div>' +
              '<div class="measure-readout">0 ft</div>' +
              '<div class="measure-hint">Click points on the map; double-click to finish.</div>' +
              '<div class="measure-actions"><button class="measure-clear">Clear</button><button class="measure-close">Close</button></div>' +
            '</div>';
          L.DomEvent.disableClickPropagation(w);
          L.DomEvent.disableScrollPropagation(w);
          btn = w.querySelector(".measure-btn");
          panel = w.querySelector(".measure-panel");
          readout = w.querySelector(".measure-readout");
          panel.style.display = "none";
          btn.onclick = function () { active ? close() : open(); };
          w.querySelector(".measure-clear").onclick = function () { clearAll(); activateCapture(); };
          w.querySelector(".measure-close").onclick = close;
          Array.prototype.forEach.call(w.querySelectorAll(".measure-units button"), function (b) {
            b.onclick = function () {
              unit = b.getAttribute("data-u");
              Array.prototype.forEach.call(w.querySelectorAll(".measure-units button"),
                function (x) { x.classList.remove("active"); });
              b.classList.add("active"); render();
            };
          });
          return w;
        }
      });
      map.addControl(new Ctl());
    })();

    // ---- Drop-a-point tool: click the map to drop a pin and copy its lat/long ----
    (function () {
      var marker = null, btn;
      var PIN_ICON = L.divIcon({
        className: "shape-marker",
        html: '<svg width="26" height="34" viewBox="0 0 26 34">' +
              '<path d="M13 1C7 1 2.5 5.6 2.5 11.3 2.5 19 13 33 13 33s10.5-14 10.5-21.7C23.5 5.6 19 1 13 1z" fill="#1a6ab5" stroke="#0a2342" stroke-width="1.6"/>' +
              '<circle cx="13" cy="11.3" r="3.6" fill="#fff"/></svg>',
        iconSize: [26, 34], iconAnchor: [13, 33]
      });
      function popupHtml(lat, lng) {
        var la = lat.toFixed(6), lo = lng.toFixed(6);
        return '<div class="coordpin">' +
          '<div class="coordpin-title">Coordinates (WGS84)</div>' +
          '<div class="coordpin-row"><span class="k">Lat</span><code>' + la + '</code></div>' +
          '<div class="coordpin-row"><span class="k">Lng</span><code>' + lo + '</code></div>' +
          '<button class="coordpin-both" data-v="' + la + ", " + lo + '">Copy Coordinates</button>' +
          '</div>';
      }
      function drop(ll) {
        track("pin_drop", { lat: ll.lat.toFixed(5), lng: ll.lng.toFixed(5), zoom: map.getZoom() });
        if (!marker) marker = L.marker(ll, { icon: PIN_ICON, pane: "emphasis", keyboard: false }).addTo(map);
        else marker.setLatLng(ll);
        marker.unbindPopup();   // drop the previous popup so only ONE is ever open
        marker.bindPopup(popupHtml(ll.lat, ll.lng), { offset: [0, -30], minWidth: 210 }).openPopup();
      }
      function domClick(e) {
        if (e.target.closest && e.target.closest(".leaflet-control, .leaflet-popup")) return;
        L.DomEvent.stop(e);
        drop(map.mouseEventToLatLng(e));
      }
      function activate() {
        var mb = document.querySelector(".measure-btn.active"); if (mb) mb.click();
        track("pin_tool_open");
        btn.classList.add("active");
        map.closePopup();
        map.getContainer().addEventListener("click", domClick, true);
        L.DomUtil.addClass(map.getContainer(), "measuring");
      }
      function deactivate() {
        btn.classList.remove("active");
        map.getContainer().removeEventListener("click", domClick, true);
        L.DomUtil.removeClass(map.getContainer(), "measuring");
        if (marker) { map.removeLayer(marker); marker = null; }
      }
      function copyText(v, b) {
        function ok() { var t = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = t; }, 1200); }
        function fallback() {
          var ta = document.createElement("textarea"); ta.value = v;
          ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch (e) {}
          document.body.removeChild(ta);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(ok, function () { fallback(); ok(); });
        } else { fallback(); ok(); }
      }
      // One delegated handler -- popup content is recreated on every drop.
      document.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest(".coordpin-both");
        if (b) { e.preventDefault(); track("coord_copy"); copyText(b.getAttribute("data-v"), b); }
      });

      var Ctl = L.Control.extend({
        options: { position: "topleft" },
        onAdd: function () {
          var w = L.DomUtil.create("div", "coordpin-ctl");
          w.innerHTML = '<button class="coordpin-btn" title="Drop a point and copy its coordinates">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>' +
            '</button>';
          L.DomEvent.disableClickPropagation(w);
          btn = w.querySelector(".coordpin-btn");
          btn.onclick = function () { btn.classList.contains("active") ? deactivate() : activate(); };
          return w;
        }
      });
      map.addControl(new Ctl());
    })();

    attachExportTool(map, { exportName: opts.exportName || "map", legendRoot: opts.legendRoot || null });
  }

  // Reads the currently-visible legend entries straight out of the rendered TOC
  // panel. A layer counts as visible when its own checkbox AND its group's
  // checkbox are both checked -- the same AND-of-two-flags rule the map uses.
  function collectVisibleLegend(rootEl) {
    var items = [];
    if (!rootEl) return items;
    Array.prototype.forEach.call(rootEl.querySelectorAll(".cat-group"), function (g) {
      var groupCb = g.querySelector(".cat-head input[type=checkbox]");
      if (groupCb && !groupCb.checked) return;
      Array.prototype.forEach.call(g.querySelectorAll(".cat-body .layer-row"), function (row) {
        var cb = row.querySelector("input[type=checkbox]");
        if (!cb || !cb.checked) return;
        var swatchEl = row.querySelector(".swatch");
        var nmEl = row.querySelector(".nm");
        if (!swatchEl || !nmEl || !nmEl.textContent) return;
        var shape = "point";
        ["line", "dashed", "polygon", "square", "star", "triangle", "diamond", "camera"].some(function (sh) {
          if (swatchEl.classList.contains("swatch-" + sh)) { shape = sh; return true; }
          return false;
        });
        items.push({
          color: swatchEl.style.background || swatchEl.style.color || "#666",
          shape: shape, label: nmEl.textContent
        });
      });
    });
    return items;
  }

  // ---- Map export: rasterize the current view, then composite a white info
  // panel BELOW the map image (title / date / scale bar / north arrow /
  // legend) so the PNG reads like a real map layout, not a bare screenshot. ----
  function attachExportTool(map, opts) {
    opts = opts || {};
    var exportName = opts.exportName || "map";
    var legendRoot = opts.legendRoot || null;
    var btn, panel, titleInput, dateChk, scaleChk, northChk, legendChk;

    function timestamp() {
      var d = new Date();
      function p(n) { return String(n).padStart(2, "0"); }
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
    }
    function todayLong() {
      var d = new Date();
      var months = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
    }
    function currentScale() {
      var p1 = map.latLngToContainerPoint(map.getCenter());
      var p2 = p1.add([100, 0]);
      var mpp = map.containerPointToLatLng(p1).distanceTo(map.containerPointToLatLng(p2)) / 100;
      return { metersPerPixel: mpp, text: "1:" + Math.round(mpp / 0.0254 * 96).toLocaleString() };
    }
    function download(canvas) {
      var a = document.createElement("a");
      a.download = exportName + "_" + timestamp() + ".png";
      a.href = canvas.toDataURL("image/png");
      a.click();
    }

    // Segmented bar sized to a "nice" round ground distance near 160 screen px.
    function drawScaleBar(ctx, x, y, metersPerPixel) {
      var targetFt = 160 * metersPerPixel * 3.28084;
      var niceFt = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000]
        .reduce(function (best, v) { return Math.abs(v - targetFt) < Math.abs(best - targetFt) ? v : best; });
      var barPx = niceFt / (metersPerPixel * 3.28084);
      var label = niceFt >= 5280
        ? (niceFt / 5280).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " mi"
        : niceFt.toLocaleString() + " ft";
      ctx.save();
      ctx.strokeStyle = "#111"; ctx.fillStyle = "#111"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + barPx, y);
      ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
      ctx.moveTo(x + barPx, y - 5); ctx.lineTo(x + barPx, y + 5);
      ctx.moveTo(x + barPx / 2, y - 3); ctx.lineTo(x + barPx / 2, y + 3);
      ctx.stroke();
      ctx.font = "12px Arial, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(label, x + barPx / 2, y + 18);
      ctx.restore();
    }
    // The map never rotates, so "up" is always true north.
    function drawNorthArrow(ctx, cx, cy) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.moveTo(0, -22); ctx.lineTo(8, 10); ctx.lineTo(0, 4); ctx.lineTo(-8, 10); ctx.closePath();
      ctx.fill();
      ctx.font = "bold 13px Arial, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("N", 0, 26);
      ctx.restore();
    }

    function composeAndDownload(mapCanvas, o) {
      var PAD = 18, W = mapCanvas.width;
      var scale = currentScale();
      var legendItems = o.legend ? collectVisibleLegend(legendRoot) : [];

      var titleH = o.title ? 38 : 0;
      var metaH = (o.date || o.scale || o.north) ? 46 : 0;
      var legendCols = Math.max(1, Math.min(4, Math.ceil((W - 2 * PAD) / 220)));
      var legendRows = legendItems.length ? Math.ceil(legendItems.length / legendCols) : 0;
      var legendH = legendItems.length ? (legendRows * 22 + 30) : 0;
      var panelH = (titleH || metaH || legendH) ? (PAD + titleH + metaH + legendH + PAD) : 0;

      var out = document.createElement("canvas");
      out.width = W;
      out.height = mapCanvas.height + panelH;
      var ctx = out.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(mapCanvas, 0, 0);

      if (panelH > 0) {
        var yy = mapCanvas.height + PAD;
        if (o.title) {
          ctx.fillStyle = "#111";
          ctx.font = "bold 26px 'Arial Narrow', Arial, sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(o.title, PAD, yy + 22);
          yy += titleH;
        }
        if (metaH) {
          ctx.fillStyle = "#111"; ctx.font = "13px Arial, sans-serif"; ctx.textAlign = "left";
          if (o.date) ctx.fillText(todayLong(), PAD, yy + 16);
          if (o.scale) { ctx.fillText(scale.text, PAD, yy + 34); drawScaleBar(ctx, PAD + 110, yy + 22, scale.metersPerPixel); }
          if (o.north) drawNorthArrow(ctx, out.width - PAD - 20, yy + 16);
          yy += metaH;
        }
        if (legendItems.length) {
          ctx.fillStyle = "#111"; ctx.font = "bold 13px Arial, sans-serif"; ctx.textAlign = "left";
          ctx.fillText("Legend", PAD, yy + 14);
          yy += 22;
          var colW = (W - 2 * PAD) / legendCols;
          legendItems.forEach(function (it, i) {
            var col = i % legendCols, rowI = Math.floor(i / legendCols);
            var ix = PAD + col * colW, iy = yy + rowI * 22;
            ctx.fillStyle = it.color; ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
            if (it.shape === "line" || it.shape === "dashed") {
              ctx.strokeStyle = it.color; ctx.lineWidth = 3;
              if (it.shape === "dashed") ctx.setLineDash([5, 3]);
              ctx.beginPath(); ctx.moveTo(ix, iy + 6); ctx.lineTo(ix + 18, iy + 6); ctx.stroke();
              ctx.setLineDash([]);
            } else if (it.shape === "polygon" || it.shape === "square" || it.shape === "camera") {
              ctx.fillRect(ix, iy, 14, 12); ctx.strokeRect(ix, iy, 14, 12);
            } else if (it.shape === "triangle") {
              ctx.beginPath(); ctx.moveTo(ix + 7, iy); ctx.lineTo(ix + 14, iy + 12);
              ctx.lineTo(ix, iy + 12); ctx.closePath(); ctx.fill(); ctx.stroke();
            } else {
              ctx.beginPath(); ctx.arc(ix + 7, iy + 6, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            }
            ctx.fillStyle = "#111"; ctx.font = "12px Arial, sans-serif"; ctx.textAlign = "left";
            ctx.fillText(it.label, ix + 24, iy + 10);
          });
        }
      }
      download(out);
    }

    function exportMap() {
      if (btn.classList.contains("busy")) return;
      if (typeof html2canvas !== "function") {
        track("map_export", { result: "no_library" });
        alert("The export library didn't load, so the map can't be rasterized.");
        return;
      }
      btn.classList.add("busy");
      panel.style.display = "none";
      map.closePopup();
      var o = {
        title: (titleInput.value || "").trim(),
        date: dateChk.checked, scale: scaleChk.checked,
        north: northChk.checked, legend: legendChk.checked
      };
      html2canvas(map.getContainer(), {
        useCORS: true,
        ignoreElements: function (el) {
          return el.classList && el.classList.contains("leaflet-control") &&
            !el.classList.contains("leaflet-control-attribution");
        }
      }).then(function (canvas) {
        composeAndDownload(canvas, o);
        // The checkbox states go along: they say which parts of the composited
        // sheet are actually wanted, which is the only way to find out.
        track("map_export", {
          result: "ok", zoom: map.getZoom(), titled: !!o.title,
          date: o.date, scale: o.scale, north: o.north, legend: o.legend
        });
        btn.classList.remove("busy");
      }).catch(function (e) {
        track("map_export", { result: "failed", message: (e && e.message) || String(e) });
        console.error("Map export failed", e);
        alert("Couldn't export the map view. Please try again.");
        btn.classList.remove("busy");
      });
    }

    var Ctl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var w = L.DomUtil.create("div", "export-ctl");
        w.innerHTML =
          '<button class="export-btn" title="Export map view as PNG">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 15V3M7 10l5 5 5-5M4 21h16"/></svg>' +
          '</button>' +
          '<div class="export-panel">' +
            '<div class="export-panel-hd">Export Map</div>' +
            '<label class="export-field">Title<input type="text" class="export-title" maxlength="80" placeholder="Optional map title"></label>' +
            '<label class="export-check"><input type="checkbox" class="export-date" checked> Date</label>' +
            '<label class="export-check"><input type="checkbox" class="export-scale" checked> Scale bar</label>' +
            '<label class="export-check"><input type="checkbox" class="export-north" checked> North arrow</label>' +
            '<label class="export-check"><input type="checkbox" class="export-legend" checked> Legend (visible layers)</label>' +
            '<div class="export-actions"><button type="button" class="export-cancel">Cancel</button><button type="button" class="export-go">Export PNG</button></div>' +
          '</div>';
        L.DomEvent.disableClickPropagation(w);
        L.DomEvent.disableScrollPropagation(w);
        btn = w.querySelector(".export-btn");
        panel = w.querySelector(".export-panel");
        titleInput = w.querySelector(".export-title");
        dateChk = w.querySelector(".export-date");
        scaleChk = w.querySelector(".export-scale");
        northChk = w.querySelector(".export-north");
        legendChk = w.querySelector(".export-legend");
        panel.style.display = "none";
        btn.onclick = function () {
          panel.style.display = (panel.style.display === "none" || !panel.style.display) ? "block" : "none";
        };
        w.querySelector(".export-cancel").onclick = function () { panel.style.display = "none"; };
        w.querySelector(".export-go").onclick = exportMap;
        return w;
      }
    });
    map.addControl(new Ctl());
  }

  window.attachMapChrome = attachMapChrome;
  window.attachExportTool = attachExportTool;
  window.collectVisibleLegend = collectVisibleLegend;
})();
