#!/usr/bin/env python3
"""Los Amigos Ranch web map -- data build.

Turns the raw survey deliverables in Data/ into the static payload the map
reads at runtime (public/data/*.geojson, layers.json, search_index.json,
photos.json) plus web-sized copies of the 2022 survey photos.

Sources, and why each one is used:
  * "Los Amigos Ranch Updated Feb23.kmz"  - newest water-infrastructure survey.
    Authoritative for geometry, and the only source carrying the Fiber layer.
  * "Los Amigos Ranch Updated _Post Review.kmz" - the same survey a revision
    earlier, but it carries ~30 <img> links tying photos to specific
    placemarks, and a handful of features that never made it into Feb23.
    Used for photo association + as a source of extra features.
  * "LosAmigos_2017_Infrastructure.kmz" - ranch base data (roads, fences,
    buildings, hunting/livestock features, lake labels).
  * "2022 Survey/Electric_Box.shp" - 3 electric boxes; the only shapefile
    layer with records that no KMZ exposes.

Aerial imagery is NOT built here: the KMZ's 7.5 m/px export was dropped in
favour of the full-resolution NAIP re-export, which scripts/build_imagery.py
produces from the source GeoTIFFs on the GIS share.

Photo geotagging uses two independent signals: the KML <img> links (exact --
the survey crew attached each photo to a placemark) and EXIF GPS (present on
the 5 full-resolution originals). Every photo lands via one or the other.
"""
from __future__ import annotations

import html
import json
import math
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image

try:
    import shapefile  # pyshp
except ImportError:
    shapefile = None

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "Data"
SURVEY = DATA / "2022 Survey"
OUT = ROOT / "public"
OUT_DATA = OUT / "data"
OUT_PHOTOS = OUT / "photos"

K = "{http://www.opengis.net/kml/2.2}"

KMZ_FEB23 = SURVEY / "Los Amigos Ranch Updated Feb23.kmz"
KMZ_POST = SURVEY / "Los Amigos Ranch Updated _Post Review.kmz"
KMZ_2017 = DATA / "LosAmigos_2017_Infrastructure.kmz"

# Every KMZ is scanned for photo<->placemark links, not just the two above:
# older revisions sometimes carry a link the newer ones dropped.
ALL_KMZ = sorted(DATA.rglob("*.kmz"))


# --------------------------------------------------------------- KML reading
def read_kml(path: Path):
    """Parse a KMZ's doc.kml. ArcGIS writes xsi:schemaLocation on <Document>
    without ever declaring the xsi prefix, which is a hard XML parse error --
    inject the declaration before handing it to ElementTree."""
    z = zipfile.ZipFile(path)
    name = next(n for n in z.namelist() if n.lower().endswith(".kml"))
    raw = z.read(name).decode("utf-8", "replace")
    raw = re.sub(r"(<Document[^>]*?)(\sxsi:)",
                 r'\1 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\2', raw)
    root = ET.fromstring(raw)
    doc = root.find(K + "Document")
    return (doc if doc is not None else root), z


def desc_fields(desc: str) -> dict:
    """Attributes out of the ArcGIS-generated description table. Only rows with
    exactly two cells are real key/value pairs -- the single-cell rows are the
    table's title banner and would otherwise show up as bogus field names."""
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", desc, re.S | re.I):
        tds = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        if len(tds) != 2:
            continue
        k = html.unescape(re.sub(r"<[^>]+>", "", tds[0])).strip()
        v = html.unescape(re.sub(r"<[^>]+>", "", tds[1])).strip()
        if k and k.lower() not in ("shape",):
            out[k] = v
    return out


def ext_fields(pm) -> dict:
    out = {}
    for sd in pm.iter(K + "SimpleData"):
        out[sd.get("name")] = (sd.text or "").strip()
    for d in pm.iter(K + "Data"):
        out[d.get("name")] = (d.findtext(K + "value") or "").strip()
    return out


def coords_of(el):
    """[(lon,lat), ...] for the first geometry under el, dropping altitude."""
    node = el.find(".//" + K + "coordinates")
    if node is None or not node.text:
        return []
    pts = []
    for tok in node.text.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            try:
                pts.append((float(parts[0]), float(parts[1])))
            except ValueError:
                pass
    return pts


def geom_of(pm):
    if pm.find(".//" + K + "Point") is not None:
        pts = coords_of(pm)
        return {"type": "Point", "coordinates": list(pts[0])} if pts else None
    if pm.find(".//" + K + "LineString") is not None:
        pts = coords_of(pm)
        return {"type": "LineString", "coordinates": [list(p) for p in pts]} if len(pts) > 1 else None
    if pm.find(".//" + K + "Polygon") is not None:
        pts = coords_of(pm)
        return {"type": "Polygon", "coordinates": [[list(p) for p in pts]]} if len(pts) > 2 else None
    return None


def parse_kmz(path: Path):
    """{folder name: [ {geom, props, photos, name} ]} for one KMZ."""
    doc, _ = read_kml(path)
    layers: dict[str, list] = {}

    def walk(el):
        for folder in el.findall(K + "Folder"):
            fname = (folder.findtext(K + "name") or "?").strip()
            for pm in folder.findall(K + "Placemark"):
                geom = geom_of(pm)
                if geom is None:
                    continue
                desc = pm.findtext(K + "description") or ""
                props = desc_fields(desc)
                props.update({k: v for k, v in ext_fields(pm).items() if v})
                photos = [s.split("/")[-1] for s in
                          re.findall(r'<img[^>]+src="([^"]+)"', desc, re.I)]
                layers.setdefault(fname, []).append({
                    "geom": geom,
                    "props": props,
                    "photos": photos,
                    "kml_name": (pm.findtext(K + "name") or "").strip(),
                })
            walk(folder)

    walk(doc)
    return layers


# ------------------------------------------------------------------ geometry
def meters_between(a, b):
    """Equirectangular approximation -- plenty exact at ranch scale."""
    lon1, lat1 = a
    lon2, lat2 = b
    mlat = math.radians((lat1 + lat2) / 2)
    dx = math.radians(lon2 - lon1) * math.cos(mlat) * 6371000
    dy = math.radians(lat2 - lat1) * 6371000
    return math.hypot(dx, dy)


