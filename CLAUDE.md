# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Field Theory CLI — syncs X/Twitter bookmarks locally into SQLite, with full-text search, LLM classification, and terminal dashboards. Fork of [afar1/fieldtheory-cli](https://github.com/afar1/fieldtheory-cli) with Windows support via Chrome DevTools Protocol.

## Commands

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run via tsx directly
npm test             # Run tests (tsx --test)
npm run start        # Run compiled dist/cli.js
```

Run a single test:
```bash
npx tsx --test tests/chrome-cookies.test.ts
```

## Architecture

Single CLI application built with Commander.js. All data stored in `~/.ft-bookmarks/`.

### Key files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Command definitions, progress rendering, first-run UX |
| `src/chrome-cookies.ts` | Cookie extraction — macOS via Keychain, Windows via CDP (Chrome DevTools Protocol) |
| `src/graphql-bookmarks.ts` | GraphQL sync engine, bookmark parsing, merge logic |
| `src/bookmarks-db.ts` | SQLite FTS5 index, search, list, stats, classify |
| `src/bookmark-classify-llm.ts` | LLM classifier (shells out to `claude -p` or `codex exec`) |
| `src/bookmark-classify.ts` | Regex-based category classifier |
| `src/bookmarks-viz.ts` | ANSI terminal dashboard |
| `src/xauth.ts` | OAuth 2.0 PKCE flow for API-based sync |
| `src/db.ts` | WASM SQLite layer (sql.js-fts5) |
| `src/config.ts` | Chrome path detection, env loading |
| `src/paths.ts` | Data directory resolution |

### Windows cookie extraction (CDP approach)

`chrome-cookies.ts` on Windows uses Chrome DevTools Protocol instead of file-based decryption:

1. Checks if Chrome is running with `--remote-debugging-port=9222`
2. If not, finds Chrome exe, gets the 8.3 short path for the user data dir (bypasses Chrome's debug port restriction), launches Chrome
3. Connects via WebSocket, sends `Network.getAllCookies`
4. Filters for `ct0` and `auth_token` from `.x.com`

The file also contains the macOS Keychain path (AES-128-CBC) and a now-unused Windows DPAPI path (AES-256-GCM) that only works on older Chrome versions.

### Visualizer

| File | Purpose |
|------|---------|
| `scripts/extract-viz-data.mjs` | Queries SQLite DB, outputs aggregated stats as JSON |
| `scripts/build-viz.mjs` | Injects JSON into HTML template |
| `viz/template.html` | Single-file HTML visualizer (CSS + vanilla JS) |
| `viz/you-are-what-you-bookmark.html` | Built output (generated, committed) |
| `viz/data.json` | Extracted stats (generated, gitignored) |

### Data flow

```
Chrome CDP → cookies → GraphQL API → JSONL cache → SQLite FTS5 index
                                          ↓
                              LLM / regex classification
                                          ↓
                              Search / List / Viz / Visualizer
```

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `FT_DATA_DIR` | Override data directory | `~/.ft-bookmarks` |
| `FT_LLM_MODEL` | LLM model for classification | `claude-haiku-4-5-20251001` |
| `FT_CHROME_USER_DATA_DIR` | Chrome user data dir override | Auto-detected |
| `FT_CHROME_PROFILE_DIRECTORY` | Chrome profile name | `Default` |

## Safety Rules

**NEVER modify or link to the user's real Chrome profile.** Do NOT create symlinks, junctions, or filesystem links to Chrome profile directories. Do NOT launch Chrome against a junction/symlink to a real profile. This destroys all session state and logs the user out of every website. Treat Chrome profile directories as read-only.
