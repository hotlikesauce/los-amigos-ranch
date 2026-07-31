#!/usr/bin/env python3
"""Re-export the source NAIP GeoTIFFs as XYZ map tiles for the ranch extent.

The aerial shipped in LosAmigos_Data_35Percent_42x.kmz is a 35%-downsampled
export: 1024 px covering 7.7 km, i.e. 7.5 m/px, which is a 1:1 pixel match only
at about zoom 14. The imagery it was made from is on the GIS share at 0.6 m/px --
roughly 12x sharper -- so this rebuilds the overlay from those originals.

Output is XYZ tiles rather than one big image on purpose. A single overlay at
native resolution would be ~23 megapixels, which every visitor would download
and decode in full before seeing anything, and which would be punishing on a
phone. Tiles load only what is on screen and cost nothing at low zoom.

Native NAIP resolution is 0.600 m/px and Leaflet's z18 is 0.597 m/px, so z18 is
where the tile grid and the source line up essentially 1:1. Tiles stop there --
generating z19+ would only upsample and quadruple the file count for detail that
does not exist. Leaflet is told maxNativeZoom=18 and upscales beyond that.

Requires: rasterio (brings its own GDAL), pillow.
Run:      python scripts/build_imagery.py
"""
from __future__ import annotations

import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np

try:
    import rasterio
    from rasterio.warp import reproject, Resampling
except ImportError:
    sys.exit("rasterio is required: python -m pip install rasterio")

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_TILES = ROOT / "public" / "imagery" / "naip"
OUT_META = ROOT / "public" / "imagery" / "naip.json"

SHARE = Path(r"S:\North_Rockies\Jonah\GIS\GIS_V2\_Archived_Folders"
             r"\John Farrell\Los Amigos\Imagery\2020 Update")
SOURCES = [
    SHARE / "m_2909955_nw_14_060_20180602" / "m_2909955_nw_14_060_20180602.tif",
    SHARE / "m_2909955_sw_14_060_20180602" / "m_2909955_sw_14_060_20180602.tif",
]

MIN_ZOOM, MAX_ZOOM = 13, 18
TILE = 256
# Padding around the surveyed extent so panning just off the ranch doesn't hit
# a hard edge of imagery.
PAD_DEG = 0.0035
JPEG_QUALITY = 82

WEB_MERC = "EPSG:3857"
ORIGIN = 20037508.342789244          # half the Web Mercator world, in metres


def merc_res(z):
    """Ground metres per pixel at a zoom level, in Web Mercator units."""
    return (2 * ORIGIN) / (TILE * (2 ** z))


def lonlat_to_merc(lon, lat):
    x = lon * ORIGIN / 180.0
    y = math.log(math.tan((90.0 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    return x, y * ORIGIN / 180.0


def tile_xy(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lr = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lr)) / math.pi) / 2.0 * n)
    return x, y