def interp_along(coords, t):
    """The point a fraction t along a polyline, measured by DISTANCE.

    Not the vertex at index len/2: the two survey revisions digitize the same
    pipe with different vertex counts, so a middle-vertex "midpoint" lands in a
    completely different place on each (230 m apart on one 634 m run), which
    silently defeated duplicate detection.
    """
    total = line_length_m(coords)
    if total <= 0:
        return tuple(coords[0])
    target, acc = t * total, 0.0
    for i in range(1, len(coords)):
        seg = meters_between(coords[i - 1], coords[i])
        if acc + seg >= target:
            f = 0.0 if seg == 0 else (target - acc) / seg
            return (coords[i - 1][0] + f * (coords[i][0] - coords[i - 1][0]),
                    coords[i - 1][1] + f * (coords[i][1] - coords[i - 1][1]))
        acc += seg
    return tuple(coords[-1])


def line_offset(a, b):
    """Mean separation between two polylines, sampled along their length.

    Sampled rather than compared endpoint-to-endpoint so it is insensitive to
    vertex count, and evaluated in both digitizing directions since one revision
    sometimes draws a run the opposite way round.
    """
    ts = (0.1, 0.3, 0.5, 0.7, 0.9)
    fwd = sum(meters_between(interp_along(a, t), interp_along(b, t)) for t in ts) / len(ts)
    rev = sum(meters_between(interp_along(a, t), interp_along(b, 1 - t)) for t in ts) / len(ts)
    return min(fwd, rev)


def rep_point(geom):
    """A single representative coordinate for any geometry (for search/dedupe)."""
    c = geom["coordinates"]
    if geom["type"] == "Point":
        return tuple(c)
    if geom["type"] == "LineString":
        return interp_along(c, 0.5)
    if geom["type"] == "Polygon":
        ring = c[0]
        return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
    return (0.0, 0.0)


def line_length_m(coords):
    return sum(meters_between(coords[i - 1], coords[i]) for i in range(1, len(coords)))


def _label(f):
    return (f["props"].get("Name") or f["props"].get("Notes") or "").strip().lower()


def _similar_length(a, b):
    if a["geom"]["type"] != "LineString":
        return True
    la = line_length_m(a["geom"]["coordinates"])
    lb = line_length_m(b["geom"]["coordinates"])
    return abs(la - lb) <= max(10.0, 0.15 * max(la, lb))


def same_feature(a, b):
    """Whether two features from DIFFERENT source revisions are the same asset.

    Measured against the actual data: of the features Post Review shares with
    Feb23, almost all sit at 0.00 m (byte-identical geometry), while the
    genuinely new ones are 85-400 m away. The only real ambiguity is a handful
    of re-digitized features 4-10 m off, and every one of those carries the
    SAME captured name as its Feb23 twin. So two rules, both narrow:

      1. geometry is effectively identical (<= 1.5 m), or
      2. both carry the same non-empty name and are within 30 m.

    Deliberately NOT a plain distance threshold: real assets cluster tightly
    (several cut-offs sit within a few metres on one manifold), so anything
    looser starts merging distinct valves. Never applied within a single
    source, where every record is by definition its own asset.
    """
    if a["geom"]["type"] != b["geom"]["type"]:
        return False
    # Lines are compared along their whole length, not at one representative
    # point: two revisions of the same pipe can differ by a few metres anywhere
    # along it while still obviously being the same run.
    if a["geom"]["type"] == "LineString":
        d = line_offset(a["geom"]["coordinates"], b["geom"]["coordinates"])
    else:
        d = meters_between(rep_point(a["geom"]), rep_point(b["geom"]))
    na, nb = _label(a), _label(b)
    if na and nb and na != nb:
        # A differing captured name is decisive: "Dove Tank Cutoff" and "Ice
        # Machine Cutoff" 2 m apart are two assets, not one.
        return False
    if d <= 1.5 and _similar_length(a, b):
        return True
    if na and na == nb and d <= 30.0 and _similar_length(a, b):
        return True
    return False


# Web Mercator (the CRS of the survey shapefiles) -> WGS84 lon/lat.
def webmerc_to_wgs84(x, y):
    lon = x / 6378137.0 * 180.0 / math.pi
    lat = (2 * math.atan(math.exp(y / 6378137.0)) - math.pi / 2) * 180.0 / math.pi
    return (lon, lat)


# -------------------------------------------------------------- layer schema
# id -> how to build it. `src` entries are (kmz key, folder name) pairs; the
# first source wins on a geometry collision, later ones only contribute
# features the earlier ones don't already have.
#   name_fields : props to try, in order, for the feature's display name
#   name_prefix : fallback label stem, numbered per layer
#   type_from   : folder name becomes this property (for merged layers)
FEB, POST, R2017 = "feb23", "post", "r2017"

# Shown in popups as "Source". The two 2022/2023 water-survey revisions
# disagree slightly about which assets exist, and rather than silently pick a
# winner the map carries both and says where each feature came from.
SOURCE_LABEL = {
    FEB: "Feb 2023 survey",
    POST: "2022 survey (post-review)",
    R2017: "2017 ranch infrastructure",
    "shp": "2022 survey shapefile",
}

