/**
 * Just enough RSS 2.0 parsing to pull title/link/date out of <item> blocks —
 * no XML dependency for one small, well-known feed shape. Not a general
 * parser: tolerant of CDATA and the handful of HTML entities that show up
 * in real Disney-fan-site feed titles, nothing more.
 */
export interface FeedItem { title: string; link: string; pubDate?: string }

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&nbsp;/g, " ");
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  let v = m[1]!.trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1]!.trim();
  return decodeEntities(v);
}

export function parseRssItems(xml: string): FeedItem[] {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    if (!title || !link) continue;
    const pubDate = extractTag(block, "pubDate") || undefined;
    items.push({ title, link, pubDate });
  }
  return items;
}
