/**
 * A one-off, deliberately CHEAP reconnaissance job for cruise pricing —
 * same purpose as probeWaitTimes.ts, adapted for a source that costs real
 * money per result instead of being free. Unlike Queue-Times, we do not get
 * to probe for free, so this defaults to the smallest possible paid pull
 * (a handful of results) and refuses to run at all without an explicit
 * confirmation that the owner has read the actor's own pricing page.
 *
 * It exists to answer three questions BEFORE any recurring budget is
 * committed or any schema is added to db/schema.sql:
 *
 *  1. Does a scraped row expose anything ABOVE the generic "Suite" bucket?
 *     The owner's own anecdote ("this suite goes for $30k a night") almost
 *     certainly refers to a named Concierge/Royal Suite tier, not the
 *     cheapest room in a broad "Suite" category — if this source floors to
 *     the bottom of that category, it will never surface the real outliers
 *     and category-only banding will understate the true top of the range.
 *  2. Is there any signal for promo/rack-rate, or availability/inventory?
 *     Neither existed in the one sample row we were shown; this checks the
 *     REAL payload rather than assuming the sample was complete.
 *  3. What does a real row actually look like, verbatim? Written-to-the-
 *     documented-shape-and-never-run has bitten this project four times
 *     already (Travelpayouts, Resend, EIA, Open-Meteo) — same discipline
 *     applies to a new source, doubly so for one bought with real money.
 *
 * Nothing here is scheduled, nothing here is on a request path, and nothing
 * here writes to the database — db/schema.sql gets a cruise_prices table
 * only after this probe's answers are read, not before.
 *
 * Required env:
 *   APIFY_TOKEN      - from the API & Integrations tab of the Apify account
 *   APIFY_ACTOR_ID   - "username~actor-name" (tilde, not slash) for whichever
 *                      Disney Cruise Line actor was actually chosen on Apify's
 *                      store; apify.com itself is blocked from this sandbox,
 *                      so its exact input-field names below are a best guess,
 *                      not confirmed — check the actor's own "Input" tab and
 *                      adjust ACTOR_INPUT if it rejects these fields.
 *   CONFIRM_SPEND=yes - refuses to run without this, so a probe can never be
 *                      an accidental large paid pull.
 */

export {}; // makes this a module with its own scope, not a global script —
           // otherwise `out`/`say` collide with probeWaitTimes.ts's own.

const TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = process.env.APIFY_ACTOR_ID;
const MAX_ITEMS = Math.min(Number(process.env.APIFY_MAX_ITEMS) || 5, 20); // hard ceiling, not just a default
const CONFIRMED = process.env.CONFIRM_SPEND === "yes";

const out: string[] = [];
const say = (s = "") => { console.log(s); out.push(s); };

// Best-guess input shape. Common Apify actor convention is a "maxItems"-style
// cap plus actor-specific filters; the exact field names for THIS actor are
// unconfirmed (apify.com is blocked from here) and must be checked against
// its own Input tab before trusting this to actually stay small.
const ACTOR_INPUT: Record<string, unknown> = {
  maxItems: MAX_ITEMS,
  // Filtering to one ship keeps a first trial small even if maxItems is
  // ignored or named differently than guessed above. Comment out if the
  // actor rejects an unrecognised field — an unrecognised field is usually
  // silently ignored by Apify actors, but that is exactly what this probe
  // exists to confirm rather than assume.
  shipName: "Disney Wonder",
};

async function main() {
  say("## Cruise price probe — before any budget or schema commitment");
  say("");

  if (!TOKEN || !ACTOR_ID) {
    say("**Missing `APIFY_TOKEN` or `APIFY_ACTOR_ID`.** Nothing was called, nothing was spent.");
    return;
  }
  if (!CONFIRMED) {
    say(`**Refusing to run.** This calls a PAID API (~$1.50 per 1,000 results; this` +
        ` request asks for at most ${MAX_ITEMS}). Set CONFIRM_SPEND=yes once you've` +
        ` checked the actor's own pricing page and are OK spending a few cents.`);
    return;
  }

  say(`Requesting at most **${MAX_ITEMS}** results from actor \`${ACTOR_ID}\`.`);
  say("");

  const url = `https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items`;
  let items: unknown[];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(ACTOR_INPUT),
    });
    const text = await res.text();
    if (!res.ok) {
      say(`**HTTP ${res.status}.** ${text.slice(0, 500)}`);
      say("");
      say("A 400 here almost always means ACTOR_INPUT's field names are wrong for this actor — check its Input tab.");
      return;
    }
    items = JSON.parse(text);
  } catch (e) {
    say(`**Request failed:** ${(e as Error).message}`);
    return;
  }

  if (!Array.isArray(items) || items.length === 0) {
    say("**Zero results returned.** Either the filter (`shipName`) matched nothing, or the field name is wrong.");
    return;
  }

  say(`Got **${items.length}** result(s). First one, verbatim:`);
  say("");
  say("```json");
  say(JSON.stringify(items[0], null, 2));
  say("```");
  say("");

  // Answer the three questions by grepping actual key names rather than
  // assuming — this is the whole point of paying for a real sample instead
  // of reasoning from the one row we were shown in chat.
  const allKeys = new Set<string>();
  for (const it of items) if (it && typeof it === "object") for (const k of Object.keys(it)) allKeys.add(k);
  const keys = [...allKeys].sort();

  say("## 1. Is there anything above the generic \"Suite\" bucket?");
  const suiteLike = keys.filter(k => /suite|concierge|royal|grand|penthouse/i.test(k));
  say(suiteLike.length
    ? `Found candidate fields: ${suiteLike.map(k => `\`${k}\``).join(", ")} — check whether any of these break out a tier ABOVE the basic "Suite" price.`
    : `**No field name beyond a generic suite price was found.** On this evidence, the real named-suite outliers ($20k-30k/night anecdotes) are NOT captured by this source — category banding here would floor to the cheapest suite, not the ceiling.`);

  say("");
  say("## 2. Promo/rack-rate or availability signal?");
  const promoLike = keys.filter(k => /promo|discount|sale|rack|list_price|was_price/i.test(k));
  const availLike = keys.filter(k => /avail|inventory|sold_out|remaining|capacity/i.test(k));
  say(promoLike.length ? `Promo/rack-rate candidates: ${promoLike.map(k => `\`${k}\``).join(", ")}` : "**No promo/rack-rate field found.** Treat every price as a single current headline number, with no way to tell a sale from a standard rate.");
  say(availLike.length ? `Availability candidates: ${availLike.map(k => `\`${k}\``).join(", ")}` : "**No availability/inventory field found**, as expected — nothing found anywhere claims to expose fill rate.");

  say("");
  say("## 3. Every field name this row actually has");
  say("");
  say("```");
  say(keys.join("\n"));
  say("```");

  say("");
  say(`Real cost of this probe: ${items.length} result(s) × ~$0.0015 ≈ $${(items.length * 0.0015).toFixed(4)}.`);

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
