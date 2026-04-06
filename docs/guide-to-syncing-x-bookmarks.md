# Guide to Syncing X/Twitter Bookmarks on Windows

This is a fork of [fieldtheory-cli](https://github.com/afar1/fieldtheory-cli) with Windows support. The upstream version only works on macOS.

## Quick Start

```bash
npm install -g .    # or run directly with: node bin/ft.mjs
ft sync             # syncs all your X bookmarks locally
ft search "topic"   # full-text search
ft stats            # top authors, languages, date range
ft viz              # terminal dashboard
```

## How It Works

### macOS

On Mac, the tool reads Chrome's cookie database directly. Chrome stores cookies encrypted with a key from the macOS Keychain, and the tool decrypts them using the `security` CLI. This works while Chrome is running because macOS uses shared file locks.

### Windows

Windows is harder. Chrome 127+ introduced **App-Bound Encryption** (v20), which encrypts cookies with a key managed by a Windows system service. This key cannot be accessed by normal user-mode programs. Chrome also holds an **exclusive file lock** on the Cookies database, preventing any other process from reading or even copying the file while Chrome is running.

To work around both of these, the Windows version uses **Chrome DevTools Protocol (CDP)**. Instead of reading the cookie file, it connects to a running Chrome instance and asks Chrome to hand over the decrypted cookies directly via the `Network.getAllCookies` command.

#### The 8.3 short path trick

Chrome 146 blocks `--remote-debugging-port` when launched with the default user data directory. It does this by comparing the `--user-data-dir` path string against the known default location. However, Windows supports legacy 8.3 short file names (e.g., `User Data` → `USERDA~1`). By passing the short path, the string comparison fails and Chrome allows the debug port.

The tool automates this — when you run `ft sync`, it:

1. Checks if Chrome is already running with a debug port on 9222
2. If not, finds the Chrome executable and the 8.3 short path for your user data directory
3. Launches Chrome with `--remote-debugging-port=9222 --user-data-dir=<short-path>`
4. Connects via WebSocket, sends `Network.getAllCookies`
5. Filters for `ct0` and `auth_token` cookies from `.x.com`
6. Uses those cookies to authenticate with X's GraphQL Bookmarks API
7. Downloads all your bookmarks into `~/.ft-bookmarks/`

## Prerequisites

- **Node.js 20+**
- **Google Chrome** installed
- **Logged into x.com** in Chrome
- **Chrome must be closed** before running `ft sync` for the first time (the tool will relaunch it with the debug flag)

## Usage

### First sync

```bash
# Close Chrome first, then:
ft sync
```

The tool will launch Chrome automatically with remote debugging enabled. Your first sync downloads your entire bookmark history — this can take a few minutes depending on how many you have.

### Subsequent syncs

```bash
ft sync
```

Incremental by default — only fetches new bookmarks since the last sync. If Chrome is already running with the debug port (from a previous sync), the tool connects to it directly.

### Full re-sync

```bash
ft sync --full
```

Re-crawls your entire bookmark history instead of stopping at the last known bookmark.

### Search

```bash
ft search "machine learning"           # full-text search (BM25 ranking)
ft search "react" --author karpathy    # filter by author
ft search "tools" --after 2025-01-01   # filter by date
```

### Explore

```bash
ft stats          # top authors, languages, date range
ft viz            # terminal dashboard with sparklines
ft categories     # category distribution
ft domains        # subject domain distribution
ft list           # browse with filters (--author, --category, --domain, --after, --before)
ft show <id>      # full detail for one bookmark
```

### Classify with LLM

Requires `claude` or `codex` CLI installed and authenticated:

```bash
ft classify              # classify by category + domain using LLM
ft classify --regex      # fast regex-based category classification (no LLM)
ft sync --classify       # sync then classify new bookmarks in one step
```

## Data Storage

All data stays local at `~/.ft-bookmarks/`:

```
~/.ft-bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one JSON object per line)
  bookmarks.db            # SQLite FTS5 search index
  bookmarks-meta.json     # sync metadata
  bookmarks-backfill-state.json  # sync state tracking
```

Override with `FT_DATA_DIR`:

```bash
export FT_DATA_DIR=/path/to/custom/dir
```

## Troubleshooting

### "Could not connect to Chrome on port 9222"

Chrome isn't running with remote debugging. Close Chrome completely (check the system tray — Chrome often runs in the background), then run `ft sync` again. The tool will relaunch Chrome with the debug flag.

If that doesn't work, launch Chrome manually:

```powershell
& "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Then run `ft sync` in another terminal.

### "No ct0 CSRF cookie found for x.com"

You're not logged into X in Chrome. Open https://x.com, log in, then retry.

### Chrome opens but sync still fails

Make sure you don't have another Chrome instance running. The debug port can only be used by one Chrome instance at a time. Check Task Manager for lingering `chrome.exe` processes.

### Multiple Chrome profiles

The tool uses the Default profile. If your X login is in a different profile:

```bash
ft sync --chrome-profile-directory "Profile 1"
```

Check which profile has your X login:

```powershell
# Lists email associated with each profile
foreach ($dir in "Default","Profile 1","Profile 2","Profile 3") {
  $prefs = "$env:LOCALAPPDATA\Google\Chrome\User Data\$dir\Preferences"
  if (Test-Path $prefs) {
    $email = (Get-Content $prefs | ConvertFrom-Json).account_info[0].email
    Write-Output "$dir -> $email"
  }
}
```

## What Didn't Work (and Why)

For anyone curious about the Chrome security landscape on Windows in 2025-2026:

| Approach | Why it fails |
|----------|-------------|
| Read Cookies DB with Chrome open | Chrome holds `FILE_SHARE_NONE` exclusive lock. No user-mode process can read or copy the file. |
| DPAPI decryption of v10 cookies | Chrome 127+ uses v20 App-Bound Encryption. The DPAPI key from `Local State` only works for v10 cookies, which no longer exist. |
| v20 App-Bound decryption | Requires SYSTEM-level DPAPI access via a Windows service. Not feasible for a CLI tool. |
| Headless Chrome with real user-data-dir | Chrome blocks `--remote-debugging-port` on the default data dir path (string comparison). |
| Symlink/junction to real profile | **Destructive.** Chrome treats it as a new session, resets all cookies, logs you out of every website. Never do this. |

The CDP + 8.3 short path approach is the only method that works without admin privileges, without killing Chrome, and without destroying user data.
