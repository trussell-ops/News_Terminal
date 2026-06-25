# 📰 Personal News Terminal

A zero-maintenance, self-updating **"Bloomberg Terminal"-style** news dashboard.

- **100% free** — no servers, no database, no paid APIs, no API keys.
- **Auto-refreshing** — a GitHub Action fetches RSS feeds on a schedule and
  commits an updated `data.json`; GitHub Pages serves the static site.
- **Resilient** — any dead/blocked/malformed feed is skipped, not fatal; a
  category that fails entirely keeps its previous data instead of going blank.

```
GitHub Actions (fetch + build)  →  commits data.json  →  GitHub Pages (static)
```

---

## How it works

| Piece | Role |
|-------|------|
| `index.html` | Static front-end. Fetches `data.json?t=<timestamp>` at runtime (cache-busted), renders three responsive columns, live search, manual + auto refresh. No build step. |
| `scripts/fetch-feeds.js` | Node script. Fetches each feed with a real User-Agent + 10s timeout, normalizes RSS/Atom/RDF, strips HTML, writes `data.json` **only when content changed**. |
| `.github/workflows/update-news.yml` | Runs the script every 30 min (and on demand), commits `data.json` only if it changed, uses `concurrency` to avoid overlapping runs. |
| `data.json` | The data the page renders. Seeded with sample items so the site works on first load. |

---

## 🚀 Deploy (first push, no code edits needed)

1. **Create a GitHub repo** and push these files to the `main` branch.
2. **Enable Pages:** repo **Settings → Pages → Build and deployment →
   Source: _Deploy from a branch_ → Branch: `main` / `(root)` → Save.**
3. **Allow the Action to commit:** **Settings → Actions → General →
   Workflow permissions → _Read and write permissions_ → Save.**
   (The workflow also declares `permissions: contents: write`.)
4. Your site is live at `https://<user>.github.io/<repo>/`.
   It renders immediately from the seed `data.json`.
5. **Trigger the first refresh:** **Actions → _Update News Data_ → _Run
   workflow_** (or just wait for the 30-minute schedule). It will replace the
   seed data with live headlines and commit only if something changed.

> The schedule runs every 30 minutes. GitHub may delay scheduled runs under
> load — that's normal and harmless here.

---

## 🖥️ Run locally

```bash
npm install
npm start          # fetches live data, then serves at http://localhost:8080
```

Other scripts:

```bash
npm run fetch      # just rebuild data.json from live feeds
npm run serve      # just serve the current files (no fetch)
npm test           # sanity-check that data.json is valid
```

> **Opening `index.html` directly (`file://`)?** The page chrome renders, but
> Chrome blocks `fetch()` of local files, so the data won't load and you'll see
> a banner. Use `npm start` (local server) or GitHub Pages instead — both work.

---

## ➕ Adding / removing feeds

Everything lives in the `FEEDS` config object at the top of
[`scripts/fetch-feeds.js`](scripts/fetch-feeds.js):

```js
const FEEDS = {
  markets: {
    label: "Markets & Business",
    feeds: [
      { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC Business" },
      // add a feed → one line here
    ],
  },
  // ...
};
```

- **Add/remove a feed:** edit one line in that category's `feeds` array.
- **Add a whole new category:** add one entry to `FEEDS` (a `label` + `feeds`).
  The front-end iterates categories straight from `data.json`, so **no HTML
  change is required** — the new column appears automatically.

---

## Reliability notes

- Each feed is wrapped in its own `try/catch`: a timeout, `403`, `404`, or
  malformed XML is logged and skipped. One dead feed never zeroes the board.
- If an entire category returns nothing, the previous items for that category
  are preserved.
- A realistic browser `User-Agent` is sent on every request (many feeds `403`
  a bare fetch), with a 10-second per-feed timeout.
- `data.json` is rewritten only when its content (ignoring the timestamp)
  changes, so the Action makes **no empty commits**.

## Dependencies (pinned)

- [`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser) `4.5.0` — RSS/Atom/RDF parsing.
- [`http-server`](https://www.npmjs.com/package/http-server) `14.1.1` — local preview only (dev dependency; not used in CI).

No other runtime dependencies — fetching uses Node's built-in `fetch` (Node ≥ 18).

## License

MIT — do whatever you like.
