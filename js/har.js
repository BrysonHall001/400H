/* har.js — turn a dropped HAR file or raw SightMap JSON into a unit snapshot.
   Mirrors scripts/fetch_units.py so both paths produce identical rows. */

const HAR = (() => {

  function moneyToInt(v) {
    if (v === null || v === undefined) return null;
    const digits = String(v).replace(/[^0-9.]/g, "");
    if (!digits) return null;
    return parseInt(digits.split(".")[0].replace(/,/g, ""), 10);
  }

  // floor_plans[].name is itself JSON-encoded, e.g. '"A04"' or '{"en":"A04"}'
  function planName(raw) {
    if (raw === null || raw === undefined) return null;
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch (_) { /* already plain */ }
    if (parsed && typeof parsed === "object") parsed = Object.values(parsed)[0];
    return parsed === null || parsed === undefined ? null : String(parsed).trim();
  }

  function looksLikeFeed(obj) {
    const d = obj && (obj.data || obj);
    return d && Array.isArray(d.units);
  }

  // Search a parsed HAR for the SightMap data response. Returns {feed, date} or null.
  function feedFromHar(har) {
    const entries = (har.log && har.log.entries) || [];
    for (const entry of entries) {
      const url = (entry.request && entry.request.url) || "";
      const content = entry.response && entry.response.content;
      if (!content || !content.text) continue;
      let text = content.text;
      if (content.encoding === "base64") {
        try { text = atob(text); } catch (_) { continue; }
      }
      // Cheap prefilter, then verify by shape — don't trust the URL alone.
      if (!/sightmap|engrain/i.test(url) && !/"units"\s*:/.test(text)) continue;
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { continue; }
      if (!looksLikeFeed(parsed)) continue;
      const started = entry.startedDateTime ? entry.startedDateTime.slice(0, 10) : null;
      return { feed: parsed, date: started, sightmapUrl: url };
    }
    return null;
  }

  function extractSnapshot(feed, date, source) {
    const data = feed.data || feed;
    const plansById = {};
    for (const fp of data.floor_plans || []) {
      const id = fp.id !== undefined ? fp.id : fp.floor_plan_id;
      plansById[id] = {
        name: planName(fp.name),
        beds: fp.bedroom_count !== undefined ? fp.bedroom_count : fp.bedrooms,
      };
    }
    const units = (data.units || []).map(u => {
      const num = String(u.unit_number || "").trim();
      const floorPart = num.slice(0, -2);
      const plan = plansById[u.floor_plan_id] || {};
      return {
        unit: num,
        floor: /^\d+$/.test(floorPart) ? parseInt(floorPart, 10) : null,
        stack: num.length >= 3 ? num.slice(-2) : null,
        plan: plan.name || null,
        beds: plan.beds !== undefined ? plan.beds : null,
        sqft: moneyToInt(u.area),
        price: moneyToInt(u.display_price),
        total_price: moneyToInt(u.total_display_price),
        available_on: u.display_available_on || null,
      };
    }).sort((a, b) => a.unit.localeCompare(b.unit));
    return { date, source, units };
  }

  /* Entry point. Returns {snapshot, sightmapUrl} — throws with a readable message on failure. */
  function parseDrop(text, fallbackDate) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {
      throw new Error("That file isn't valid JSON. Export the HAR again, or paste the raw SightMap response.");
    }
    if (parsed.log) {
      const found = feedFromHar(parsed);
      if (!found) {
        const n = (parsed.log.entries || []).length;
        if (n === 0) {
          throw new Error("This HAR has zero entries — DevTools was likely opened after the page loaded. " +
            "Open DevTools first, check Preserve log, reload, let the Map tab load, then export.");
        }
        throw new Error(`Searched ${n} HAR entries but found no SightMap unit feed. ` +
          "Make sure you clicked the site's Map tab before exporting.");
      }
      return {
        snapshot: extractSnapshot(found.feed, found.date || fallbackDate, "har"),
        sightmapUrl: found.sightmapUrl,
      };
    }
    if (looksLikeFeed(parsed)) {
      return { snapshot: extractSnapshot(parsed, fallbackDate, "json"), sightmapUrl: null };
    }
    throw new Error("JSON parsed, but no units array found — expected a HAR or a SightMap data response.");
  }

  return { parseDrop, extractSnapshot };
})();
