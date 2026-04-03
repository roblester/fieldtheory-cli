# Field Theory CLI

Self-custody for your X/Twitter bookmarks. Sync them locally, search with full-text, classify into categories, and point an AI agent at them.

Your bookmarks stay on your machine. No account required. Free and open source.

## Install

```bash
npm install -g ft-bookmarks
```

Requires Node.js 20+.

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

On first run, `ft sync` extracts your X session from Chrome and downloads your bookmarks into `~/.ft-bookmarks/`. It auto-classifies them into 7 categories (tool, security, technique, launch, research, opinion, commerce) using fast regex matching.

## Commands

| Command | Description |
|---------|-------------|
| `ft sync` | Sync bookmarks via Chrome session |
| `ft sync --api` | Sync via OAuth API (cross-platform) |
| `ft search <query>` | Full-text search (FTS5 with BM25 ranking) |
| `ft list` | List with filters (author, date, category, domain) |
| `ft show <id>` | Show one bookmark in detail |
| `ft stats` | Aggregate statistics |
| `ft viz` | ANSI terminal dashboard with sparklines and heatmaps |
| `ft classify` | Regex classification (instant, free) |
| `ft classify --deep` | LLM classification (needs `claude` or `codex` in PATH) |
| `ft classify-domains` | LLM domain classification (ai, finance, devops, etc.) |
| `ft categories` | Show category distribution |
| `ft domains` | Show domain distribution |
| `ft index` | Rebuild the SQLite search index |
| `ft auth` | Set up OAuth for API-based sync |
| `ft status` | Show sync status and data location |
| `ft path` | Print data directory path |
| `ft sample <category>` | Sample bookmarks by category |
| `ft fetch-media` | Download media assets |

## Agent integration

The CLI is designed to work with AI agents. Add these tools to your agent's system prompt or `CLAUDE.md`:

```
Use the ft CLI to query the user's X bookmarks:
  - ft search <query>     — full-text search
  - ft list --category X  — list by category
  - ft categories         — see all categories
  - ft stats              — aggregate statistics
```

**Fun prompt to try:**

> "Take my oldest and newest bookmarks and tell me how my interests have changed over time."

Works with Claude Code, Codex, or any agent with shell access.

## Scheduling

Sync daily with crontab:

```bash
# Sync every morning at 7am
0 7 * * * ft sync
```

For API-based sync (no Chrome needed), set up OAuth first:

```bash
ft auth          # one-time OAuth setup
ft sync --api    # uses API token, works headlessly
```

## Data

All data is stored locally at `~/.ft-bookmarks/`:

```
~/.ft-bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one per line)
  bookmarks.db            # SQLite FTS5 search index
  bookmarks-meta.json     # sync metadata
  oauth-token.json        # OAuth token (if using API mode)
```

Override the location with `FT_DATA_DIR`:

```bash
export FT_DATA_DIR=/path/to/custom/dir
```

## Categories

The regex classifier sorts bookmarks into 7 categories:

- **tool** — GitHub repos, CLI tools, npm packages, open-source projects
- **security** — CVEs, vulnerabilities, exploits, supply chain
- **technique** — Tutorials, demos, code patterns, "how I built X"
- **launch** — Product launches, announcements, "just shipped"
- **research** — ArXiv papers, studies, academic findings
- **opinion** — Takes, analysis, commentary, threads
- **commerce** — Products, shopping, physical goods

Use `ft classify --deep` for LLM-powered classification that catches what regex misses.

## Platform support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Chrome session sync (`ft sync`) | Yes | No* | No* |
| OAuth API sync (`ft sync --api`) | Yes | Yes | Yes |
| Search, list, classify, viz | Yes | Yes | Yes |

\*Chrome session extraction uses macOS Keychain. On other platforms, use `ft auth` + `ft sync --api`.

## License

MIT
