# Los Amigos Ranch — Infrastructure & Water Systems Map

Static Leaflet web map inventorying the ranch's water infrastructure, utilities,
roads and ranch features, with the 2022 field-survey photos geotagged and
browsable in place. Chrome and interaction conventions follow the Jonah
Operations Map so the two read as one family of internal maps.

Ranch is near Sabinal, TX — approx. 29.163–29.194 N, -99.227 to -99.209 W.

## Running locally

```bash
npm run dev            # serves ./public at http://localhost:8080
```

Any static file server works; there is no build step and no server-side code.
Opening `public/index.html` directly off the filesystem will **not** work — the
map `fetch`es its GeoJSON, which browsers block on `file://`.

## Rebuilding the data

```bash
pip install pillow pyshp
npm run build:data     # python scripts/build_data.py
```

That regenerates everything the map reads, from the raw deliverables in `Data/`:

| Output | Contents |
| --- | --- |
| `public/layers.json` | Layer catalog, categories, map extent, imagery bounds |
| `public/data/*.geojson` | One file per layer (25 layers, 386 features) |
| `public/data/search_index.json` | Flat searchable index incl. alternate names |
| `public/data/photos.json` | Photo metadata (coords, date, how it was geotagged) |
| `public/photos/`, `photos/thumb/` | Web-sized (1600px) + thumbnail (320px) JPEGs |
| `public/imagery/*.png` | 2018 NAIP aerial, extracted from the KMZ GroundOverlays |

## Where the data comes from

| Source | Used for |
| --- | --- |
| `Los Amigos Ranch Updated Feb23.kmz` | Newest water survey — authoritative geometry; sole source of the Fiber layer |
| `Los Amigos Ranch Updated _Post Review.kmz` | Same survey, one revision earlier — carries the photo↔placemark links and some features Feb23 dropped |
| `LosAmigos_2017_Infrastructure.kmz` | Roads, fences, buildings, lakes, hunting & livestock features |
| `2022 Survey/Electric_Box.shp` | 3 electric boxes — the only shapefile record set no KMZ exposes |
| `LosAmigos_Data_35Percent_42x.kmz` | June 2018 NAIP aerial imagery |
| `2022 Survey/*.jpg` | 27 survey photos |

### Notes on the source data

Things worth knowing, since they shape what the map shows:

- **The two 2022/2023 water-survey revisions disagree** about which assets
  exist. Rather than silently pick a winner, the map carries the union and every
  feature's popup shows a **Source** field naming its revision. Duplicates are
  collapsed only on near-identical geometry (≤1.5 m) or a matching captured name
  within 30 m — deliberately narrow, because real cut-offs cluster within a few
  metres of each other and a looser rule merges distinct valves.
- **Only 5 of 27 photos carry EXIF GPS.** The rest are located from the `<img>`
  links in the KMZ descriptions, which tie each photo to a specific placemark —
  more precise than EXIF anyway. Every photo is placed by one route or the
  other; `photos.json` records which, and it is shown in the lightbox.
- **Most survey points were captured with no name at all.** Those get a
  synthesized label (`Cut-Off 14 (Yancey)`) so they remain searchable and
  clickable, tagged `name_src: "seq"` so the map knows not to draw a text label
  for them. Named and type-named features (`name_src` `field`/`type`) do get
  labels.
- **The survey is internally inconsistent about names.** One cut-off has
  `Name = "Upstream Cutoff"` but placemark name and `Notes = "North Field
  Cutoff"`. Both are indexed, so either term finds it, and the photo attaches to
  the right asset.
- `Pipe_Size` is present on every water line but is `0` throughout — never
  captured in the field — so it is dropped rather than shown as a measurement.
- `Water Pump`, `Filter` and `Irrigation_Pivot_Inlet` exist as empty layers in
  the source. Water Pumps is kept in the panel, greyed out, so its emptiness is
  visible rather than looking like an omission.
- The survey shapefiles are in **Web Mercator**, not lon/lat; the build
  reprojects them.

## Map features

- **Search (header)** — matches names, alternate/field names, layer and system
  across all 386 features and 27 photos; keyboard navigable (↑/↓/Enter/Esc).
  Selecting a result turns its layer on, clears a conflicting system filter,
  zooms, opens the popup and highlights the marker.
- **Water System filter** — one click restricts the whole inventory (lines *and*
  points) to Yancey, Ranch Water or Irrigation. Features with no system recorded
  stay visible so ranch context doesn't vanish.
- **Layer panel** — collapsible categories with per-layer and per-category
  toggles and feature counts; swatches match the on-map symbol.
- **Photos** — thumbnails inline in any feature's popup, plus a standalone
  Survey Photos layer; click for a keyboard-navigable lightbox showing capture
  date, dimensions, geotag provenance and a Google Maps link.
- **Basemaps** — Esri Topographic / Aerial with a transparency slider, plus the
  supplied 2018 ranch aerial as a separately-toggleable overlay.
- **Tools** — measure (ft/mi), drop-a-pin with coordinate copy, live lat/long
  and 1:N scale readouts, and PNG export with title/date/scale bar/north
  arrow/legend composited below the map.

## Deploying to Vercel

`vercel.json` serves `public/` as static output with long cache lifetimes on
photos, imagery and vendor assets, and no-cache on `data/` so a data rebuild
goes live immediately.

```bash
vercel        # preview
vercel --prod
```

The map is fully client-side and needs no environment variables. It does fetch
Esri basemap tiles from `server.arcgisonline.com` at runtime; everything else
(Leaflet, html2canvas, all data, all photos) is served from this project.

## Layout

```
public/
  index.html        chrome, styling, panel + lightbox markup
  app.js            layers, symbology, search, system filter, photos
  map_chrome.js     measure / pin / coord + scale readouts / PNG export
  layers.json       generated layer catalog
  data/             generated GeoJSON + indexes
  photos/           generated web-sized photos (thumb/ subfolder)
  imagery/          generated aerial PNGs
  vendor/           Leaflet 1.9.4, html2canvas 1.4.1
scripts/
  build_data.py     the whole ETL
Data/               raw survey deliverables (input; not served)
```
