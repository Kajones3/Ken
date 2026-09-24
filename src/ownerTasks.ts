/**
 * The owner's outstanding manual jobs, in one place, attached to the one
 * email that already lands in their inbox every night.
 *
 * This project runs on hand-maintained data by necessity — no API publishes
 * Disney ticket prices, promotions, attraction lists, visa rules or closure
 * calendars — and CLAUDE.md says the quiet part out loud more than once:
 * every one of those is "just as easy to let go stale silently". Several
 * already have. The nightly digest is the only thing that reliably reaches a
 * human, so the chore list rides it rather than becoming a fourth email job
 * nobody reads either.
 *
 * Two kinds of task, and the difference is stated on every row:
 *
 *   - CHECKED tasks are computed from real state — an env var that is empty,
 *     a ticket row that is 40 days old, a resort with no real hotel pull.
 *     They appear when true and disappear when fixed, with no edit here.
 *   - STANDING tasks cannot be detected from inside the program: whether a
 *     rate was verified against a real booking, whether a list is still the
 *     placeholder one. They stay until someone flips a flag below, which is
 *     itself a manual job — so they are kept few, and each says what "done"
 *     means.
 *
 * Every task also carries whether it affects the FREE product or PLUS, at
 * the owner's request. That is a priority signal, not decoration: a broken
 * free feature is everybody's problem, a broken Plus feature is a paying
 * customer's problem, and they deserve different urgency.
 */
import { NEWS_FEEDS, RESORTS, mileageRateStatus, CROWDS_REVIEWED, CROWDS_ARE_PLACEHOLDER, CLIMATE_SOURCE } from "./config.js";
import { EXCHANGE_IS_PLACEHOLDER } from "./exchangeData.js";
import type { Db } from "./db.js";
import { todayISO, type ISODate } from "./dates.js";
import { requireVerifiedEmail } from "./verifyEmail.js";

/** Which side of the paywall a task affects. */
export type TaskSide = "free" | "plus" | "both";

export interface OwnerTask {
  id: string;
  title: string;
  /** What actually happens while this is undone. Not "improves accuracy" —
   *  the concrete consequence, so it can be triaged without re-reasoning. */
  why: string;
  side: TaskSide;
  /** True when something is broken or reaching nobody right now, as opposed
   *  to merely getting worse over time. Sorted to the top. */
  blocking: boolean;
  /** How this row was decided, so nobody trusts a standing task as evidence. */
  source: "checked" | "standing";
}

/**
 * Tasks that no amount of querying can settle.
 *
 * Flip `done` when the work is really finished; the row then stops
 * appearing. Deliberately short — a long list of un-checkable reminders is
 * how a digest becomes noise and stops being read, which is the failure this
 * whole file is trying to prevent.
 */
const STANDING_TASKS: (Omit<OwnerTask, "source"> & { done: boolean })[] = [
  {
    id: "attraction-list",
    title: "Replace the starter attraction list with your own",
    why: "ATTRACTIONS in config.ts ships ~10 rows Claude was confident about, not a researched catalogue. Attraction picks are free (2026-09-24), so every signed-in user is matching against a sample, not just a Plus one. Next step is not a scrape (Disney's list is client-rendered, covers only WDW, and cannot tell that Remy's Ratatouille Adventure and Ratatouille: L'Aventure Totalement Toquee are the same ride): paste WDW and Disneyland names in any rough form and have them structured into rows, with every cross-resort clone flagged for you to confirm. Aim for 40-80 headline attractions across all six resorts, not a complete inventory.",
    side: "free",
    blocking: false,
    done: false,
  },
  {
    id: "on-property-rates",
    title: "Check on-property hotel rates against a real booking",
    why: "The model treats each hotel's `base` as an ANNUAL AVERAGE and applies a seasonal multiplier on top. Feeding it rack rates or off-peak floors is exactly the mistake that once produced $70/night Orlando rooms.",
    side: "free",
    blocking: false,
    done: false,
  },
  {
    id: "real-promos",
    title: "Replace the three example promos with real, dated offers",
    why: "seedPromos.ts ships illustrative rows. Applying a promo is free (2026-09-24), so any user who applies one today gets a discount that does not exist.",
    side: "free",
    blocking: false,
    done: false,
  },
  {
    id: "ticket-table",
    title: "Replace the placeholder ticket curve with maintained prices",
    why: "seedTickets fills ticket_prices from a two-parameter approximation of a genuinely date-tiered system. It is disclosed in the UI, but it is still a guess at every resort.",
    side: "free",
    blocking: false,
    done: false,
  },
];

