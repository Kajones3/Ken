// The site's illustration: a dotted world map with a small stylized castle at
// each of the six resorts (owner, 2026-10-07: "the globe with the six dots,
// but ... illustrated castles that are subtle nods to the castles at each
// park"), plus a round badge per castle and the logo mark. Writes plain SVG
// files into public/brand/. The castles are NODS, not copies: shapes and
// colors only, no Disney logos, characters or lettering.
//
// Not part of the build; re-run only to change the art. It needs three map
// packages that are deliberately NOT project dependencies:
//   mkdir /tmp/mapgen && cd /tmp/mapgen && npm i world-atlas@2 topojson-client@3 d3-geo@3
//   node tools/brand/gen.mjs /tmp/mapgen/node_modules public/brand
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const [, , nm, out] = process.argv;
const req = createRequire(nm + "/");
const topo = req("topojson-client");
const d3 = req("d3-geo");
const land = topo.feature(JSON.parse(readFileSync(nm + "/world-atlas/land-110m.json", "utf8")),
  JSON.parse(readFileSync(nm + "/world-atlas/land-110m.json", "utf8")).objects.land);
mkdirSync(out, { recursive: true });

// Crop: lon -135..160, lat 72..-40, equirectangular, 1440 wide.
const LON0 = -135, LON1 = 160, LAT0 = 72, LAT1 = -40, W = 1440;
const H = Math.round(W * (LAT0 - LAT1) / (LON1 - LON0));
const px = (lon, lat) => [((lon - LON0) / (LON1 - LON0)) * W, ((LAT0 - lat) / (LAT0 - LAT1)) * H];

// Land dots.
const STEP = 1.5;
const dots = [];
for (let lat = LAT0 - STEP / 2; lat > LAT1; lat -= STEP) {
  for (let lon = LON0 + STEP / 2; lon < LON1; lon += STEP) {
    if (d3.geoContains(land, [lon, lat])) dots.push(px(lon, lat));
  }
}
const f1 = (n) => Math.round(n * 10) / 10;

// ---------- castles v2 (base center at 0,0; drawn upward) ----------
// Flat shapes with ONE step of shading (lit left, shaded right) so they read
// as 3-D without the photo-like detail. Shapes, not just colors, tell the six
// apart: Shanghai wide with chunky tiered roofs, Tokyo tall needles, Hong Kong
// a pink body with colored spires around a gold center.
const DOOR = "#22305C";
const GOLD = "#E8B23E";
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1)));
  return "#" + c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}
