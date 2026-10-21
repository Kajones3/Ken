/**
 * The whole site behind one password, with a "coming soon" page in front
 * (2026-09-29, the owner: "password protect the entire site and make it a
 * 'coming soon' landing page. I don't want someone to stumble on it now").
 *
 * HOW IT IS SWITCHED ON. Set SITE_PASSWORD in Render. Unset, there is no
 * gate at all, which is what local development and the tests want. Taking it
 * off for launch is deleting that one variable; nothing in the code changes.
 *
 * WHAT A VISITOR SEES. Every page and every API answer is replaced by the
 * coming-soon page (the API gets a 401 instead, so nothing leaks through a
 * direct call). A small form on that page takes the password; the right one
 * sets a cookie for 90 days and sends the visitor on to wherever they were
 * going, so a password-reset link opened in a fresh browser still lands.
 *
 * WHAT STAYS OPEN, and why:
 *  - /unsubscribe. Someone who got a deal email must always be able to stop
 *    them, password or not. It shows nothing about the product.
 *  - /health. A JSON heartbeat with row counts, for uptime checks.
 *  - /robots.txt, which tells search engines to stay out entirely.
 *
 * THE COOKIE holds a hash of the password, never the password itself, so
 * changing SITE_PASSWORD in Render locks out every old cookie at once. That
 * is also how to "revoke" a tester.
 *
 * GUESSING is limited per connection, the same shape as sign-in's lockout:
 * a person mistyping is fine, a script working through a list is not.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const GATE_COOKIE = "pf_site";
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/** Paths anyone may reach while the site is locked. */
const OPEN_PATHS = new Set(["/unsubscribe", "/health", "/robots.txt", "/site-unlock"]);

export function sitePassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = (env.SITE_PASSWORD ?? "").trim();
  return p ? p : null;
}

/** What the cookie holds: a keyed hash of the password. */
export function gateToken(password: string): string {
  // The key keeps the project's old name on purpose: it is never shown, and
  // changing it would sign every tester out.
  return createHmac("sha256", "parkfare-site-gate").update(password).digest("hex");
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function passwordMatches(typed: string, password: string): boolean {
  return sameString(gateToken(typed.trim()), gateToken(password));
}

export function isUnlocked(cookieHeader: string | undefined, password: string): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== GATE_COOKIE) continue;
    if (sameString(part.slice(i + 1).trim(), gateToken(password))) return true;
  }
  return false;
}

export function gateOpenPath(pathname: string): boolean {
  return OPEN_PATHS.has(pathname);
}

export function gateCookieHeader(password: string, secure: boolean): string {
  return `${GATE_COOKIE}=${gateToken(password)}; HttpOnly; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Only a path on this site, never "//elsewhere.com" or a full URL. */
export function safeNext(next: string | undefined | null): string {
  const n = String(next ?? "");
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && !n.startsWith("/site-unlock")
    ? n : "/";
}

/* -------------------------------------------------------------- guessing */

const WINDOW_MS = 15 * 60 * 1000;
export const MAX_TRIES = 10;
const tries = new Map<string, { n: number; since: number }>();

export function gateLocked(ip: string, now = Date.now()): boolean {
  const t = tries.get(ip);
  if (!t || now - t.since > WINDOW_MS) return false;
  return t.n >= MAX_TRIES;
}

export function recordGateFailure(ip: string, now = Date.now()): void {
  const t = tries.get(ip);
  if (!t || now - t.since > WINDOW_MS) tries.set(ip, { n: 1, since: now });
  else t.n++;
}

export function clearGateFailures(ip: string): void {
  tries.delete(ip);
}

/* ------------------------------------------------------------- the page */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The tab icon (public/brand/tab-icon.svg), which is also the logo. Inline:
 *  while the site is locked nothing under /public is served. */
const TAB_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect x="2" y="2" width="60" height="60" rx="14" fill="#16204A"/><ellipse cx="32" cy="32" rx="25" ry="10" transform="rotate(-24 32 32)" fill="none" stroke="#F5EFE0" stroke-width="2.5" stroke-dasharray="3.5 4"/><path d="M32 13L36.56 27.44L51 32L36.56 36.56L32 51L27.44 36.56L13 32L27.44 27.44Z" fill="#E8B23E"/><circle cx="53" cy="22" r="3" fill="#F5EFE0"/></svg>`;

export function comingSoonHtml(opts: { next?: string; error?: string } = {}): string {
  const next = safeNext(opts.next);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Pricing the Magic · Coming Soon</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(TAB_ICON_SVG)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Public+Sans:wght@400;600&display=swap">
<style>
:root{color-scheme:light;--plane:#DFEAEC;--surface:#FBFAF6;--ink:#16204A;--ink-2:#4C5878;--muted:#626D88;
  --rule:#AFC3CA;--cream:#F5EFE0;--gold:#E8B23E;--bad:#9a2a2a}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--plane);color:var(--ink);font:16px/1.5 "Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:440px;text-align:center}
.mark{display:inline-block;width:64px;height:64px}
.name{font-family:"Bricolage Grotesque",system-ui,sans-serif;font-weight:800;font-size:22px;margin:10px 0 0}
h1{font-family:"Bricolage Grotesque",system-ui,sans-serif;font-weight:800;font-size:44px;line-height:1;margin:20px 0 10px;letter-spacing:-.02em}
p.lede{color:var(--ink-2);margin:0 0 36px}
details{border-top:2px solid var(--ink);padding-top:20px;text-align:left}
summary{cursor:pointer;color:var(--muted);font-size:14px;text-align:center;list-style:none}
summary::-webkit-details-marker{display:none}
form{display:flex;gap:8px;margin-top:14px}
input{flex:1;min-width:0;font:inherit;font-size:16px;padding:10px 14px;border-radius:999px;
  border:1.5px solid var(--rule);background:var(--surface);color:var(--ink)}
button{font:inherit;font-weight:600;padding:10px 20px;border-radius:999px;border:1.5px solid var(--ink);
  background:var(--ink);color:var(--cream);cursor:pointer}
.err{color:var(--bad);font-size:14px;margin:10px 0 0;text-align:center}
</style>
</head>
<body>
<main>
  <span class="mark">${TAB_ICON_SVG}</span>
  <p class="name">Pricing the Magic</p>
  <h1>Coming Soon</h1>
  <p class="lede">We're getting ready. Check back soon.</p>
  <details${opts.error ? " open" : ""}>
    <summary>Have the password?</summary>
    <form method="post" action="/site-unlock">
      <input type="hidden" name="next" value="${esc(next)}">
      <input type="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required${opts.error ? " autofocus" : ""}>
      <button type="submit">Enter</button>
    </form>
    ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
  </details>
</main>
</body>
</html>`;
}