LAYERS = [
    # ---- Water infrastructure (points) ----
    dict(id="water_wells", title="Water Wells", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Water Wells"), (POST, "Water Wells")],
         name_fields=["Notes", "Name"], name_prefix="Water Well"),
    dict(id="water_pumps", title="Water Pumps", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Water Pump"), (POST, "Water Pump")],
         name_fields=["Notes", "Name"], name_prefix="Water Pump"),
    dict(id="meters", title="Meters", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Meter"), (POST, "Meter")],
         name_fields=["Name", "Notes"], name_prefix="Meter"),
    dict(id="manifolds", title="Manifolds", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Manifold"), (POST, "Manifold")],
         name_fields=["Notes", "Name"], name_prefix="Manifold"),
    dict(id="risers", title="Risers", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Riser"), (POST, "Riser")],
         name_fields=["Notes", "Name"], name_prefix="Riser"),
    dict(id="transfer_points", title="Transfer Points", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Transfer Points"), (POST, "Transfer Points")],
         name_fields=["Notes", "Name"], name_prefix="Transfer Point"),
    dict(id="valves", title="Valves", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Valve"), (POST, "Valve")],
         name_fields=["Name", "Notes"], name_prefix="Valve"),
    dict(id="cutoffs", title="Cut-Offs / Valve Boxes", category="Water Infrastructure",
         geometry="point", src=[(FEB, "Cut Off"), (POST, "Cut Off")],
         name_fields=["Name", "Notes"], name_prefix="Cut-Off"),
    dict(id="irrigation_pivots", title="Irrigation Pivots", category="Water Infrastructure",
         geometry="point", src=[(R2017, "Irrigation pivot")],
         name_fields=[], name_prefix="Irrigation Pivot"),

    # ---- Water lines: the three distinct distribution systems ----
    dict(id="yancey_water", title="Yancey Water Line", category="Water Lines",
         geometry="line", src=[(FEB, "Yancey Water"), (POST, "Yancey Water")],
         name_fields=["Notes"], name_prefix="Yancey Water Line", system="Yancey"),
    dict(id="ranch_water", title="Ranch Water Line", category="Water Lines",
         geometry="line", src=[(FEB, "Ranch Water"), (POST, "Ranch Water")],
         name_fields=["Notes"], name_prefix="Ranch Water Line", system="Ranch Water"),
    dict(id="lake_irrigation_water", title="Lake Irrigation Line", category="Water Lines",
         geometry="line", src=[(FEB, "Lake Irrigation Water"), (POST, "Lake Irrigation Water")],
         name_fields=["Notes"], name_prefix="Lake Irrigation Line", system="Irrigation"),

    # ---- Utilities ----
    dict(id="buried_electric", title="Buried Electric", category="Utilities",
         geometry="line", src=[(FEB, "Buried Electric"), (POST, "Buried Electric")],
         name_fields=["Notes"], name_prefix="Buried Electric"),
    dict(id="fiber", title="Fiber", category="Utilities",
         geometry="line", src=[(FEB, "Fiber")],
         name_fields=["Notes", "Name"], name_prefix="Fiber"),
    dict(id="electric_boxes", title="Electric Boxes", category="Utilities",
         geometry="point", src=[("shp:Electric_Box", None)],
         name_fields=[], name_prefix="Electric Box"),

    # ---- Ranch facilities ----
    dict(id="ranch_sites", title="Ranch Sites & Buildings", category="Ranch Features",
         geometry="point", type_from="Type", src=[
             (R2017, "HQ"), (R2017, "Fort"), (R2017, "Medina Cantina"),
             (R2017, "Boat house"), (R2017, "Pumphouse"), (R2017, "Restrooms"),
             (R2017, "Entrance"), (R2017, "Dump"),
             (R2017, "Shotgun range"), (R2017, "Rifle range")],
         name_fields=["Name", "SymbolText"], name_prefix=None),
    dict(id="lakes", title="Lakes & Tanks", category="Ranch Features",
         geometry="point", src=[(R2017, "LakeLabelPoint")],
         name_fields=["Name"], name_prefix="Lake"),

    # ---- Hunting & livestock ----
    dict(id="blinds", title="Blinds", category="Hunting & Livestock",
         geometry="point", type_from="Type",
         src=[(R2017, "Deer blind"), (R2017, "Duck blind")],
         name_fields=["SymbolText", "Name"], name_prefix=None),
    dict(id="feeders", title="Feeders", category="Hunting & Livestock",
         geometry="point", type_from="Type",
         src=[(R2017, "Deer feeder"), (R2017, "Turkey feeder")],
         name_fields=["SymbolText", "Name"], name_prefix=None),
    dict(id="cattle_troughs", title="Cattle Troughs", category="Hunting & Livestock",
         geometry="point", src=[(R2017, "Cattle trough")],
         name_fields=[], name_prefix="Cattle Trough"),
    dict(id="cattle_guards", title="Cattle Guards", category="Hunting & Livestock",
         geometry="point", src=[(R2017, "Cattle guard")],
         name_fields=["SymbolText"], name_prefix="Cattle Guard"),

    # ---- Transportation & boundaries ----
    dict(id="roads", title="Roads", category="Transportation & Boundaries",
         geometry="line", src=[(R2017, "Road")],
         name_fields=[], name_prefix="Road"),
    dict(id="fences", title="Fences", category="Transportation & Boundaries",
         geometry="line", src=[(R2017, "Fence")],
         name_fields=["TypeString"], name_prefix="Fence"),
    dict(id="fence_posts", title="Fence Posts", category="Transportation & Boundaries",
         geometry="point", src=[(R2017, "FencePost")],
         name_fields=[], name_prefix="Fence Post"),
]

CATEGORIES = ["Water Infrastructure", "Water Lines", "Utilities",
              "Ranch Features", "Hunting & Livestock",
              "Transportation & Boundaries", "Survey Photos"]

# Attributes worth showing in a popup, in display order. Bookkeeping columns
# from the ArcGIS field-collection schema (Creator/Editor/GlobalID/FID/SHAPE*)
# are dropped -- they say nothing about the asset itself.
POPUP_FIELDS = ["Name", "Notes", "System", "Type", "TypeString",
                "Length_ft", "CreationDa", "Source"]
DROP_FIELDS = {"Creator", "Editor", "GlobalID", "FID", "Id", "SHAPE",
               "SHAPE_Length", "SHAPE_Area", "OBJECTID"}


# --------------------------------------------------------------------- build
def clean_props(props: dict) -> dict:
    out = {}
    for k, v in props.items():
        if k in DROP_FIELDS or v in (None, "", "0", "1899-12-30", "12:00:00 AM"):
            # Pipe_Size is uniformly "0" across the survey (never captured) and
            # a bare "0" reads as a real measurement in a popup, so it goes too.
            if not (k == "Class" and v in ("0", "1")):
                continue
        out[k] = v
    return out


def load_shapefile_points(name: str):
    """Point records from Data/2022 Survey/<name>.shp as parse_kmz-shaped dicts."""
    if shapefile is None:
        print("  ! pyshp missing, skipping " + name)
        return []
    path = SURVEY / (name + ".shp")
    if not path.exists():
        return []
    # These shapefiles are stored in WGS_1984_Web_Mercator_Auxiliary_Sphere
    # (metres), not lon/lat -- feeding the raw coordinates straight into
    # GeoJSON puts the features somewhere off the coast of Africa.
    prj = path.with_suffix(".prj")
    projected = prj.exists() and "Mercator" in prj.read_text(errors="replace")

    r = shapefile.Reader(str(path))
    flds = [f[0] for f in r.fields[1:]]
    feats = []
    for sr in r.shapeRecords():
        pts = sr.shape.points
        if not pts:
            continue
        x, y = pts[0][0], pts[0][1]
        lon, lat = webmerc_to_wgs84(x, y) if projected else (x, y)
        props = {}
        for k, v in zip(flds, sr.record):
            # The esrignss_* columns are GNSS receiver telemetry (accuracy,
            # device model, fix type) -- not asset attributes. Two of them do
            # carry the captured lat/long and date, which are worth keeping.
            if k.startswith("esrignss_l") or k.startswith("esrignss_1"):
                continue
            if k == "esrignss_6":
                props["CreationDa"] = str(v)
                continue
            if k.startswith("esrignss") or k.startswith("esrisnsr") or k.startswith("esrigns"):
                continue
            props[k] = str(v)
        feats.append({"geom": {"type": "Point", "coordinates": [lon, lat]},
                      "props": props, "photos": [], "kml_name": ""})
    return feats


