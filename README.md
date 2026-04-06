# Field Theory CLI (Windows Fork)

Sync and store all of your X/Twitter bookmarks locally. Search, classify, and make them available to Claude Code, Codex, or any agent with shell access.

Fork of [afar1/fieldtheory-cli](https://github.com/afar1/fieldtheory-cli) with full Windows support.

## Install

```bash
npm install -g .
```

Requires Node.js 20+ and Google Chrome.

## Quick start

```bash
# 1. Sync your bookmarks (needs Chrome logged into X)
ft sync

# 2. Search them
ft search "distributed systems"

# 3. Explore
ft viz
ft categories
ft stats
```

On first run, `ft sync` connects to Chrome via the DevTools Protocol and downloads your bookmarks into `~/.ft-bookmarks/`.

## Platform support

| Feature | macOS | Windows | Linux |
|---------|-------|---------|-------|
| Chrome session sync (`ft sync`) | Yes (Keychain) | Yes (CDP) | No* |
| OAuth API sync (`ft sync --api`) | Yes | Yes | Yes |
| Search, classify, viz | Yes | Yes | Yes |
| Bookmark visualizer | Yes | Yes | Yes |

\*Linux support could be added via libsecret/GNOME Keyring or CDP. Contributions welcome.

### Windows sync details

On Windows, Chrome 127+ uses App-Bound Encryption which prevents direct cookie file access. This fork uses the **Chrome DevTools Protocol** instead — it connects to a running Chrome instance and asks Chrome for the decrypted cookies directly.

When you run `ft sync`, the tool:
1. Checks if Chrome is running with a debug port
2. If not, launches Chrome with `--remote-debugging-port=9222` (uses the Windows 8.3 short path to bypass Chrome's debug port restriction)
3. Extracts `ct0` and `auth_token` cookies via CDP `Network.getAllCookies`
4. Syncs bookmarks via X's GraphQL API

See [docs/guide-to-syncing-x-bookmarks.md](docs/guide-to-syncing-x-bookmarks.md) for the full Windows guide with troubleshooting.

## Commands

| Command | Description |
|---------|-------------|
| `ft sync` | Download and sync all bookmarks (no API required) |
| `ft sync --classify` | Sync then classify new bookmarks with LLM |
| `ft sync --full` | Full history crawl (not just incremental) |
| `ft search <query>` | Full-text search with BM25 ranking |
| `ft viz` | Terminal dashboard with sparklines, categories, and domains |
| `ft classify` | Classify by category and domain using LLM |
| `ft classify --regex` | Classify by category using simple regex |
| `ft categories` | Show category distribution |
| `ft domains` | Subject domain distribution |
| `ft stats` | Top authors, languages, date range |
| `ft list` | Filter by author, date, category, domain |
| `ft show <id>` | Show one bookmark in detail |
| `ft index` | Merge new bookmarks into search index (preserves classifications) |
| `ft auth` | Set up OAuth for API-based sync (optional) |
| `ft sync --api` | Sync via OAuth API (cross-platform) |
| `ft fetch-media` | Download media assets (static images only) |
| `ft status` | Show sync status and data location |
| `ft path` | Print data directory path |

## Agent integration

Tell your agent to use the `ft` CLI:

> "What have I bookmarked about cancer research in the last three years?"

> "Find all the AI tools I bookmarked and pick the best one for memory management."

> "Sync my X bookmarks every morning."

Works with Claude Code, Codex, or any agent with shell access.

## Bookmark visualizer

Generate an interactive HTML report of your bookmarking patterns:

```bash
node scripts/extract-viz-data.mjs > viz/data.json
node scripts/build-viz.mjs
# Open viz/you-are-what-you-bookmark.html in a browser
```

The visualizer shows domain/category breakdowns, engagement analysis, author loyalty patterns, a timeline, and a personality assessment — styled as a retro terminal intelligence dossier.

## Classification

LLM classification uses `claude -p` (Claude Code CLI) or `codex exec` — whichever is installed. Defaults to Haiku 4.5 for speed. Override with:

```bash
export FT_LLM_MODEL=claude-sonnet-4-6
ft classify
```

Categories: tool, technique, opinion, launch, research, commerce, security, and LLM-generated categories for content that doesn't fit.

Domains: ai, design, media, gaming, startups, hardware, web-dev, finance, health, politics, and more.

## Data

All data stays local at `~/.ft-bookmarks/`:

```
~/.ft-bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one per line)
  bookmarks.db            # SQLite FTS5 search index
  bookmarks-meta.json     # sync metadata
  oauth-token.json        # OAuth token (if using API mode, chmod 600)
```

Override with `FT_DATA_DIR`:

```bash
export FT_DATA_DIR=/path/to/custom/dir
```

## Security

**Your data stays local.** No telemetry, no analytics, nothing phoned home.

**Chrome session sync** connects to Chrome's debug port to read cookies. Cookies are used for the sync request and discarded. On macOS, cookies are read from Chrome's local database via Keychain.

**OAuth tokens** are stored with `chmod 600` (owner-only).

**The default sync uses X's internal GraphQL API**, the same API that x.com uses in your browser.

## Docs

- [Windows sync guide](docs/guide-to-syncing-x-bookmarks.md) — setup, troubleshooting, and security notes

## License

MIT — based on [fieldtheory.dev/cli](https://fieldtheory.dev/cli)