/** How old a resort's ticket rows may get before it is worth a nudge. */
export const TICKET_STALE_DAYS = 30;

/**
 * HAND-MAINTAINED DATA THAT GOES STALE ON A CLOCK.
 *
 * Every table in this project that no API publishes has the same failure
 * mode: it keeps working, keeps looking right, and quietly stops being true.
 * Ticket rows had a staleness check; nothing else did, so each new list
 * (attractions, then crowd bands) arrived with its own bespoke reminder or
 * none at all.
 *
 * This is the registry so the NEXT one is a row here rather than a new idea.
 * Add an entry the same day you add a hand-maintained table.
 *
 *   reviewedOn   — a date constant kept next to the data itself, bumped when
 *                  somebody actually looks at it. Not the file's git mtime:
 *                  reformatting a file is not reviewing it, and a git date
 *                  would silently reset the clock every time it was touched.
 *   everyDays    — how long the data stays believable, from how often the
 *                  real world republishes it. DVC points charts and ticket
 *                  prices come out annually; visa rules change whenever they
 *                  change, so they get a shorter fuse than their publication
 *                  schedule would suggest.
 *
 * None of these is blocking. Stale is not broken — it is the thing that
 * becomes broken while nobody is looking, which is exactly what a nightly
 * nag is for.
 */
interface ReviewableData {
  id: string;
  title: string;
  why: string;
  side: TaskSide;
  reviewedOn: string;
  everyDays: number;
}

const YEARLY = 365;

const REVIEWABLE: ReviewableData[] = [
  {
    id: "crowd-bands",
    title: "Re-check the crowd bands against the current DVC points charts",
    why: "CROWDS in config.ts is how the app answers 'when should we go' — the free half of the product's promise. Walt Disney World and Disneyland are read off DVC points charts, which Disney republishes every year, and the four international resorts are judgement with no chart behind them at all. A band that is a year out is a confident recommendation to travel in a week that is no longer quiet. Bump CROWDS_REVIEWED in src/config.ts when you have looked.",
    side: "free",
    reviewedOn: CROWDS_REVIEWED,
    everyDays: YEARLY,
  },
];

