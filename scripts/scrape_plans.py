#!/usr/bin/env python3
"""Scrape per-floorplan Total Monthly Leasing Prices from live400h.com/floorplans.

Appends one row per plan per day to data/plan-history.json.
Idempotent: re-running on the same day replaces that day's rows.
On a parse anomaly (fewer plans found than expected), writes the raw HTML
to debug/ and exits non-zero so the GitHub Action surfaces the failure.
"""
import json
import pathlib
import re
import sys
from datetime import datetime, timezone

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
HISTORY_PATH = ROOT / "data" / "plan-history.json"
PLANS_PATH = ROOT / "data" / "plans.json"
URL = "https://live400h.com/floorplans/"
UA = "Mozilla/5.0 (personal apartment price tracker; contact: repo owner)"

EXPECTED_MIN_PLANS = 18  # 21 known plans; tolerate a few missing before alarming


def strip_tags(html: str) -> str:
    html = re.sub(r"<script\b.*?</script>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<style\b.*?</style>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", html)
    text = text.replace("&amp;", "&").replace("&nbsp;", " ").replace("&#39;", "'")
    return re.sub(r"\s+", " ", text)


def money(s: str) -> int:
    """'$1,910.12' -> 1910 (whole dollars, cents dropped)."""
    return int(re.sub(r"[^0-9.]", "", s).split(".")[0].replace(",", "") or 0)


def parse_plans(html: str, plan_codes: list[str]) -> list[dict]:
    text = strip_tags(html)
    rows = []
    # Each plan card flattens to text like:
    #   "U01 1 bed 1 bath 746 sq. ft. $1,910.12 - $2,060.12 /mo* Only 2 left! 12 months $1,830 - $1,980 Base Rent"
    # or "A02 1 bed 1 bath 761 sq. ft. Contact Us"
    for code in plan_codes:
        # Find the card occurrence: plan code followed by bed/bath info within a short window.
        pattern = re.compile(
            re.escape(code)
            + r"\s*(?:Studio|\d+\s*bed)s?\s*\d+\s*bath[^$]{0,120}?"
            + r"(?:(?P<contact>Contact\s*Us)|"
            + r"\$(?P<min>[\d,]+(?:\.\d+)?)\s*(?:-\s*\$(?P<max>[\d,]+(?:\.\d+)?))?\s*/mo)"
            , re.I,
        )
        m = pattern.search(text)
        if not m:
            continue
        row = {"plan": code}
        if m.group("contact"):
            row["status"] = "contact"
            rows.append(row)
            continue
        row["status"] = "priced"
        row["total_min"] = money(m.group("min"))
        row["total_max"] = money(m.group("max")) if m.group("max") else row["total_min"]
        tail = text[m.end(): m.end() + 260]
        # A card's details end at "Base Rent"; clamp there so we never read the next card.
        base_end = re.search(r"Base\s*Rent", tail, re.I)
        if base_end:
            tail = tail[: base_end.end()]
        left = re.search(r"Only\s+(\d+)\s+left", tail, re.I)
        row["units_left"] = int(left.group(1)) if left else None
        term = re.search(r"(\d+)\s+months?", tail, re.I)
        row["term_months"] = int(term.group(1)) if term else None
        base = re.search(r"\$([\d,]+)\s*(?:-\s*\$([\d,]+))?\s*Base\s*Rent", tail, re.I)
        if base:
            row["base_min"] = money(base.group(1))
            row["base_max"] = money(base.group(2)) if base.group(2) else row["base_min"]
        rows.append(row)
    return rows


def main() -> int:
    plan_codes = [p["code"] for p in json.loads(PLANS_PATH.read_text())["plans"]]
    resp = requests.get(URL, headers={"User-Agent": UA}, timeout=30)
    resp.raise_for_status()
    rows = parse_plans(resp.text, plan_codes)

    if len(rows) < EXPECTED_MIN_PLANS:
        debug_dir = ROOT / "debug"
        debug_dir.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (debug_dir / f"floorplans-{stamp}.html").write_text(resp.text)
        print(f"PARSE ANOMALY: only {len(rows)} plans found (expected >= {EXPECTED_MIN_PLANS}). "
              f"Raw HTML saved to debug/. Site layout may have changed.", file=sys.stderr)
        return 1

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doc = json.loads(HISTORY_PATH.read_text())
    doc["history"] = [r for r in doc["history"] if r.get("date") != today]
    for r in rows:
        doc["history"].append({"date": today, **r})
    doc["history"].sort(key=lambda r: (r["date"], r["plan"]))
    HISTORY_PATH.write_text(json.dumps(doc, indent=2) + "\n")
    priced = sum(1 for r in rows if r["status"] == "priced")
    print(f"{today}: recorded {len(rows)} plans ({priced} priced, {len(rows) - priced} contact-us).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
