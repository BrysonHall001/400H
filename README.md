# 400H Unit Tracker

Personal tracker for pricing and availability at 400H (9 N Harrington St, Raleigh),
floors 9–20, aimed at a ~Jan 2028 move. Static site, no build step, no paid services.

## Run it locally

```
npx serve            # or: python3 -m http.server 8000
```

Then open the printed localhost URL. (Opening `index.html` directly via `file://`
won't work because the app fetches the JSON files in `data/`.)

## The two data records

| Record | Source | Granularity | Captured by |
|---|---|---|---|
| **Primary: per-plan** | `live400h.com/floorplans` page (Floorplans tab) | 21 plan types, advertised min–max Total Monthly Leasing Price | `scripts/scrape_plans.py`, fully automatic |
| **Secondary: per-unit** | Engrain SightMap feed (Map tab) | Each actually-listed unit's real price | `scripts/fetch_units.py` (automatic once configured) or HAR/JSON drop on the Tracker tab |

Both live as JSON in `data/` and the site reads them directly.

## Automating daily capture (recommended)

The GitHub Action in `.github/workflows/daily.yml` runs once a day:

1. Push this repo to GitHub (private is fine).
2. On the repo page: **Settings → Actions → General → Workflow permissions →
   "Read and write permissions"** (so the bot can commit data).
3. That's it for per-plan prices — they start accumulating tomorrow.
   You can also trigger a run any time from **Actions → Daily price capture → Run workflow**.

Cost: ~1 free Actions minute per day. Private repos get 2,000 free minutes/month.

### Activating the per-unit fetch (one-time, ~2 minutes)

The script needs the SightMap feed URL, which is easiest to grab from your browser:

1. Open `live400h.com/floorplans`, press **F12** (DevTools) → **Network** tab.
2. Type `sightmap` in the network filter box.
3. Reload the page and click the site's **Map** tab.
4. A request to `sightmap.com/...` appears. Right-click it → **Copy → Copy link address**.
5. In GitHub: **Settings → Secrets and variables → Actions → Variables →
   New repository variable**, name `SIGHTMAP_URL`, value = the copied URL.

Alternatively: drop any valid HAR on the Tracker tab — the app finds the feed inside it
and prints the URL for you in the import status message.

## Manual capture (fallback / backfill)

Drop a HAR file or the raw SightMap JSON response onto the drop zone on the
**Tracker** tab. The snapshot is dated from the capture itself, so old HARs backfill
their own day. Then click **Save updated unit-history.json**, replace
`data/unit-history.json`, and commit.

**Exporting a HAR that isn't empty** (the empty-file trap): open DevTools **before**
loading the page → Network tab → check **Preserve log** → reload → click the site's
Map tab and let it finish → right-click anywhere in the request list →
**Save all as HAR with content**. A good export is several MB.

## Hosting (optional)

GitHub Pages is free with no build-minute limits: **Settings → Pages → Deploy from
branch → main → / (root)**. The daily Action commits data, Pages redeploys, and the
charts stay current with zero effort. A private repo requires GitHub Pro for Pages;
on a free account either make the repo public or just run locally.

## Roadmap

- **Phase 2 — 3D building tab**: clickable model of floors 9–20 traced from the floor
  screenshots; per-unit popup with sqft, beds, porch flag, availability, floorplan image;
  filters for beds/porch/floor. Backed by a canonical `data/building.json` (every unit,
  not just available ones).
- **Phase 3 — full units table + analytics**: all ~242 units in the table with
  availability status; per-unit volatility and days-on-market; watchlist for
  high-floor 1BRs with porches.