def build_layers(sources: dict):
    """Merge each layer's sources into one feature list.

    Sources are applied in the order declared. Within a single source every
    record is kept verbatim -- they are distinct surveyed assets, however close
    together. Only features arriving from a *later* source are matched against
    what earlier sources already contributed, so a re-digitized duplicate
    collapses while a genuine cluster of neighbouring valves survives.
    """
    built = {}
    for cfg in LAYERS:
        feats = []          # accumulated across sources
        for si, (skey, folder) in enumerate(cfg["src"]):
            if skey.startswith("shp:"):
                incoming = load_shapefile_points(skey[4:])
            else:
                incoming = sources.get(skey, {}).get(folder, [])
            # Only compare against features contributed by earlier sources.
            prior = list(feats) if si > 0 else []
            batch = []
            for f in incoming:
                dup = next((e for e in prior if same_feature(f, e)), None)
                if dup is not None:
                    # Same asset, already in from a higher-priority revision:
                    # keep that geometry but adopt any photo link and any
                    # attribute this revision fills in and the winner leaves blank.
                    for p in f["photos"]:
                        if p not in dup["photos"]:
                            dup["photos"].append(p)
                    for k, v in f["props"].items():
                        if v and not (dup["props"].get(k) or "").strip():
                            dup["props"][k] = v
                    continue
                g = dict(f)
                g["props"] = dict(g["props"])
                if cfg.get("type_from") and folder:
                    g["props"][cfg["type_from"]] = folder.strip()
                g["props"]["Source"] = SOURCE_LABEL.get(
                    "shp" if skey.startswith("shp:") else skey, skey)
                batch.append(g)
            feats.extend(batch)
        built[cfg["id"]] = feats
        by_src = {}
        for f in feats:
            by_src[f["props"].get("Source", "?")] = by_src.get(f["props"].get("Source", "?"), 0) + 1
        extra = ""
        if len(by_src) > 1:
            extra = "  <- " + ", ".join(f"{v} {k}" for k, v in by_src.items())
        print(f"  {cfg['id']:24s} {len(feats):4d} features{extra}")
    return built


def captured_name(cfg, feat):
    """The asset's real, surveyed name -- or None if it was never recorded."""
    for fld in cfg.get("name_fields") or []:
        v = (feat["props"].get(fld) or "").strip()
        # The 2017 layers put a bare row number ("1", "2") in the placemark
        # name, which is not a name -- only accept descriptive values.
        if v and not v.isdigit():
            return v
    kn = (feat.get("kml_name") or "").strip()
    if kn and not kn.isdigit():
        return kn
    return None


def name_layer(cfg, feats):
    """Assign every feature in a layer a display name, in one pass over the layer.

    Most survey points were captured with no Name/Notes at all, so a synthesized
    label is what makes them findable at all -- a blank name would leave the
    feature effectively invisible in search. Sequence numbers are only appended
    when a prefix is actually shared by more than one feature, so a one-off site
    reads "HQ" rather than "HQ 1".

    Also records where each name came from, as `name_src`:
      field - surveyed name, always worth drawing on the map
      type  - the feature's type/category (a real description, e.g. "Boat House")
      seq   - pure fallback ("Cut-Off 14"); carries no information, so the map
              does not label these.
    """
    # Pass 1: resolve each feature's base label and where it came from.
    plan = []
    counts = {}
    for f in feats:
        real = captured_name(cfg, f)
        if real:
            src, base = "field", real
        else:
            src = "seq"
            base = cfg.get("name_prefix") or cfg["title"]
            if cfg.get("type_from"):
                t = (f["props"].get(cfg["type_from"]) or "").strip()
                if t:
                    # Folder names arrive sentence-cased ("Boat house", "Duck
                    # blind"); these become user-facing labels, so title-case
                    # them -- but only the all-lowercase words, so acronyms the
                    # source already capitalised survive ("HQ", not "Hq").
                    base = " ".join(w.capitalize() if w.islower() else w
                                    for w in t.split())
                    src = "type"
        plan.append((src, base))
        counts[base] = counts.get(base, 0) + 1

    # Pass 2: number any base label shared by more than one feature -- including
    # surveyed ones. Five risers all captured as "Ranch Water Riser" would
    # otherwise be indistinguishable in search results, and a search hit is
    # matched back to its feature by label, so duplicates would all resolve to
    # whichever one happened to load first.
    used = {}
    out = []
    for (src, base), f in zip(plan, feats):
        label = base
        if counts.get(base, 0) > 1:
            used[base] = used.get(base, 0) + 1
            label = f"{base} {used[base]}"
        sysname = (f["props"].get("System") or "").strip()
        if sysname and src == "seq":
            label += f" ({sysname})"
        out.append((label, src))
    return out


# --------------------------------------------------------------------- photos
def exif_latlon(path: Path):
    try:
        ex = Image.open(path).getexif()
        gps = ex.get_ifd(0x8825)
        if not gps:
            return None
        def dms(v):
            return float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
        lat, lon = dms(gps.get(2)), dms(gps.get(4))
        if gps.get(1) == "S":
            lat = -lat
        if gps.get(3) in ("W", "w"):
            lon = -lon
        return (lon, lat)
    except Exception:
        return None


def exif_date(path: Path):
    try:
        d = Image.open(path).getexif().get(306)
        if d:
            return str(d).split(" ")[0].replace(":", "-")
    except Exception:
        pass
    return ""


