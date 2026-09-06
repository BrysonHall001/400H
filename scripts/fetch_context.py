#!/usr/bin/env python3
"""One-time fetch of surrounding context (buildings + streets) from OpenStreetMap.

Queries the free Overpass API for everything within ~1 mile of 400H, converts
to the tracker's local meter grid (same origin as building.json), and writes a
compact data/context.json the 3D scene renders natively. No API key needed.

Run via the "Fetch surrounding context" workflow. Safe to re-run.
"""
import json
import math
import pathlib
import re
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "context.json"

LAT0, LNG0 = 35.781, -78.6455          # same origin as building.json
RADIUS_BUILDINGS = 1650                 # meters (~1 mile)
RADIUS_ROADS = 1750
MLAT = 111132.0
MLNG = 111320.0 * math.cos(math.radians(LAT0))

ROAD_CLASSES = {
    "motorway": 16, "trunk": 14, "primary": 12, "secondary": 10,
    "tertiary": 8, "residential": 6, "unclassified": 6, "pedestrian": 3.5,
}

QUERY = f"""
[out:json][timeout:120];
(
  way["building"](around:{RADIUS_BUILDINGS},{LAT0},{LNG0});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|pedestrian)$"](around:{RADIUS_ROADS},{LAT0},{LNG0});
);
out body;
>;
out skel qt;
"""

FLOOR_M = 3.3


def to_m(lng, lat):
    return (round((lng - LNG0) * MLNG, 1), round((lat - LAT0) * MLAT, 1))


def parse_height(tags):
    h = tags.get("height") or tags.get("building:height")
    if h:
        m = re.match(r"\s*([\d.]+)", str(h))
        if m:
            return round(float(m.group(1)), 1)
    lv = tags.get("building:levels")
    if lv:
        m = re.match(r"\s*([\d.]+)", str(lv))
        if m:
            return round(float(m.group(1)) * FLOOR_M + 1, 1)
    return 5.0  # default low-rise


def dedupe(pts):
    out = []
    for p in pts:
        if not out or p != out[-1]:
            out.append(p)
    return out


def main() -> int:
    url = "https://overpass-api.de/api/interpreter?data=" + urllib.parse.quote(QUERY)
    req = urllib.request.Request(url, headers={"User-Agent": "400h-tracker personal project"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        osm = json.load(resp)

    nodes = {el["id"]: (el["lon"], el["lat"]) for el in osm["elements"] if el["type"] == "node"}
    buildings, roads = [], []
    for el in osm["elements"]:
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        coords = [nodes[n] for n in el.get("nodes", []) if n in nodes]
        if len(coords) < 2:
            continue
        pts = dedupe([to_m(lng, lat) for lng, lat in coords])
        if "building" in tags and len(pts) >= 4:
            # skip 400H's own OSM footprint (we render the real one)
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            if math.hypot(cx, cy) < 48:
                continue
            buildings.append({"p": pts, "h": parse_height(tags)})
        elif tags.get("highway") in ROAD_CLASSES and len(pts) >= 2:
            roads.append({
                "p": pts,
                "w": ROAD_CLASSES[tags["highway"]],
                "n": tags.get("name", ""),
            })

    doc = {
        "note": "Surrounding buildings + streets from OpenStreetMap (odbl.org licence), local meters, same origin as building.json.",
        "attribution": "Map data (c) OpenStreetMap contributors",
        "buildings": buildings,
        "roads": roads,
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    named = len({r["n"] for r in roads if r["n"]})
    print(f"saved {OUT.name}: {len(buildings)} buildings, {len(roads)} road segments "
          f"({named} named streets), {OUT.stat().st_size:,} bytes")
    if len(buildings) < 50:
        print("Suspiciously few buildings - Overpass may have been busy; re-run the workflow.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
