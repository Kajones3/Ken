import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRssItems } from "./rss.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Example Disney News</title>
  <item>
    <title><![CDATA[Space Mountain Closing at Disneyland Paris]]></title>
    <link>https://example.com/space-mountain-closing</link>
    <pubDate>Mon, 07 Sep 2026 12:00:00 +0000</pubDate>
    <description>Some HTML &amp; entities here</description>
  </item>
  <item>
    <title>It&#8217;s a Small World Refurbishment Announced</title>
    <link>https://example.com/small-world-refurb</link>
    <pubDate>Sun, 06 Sep 2026 08:30:00 +0000</pubDate>
  </item>
  <item>
    <title>No link here, should be skipped</title>
  </item>
</channel>
</rss>`;

test("parseRssItems: pulls title/link/date out of CDATA and plain items", () => {
  const items = parseRssItems(SAMPLE);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "Space Mountain Closing at Disneyland Paris");
  assert.equal(items[0]!.link, "https://example.com/space-mountain-closing");
  assert.ok(items[0]!.pubDate);
});

test("parseRssItems: decodes common HTML entities in plain (non-CDATA) titles", () => {
  const items = parseRssItems(SAMPLE);
  assert.equal(items[1]!.title, "It's a Small World Refurbishment Announced");
});

test("parseRssItems: an item with no link is skipped, not a crash", () => {
  const items = parseRssItems(SAMPLE);
  assert.ok(!items.some((i) => i.title.includes("No link here")));
});

test("parseRssItems: empty or garbage input returns an empty list", () => {
  assert.deepEqual(parseRssItems(""), []);
  assert.deepEqual(parseRssItems("not xml at all"), []);
});
