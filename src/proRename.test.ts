import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { memoryDb } from "./db.js";
import { grantPro } from "./grantPro.js";

/* "Plus" became "Planner Pro" (2026-10-30). Step 1 keeps the old columns
 * beside the new ones; these pin that the move loses nothing and is safe to
 * run on every migrate. */
const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

test("a pass held under the old columns is copied to the new ones, and a second migrate changes nothing", async () => {
  const db = await memoryDb();
  const id = randomUUID();
  await db.query(
    `insert into users (id, email, plus_until, plus_pass, plus_reminder_for) values ($1, 'old@example.com', '2027-01-29', 'threeMonths', '2027-01-29')`,
    [id]);
  await db.exec(schema);
  await db.exec(schema);
  const { rows } = await db.query<{ pro_until: unknown; pro_pass: string; pro_reminder_for: unknown }>(
    `select pro_until::text as pro_until, pro_pass, pro_reminder_for::text as pro_reminder_for from users where id = $1`, [id]);
  assert.deepEqual(rows[0], { pro_until: "2027-01-29", pro_pass: "threeMonths", pro_reminder_for: "2027-01-29" });
  await db.close();
});

test("granting Planner Pro writes the new columns and the old ones, so a server on the old code still sees it", async () => {
  const db = await memoryDb();
  await grantPro(db, "friend@example.com", 91, "threeMonths");
  const { rows } = await db.query<{ same: boolean; pass: string; old_pass: string }>(
    `select pro_until = plus_until as same, pro_pass as pass, plus_pass as old_pass from users where email = 'friend@example.com'`);
  assert.deepEqual(rows[0], { same: true, pass: "threeMonths", old_pass: "threeMonths" });
  await db.close();
});

test("old 'plus' click counts fold into 'pro', adding to a row already there", async () => {
  const db = await memoryDb();
  await db.exec(`insert into event_counts (day, kind, resort_id, detail, n) values
    ('2026-10-20', 'plus', '', 'week', 2), ('2026-10-20', 'pro', '', 'week', 1), ('2026-10-21', 'plus', '', 'nineMonths', 4)`);
  await db.exec(schema);
  await db.exec(schema);
  const { rows } = await db.query<{ day: string; kind: string; detail: string; n: number }>(
    `select day::text as day, kind, detail, n from event_counts order by day, detail`);
  assert.deepEqual(rows, [
    { day: "2026-10-20", kind: "pro", detail: "week", n: 3 },
    { day: "2026-10-21", kind: "pro", detail: "nineMonths", n: 4 },
  ]);
  await db.close();
});
