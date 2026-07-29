# Los Amigos Ranch — Infrastructure & Water Systems Map

**Live: https://hotlikesauce.github.io/los-amigos-ranch/**

Static Leaflet web map inventorying the ranch's water infrastructure, utilities,
roads and ranch features, with the 2022 field-survey photos geotagged and
browsable in place. Chrome and interaction conventions follow the Jonah
Operations Map so the two read as one family of internal maps.

Ranch is near Sabinal, TX — approx. 29.163–29.194 N, -99.227 to -99.209 W.

25 layers · 386 features · 27 geotagged photos · no server-side code.

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
- **The supplied ranch aerial is low resolution.** `LosAmigos_Data_35Percent_42x.kmz`
  holds two 1024×1017 px PNGs covering 7.7 km each — about **7.5 m/px**, i.e. a
  1:1 pixel match only at ~zoom 14, blurry beyond it. The filename says as much:
  it is a 35%-downsampled export, not the source NAIP. The underlying
  `m_2909955_{nw,sw}_14_060_20180602.tif` NAIP tiles are 0.6 m/px — roughly 12×
  sharper — so if closer inspection of the 2018 imagery matters, re-export from
  those GeoTIFFs. In the meantime Esri's aerial basemap (real tiles to z19, ~0.3
  m/px here) is the sharper option and the ranch overlay is best treated as an
  "as-surveyed 2018" mid-zoom reference.
- **Esri basemap depth over this ranch is z19, not the service maximum.**
  Measured directly: World_Imagery returns real tiles through z19 and an
  identical 2.5 KB "not available" placeholder at z20+. Both basemaps are capped
  at `maxNativeZoom: 19` so Leaflet upscales the real tile instead of drawing
  placeholders; `maxZoom` runs to 22.

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
- **Zoom-responsive symbology** — marker glyphs and labels grow as you zoom in,
  so symbols sized for the ranch-wide view don't shrink into irrelevance when
  you're inspecting one valve. Icons are *rebuilt* at each size rather than
  CSS-scaled, so the click target grows with the drawing; rebuilds are quantised
  into 7 scale buckets and cached per layer.
- **Mobile** — layers become a slide-over drawer with a tap-to-dismiss backdrop,
  touch targets are enlarged on coarse pointers, popups clamp to the viewport
  width, and the photo lightbox supports swipe.

## Deploying

The map is fully client-side, needs no environment variables, and uses only
relative paths — so it works from a subdirectory (`/los-amigos-ranch/`) or a
domain root without changes. It fetches Esri basemap tiles from
`server.arcgisonline.com` at runtime; everything else (Leaflet, html2canvas, all
data, all photos, all imagery) is served from this project.

**GitHub Pages (current).** `.github/workflows/pages.yml` uploads `public/` as
the Pages artifact on every push to `main`, so `scripts/` and the repo config
aren't published alongside the map. Nothing to run by hand — push and it deploys.

**Vercel.** `vercel.json` serves `public/` as static output with long cache
lifetimes on photos, imagery and vendor assets and no-cache on `data/`, so a
data rebuild goes live immediately.

```bash
vercel && vercel --prod
```

**AWS S3 + CloudFront.** `aws s3 sync public/ s3://<bucket>/ --delete`, with the
bucket set to serve `index.html` as the index document. One thing to watch: S3
serves unknown extensions as `application/octet-stream`, and `.geojson` is
unknown to it. The map parses JSON by hand rather than trusting `Content-Type`
(see `fetchJson` in `app.js`) specifically so this doesn't break it — but set
`--content-type application/geo+json` on the `data/` sync anyway if you want
correct headers.

### One external dependency worth knowing about

The header and splash logo is hotlinked from Jonah's Azure blob storage
(`jegisstoreage.blob.core.windows.net`). On a public site it loads only while
that container stays publicly readable; `onerror` hides the image if it doesn't,
so the layout degrades cleanly rather than breaking. Copy the PNG into
`public/vendor/` if you'd rather not depend on it.

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
