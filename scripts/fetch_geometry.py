#!/usr/bin/env python3
"""One-time fetch of 400H building geometry + floorplan images from the SightMap feed.

Downloads into the repo:
  data/geometry/feed-snapshot.json   full raw feed (unit list, plan metadata)
  data/geometry/units.geojson        per-unit polygon geometry (the site's own map data)
  data/geometry/*.umap               Engrain map files (floor picker + unit map)
  assets/floorplans/<PLAN>.jpg       3D render per plan
  assets/floorplans/<PLAN>-2d.jpg    2D floorplan per plan (when provided)
  assets/base-map.jpg                background floor-plate image

Run via the "Fetch building geometry" workflow. Safe to re-run; overwrites in place.
"""
import json
import os
import pathlib
import re
import sys

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
GEO_DIR = ROOT / "data" / "geometry"
IMG_DIR = ROOT / "assets" / "floorplans"
UA = "Mozilla/5.0 (personal apartment price tracker; contact: repo owner)"


def get(url, binary=False):
    resp = requests.get(url, headers={"User-Agent": UA}, timeout=60)
    resp.raise_for_status()
    return resp.content if binary else resp.text


def save(path: pathlib.Path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content)
    print(f"saved {path.relative_to(ROOT)} ({path.stat().st_size:,} bytes)")


def plan_code(raw_name):
    try:
        parsed = json.loads(raw_name)
        name = parsed.get("name") if isinstance(parsed, dict) else parsed
    except (TypeError, ValueError):
        name = raw_name
    m = re.fullmatch(r"([A-Za-z]+)\s*(\d+)", str(name).strip())
    return (m.group(1).upper() + m.group(2).zfill(2)) if m else str(name).strip()


def main() -> int:
    url = os.environ.get("SIGHTMAP_URL", "").strip()
    if not url:
        print("SIGHTMAP_URL not set - nothing to do.", file=sys.stderr)
        return 1

    feed = json.loads(get(url))
    data = feed.get("data", feed)
    save(GEO_DIR / "feed-snapshot.json", json.dumps(feed, indent=1))

    unit_map = data.get("unit_map", {})
    if unit_map.get("geojson_url"):
        save(GEO_DIR / "units.geojson", get(unit_map["geojson_url"]))
    if unit_map.get("url"):
        save(GEO_DIR / "unit-map.umap", get(unit_map["url"], binary=True))
    if unit_map.get("background_image_url"):
        save(ROOT / "assets" / "base-map.jpg", get(unit_map["background_image_url"], binary=True))

    picker = data.get("floor_picker", {})
    if picker.get("unit_map_url"):
        save(GEO_DIR / "floor-picker.umap", get(picker["unit_map_url"], binary=True))

    for fp in data.get("floor_plans", []):
        code = plan_code(fp.get("name"))
        if fp.get("image_url"):
            save(IMG_DIR / f"{code}.jpg", get(fp["image_url"], binary=True))
        if fp.get("secondary_image_url"):
            save(IMG_DIR / f"{code}-2d.jpg", get(fp["secondary_image_url"], binary=True))

    print("geometry fetch complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
