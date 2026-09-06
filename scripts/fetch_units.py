#!/usr/bin/env python3
"""Fetch per-unit availability + pricing from the Engrain SightMap data feed.

Requires the SIGHTMAP_URL environment variable (set as a GitHub Actions
repository variable). Skips quietly if unset, so the workflow works
before you've configured it.

Appends one snapshot per day to data/unit-history.json. Idempotent per day.
"""
import json
import os
import pathlib
import re
import sys
from datetime import datetime, timezone

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
HISTORY_PATH = ROOT / "data" / "unit-history.json"
UA = "Mozilla/5.0 (personal apartment price tracker; contact: repo owner)"


def money(s):
    if s is None:
        return None
    digits = re.sub(r"[^0-9.]", "", str(s))
    if not digits:
        return None
    return int(digits.split(".")[0].replace(",", "") or 0)


def plan_name(raw):
    """floor_plans[].name is JSON-encoded, e.g. '{"name":"U4","provider_id":"21"}' or '"A04"'."""
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        parsed = raw
    if isinstance(parsed, dict):
        parsed = parsed.get("name") or next(iter(parsed.values()), None)
    if parsed is None:
        return None
    return normalize_plan(str(parsed).strip())


def normalize_plan(code):
    """SightMap uses 'U4'/'B5'/'S1'; the floorplans page uses 'U04'/'B05'/'S01'.
    Normalize to the zero-padded form so the two records join."""
    m = re.fullmatch(r"([A-Za-z]+)\s*(\d+)", code or "")
    if not m:
        return code
    return m.group(1).upper() + m.group(2).zfill(2)


def extract_snapshot(feed: dict, source: str) -> dict:
    data = feed.get("data", feed)
    plans_by_id = {}
    for fp in data.get("floor_plans", []):
        pid = fp.get("id") or fp.get("floor_plan_id")
        plans_by_id[pid] = {
            "name": plan_name(fp.get("name")),
            "beds": fp.get("bedroom_count", fp.get("bedrooms")),
            "baths": fp.get("bathroom_count", fp.get("bathrooms")),
        }
    units = []
    for u in data.get("units", []):
        num = str(u.get("unit_number", "")).strip()
        plan = plans_by_id.get(u.get("floor_plan_id"), {})
        floor = int(num[:-2]) if num[:-2].isdigit() else None
        stack = num[-2:] if len(num) >= 3 else None
        price = u.get("price")
        if not isinstance(price, (int, float)):
            price = money(u.get("display_price"))
        tp = u.get("total_price")
        if isinstance(tp, list) and tp:
            total = int(tp[0])
        else:
            total = money(u.get("total_display_price"))
        units.append({
            "unit": num,
            "floor": floor,
            "stack": stack,
            "plan": plan.get("name"),
            "beds": plan.get("beds"),
            "sqft": money(u.get("area")),
            "price": int(price) if isinstance(price, (int, float)) else None,
            "total_price": total,
            "available_on": u.get("available_on") or u.get("display_available_on"),
            "lease_term": u.get("display_lease_term"),
        })
    units.sort(key=lambda x: x["unit"])
    return {
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": source,
        "units": units,
    }


def append_snapshot(snapshot: dict) -> None:
    doc = json.loads(HISTORY_PATH.read_text())
    doc["snapshots"] = [s for s in doc["snapshots"] if s.get("date") != snapshot["date"]]
    doc["snapshots"].append(snapshot)
    doc["snapshots"].sort(key=lambda s: s["date"])
    HISTORY_PATH.write_text(json.dumps(doc, indent=2) + "\n")


def main() -> int:
    url = os.environ.get("SIGHTMAP_URL", "").strip()
    if not url:
        print("SIGHTMAP_URL not set - skipping per-unit fetch (plan scrape still runs).")
        return 0
    resp = requests.get(url, headers={"User-Agent": UA, "Accept": "application/json"}, timeout=30)
    resp.raise_for_status()
    snapshot = extract_snapshot(resp.json(), source="api")
    if not snapshot["units"]:
        print("Feed returned zero units - check SIGHTMAP_URL.", file=sys.stderr)
        return 1
    append_snapshot(snapshot)
    print(f"{snapshot['date']}: recorded {len(snapshot['units'])} available units.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
