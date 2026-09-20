/**
 * The spreadsheet half of the admin page.
 *
 * Deliberately forgiving about what a SPREADSHEET does to a file, and strict
 * about what the OWNER puts in it. Excel adds a byte-order mark, Windows uses
 * CRLF, Numbers quotes anything containing a comma, and every one of them
 * leaves a trailing blank line — none of which is a mistake the owner made, so
 * none of them should cost them an upload. What a value is allowed to BE is
 * validated elsewhere, once, by the same code the single-value form uses.
 */

/** One cell, quoted only when it would otherwise break the row. */
export function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of cells. Blank lines are dropped rather than becoming empty rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface CsvEntries {
  ok: true;
  entries: { key: string; value: string }[];
}
export interface CsvRefused {
  ok: false;
  message: string;
}

/**
 * Turn an uploaded file into the entries applySettings expects.
 *
 * Finds the columns by NAME rather than position, so a spreadsheet that
 * reorders or adds columns still imports — people rearrange spreadsheets, and
 * a file that silently read the wrong column would write the wrong numbers.
 */
export function entriesFromCsv(text: string): CsvEntries | CsvRefused {
  const rows = parseCsv(text);
  if (!rows.length) return { ok: false, message: "That file had no rows in it." };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const keyAt = header.indexOf("key"), valAt = header.indexOf("value");
  if (keyAt < 0 || valAt < 0) {
    return { ok: false, message:
      'That file needs a header row with "key" and "value" columns. Download the spreadsheet again and edit the value column.' };
  }
  return { ok: true, entries: rows.slice(1).map((r) => ({
    key: (r[keyAt] ?? "").trim(), value: (r[valAt] ?? "").trim(),
  })) };
}
