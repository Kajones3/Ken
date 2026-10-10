/** Prints, one per line, every DB1C file name already loaded into
 *  historical_fares_monthly, so the workflow loads only new months. */
import { getDb } from "../db.js";

const db = await getDb();
const r = await db.query<{ file: string }>(
  `select distinct file from historical_fares_monthly where file is not null order by file`,
);
for (const row of r.rows) console.log(row.file);
await db.close();