def collect_photo_locations():
    """{lowercase photo basename: (lon, lat, folder hint, placemark name)}.

    Scans every KMZ for <img> links. Later/duplicate hits don't overwrite an
    earlier one -- the KMZs are revisions of the same survey and agree to
    within a couple of metres, so the first hit is as good as any.
    """
    located = {}
    for kmz in ALL_KMZ:
        try:
            doc, _ = read_kml(kmz)
        except Exception:
            continue

        def walk(el):
            for folder in el.findall(K + "Folder"):
                fname = (folder.findtext(K + "name") or "").strip()
                for pm in folder.findall(K + "Placemark"):
                    desc = pm.findtext(K + "description") or ""
                    srcs = re.findall(r'<img[^>]+src="([^"]+)"', desc, re.I)
                    if not srcs:
                        continue
                    pts = coords_of(pm)
                    if not pts:
                        continue
                    lon, lat = pts[0]
                    for s in srcs:
                        base = s.split("/")[-1].lower()
                        located.setdefault(base, (lon, lat, fname,
                                                  (pm.findtext(K + "name") or "").strip()))
                walk(folder)

        walk(doc)
    return located


# Renamed copies: the survey folder holds friendly-named duplicates of photos
# the KMZ references by camera filename. Mapping them lets the friendly-named
# file inherit the camera file's KML placemark link.
ALIASES = {
    "north field cutoff.jpg": "20220726_100349.jpg",
    "downstream cutoff.jpg": "20220726_100636.jpg",
    "irr north riser _ raw.jpg": "irr north riser.jpg",
}

PHOTO_MAX = 1600      # long edge of the web-sized copy
THUMB_MAX = 320


def build_photos(built):
    """Write web-sized photos + thumbs, geotag them, and attach each one to the
    nearest infrastructure feature. Returns the photo records."""
    located = collect_photo_locations()
    OUT_PHOTOS.mkdir(parents=True, exist_ok=True)
    (OUT_PHOTOS / "thumb").mkdir(exist_ok=True)

    # Unique source photos (the Images/ subfolder duplicates the parent).
    srcs = {}
    for p in sorted(list(SURVEY.glob("*.jpg")) + list(SURVEY.glob("*.JPG"))):
        srcs.setdefault(p.name.lower(), p)

    # Folder name in the KMZ -> the layer id it became here, so a photo can be
    # snapped to a feature in the right layer rather than whatever is closest.
    folder_to_layer = {}
    for cfg in LAYERS:
        for skey, folder in cfg["src"]:
            if folder:
                folder_to_layer[folder.lower()] = cfg["id"]

    records = []
    unlocated = []
    for key, path in sorted(srcs.items()):
        loc = located.get(key) or located.get(ALIASES.get(key, ""))
        lon = lat = None
        hint_folder = hint_name = ""
        source = ""
        if loc:
            lon, lat, hint_folder, hint_name = loc
            source = "KML placemark link"
        else:
            ex = exif_latlon(path)
            if ex:
                lon, lat = ex
                source = "EXIF GPS"
        if lon is None:
            unlocated.append(path.name)
            continue

        slug = re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-") + ".jpg"
        with Image.open(path) as im:
            im = im.convert("RGB")
            w, h = im.size
            full = im.copy()
            full.thumbnail((PHOTO_MAX, PHOTO_MAX), Image.LANCZOS)
            full.save(OUT_PHOTOS / slug, "JPEG", quality=82, optimize=True)
            th = im.copy()
            th.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            th.save(OUT_PHOTOS / "thumb" / slug, "JPEG", quality=76, optimize=True)

        # Attach the photo to the asset it depicts, for the "photos on this
        # feature" list in the popup. (The photo also keeps its own coordinates
        # as a point on the Survey Photos layer.)
        #
        # Preference order matters: several cut-offs sit within a metre of each
        # other, so nearest-point alone can hand a photo to the wrong one. When
        # the KML names the placemark, an exact name match in the hinted layer
        # is authoritative and beats proximity.
        target_layer = folder_to_layer.get(hint_folder.lower())
        best = None
        hint_lc = hint_name.strip().lower()
        if target_layer and hint_lc:
            for i, f in enumerate(built.get(target_layer) or []):
                # Compare against every name the feature carries, not just the
                # Name field: the survey is internally inconsistent (one cut-off
                # has Name="Upstream Cutoff" but placemark name and
                # Notes="North Field Cutoff"), and the photo link points at the
                # placemark name. Matching only Name misattributes that photo to
                # a different cut-off 1 m away.
                cands = {(f["props"].get(k) or "").strip().lower()
                         for k in ("Name", "Notes")}
                cands.add((f.get("kml_name") or "").strip().lower())
                if hint_lc in cands - {""}:
                    best = (meters_between((lon, lat), rep_point(f["geom"])), target_layer, i)
                    break
        if best is None:
            search_ids = [target_layer] if target_layer else list(built.keys())
            for lid in search_ids:
                for i, f in enumerate(built.get(lid) or []):
                    d = meters_between((lon, lat), rep_point(f["geom"]))
                    if best is None or d < best[0]:
                        best = (d, lid, i)
        if best is None or best[0] > 60:
            best = None
            for lid, feats in built.items():
                for i, f in enumerate(feats):
                    d = meters_between((lon, lat), rep_point(f["geom"]))
                    if best is None or d < best[0]:
                        best = (d, lid, i)

        attached = None
        if best and best[0] <= 60:
            _, lid, i = best
            attached = lid
            lst = built[lid][i].setdefault("photos_web", [])
            if slug not in lst:
                lst.append(slug)

        records.append({
            "file": slug,
            "title": re.sub(r"\s+", " ", re.sub(r"[_]+", " ", path.stem)).strip(),
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "width": w,
            "height": h,
            "date": exif_date(path),
            "geotag": source,
            "placemark": hint_name,
            "layer": attached or "",
            "snap_m": round(best[0], 1) if best else None,
        })

    print(f"  photos: {len(records)} geotagged "
          f"({sum(1 for r in records if r['geotag'] == 'EXIF GPS')} via EXIF, "
          f"{sum(1 for r in records if r['geotag'] == 'KML placemark link')} via KML)")
    if unlocated:
        print("  ! no location for: " + ", ".join(unlocated))
    return records


# ------------------------------------------------------------------- network
# The water lines are a pile of independent LineStrings; nothing in the survey
# records how they connect. This derives the actual pipe network from the
# geometry so the map can answer the two questions that matter in the field:
# "what else is on this line?" and "which valves shut it off?".
#
# Model: endpoints that land within SNAP_M of each other are the same junction;
# a closing device (valve / cut-off) sitting on a line splits it there, so the
# device becomes a real node the traversal can stop at. Connected components
# over that graph are the distinct water systems.
WATER_LINE_LAYERS = ["yancey_water", "ranch_water", "lake_irrigation_water"]
# Devices that can actually shut water off -- the ones an isolation answer is
# allowed to name.
CLOSING_LAYERS = ["valves", "cutoffs"]
# On the network but not able to close it; listed as "what's on this system".
FITTING_LAYERS = ["manifolds", "risers", "transfer_points", "meters",
                  "water_wells", "water_pumps", "irrigation_pivots"]

