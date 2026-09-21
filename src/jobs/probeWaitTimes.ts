/**
 * A one-off reconnaissance job for the "average wait time this month" card.
 *
 * This exists because the sandbox Claude works in cannot reach any wait-time
 * source — queue-times.com answers `CONNECT tunnel failed, 403` through the
 * egress proxy, exactly like every Disney domain and every weather API before
 * it. GitHub Actions is not restricted that way, so this is the one place the
 * questions below can actually be answered with a fact instead of a guess.
 *
 * It answers three things, in order of how much they matter:
 *
 *  1. Does Queue-Times cover all six of our resorts, and what are the park
 *     ids? The card is only worth building if the answer is all six — a wait
 *     time for Orlando and Anaheim but not Shanghai would quietly bias the
 *     one comparison this app exists to make, which is the same argument that
 *     put us on Open-Meteo rather than NOAA for weather.
 *  2. Is there a HISTORICAL endpoint? Their documented API is live-only. If
 *     some stats route returns JSON, a monthly average is available today.
 *     If not, the only honest route is to start sampling live and have a real
 *     average in a year.
 *  3. What does a live payload actually look like? The collector has to be
 *     written against the real shape, not a documented one — this project has
 *     been burned by "written to the documented shape, never run" four times
 *     (Travelpayouts, Resend, EIA, Open-Meteo).
 *
 * Read-only. No database, no secrets, no writes. Nothing here is on a request
 * path and nothing here is scheduled.
 */

/** The parks we need, by the name Queue-Times is likely to use, grouped by
 *  our own resort id. A resort can have several parks (Walt Disney World has
 *  four); the card averages across whichever ones we find. */
const WANTED: { resortId: string; resortName: string; parkNames: string[] }[] = [
  { resortId: "wdw", resortName: "Walt Disney World", parkNames: ["Magic Kingdom", "Epcot", "Hollywood Studios", "Animal Kingdom"] },
  { resortId: "dlr", resortName: "Disneyland Resort", parkNames: ["Disneyland", "California Adventure"] },
  { resortId: "dlp", resortName: "Disneyland Paris", parkNames: ["Disneyland Park", "Walt Disney Studios"] },
  { resortId: "tdr", resortName: "Tokyo Disney Resort", parkNames: ["Tokyo Disneyland", "Tokyo DisneySea"] },
  { resortId: "shdr", resortName: "Shanghai Disney Resort", parkNames: ["Shanghai Disneyland"] },
  { resortId: "hkdl", resortName: "Hong Kong Disneyland", parkNames: ["Hong Kong Disneyland"] },
];

const BASE = "https://queue-times.com";

type Park = { id: number; name: string; country?: string; timezone?: string };
type Group = { id: number; name: string; parks: Park[] };

async function getJson(url: string): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        // Their terms ask for attribution in the app; identifying the caller
        // is the same courtesy one level down, and it is what lets them tell
        // a well-behaved consumer from a scraper if they ever look.
        "user-agent": "Parkfare/0.1 (+https://pricingthemagic.com) wait-time feasibility probe",
        accept: "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, why: `HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}` };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      // A 200 that is HTML is the interesting failure: it means the route
      // exists as a web page but not as data, which is the difference
      // between "we can have history today" and "we start collecting".
      const looksHtml = /^\s*<(!doctype|html)/i.test(text);
      return { ok: false, why: looksHtml ? `HTTP 200 but HTML, not JSON (${text.length} bytes) — a page, not an endpoint` : `HTTP 200 but unparseable (${text.slice(0, 200)})` };
    }
  } catch (e) {
    return { ok: false, why: `fetch failed: ${(e as Error).message}` };
  }
}

const out: string[] = [];
const say = (s = "") => { console.log(s); out.push(s); };