def main():
    missing = [p for p in SOURCES if not p.exists()]
    if missing:
        sys.exit("source imagery not reachable:\n  " + "\n  ".join(str(m) for m in missing))

    bounds = json.loads((ROOT / "public" / "layers.json").read_text(encoding="utf-8"))["bounds"]
    south, west = bounds[0][0] - PAD_DEG, bounds[0][1] - PAD_DEG
    north, east = bounds[1][0] + PAD_DEG, bounds[1][1] + PAD_DEG
    print(f"ranch extent + {PAD_DEG} deg pad: lat {south:.5f}..{north:.5f}  lon {west:.5f}..{east:.5f}")

    # Work out the z18 tile range, then build one mosaic aligned exactly to that
    # tile grid. Aligning up front means every tile is a clean array slice --
    # no per-tile warping, and no half-pixel drift between adjacent tiles.
    x0, y0 = tile_xy(west, north, MAX_ZOOM)
    x1, y1 = tile_xy(east, south, MAX_ZOOM)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    res = merc_res(MAX_ZOOM)
    width, height = nx * TILE, ny * TILE
    left = -ORIGIN + x0 * TILE * res
    top = ORIGIN - y0 * TILE * res
    transform = rasterio.Affine(res, 0, left, 0, -res, top)
    print(f"z{MAX_ZOOM} mosaic: {width}x{height}px ({nx}x{ny} tiles) at {res:.3f} m/px")

    mosaic = np.zeros((3, height, width), dtype=np.uint8)
    covered = np.zeros((height, width), dtype=bool)

    for src_path in SOURCES:
        with rasterio.open(src_path) as src:
            print(f"  warping {src_path.name} ({src.width}x{src.height}, {src.crs})...")
            # Only the visible bands: NAIP band 4 is near-infrared, which would
            # turn the vegetation magenta if carried through as blue.
            buf = np.zeros((3, height, width), dtype=np.uint8)
            for i in range(3):
                reproject(
                    source=rasterio.band(src, i + 1),
                    destination=buf[i],
                    src_transform=src.transform, src_crs=src.crs,
                    dst_transform=transform, dst_crs=WEB_MERC,
                    resampling=Resampling.cubic,
                    num_threads=4,
                )
            # The two quads overlap by ~300 m; keep whatever the first source
            # already wrote there so the seam does not flicker between them.
            fresh = (buf.any(axis=0)) & (~covered)
            for i in range(3):
                mosaic[i][fresh] = buf[i][fresh]
            covered |= fresh

    filled = covered.mean() * 100
    print(f"  mosaic coverage: {filled:.1f}% of the padded extent")
    if filled < 99.0:
        print("  !!  gaps in coverage -- tiles at the edge will show black")

    if OUT_TILES.exists():
        shutil.rmtree(OUT_TILES)

    # z18 straight off the mosaic; each lower zoom is a 2x box-downsample of the
    # level above, which is both faster than re-warping and free of resampling
    # drift between levels.
    level = mosaic
    lx0, ly0 = x0, y0
    total = 0
    for z in range(MAX_ZOOM, MIN_ZOOM - 1, -1):
        h, w = level.shape[1], level.shape[2]
        tx, ty = w // TILE, h // TILE
        count = 0
        for iy in range(ty):
            for ix in range(tx):
                chunk = level[:, iy * TILE:(iy + 1) * TILE, ix * TILE:(ix + 1) * TILE]
                if not chunk.any():
                    continue        # fully outside the imagery; skip the file
                d = OUT_TILES / str(z) / str(lx0 + ix)
                d.mkdir(parents=True, exist_ok=True)
                Image.fromarray(np.transpose(chunk, (1, 2, 0))).save(
                    d / f"{ly0 + iy}.jpg", "JPEG", quality=JPEG_QUALITY, optimize=True)
                count += 1
        total += count
        print(f"  z{z}: {count} tiles ({tx}x{ty} grid)")

        if z > MIN_ZOOM:
            # Pad to even tile counts so the halving stays aligned to the parent
            # tile grid rather than sliding half a tile per level.
            if lx0 % 2 or ly0 % 2 or tx % 2 or ty % 2:
                px0 = lx0 - (lx0 % 2)
                py0 = ly0 - (ly0 % 2)
                pad_l = (lx0 - px0) * TILE
                pad_t = (ly0 - py0) * TILE
                new_w = int(math.ceil((pad_l + w) / (2 * TILE)) * 2 * TILE)
                new_h = int(math.ceil((pad_t + h) / (2 * TILE)) * 2 * TILE)
                padded = np.zeros((3, new_h, new_w), dtype=np.uint8)
                padded[:, pad_t:pad_t + h, pad_l:pad_l + w] = level
                level, lx0, ly0 = padded, px0, py0
                h, w = new_h, new_w
            level = (level.reshape(3, h // 2, 2, w // 2, 2)
                          .mean(axis=(2, 4)).astype(np.uint8))
            lx0, ly0 = lx0 // 2, ly0 // 2

    size_mb = sum(f.stat().st_size for f in OUT_TILES.rglob("*.jpg")) / 1e6
    meta = {
        "url": "imagery/naip/{z}/{x}/{y}.jpg",
        "minZoom": MIN_ZOOM,
        "maxNativeZoom": MAX_ZOOM,
        "bounds": [[south, west], [north, east]],
        "name": "Ranch Aerial - 2018 NAIP (full resolution)",
        "attribution": "USDA NAIP, 2 June 2018",
        "resolution_m": 0.6,
        "tiles": total,
        "size_mb": round(size_mb, 1),
    }
    OUT_META.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"\n{total} tiles, {size_mb:.1f} MB -> {OUT_TILES}")
    print(f"wrote {OUT_META}")


if __name__ == "__main__":
    main()