SNAP_M = 4.0        # endpoints this close are one junction
# How far off a line a device may sit and still count as being on it. Measured:
# 45 of the 47 closing devices are within 7 m of a water line, one more sits at
# 12.1 m, and the next nearest is 58.8 m away. 13 m therefore sits inside a very
# wide, unambiguous gap -- it is not a round number picked by feel, and the one
# device it excludes ("End of Ranch Line") really is off on its own.
DEVICE_ON_LINE_M = 13.0
# Two device records closer than this are treated as one fitting (a valve and
# the valve box it sits in), rather than as two things that can close.
CO_LOCATED_M = 1.5
# Dangling line ends this close across a break are joined by an inferred link.
# Measured: after the co-located fix the only remaining break is a single 14.2 m
# gap that fragments a 6,651 ft Yancey main, and the next closest approach
# between components is 21 m -- so 15 m sits inside a clean gap. Bridges are
# flagged `inferred` so the UI can say the survey never recorded that tie-in.
BRIDGE_M = 15.0


def _proj(lat0):
    """Local equirectangular metres around the ranch -- exact enough at 3 km."""
    kx = math.cos(math.radians(lat0)) * 111320.0
    ky = 110540.0
    return (lambda lon, lat: (lon * kx, lat * ky))


def _pt_seg(px, py, ax, ay, bx, by):
    """(distance, t) from point to segment, t in [0,1] along the segment."""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay), 0.0
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t


