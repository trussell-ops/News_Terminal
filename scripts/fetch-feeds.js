"use strict";

/**
 * fetch-feeds.js
 * -----------------------------------------------------------------------------
 * Server-side RSS/Atom fetcher for the personal News Terminal dashboard.
 *
 * Design goals (see README):
 *   - Every feed is wrapped in its own try/catch. ONE dead feed (timeout / 403 /
 *     404 / malformed XML) is logged, skipped, and never crashes the run.
 *   - If an ENTIRE category fails, we KEEP the previous data.json entries for
 *     that category instead of zeroing it out.
 *   - Realistic User-Agent + per-feed timeout (many feeds 403 a bare fetch).
 *   - Handles RSS 2.0, RSS 1.0 (RDF) and Atom in one normalizer.
 *   - Writes data.json ONLY when the content (ignoring the timestamp) changed,
 *     so the GitHub Action never makes empty commits.
 *
 * ADDING A FEED:      add one line to the relevant category's `feeds` array.
 * ADDING A CATEGORY:  add one entry to FEEDS below. The HTML renders it
 *                     automatically — no HTML edit required.
 * -----------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

// ============================ CONFIG — edit here =============================
const FEEDS = {
  markets: {
    label: "Markets & Business",
    feeds: [
      { url: "https://feeds.bbci.co.uk/news/business/rss.xml",          source: "BBC Business" },
      { url: "https://www.cnbc.com/id/10001147/device/rss/rss.html",    source: "CNBC Business" },
    ],
  },
  tech: {
    label: "Tech Developments",
    feeds: [
      { url: "https://news.ycombinator.com/rss",                        source: "Hacker News" },
      { url: "https://feeds.arstechnica.com/arstechnica/index",         source: "Ars Technica" },
      { url: "https://www.theverge.com/rss/index.xml",                  source: "The Verge" },
    ],
  },
  legal: {
    label: "Legal Developments",
    feeds: [
      { url: "https://www.scotusblog.com/feed/",                        source: "SCOTUSblog" },
      { url: "https://abovethelaw.com/feed/",                           source: "Above the Law" },
    ],
  },
};

const MAX_ITEMS_PER_CATEGORY = 24;
const FEED_TIMEOUT_MS = 10_000;
const SNIPPET_LENGTH = 240;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 PersonalNewsTerminal/1.0";
// ============================================================================

const OUT_PATH = path.join(__dirname, "..", "data.json");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  processEntities: true,
});

// ----------------------------- text helpers --------------------------------
function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && node["#text"] != null) return String(node["#text"]);
  return "";
}

function stripHtml(input) {
  return String(input || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x?\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(str, n) {
  if (str.length <= n) return str;
  return str.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

// --------------------------- field extractors ------------------------------
function extractLink(item) {
  if (item.link) {
    if (typeof item.link === "string") return item.link.trim();
    if (Array.isArray(item.link)) {
      const alt =
        item.link.find((l) => l && l["@_rel"] === "alternate") ||
        item.link.find((l) => l && l["@_href"]);
      if (alt) return (alt["@_href"] || textOf(alt)).trim();
    }
    if (typeof item.link === "object") return (item.link["@_href"] || textOf(item.link)).trim();
  }
  const guid = textOf(item.guid);
  if (/^https?:\/\//i.test(guid)) return guid.trim();
  const id = textOf(item.id);
  if (/^https?:\/\//i.test(id)) return id.trim();
  return "";
}

function extractDate(item) {
  const raw = textOf(item.pubDate || item.published || item.updated || item["dc:date"] || "");
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractSnippet(item) {
  const raw =
    item.description || item.summary || item["content:encoded"] || item.content || "";
  const text = typeof raw === "string" ? raw : textOf(raw) || textOf(raw["#text"]);
  return truncate(stripHtml(text), SNIPPET_LENGTH);
}

// --------------------------- feed -> items ---------------------------------
function parseFeed(xml, source, category) {
  const tree = parser.parse(xml);

  let rawItems = [];
  if (tree.rss && tree.rss.channel) {
    rawItems = tree.rss.channel.item || [];                 // RSS 2.0
  } else if (tree.feed) {
    rawItems = tree.feed.entry || [];                       // Atom
  } else if (tree["rdf:RDF"]) {
    rawItems = tree["rdf:RDF"].item || [];                  // RSS 1.0 / RDF
  }
  if (!Array.isArray(rawItems)) rawItems = [rawItems];

  return rawItems
    .map((it) => ({
      title: stripHtml(textOf(it.title)) || "(untitled)",
      link: extractLink(it),
      source,
      category,
      snippet: extractSnippet(it),
      published: extractDate(it),
    }))
    .filter((x) => x.link);
}

// --------------------------- network ---------------------------------------
async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------- main ------------------------------------------
function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch {
    return { categories: {} };
  }
}

async function main() {
  const previous = loadPrevious();
  const categories = {};

  for (const [key, cfg] of Object.entries(FEEDS)) {
    const collected = [];

    for (const feed of cfg.feeds) {
      try {
        const xml = await fetchFeed(feed.url);
        const items = parseFeed(xml, feed.source, key);
        if (items.length) {
          collected.push(...items);
          console.log(`  ✓ ${feed.source}: ${items.length} items  [${key}]`);
        } else {
          console.warn(`  ! ${feed.source}: parsed 0 items  [${key}]`);
        }
      } catch (err) {
        // A single failing feed is logged and skipped — never fatal.
        console.warn(`  ✗ ${feed.source}: ${err.message}  [${key}]`);
      }
    }

    let items;
    if (collected.length === 0) {
      // Whole category failed → preserve whatever we had last time.
      const prev =
        (previous.categories && previous.categories[key] && previous.categories[key].items) || [];
      console.warn(`  → "${key}" had no live items; keeping ${prev.length} previous item(s).`);
      items = prev;
    } else {
      const seen = new Set();
      items = collected
        .filter((i) => i.link && !seen.has(i.link) && seen.add(i.link))
        .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
        .slice(0, MAX_ITEMS_PER_CATEGORY);
    }

    categories[key] = { label: cfg.label, items };
  }

  const output = { updated: new Date().toISOString(), categories };
  const newStr = JSON.stringify(output, null, 2);

  // Diff ignoring the "updated" timestamp so unchanged content == no rewrite
  // == no git diff == no empty commit.
  const stripTs = (s) => s.replace(/"updated":\s*"[^"]*",?\s*/, "");
  let oldStr = "";
  try {
    oldStr = fs.readFileSync(OUT_PATH, "utf8");
  } catch {}

  if (stripTs(oldStr).trim() === stripTs(newStr).trim()) {
    console.log("\nNo content change — data.json left untouched.");
    return;
  }

  fs.writeFileSync(OUT_PATH, newStr + "\n");
  console.log("\ndata.json updated.");
}

main().catch((err) => {
  // Only truly fatal problems (e.g. cannot write the file) reach here.
  console.error("FATAL:", err);
  process.exit(1);
});