// t: one tower. fin: "flag" | "ball" | "none"
function t(o, x, w, h, roof, rh, wall, L, fin = "flag", tip = GOLD, y0 = 0) {
  const l = x - w / 2, r = x + w / 2, top = y0 - h, apex = top - rh;
  o.push(`<rect x="${f1(l)}" y="${f1(top)}" width="${f1(w)}" height="${f1(h)}" fill="${wall}"${L}/>`);
  o.push(`<rect x="${f1(x)}" y="${f1(top)}" width="${f1(w / 2)}" height="${f1(h)}" fill="${shade(wall, 0.86)}"/>`);
  o.push(`<polygon points="${f1(l - 1.4)},${f1(top)} ${f1(x)},${f1(apex)} ${f1(r + 1.4)},${f1(top)}" fill="${shade(roof, 1.14)}"${L}/>`);
  o.push(`<polygon points="${f1(x)},${f1(apex)} ${f1(r + 1.4)},${f1(top)} ${f1(x)},${f1(top)}" fill="${shade(roof, 0.78)}"/>`);
  o.push(`<rect x="${f1(l - 0.6)}" y="${f1(top)}" width="${f1(w + 1.2)}" height="1.6" fill="${GOLD}"/>`);
  if (fin === "flag") {
    o.push(`<line x1="${f1(x)}" y1="${f1(apex)}" x2="${f1(x)}" y2="${f1(apex - 5)}" stroke="${tip}" stroke-width="1.2"/>`);
    o.push(`<polygon points="${f1(x)},${f1(apex - 5)} ${f1(x + 5)},${f1(apex - 3.6)} ${f1(x)},${f1(apex - 2.2)}" fill="${tip}"/>`);
  } else if (fin === "ball") {
    o.push(`<line x1="${f1(x)}" y1="${f1(apex)}" x2="${f1(x)}" y2="${f1(apex - 3)}" stroke="${tip}" stroke-width="1.2"/><circle cx="${f1(x)}" cy="${f1(apex - 3.6)}" r="1.7" fill="${tip}"/>`);
  }
  if (h - (y0 ? 0 : 0) > 16 && w >= 6) {
    const ww = Math.max(2, w * 0.3), wy = top + Math.min(h * 0.3, 10);
    o.push(`<path d="M${f1(x - ww / 2)},${f1(wy + 5)} v-3 a${f1(ww / 2)},${f1(ww / 2)} 0 0 1 ${f1(ww)},0 v3 z" fill="${DOOR}" opacity=".8"/>`);
  }
}
function base(o, x0, x1, h, wall, L, y0 = 0) {
  o.push(`<rect x="${x0}" y="${y0 - h}" width="${x1 - x0}" height="${h}" fill="${wall}"${L}/>`);
  o.push(`<rect x="${(x0 + x1) / 2}" y="${y0 - h}" width="${(x1 - x0) / 2}" height="${h}" fill="${shade(wall, 0.9)}"/>`);
  o.push(`<rect x="${x0}" y="${y0 - h}" width="${x1 - x0}" height="2" fill="${GOLD}"/>`);
  for (let x = x0 + 2; x < x1 - 2; x += 6) o.push(`<rect x="${x}" y="${y0 - h - 2.5}" width="3" height="2.5" fill="${x < (x0 + x1) / 2 ? wall : shade(wall, 0.9)}"/>`);
}
const door = (o) => o.push(`<path d="M-5,0 v-8 a5,5 0 0 1 10,0 v8 z" fill="${DOOR}"/>`);
const CASTLES = {
  wdw: { label: "Orlando", draw(o, L) {            // tall, slim, royal blue, gold
    const wall = "#F5EFE0", roof = "#3F6FD1";
    base(o, -34, 34, 22, wall, L);
    t(o, -30, 10, 30, roof, 14, wall, L); t(o, 30, 10, 30, roof, 14, wall, L);
    t(o, -14, 9, 46, roof, 18, wall, L); t(o, 14, 9, 46, roof, 18, wall, L);
    base(o, -22, 22, 14, wall, L, -22);
    t(o, -7, 5, 52, roof, 12, wall, L); t(o, 7, 5, 52, roof, 12, wall, L);
    t(o, 0, 12, 64, roof, 32, wall, L);
    door(o);
  } },
  tdr: { label: "Tokyo", draw(o, L) {               // taller and thinner: a cluster of needle spires
    const wall = "#F1E6D2", roof = "#2E50B8";
    base(o, -30, 30, 22, wall, L);
    t(o, -27, 7, 28, roof, 16, wall, L); t(o, 27, 7, 28, roof, 16, wall, L);
    t(o, -19, 6, 40, roof, 20, wall, L); t(o, 19, 6, 40, roof, 20, wall, L);
    t(o, -11, 6, 50, roof, 24, wall, L); t(o, 11, 6, 50, roof, 24, wall, L);
    t(o, -5, 5, 58, roof, 18, wall, L, "none"); t(o, 5, 5, 58, roof, 18, wall, L, "none");
    t(o, 0, 9, 68, roof, 36, wall, L);
    door(o);
  } },
  dlr: { label: "Anaheim", draw(o, L) {             // small, pink, cozy
    const wall = "#F2A9C4", roof = "#6FA8E8";
    base(o, -26, 26, 18, wall, L);
    t(o, -23, 8, 22, roof, 10, wall, L); t(o, 23, 8, 22, roof, 10, wall, L);
    t(o, -11, 7, 30, roof, 13, wall, L); t(o, 11, 7, 30, roof, 13, wall, L);
    t(o, 0, 10, 36, roof, 18, wall, L);
    door(o);
  } },
  dlp: { label: "Paris", draw(o, L) {               // pink, many very pointed spires
    const wall = "#EE9DBB", roof = "#4E8FE0";
    base(o, -32, 32, 18, wall, L);
    t(o, -31, 7, 18, roof, 11, wall, L); t(o, 31, 7, 18, roof, 11, wall, L);
    t(o, -23, 6, 26, roof, 16, wall, L); t(o, 23, 6, 26, roof, 16, wall, L);
    t(o, -15, 6, 34, roof, 20, wall, L); t(o, 15, 6, 34, roof, 20, wall, L);
    t(o, -7, 6, 42, roof, 24, wall, L); t(o, 7, 6, 42, roof, 24, wall, L);
    t(o, 0, 9, 52, roof, 38, wall, L);
    door(o);
  } },
  shdr: { label: "Shanghai", draw(o, L) {           // widest; chunky, tiered blue roofs; gold balls
    const wall = "#F8F6EF", roof = "#3561C4";
    base(o, -52, 52, 22, wall, L);
    t(o, -48, 10, 28, roof, 9, wall, L, "ball"); t(o, 48, 10, 28, roof, 9, wall, L, "ball");
    t(o, -38, 12, 38, roof, 11, wall, L, "ball"); t(o, 38, 12, 38, roof, 11, wall, L, "ball");
    base(o, -30, 30, 18, wall, L, -22);
    t(o, -26, 12, 50, roof, 12, wall, L, "ball"); t(o, 26, 12, 50, roof, 12, wall, L, "ball");
    t(o, -15, 14, 54, roof, 9, wall, L, "none"); t(o, 15, 14, 54, roof, 9, wall, L, "none");
    t(o, -15, 8, 10, roof, 12, wall, L, "ball", GOLD, -63); t(o, 15, 8, 10, roof, 12, wall, L, "ball", GOLD, -63);
    t(o, 0, 22, 60, roof, 10, wall, L, "none");
    t(o, 0, 14, 14, roof, 10, wall, L, "none", GOLD, -70);
    t(o, 0, 8, 10, roof, 16, wall, L, "ball", GOLD, -94);
    door(o);
  } },
  hkdl: { label: "Hong Kong", draw(o, L) {          // blush-pink body, colored spires, gold center
    const wall = "#F5CFC6";
    base(o, -38, 38, 22, wall, L);
    t(o, -35, 8, 24, "#F08A5D", 11, wall, L, "ball"); t(o, 35, 8, 24, "#7CC47F", 11, wall, L, "ball");
    t(o, -24, 9, 34, "#8D6BD8", 15, wall, L, "ball"); t(o, 24, 9, 34, "#4E8FE0", 15, wall, L, "ball");
    t(o, -13, 9, 46, "#E98BB0", 19, wall, L, "ball"); t(o, 13, 9, 46, "#3FB6A8", 19, wall, L, "ball");
    t(o, 0, 14, 56, GOLD, 12, wall, L, "none");
    t(o, 0, 9, 12, GOLD, 22, wall, L, "ball", "#E98BB0", -68);
    door(o);
  } },
};
function castle(id, line) {
  const o = [];
  const L = line ? ` stroke="${line}" stroke-width="1" stroke-linejoin="round"` : "";
  CASTLES[id].draw(o, L);
  return o.join("");
}