async function main() {
  say("## 1. Park coverage");
  say("");
  const parksRes = await getJson(`${BASE}/parks.json`);
  if (!parksRes.ok) {
    say(`**Could not read the park list.** ${parksRes.why}`);
    say("");
    say("Nothing below could be checked. If this is a 403 the probe itself is being blocked, not the data.");
    await writeSummary();
    return;
  }

  const groups = parksRes.body as Group[];
  const all: Park[] = Array.isArray(groups) ? groups.flatMap(g => g.parks ?? []) : [];
  say(`Queue-Times lists **${all.length} parks** across ${Array.isArray(groups) ? groups.length : 0} groups.`);
  say("");

  const found: { resortId: string; parkId: number; parkName: string }[] = [];
  const missing: string[] = [];
  say("| Our resort | Park we want | Queue-Times id | Their name |");
  say("|---|---|---|---|");
  for (const w of WANTED) {
    for (const want of w.parkNames) {
      const needle = want.toLowerCase();
      const hit = all.find(p => (p.name ?? "").toLowerCase().includes(needle));
      if (hit) {
        found.push({ resortId: w.resortId, parkId: hit.id, parkName: hit.name });
        say(`| ${w.resortId} | ${want} | \`${hit.id}\` | ${hit.name} |`);
      } else {
        missing.push(`${w.resortId}: ${want}`);
        say(`| ${w.resortId} | ${want} | — | **not found** |`);
      }
    }
  }
  say("");
  const covered = new Set(found.map(f => f.resortId));
  const uncovered = WANTED.filter(w => !covered.has(w.resortId));
  if (uncovered.length === 0) {
    say(`**All six resorts are covered.** The card is worth building on this source.`);
  } else {
    say(`**${uncovered.length} resort(s) have no park at all:** ${uncovered.map(u => u.resortName).join(", ")}.`);
    say(`The owner's own bar was "only valuable if we can get it for all the parks" — on this result, that bar is not met.`);
  }
  if (missing.length) {
    say("");
    say(`Individually unmatched (may just be a naming difference, check the full list below): ${missing.join("; ")}`);
  }

  say("");
  say("## 2. Is there a historical endpoint?");
  say("");
  say("Their documented API is live-only. These are the routes worth trying before concluding that.");
  say("");
  const probe = found[0];
  if (!probe) {
    say("No park id to probe with — skipped.");
  } else {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const candidates = [
      `${BASE}/parks/${probe.parkId}/stats.json`,
      `${BASE}/parks/${probe.parkId}/calendar.json`,
      `${BASE}/parks/${probe.parkId}/calendar/${yesterday}.json`,
      `${BASE}/en-US/parks/${probe.parkId}/stats.json`,
      `${BASE}/parks/${probe.parkId}/queue_times.json?date=${yesterday}`,
    ];
    say(`Probing against park \`${probe.parkId}\` (${probe.parkName}):`);
    say("");
    say("| Candidate | Result |");
    say("|---|---|");
    let anyHistory = false;
    for (const url of candidates) {
      const r = await getJson(url);
      if (r.ok) {
        anyHistory = true;
        say(`| \`${url.replace(BASE, "")}\` | **JSON returned** — ${JSON.stringify(r.body).slice(0, 160)}… |`);
      } else {
        say(`| \`${url.replace(BASE, "")}\` | ${r.why.slice(0, 140)} |`);
      }
      await new Promise(r => setTimeout(r, 1200)); // be a good citizen
    }
    say("");
    say(anyHistory
      ? "**At least one historical route returned JSON.** Worth reading the payload above before assuming it holds monthly averages — a daily crowd level is not the same thing."
      : "**No historical JSON.** Monthly averages are not available from this API today, so the only honest route is to sample the live endpoint on a schedule and build our own history.");
  }

  say("");
  say("## 3. What the live payload actually looks like");
  say("");
  if (!probe) {
    say("No park id — skipped.");
  } else {
    const live = await getJson(`${BASE}/parks/${probe.parkId}/queue_times.json`);
    if (!live.ok) {
      say(`Live read failed: ${live.why}`);
    } else {
      const body = live.body as { lands?: { name: string; rides?: unknown[] }[]; rides?: unknown[] };
      const landCount = body.lands?.length ?? 0;
      const rideCount = (body.rides?.length ?? 0) + (body.lands ?? []).reduce((n, l) => n + (l.rides?.length ?? 0), 0);
      say(`\`${landCount}\` lands, \`${rideCount}\` rides in the payload.`);
      say("");
      // Worth printing verbatim: the collector must be written against this,
      // not against the documentation.
      say("First 1,500 characters, verbatim:");
      say("");
      say("```json");
      say(JSON.stringify(live.body, null, 2).slice(0, 1500));
      say("```");
      if (landCount) {
        say("");
        say(`Land names, which we also need for the PDF's "features these lands" line: ${(body.lands ?? []).map(l => l.name).join(", ")}`);
      }
    }
  }

  say("");
  say("## Full park list (for the record)");
  say("");
  say("<details><summary>Every park Queue-Times knows about</summary>");
  say("");
  say("```");
  for (const g of (Array.isArray(groups) ? groups : [])) {
    say(`${g.name}`);
    for (const p of g.parks ?? []) say(`  ${String(p.id).padStart(4)}  ${p.name}`);
  }
  say("```");
  say("</details>");

  await writeSummary();
}

async function writeSummary() {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, out.join("\n") + "\n");
}

main().catch(async e => {
  say(`\nProbe threw: ${(e as Error).message}`);
  await writeSummary();
  process.exit(1);
});
