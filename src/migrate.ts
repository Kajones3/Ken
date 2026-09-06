import { readFileSync } from "node:fs";
import { getDb } from "./db.js";

const db = await getDb();
await db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
console.log(`schema applied (${db.kind})`);
await db.close();