// Resorts: true location, and where the castle sits (offset so Asia's three don't collide).
const RES = [
  { id: "dlr", lon: -117.92, lat: 33.81, dx: 0, dy: -10 },
  { id: "wdw", lon: -81.56, lat: 28.39, dx: 0, dy: -10 },
  { id: "dlp", lon: 2.78, lat: 48.87, dx: 0, dy: -10 },
  { id: "shdr", lon: 121.66, lat: 31.14, dx: -22, dy: -22 },
  { id: "tdr", lon: 139.88, lat: 35.63, dx: 26, dy: -24 },
  { id: "hkdl", lon: 114.04, lat: 22.31, dx: -86, dy: 96 },
];

function map({ dot, label, pin, route, line, scale = 1, focus = null, labels = true }) {
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`];
  // One path of zero-length round-capped strokes: a quarter of the bytes of 6,000 <circle>s.
  o.push(`<path d="${dots.map(([x, y]) => `M${f1(x)} ${f1(y)}h0`).join("")}" stroke="${dot}" stroke-width="3.8" stroke-linecap="round"/>`);
  const P = Object.fromEntries(RES.map((r) => [r.id, px(r.lon, r.lat)]));
  // a dotted route around the world
  const seq = ["dlr", "wdw", "dlp", "shdr", "tdr"];
  let d = `M${f1(P.dlr[0])},${f1(P.dlr[1])}`;
  for (let i = 1; i < seq.length; i++) {
    const [ax, ay] = P[seq[i - 1]], [bx, by] = P[seq[i]];
    const cx = (ax + bx) / 2, cy = Math.min(ay, by) - Math.abs(bx - ax) * 0.18;
    d += ` Q${f1(cx)},${f1(cy)} ${f1(bx)},${f1(by)}`;
  }
  const [hx, hy] = P.hkdl, [sx, sy] = P.shdr;
  d += ` M${f1(sx)},${f1(sy)} Q${f1(sx - 30)},${f1((sy + hy) / 2)} ${f1(hx)},${f1(hy)}`;
  o.push(`<path d="${d}" fill="none" stroke="${route}" stroke-width="1.6" stroke-dasharray="2 6" stroke-linecap="round"/>`);
  for (const r of RES) {
    const [x, y] = P[r.id];
    const cx = x + r.dx, cy = y + r.dy;
    const dim = focus && focus !== r.id;
    const s = focus === r.id ? scale * 1.35 : scale;
    o.push(`<g opacity="${dim ? 0.35 : 1}">`);
    if (Math.hypot(r.dx, r.dy) > 30) o.push(`<line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(cx)}" y2="${f1(cy - 2)}" stroke="${route}" stroke-width="1.2" stroke-dasharray="2 3"/>`);
    o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="7" fill="${pin}" opacity=".28"/><circle cx="${f1(x)}" cy="${f1(y)}" r="3.2" fill="${pin}"/>`);
    o.push(`<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(40 * s)}" ry="${f1(4.5 * s)}" fill="#000" opacity=".18"/>`);
    o.push(`<g transform="translate(${f1(cx)},${f1(cy)}) scale(${s})">${castle(r.id, line)}</g>`);
    // Label under the pin, or under the castle when it sits away from its pin.
    const away = Math.hypot(r.dx, r.dy) > 30;
    const lx = away ? cx : x, ly = away ? cy + 17 * s : y + 21;
    if (labels) o.push(`<text x="${f1(lx)}" y="${f1(ly)}" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-size="${f1(11.5 * Math.max(1, s * 0.85))}" font-weight="700" letter-spacing="1.4" fill="${label}">${CASTLES[r.id].label.toUpperCase()}</text>`);
    o.push(`</g>`);
  }
  o.push(`</svg>`);
  return o.join("");
}