/** Days between two ISO dates, positive when `later` is after `earlier`. */
function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(earlier + "T00:00:00Z");
  const b = Date.parse(later + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

export interface OwnerTaskOptions {
  env?: NodeJS.ProcessEnv;
  today?: ISODate;
}

export async function ownerTasks(db: Db, opts: OwnerTaskOptions = {}): Promise<OwnerTask[]> {
  const env = opts.env ?? process.env;
  const today = opts.today ?? todayISO();
  const tasks: OwnerTask[] = [];
  const checked = (t: Omit<OwnerTask, "source">) => tasks.push({ ...t, source: "checked" });

  // --- 1. Email. The one that hides all the others -----------------------
  // Every email job treats a missing owner address as "nothing to send", so
  // the workflow goes green and the mail never goes. Named first because
  // while it is true, this very list is reaching nobody.
  const missingEmail = ["OWNER_EMAIL", "ALERT_FROM_EMAIL", "RESEND_API_KEY"]
    .filter((k) => !env[k]);
  if (missingEmail.length) {
    checked({
      id: "email-secrets",
      title: `Set ${missingEmail.join(", ")} in GitHub Actions and Render`,
      why: "Every email job treats a missing address as 'nothing to send', so the run goes green and the mail silently never goes. Price alerts, the deal alerts, this digest and the real-pulls digest are all built, all running nightly, and all reaching nobody. RESEND_API_KEY also needs a Resend account with a verified sending domain.",
      side: "both",
      blocking: true,
    });
  }

  // --- 1b. Hand-maintained tables that have aged out ---------------------
  // A date comparison, not a judgement: the row appears when the clock says
  // so and disappears the day the constant is bumped.
  for (const d of REVIEWABLE) {
    const age = daysBetween(d.reviewedOn, today);
    if (age < d.everyDays) continue;
    checked({
      id: d.id,
      title: d.title,
      why: `Last reviewed ${d.reviewedOn}, ${age} days ago — this data is meant to be checked every ${d.everyDays}. ${d.why}`,
      side: d.side,
      blocking: false,
    });
  }

  // --- 1c. Generated or seeded tables still holding placeholder rows ------
  // These say so in their own data rather than on a clock, so each exposes a
  // flag and this reads it. A placeholder that nobody replaces is the
  // failure mode: the UI admits it is a guess, in small text, forever.
  const placeholders: { id: string; title: string; why: string; side: TaskSide }[] = [];
  if (CROWDS_ARE_PLACEHOLDER) {
    placeholders.push({
      id: "crowd-bands-placeholder",
      title: "Replace the placeholder crowd bands with your own points-chart reading",
      why: "CROWDS in src/config.ts still ships Claude's first-pass bands, and the crowd card tells every visitor so. Send your own per-resort, per-month bands, then set CROWDS_ARE_PLACEHOLDER to false in the same commit.",
      side: "free",
    });
  }
  if (EXCHANGE_IS_PLACEHOLDER) {
    placeholders.push({
      id: "exchange-placeholder",
      title: "Run the 'Parkfare exchange rates' workflow",
      why: "src/exchangeData.ts still holds hand-seeded rates rather than ECB reference rates, and the shared PDF says so in words. The workflow is free and takes one dispatch.",
      side: "free",
    });
  }
  if (/hand-seeded|seed/i.test(CLIMATE_SOURCE)) {
    placeholders.push({
      id: "climate-placeholder",
      title: "Run the 'Parkfare climate normals' workflow",
      why: "src/climateData.ts still holds hand-seeded weather rather than observations. CLIMATE_SOURCE in that file says which it currently is.",
      side: "free",
    });
  }
  for (const pl of placeholders) checked({ ...pl, blocking: false });

  // --- 2. IRS mileage rate ----------------------------------------------
  const mileage = mileageRateStatus(today);
  if (mileage.uncoveredYears.length) {
    checked({
      id: "irs-mileage",
      title: `Add the IRS standard mileage rate for ${mileage.uncoveredYears.join(", ")}`,
      // The fix instruction belongs on BOTH branches. A first draft put
      // irs.gov only on the urgent one, so the case you actually see first —
      // a rate merely carried forward — told you something was missing and
      // not how to fix it. A test caught that.
      why: (mileage.pricingBroken
        ? "Driving trips in those years will NOT price at all — priceTrip refuses rather than guessing."
        : `Driving trips that far out are being priced on ${mileage.newestYearOnFile}'s rate, carried forward, and nothing on the site says so. It keeps working until the gap is more than a year.`)
        + ' Look up "IRS standard mileage rates" at irs.gov, then add a row to IRS_MILEAGE_RATES in src/config.ts.',
      side: "free",
      blocking: mileage.pricingBroken,
    });
  }

  // --- 2b. The verification gate is off until mail really delivers -------
  if (!requireVerifiedEmail(env)) {
    checked({
      id: "verify-gate",
      title: env.RESEND_API_KEY
        ? "Turn on REQUIRE_VERIFIED_EMAIL now that email can send"
        : "Email verification is issuing links it cannot deliver",
      why: env.RESEND_API_KEY
        ? "Mail is configured, so the hard gate is safe to switch on: set REQUIRE_VERIFIED_EMAIL=true and an unconfirmed address can no longer sign in. Send yourself a link first and confirm it actually arrives."
        : "Sign-ups create a confirmation link and the console sender prints it to a server log instead of sending it. Nobody can confirm an address, so price alerts reach nobody — alerts require a confirmed address by design. Leave REQUIRE_VERIFIED_EMAIL off until RESEND_API_KEY is set, or every new sign-up is locked out.",
      side: "both",
      blocking: false,
    });
  }

  // --- 3. Ticket price staleness ----------------------------------------
  // The alarm CLAUDE.md says should exist and never did: "replace with rows
  // you maintain by hand and alarm on any resort whose rows are >30 days
  // old — nothing fails loudly here."
  const stale = await db.query<{ resort_id: string; days: string }>(
    `select resort_id, extract(day from now() - max(updated_at))::int as days
       from ticket_prices group by resort_id
      having extract(day from now() - max(updated_at))::int > $1
      order by 2 desc`,
    [TICKET_STALE_DAYS],
  );
  if (stale.rows.length) {
    checked({
      id: "stale-tickets",
      title: `Ticket prices are over ${TICKET_STALE_DAYS} days old at ${stale.rows.length} resort(s)`,
      why: `Oldest: ${stale.rows.map((r) => `${r.resort_id} (${r.days}d)`).join(", ")}. Disney has confirmed date-tiered dynamic ticket pricing is coming to WDW and Disneyland, which makes a static table go stale faster than it used to.`,
      side: "free",
      blocking: false,
    });
  }

  // --- 4. Resorts with no real off-property hotel data -------------------
  // Only on_property = false rows count, for the same reason the hotel
  // rotation counts only those: on-property rates are generated locally and
  // carry the same source tag, so counting them would report coverage that
  // no vendor ever provided.
  const pulled = await db.query<{ resort_id: string }>(
    `select distinct resort_id from hotel_rates
      where source = 'serpapi_hotels' and on_property = false`,
  );
  const have = new Set(pulled.rows.map((r) => r.resort_id));
  const never = RESORTS.filter((r) => !have.has(r.id));
  if (never.length) {
    checked({
      id: "hotel-coverage",
      title: `No real off-property hotel prices yet for ${never.map((r) => r.name).join(", ")}`,
      why: "The nightly rotation fills these in stalest-first and needs about ten nights from empty, so this clears itself if the refresh job is running. If it is still here in a fortnight, the hotel budget is not being spent.",
      side: "free",
      blocking: false,
    });
  }

  // --- 5. News feeds never confirmed reachable ---------------------------
  // `note` holds the run SUMMARY, not the per-feed error, so quoting it here
  // produced a line that looked like evidence and said nothing ("reported
  // errors: nothing new; 7 manual jobs outstanding"). Report the count and
  // point at the log that actually names the URL.
  const feedErrors = await db.query<{ errors: number; started_at: Date }>(
    `select errors, started_at from fetch_runs
      where job = 'news_digest' and errors > 0
      order by started_at desc limit 1`,
  ).catch(() => ({ rows: [] as { errors: number; started_at: Date }[] }));
  const lastFeedError = feedErrors.rows[0];
  if (lastFeedError) {
    checked({
      id: "news-feeds",
      title: `${lastFeedError.errors} of ${NEWS_FEEDS.length} news feeds failed on the last run`,
      why: "These URLs were best guesses and have never been confirmed reachable. The per-feed error naming the failing URL is in the 'Parkfare news digest' Actions log; a feed that is permanently 403 or 404 should be replaced in NEWS_FEEDS in src/config.ts. This is how closures and new promos reach you, so a dead feed is a blind spot.",
      side: "free",
      blocking: false,
    });
  }

  for (const t of STANDING_TASKS) {
    if (!t.done) {
      const { done, ...rest } = t;
      void done;
      tasks.push({ ...rest, source: "standing" });
    }
  }

  // Blocking first, then anything affecting the free product (it reaches
  // everyone), then the rest.
  const weight = (t: OwnerTask) =>
    (t.blocking ? 0 : 10) + (t.side === "both" ? 0 : t.side === "free" ? 1 : 2);
  return tasks.sort((a, b) => weight(a) - weight(b));
}

/** Plain-text block for the digest email. */
export function renderOwnerTasks(tasks: OwnerTask[]): string {
  if (!tasks.length) return "Manual jobs: none outstanding. Nothing needs you right now.";
  const label = (t: OwnerTask) =>
    `[${t.side === "both" ? "FREE+PLUS" : t.side.toUpperCase()}]${t.blocking ? " [BLOCKING]" : ""}`;
  const lines = tasks.map((t, i) =>
    `${i + 1}. ${label(t)} ${t.title}\n   ${t.why}\n   (${t.source === "checked" ? "checked against real state just now" : "always shown until marked done in src/ownerTasks.ts"})`);
  return [
    `Your manual jobs (${tasks.length})`,
    "-".repeat(40),
    ...lines,
  ].join("\n\n");
}