def build_network(built, names_by_layer):
    lat0 = 29.178
    to_m = _proj(lat0)

    # Line features carry no System attribute of their own -- it comes from the
    # layer they belong to, and is only stamped onto the properties later when
    # the GeoJSON is written. Look it up from the layer config here so traced
    # results are labelled with a real system instead of always reading "mixed".
    layer_system = {c["id"]: c.get("system", "") for c in LAYERS}
    def sys_of(lid, f):
        return (f["props"].get("System") or "").strip() or layer_system.get(lid, "")

    # --- closing devices and fittings, with the display names already assigned
    devices = []
    for lid in CLOSING_LAYERS + FITTING_LAYERS:
        for (label, _src), f in zip(names_by_layer.get(lid, []), built.get(lid, [])):
            lon, lat = rep_point(f["geom"])
            devices.append({
                "layer": lid, "name": label, "lon": lon, "lat": lat,
                "closes": lid in CLOSING_LAYERS,
                "system": sys_of(lid, f),
                "photos": list(f.get("photos_web") or []),
            })

    nodes = []          # {lon, lat, x, y, devs: [device indices]}
    def node_at(lon, lat, devlist=()):
        """Find or create the junction node at this position.

        A node can hold several devices, because one physical fitting is often
        recorded in two layers -- the Cut-Offs layer is literally "Cut-Offs /
        Valve Boxes", so a valve and the box it sits in are two records at the
        same spot. Those must share a junction or the network fragments there.

        But two devices that are merely NEAR each other stay separate: cut-offs
        on this ranch genuinely sit ~2 m apart, and collapsing those would drop
        one from the graph and under-report the valves needed to isolate a line.
        CO_LOCATED_M is the line between "same fitting" and "two fittings".

        A plain endpoint still snaps onto a nearby device node regardless --
        that is just the pipe ending at the valve.
        """
        x, y = to_m(lon, lat)
        devlist = list(devlist)
        for i, n in enumerate(nodes):
            d = math.hypot(n["x"] - x, n["y"] - y)
            if d > SNAP_M:
                continue
            fresh = [dv for dv in devlist if dv not in n["devs"]]
            if fresh and n["devs"] and d > CO_LOCATED_M:
                continue
            n["devs"].extend(fresh)
            return i
        nodes.append({"lon": lon, "lat": lat, "x": x, "y": y, "devs": devlist})
        return len(nodes) - 1

    edges = []
    for lid in WATER_LINE_LAYERS:
        feats = built.get(lid, [])
        labels = names_by_layer.get(lid, [])
        for (label, _src), f in zip(labels, feats):
            coords = f["geom"]["coordinates"]
            if len(coords) < 2:
                continue
            pm = [to_m(c[0], c[1]) for c in coords]

            # Cumulative distance to each vertex, so a device's projection can be
            # expressed as one scalar along the whole polyline and the splits
            # sorted without worrying about which segment they landed on.
            cum = [0.0]
            for i in range(1, len(pm)):
                cum.append(cum[-1] + math.hypot(pm[i][0] - pm[i - 1][0], pm[i][1] - pm[i - 1][1]))
            total = cum[-1]

            splits = []     # (distance along line, device index)
            for di, d in enumerate(devices):
                dx, dy = to_m(d["lon"], d["lat"])
                best = None
                for i in range(1, len(pm)):
                    dist, t = _pt_seg(dx, dy, pm[i - 1][0], pm[i - 1][1], pm[i][0], pm[i][1])
                    if best is None or dist < best[0]:
                        seg_len = cum[i] - cum[i - 1]
                        best = (dist, cum[i - 1] + t * seg_len)
                if best and best[0] <= DEVICE_ON_LINE_M:
                    splits.append((best[1], di))
            splits.sort()

            # Cut points along the line, each carrying EVERY device that lands
            # there. Devices are merged into a shared cut when they project to
            # within CUT_MERGE_M of each other, and clamped onto the endpoints
            # when they land at either end.
            #
            # Merging is what makes this correct: three cut-offs on this ranch
            # project to within 0.1 m of each other on one line, and treating
            # them as three separate cuts produced sub-edges too short to keep,
            # which silently dropped two of them out of the network entirely.
            CUT_MERGE_M = 1.0
            cut_devs = {0.0: [], total: []}
            for dist, di in splits:
                if dist <= CUT_MERGE_M:
                    key = 0.0
                elif dist >= total - CUT_MERGE_M:
                    key = total
                else:
                    key = next((k for k in cut_devs
                                if 0.0 < k < total and abs(k - dist) <= CUT_MERGE_M), dist)
                cut_devs.setdefault(key, []).append(di)
            cuts = [(d, cut_devs[d]) for d in sorted(cut_devs)]

            def coords_between(d0, d1):
                """Sub-polyline of this feature between two distances along it."""
                out = []
                for i in range(len(coords)):
                    if d0 <= cum[i] <= d1:
                        out.append([round(coords[i][0], 6), round(coords[i][1], 6)])
                # interpolate exact endpoints so split edges meet at the device
                def at(d):
                    for i in range(1, len(cum)):
                        if cum[i] >= d:
                            seg = cum[i] - cum[i - 1]
                            t = 0.0 if seg == 0 else (d - cum[i - 1]) / seg
                            return [round(coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), 6),
                                    round(coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]), 6)]
                    return [round(coords[-1][0], 6), round(coords[-1][1], 6)]
                head, tail = at(d0), at(d1)
                if not out or out[0] != head:
                    out.insert(0, head)
                if out[-1] != tail:
                    out.append(tail)
                return out

            for k in range(len(cuts) - 1):
                d0, devs0 = cuts[k]
                d1, devs1 = cuts[k + 1]
                sub = coords_between(d0, d1)
                # Nodes are registered even when the span between two cuts is too
                # short to keep as an edge -- dropping the span must never drop
                # the devices sitting at its ends.
                a = node_at(sub[0][0], sub[0][1], devs0)
                b = node_at(sub[-1][0], sub[-1][1], devs1)
                if a == b or d1 - d0 < 0.5:
                    continue
                edges.append({
                    "a": a, "b": b, "layer": lid, "feature": label,
                    "system": sys_of(lid, f),
                    "len_ft": round((d1 - d0) * 3.28084),
                    "coords": sub,
                })

    # --- connected components (union-find over edges) -----------------------
    parent = list(range(len(nodes)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
    for e in edges:
        union(e["a"], e["b"])

    # --- bridge short survey gaps ------------------------------------------
    # The crew digitized each run separately and the ends don't always meet, so
    # a single unrecorded tie-in can split a main into two "systems" and make a
    # trace look wrong. Join dangling ends that are close AND currently in
    # different components, shortest first, one bridge per end. These edges are
    # marked inferred so the map can label them as an assumption rather than
    # passing them off as surveyed pipe.
    degree = {}
    for e in edges:
        degree[e["a"]] = degree.get(e["a"], 0) + 1
        degree[e["b"]] = degree.get(e["b"], 0) + 1
    dangling = [i for i, d in degree.items() if d == 1]
    cands = []
    for ai in range(len(dangling)):
        for bi in range(ai + 1, len(dangling)):
            a, b = dangling[ai], dangling[bi]
            d = math.hypot(nodes[a]["x"] - nodes[b]["x"], nodes[a]["y"] - nodes[b]["y"])
            if d <= BRIDGE_M:
                cands.append((d, a, b))
    cands.sort()
    used = set()
    bridges = 0
    for d, a, b in cands:
        if a in used or b in used or find(a) == find(b):
            continue
        used.add(a); used.add(b)
        union(a, b)
        edges.append({
            "a": a, "b": b, "layer": "inferred", "feature": "Inferred connection",
            "system": "", "len_ft": round(d * 3.28084), "inferred": True,
            "coords": [[round(nodes[a]["lon"], 6), round(nodes[a]["lat"], 6)],
                       [round(nodes[b]["lon"], 6), round(nodes[b]["lat"], 6)]],
        })
        bridges += 1
    if bridges:
        print(f"  bridged {bridges} survey gap(s) under {BRIDGE_M:.0f} m "
              f"(flagged as inferred, not surveyed pipe)")

    comps = {}
    for ei, e in enumerate(edges):
        comps.setdefault(find(e["a"]), []).append(ei)

    components = []
    for root, eidx in sorted(comps.items(), key=lambda kv: -len(kv[1])):
        cid = len(components)
        systems = {}
        length = 0
        node_ids = set()
        for ei in eidx:
            edges[ei]["comp"] = cid
            length += edges[ei]["len_ft"]
            s = edges[ei]["system"]
            if s:
                systems[s] = systems.get(s, 0) + edges[ei]["len_ft"]
            node_ids.add(edges[ei]["a"]); node_ids.add(edges[ei]["b"])
        devs = sorted({d for n in node_ids for d in nodes[n]["devs"]})
        components.append({
            "id": cid,
            "system": max(systems, key=systems.get) if systems else "",
            "systems": sorted(systems, key=systems.get, reverse=True),
            "len_ft": length,
            "edges": eidx,
            "devices": devs,
        })

    # --- flow direction ------------------------------------------------------
    # Nothing in the survey records flow direction. What we have is the ranch's
    # own description: water enters from the north road intersection and runs
    # north to south, "with some exceptions". That is enough to root the graph:
    # take the northernmost junction of each component as its inlet and measure
    # every other node's hop distance from it. Direction is then "away from the
    # inlet", which handles the exceptions correctly -- a spur that doubles back
    # north is still downstream, because it is further along the pipe.
    #
    # This is DERIVED, not surveyed. `flow_source` is emitted so the map can say
    # so, and so the assumed inlet can be checked against reality.
    inlets = []
    for c in components:
        node_ids = set()
        for ei in c["edges"]:
            node_ids.add(edges[ei]["a"]); node_ids.add(edges[ei]["b"])
        if not node_ids:
            continue
        root = max(node_ids, key=lambda i: nodes[i]["lat"])
        inlets.append(root)
        depth = {root: 0}
        queue = [root]
        while queue:
            cur = queue.pop(0)
            for e in edges:
                if e["a"] == cur and e["b"] not in depth:
                    depth[e["b"]] = depth[cur] + 1; queue.append(e["b"])
                elif e["b"] == cur and e["a"] not in depth:
                    depth[e["a"]] = depth[cur] + 1; queue.append(e["a"])
        for ni, d in depth.items():
            nodes[ni]["depth"] = d
        c["inlet"] = root
    for n in nodes:
        n.setdefault("depth", None)

    main = components[0] if components else None
    if main and "inlet" in main:
        r = nodes[main["inlet"]]
        print(f"  assumed inlet for the main system: {r['lat']:.6f}, {r['lon']:.6f} "
              f"(northernmost junction) -- flow measured outward from there")

    out = {
        "flow_source": "derived: northernmost junction of each system, per the "
                       "ranch's description of water entering from the north",
        "snap_m": SNAP_M,
        "device_on_line_m": DEVICE_ON_LINE_M,
        "devices": devices,
        "nodes": [{"lon": round(n["lon"], 6), "lat": round(n["lat"], 6),
                   "devs": n["devs"], "depth": n.get("depth")} for n in nodes],
        "edges": [{k: v for k, v in e.items() if k != "comp"} | {"comp": e.get("comp", -1)} for e in edges],
        "components": components,
    }

    attached = len({d for n in nodes for d in n["devs"]})
    closing = sum(1 for d in devices if d["closes"])
    print(f"  network: {len(nodes)} junctions, {len(edges)} segments, "
          f"{len(components)} connected systems")
    print(f"           {attached} of {len(devices)} assets sit on the network "
          f"({closing} of which can close)")
    for c in components[:6]:
        print(f"           system {c['id']}: {c['len_ft']:>6,} ft, {len(c['edges']):>3} segments, "
              f"{len(c['devices']):>2} assets  [{c['system'] or 'mixed'}]")
    if len(components) > 6:
        print(f"           ... and {len(components) - 6} smaller disconnected runs")
    return out


# --------------------------------------------------------------------- write
def main():
    if not KMZ_FEB23.exists():
        sys.exit("missing " + str(KMZ_FEB23))
    OUT_DATA.mkdir(parents=True, exist_ok=True)

    print("Reading KMZs...")
    sources = {FEB: parse_kmz(KMZ_FEB23), POST: parse_kmz(KMZ_POST), R2017: parse_kmz(KMZ_2017)}

    print("Merging layers...")
    built = build_layers(sources)

    print("Processing photos...")
    photos = build_photos(built)

    # Names are assigned once, up front: the network build labels its junctions
    # and valves with exactly the same names the GeoJSON and search index use,
    # so a traced result and a search hit always refer to the same asset.
    names_by_layer = {cfg["id"]: name_layer(cfg, built[cfg["id"]]) for cfg in LAYERS}

    print("Deriving pipe network...")
    network = build_network(built, names_by_layer)

    print("Writing GeoJSON...")
    search = []
    catalog = []
    for cfg in LAYERS:
        feats = built[cfg["id"]]
        names = names_by_layer[cfg["id"]]
        gj = {"type": "FeatureCollection", "features": []}
        for (label, name_src), f in zip(names, feats):
            props = clean_props(f["props"])
            props["name"] = label
            props["name_src"] = name_src
            props["layer"] = cfg["title"]
            if cfg.get("system"):
                props.setdefault("System", cfg["system"])
            if f["geom"]["type"] == "LineString":
                props["Length_ft"] = str(round(line_length_m(f["geom"]["coordinates"]) * 3.28084))
            if f.get("photos_web"):
                props["photos"] = f["photos_web"]
            gj["features"].append({"type": "Feature", "geometry": f["geom"], "properties": props})

            # Alternate names the asset is also known by. The survey often
            # records a different label in Notes / the placemark name than in
            # Name (e.g. "Upstream Cutoff" is also "North Field Cutoff"), so
            # indexing only the display name would make it unfindable by the
            # name the crew actually used in the field.
            alt = []
            for cand in (f["props"].get("Notes"), f.get("kml_name"),
                         f["props"].get("Name"), props.get("System"),
                         props.get("Type"), props.get("TypeString")):
                cand = (cand or "").strip()
                if cand and not cand.isdigit() and cand.lower() != label.lower() \
                        and cand.lower() not in [a.lower() for a in alt]:
                    alt.append(cand)

            lon, lat = rep_point(f["geom"])
            search.append({
                "id": cfg["id"], "label": label, "layer": cfg["title"],
                "category": cfg["category"], "lat": round(lat, 7), "lon": round(lon, 7),
                "system": props.get("System", ""),
                "alt": alt,
                "photos": len(f.get("photos_web") or []),
            })
        (OUT_DATA / f"{cfg['id']}.geojson").write_text(
            json.dumps(gj, separators=(",", ":")), encoding="utf-8")

        catalog.append({
            "id": cfg["id"], "title": cfg["title"], "category": cfg["category"],
            "geometry": cfg["geometry"], "count": len(feats),
            "label_field": "name",
            "popup_fields": [k for k in POPUP_FIELDS],
        })

    # Photos ride along as their own searchable point layer.
    pgj = {"type": "FeatureCollection", "features": [
        {"type": "Feature",
         "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
         "properties": {"name": r["title"], "layer": "Survey Photos", "photos": [r["file"]],
                        "Date": r["date"], "Geotag": r["geotag"],
                        "Placemark": r["placemark"]}}
        for r in photos]}
    (OUT_DATA / "photos.geojson").write_text(json.dumps(pgj, separators=(",", ":")), encoding="utf-8")
    catalog.append({"id": "photos", "title": "Survey Photos", "category": "Survey Photos",
                    "geometry": "point", "count": len(photos), "label_field": "name",
                    "popup_fields": ["Date", "Geotag", "Placemark"]})
    for r in photos:
        search.append({"id": "photos", "label": r["title"], "layer": "Survey Photos",
                       "category": "Survey Photos", "lat": r["lat"], "lon": r["lon"],
                       "system": "", "photos": 1})

    (OUT_DATA / "search_index.json").write_text(
        json.dumps(search, separators=(",", ":")), encoding="utf-8")
    (OUT_DATA / "photos.json").write_text(
        json.dumps(photos, indent=1), encoding="utf-8")
    (OUT_DATA / "network.json").write_text(
        json.dumps(network, separators=(",", ":")), encoding="utf-8")

    # Map extent from every feature actually built.
    lats = [s["lat"] for s in search]
    lons = [s["lon"] for s in search]
    (OUT / "layers.json").write_text(json.dumps({
        "title": "Los Amigos Ranch",
        "subtitle": "Infrastructure & Water Systems Inventory",
        "categories": CATEGORIES,
        "layers": catalog,
        "center": [round((min(lats) + max(lats)) / 2, 6), round((min(lons) + max(lons)) / 2, 6)],
        "bounds": [[round(min(lats), 6), round(min(lons), 6)],
                   [round(max(lats), 6), round(max(lons), 6)]],
        "zoom": 14,
    }, indent=1), encoding="utf-8")

    total = sum(c["count"] for c in catalog)
    print(f"\nDone. {len(catalog)} layers, {total} features, {len(photos)} photos.")
    print(f"Extent: {min(lats):.5f},{min(lons):.5f} -> {max(lats):.5f},{max(lons):.5f}")


if __name__ == "__main__":
    main()