writeFileSync(`${out}/map-dark.svg`, map({ dot: "#26325E", label: "#AEB9DA", pin: GOLD, route: "#E8B23E99", line: null }));
writeFileSync(`${out}/map-light.svg`, map({ dot: "#CBD7EC", label: "#3A4670", pin: "#C98A12", route: "#C98A12AA", line: "#2B3A67" }));
// The PDF cover: the chosen resort's castle larger, the other five faded.
for (const r of RES) {
  writeFileSync(`${out}/map-cover-${r.id}.svg`, map({ dot: "#D5DFEF", label: "#3A4670", pin: "#C98A12", route: "#C98A1288", line: "#2B3A67", focus: r.id }));
}

// Badges: one castle in a navy circle (works on light and dark), each castle
// scaled to fit: [width, height to the top of its flag].
const SIZE = { dlr: [56, 60], wdw: [72, 102], dlp: [72, 96], shdr: [108, 126], tdr: [64, 110], hkdl: [80, 108] };
for (const id of Object.keys(CASTLES)) {
  writeFileSync(`${out}/badge-${id}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">` +
    `<circle cx="60" cy="60" r="58" fill="#16204A"/><circle cx="60" cy="60" r="58" fill="none" stroke="${GOLD}" stroke-width="2.5"/>` +
    `<g fill="#26325E">${[[20, 92], [30, 98], [44, 102], [76, 102], [90, 98], [100, 92]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2"/>`).join("")}</g>` +
    `<g transform="translate(60,94) scale(${f1(Math.min(1.1, 76 / SIZE[id][1], 92 / SIZE[id][0]) * 100) / 100})">${castle(id, null)}</g></svg>`);
}

// The mark: a simple three-spire castle on a price tag (tab icon / app icon).
const mark = (bg, fg, gold) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
  `<rect x="2" y="2" width="60" height="60" rx="14" fill="${bg}"/>` +
  `<path d="M14 50 V33 h5 v-6 l3.5 -9 l3.5 9 v6 h12 v-6 l3.5 -9 l3.5 9 v6 h5 V50 Z" fill="${fg}"/>` +
  `<path d="M27.5 33 V22 l4.5 -12 l4.5 12 V33 Z" fill="${fg}"/>` +
  `<circle cx="32" cy="8.5" r="2.6" fill="${gold}"/>` +
  `<path d="M28 50 v-7 a4 4 0 0 1 8 0 v7 Z" fill="${bg}"/>` +
  `<rect x="14" y="52.5" width="36" height="3" rx="1.5" fill="${gold}"/></svg>`;
writeFileSync(`${out}/mark.svg`, mark("#16204A", "#F5EFE0", GOLD));
console.log(`map ${W}x${H}, ${dots.length} dots`);
