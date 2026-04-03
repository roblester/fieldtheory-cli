#!/usr/bin/env node
import { Command } from 'commander';
import { syncTwitterBookmarks } from './bookmarks.js';
import { getBookmarkStatusView, formatBookmarkStatus } from './bookmarks-service.js';
import { runTwitterOAuthFlow } from './xauth.js';
import { syncBookmarksGraphQL } from './graphql-bookmarks.js';
import type { SyncProgress } from './graphql-bookmarks.js';
import { fetchBookmarkMediaBatch } from './bookmark-media.js';
import {
  buildIndex,
  searchBookmarks,
  formatSearchResults,
  getStats,
  classifyAndRebuild,
  getCategoryCounts,
  sampleByCategory,
  getDomainCounts,
  listBookmarks,
  getBookmarkById,
} from './bookmarks-db.js';
import { formatClassificationSummary } from './bookmark-classify.js';
import { classifyWithLlm, classifyDomainsWithLlm } from './bookmark-classify-llm.js';
import { renderViz } from './bookmarks-viz.js';
import { dataDir, ensureDataDir, isFirstRun } from './paths.js';

// ── Progress rendering ──────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIdx = 0;

function renderProgress(status: SyncProgress, startTime: number): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const spin = SPINNER[spinnerIdx++ % SPINNER.length];
  const line = `  ${spin} Syncing bookmarks...  ${status.newAdded} new  \u2502  page ${status.page}  \u2502  ${elapsed}s`;
  process.stderr.write(`\r\x1b[K${line}`);
}

const FRIENDLY_STOP_REASONS: Record<string, string> = {
  'caught up to newest stored bookmark': 'All caught up \u2014 no new bookmarks since last sync.',
  'no new bookmarks (stale)': 'Sync complete \u2014 reached the end of new bookmarks.',
  'end of bookmarks': 'Sync complete \u2014 all bookmarks fetched.',
  'max runtime reached': 'Paused after 30 minutes. Run again to continue.',
  'max pages reached': 'Paused after reaching page limit. Run again to continue.',
  'target additions reached': 'Reached target bookmark count.',
};

function friendlyStopReason(raw?: string): string {
  if (!raw) return 'Sync complete.';
  return FRIENDLY_STOP_REASONS[raw] ?? `Sync complete \u2014 ${raw}`;
}

// ── First-run welcome ───────────────────────────────────────────────────────

function showWelcome(): void {
  process.stderr.write(`
  Field Theory CLI \u2014 self-custody for your bookmarks.

  This tool syncs your X/Twitter bookmarks to a local
  SQLite database on your machine. Your data never leaves
  your computer.

  Requirements:
    \u2022 Google Chrome with an active X login

  Data will be stored at: ${dataDir()}

`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function buildCli() {
  const program = new Command();

  async function rebuildAndClassify(added: number): Promise<void> {
    if (added <= 0) return;
    process.stderr.write('  Indexing and classifying...\n');
    const idx = await classifyAndRebuild();
    process.stderr.write(`  \u2713 ${idx.recordCount} bookmarks indexed, ${Object.keys(idx.summary).length} categories\n`);
  }

  program
    .name('ft')
    .description('Self-custody for your X/Twitter bookmarks. Sync, search, classify, and explore locally.')
    .version('1.0.0')
    .showHelpAfterError();

  // ── sync ────────────────────────────────────────────────────────────────

  program
    .command('sync')
    .description('Sync bookmarks from X into your local database')
    .option('--api', 'Use OAuth v2 API instead of Chrome session', false)
    .option('--full', 'Full crawl instead of incremental sync', false)
    .option('--max-pages <n>', 'Max pages to fetch', (v: string) => Number(v), 500)
    .option('--target-adds <n>', 'Stop after N new bookmarks', (v: string) => Number(v))
    .option('--delay-ms <n>', 'Delay between requests in ms', (v: string) => Number(v), 600)
    .option('--max-minutes <n>', 'Max runtime in minutes', (v: string) => Number(v), 30)
    .option('--chrome-user-data-dir <path>', 'Chrome user-data directory')
    .option('--chrome-profile-directory <name>', 'Chrome profile name')
    .action(async (options) => {
      const firstRun = isFirstRun();
      if (firstRun) showWelcome();
      ensureDataDir();

      const useApi = Boolean(options.api);
      const mode = Boolean(options.full) ? 'full' : 'incremental';

      if (useApi) {
        const result = await syncTwitterBookmarks(mode, {
          targetAdds: typeof options.targetAdds === 'number' && !Number.isNaN(options.targetAdds) ? options.targetAdds : undefined,
        });
        console.log(`\n  \u2713 ${result.added} new bookmarks synced (${result.totalBookmarks} total)`);
        console.log(`  \u2713 Data: ${dataDir()}\n`);
        await rebuildAndClassify(result.added);
      } else {
        const startTime = Date.now();
        const result = await syncBookmarksGraphQL({
          incremental: !Boolean(options.full),
          maxPages: Number(options.maxPages) || 500,
          targetAdds: typeof options.targetAdds === 'number' && !Number.isNaN(options.targetAdds) ? options.targetAdds : undefined,
          delayMs: Number(options.delayMs) || 600,
          maxMinutes: Number(options.maxMinutes) || 30,
          chromeUserDataDir: options.chromeUserDataDir ? String(options.chromeUserDataDir) : undefined,
          chromeProfileDirectory: options.chromeProfileDirectory ? String(options.chromeProfileDirectory) : undefined,
          onProgress: (status: SyncProgress) => {
            renderProgress(status, startTime);
            if (status.done) process.stderr.write('\n');
          },
        });

        console.log(`\n  \u2713 ${result.added} new bookmarks synced (${result.totalBookmarks} total)`);
        console.log(`  ${friendlyStopReason(result.stopReason)}`);
        console.log(`  \u2713 Data: ${dataDir()}\n`);

        await rebuildAndClassify(result.added);
      }

      if (firstRun) {
        console.log(`\n  Try:  ft search "machine learning"`);
        console.log(`        ft viz`);
        console.log(`        ft categories\n`);
      }
    });

  // ── search ──────────────────────────────────────────────────────────────

  program
    .command('search')
    .description('Full-text search across bookmarks')
    .argument('<query>', 'Search query (supports FTS5 syntax: AND, OR, NOT, "exact phrase")')
    .option('--author <handle>', 'Filter by author handle')
    .option('--after <date>', 'Bookmarks posted after this date (YYYY-MM-DD)')
    .option('--before <date>', 'Bookmarks posted before this date (YYYY-MM-DD)')
    .option('--limit <n>', 'Max results', (v: string) => Number(v), 20)
    .action(async (query: string, options) => {
      const results = await searchBookmarks({
        query,
        author: options.author ? String(options.author) : undefined,
        after: options.after ? String(options.after) : undefined,
        before: options.before ? String(options.before) : undefined,
        limit: Number(options.limit) || 20,
      });
      console.log(formatSearchResults(results));
    });

  // ── list ────────────────────────────────────────────────────────────────

  program
    .command('list')
    .description('List bookmarks with filters')
    .option('--query <query>', 'Text query (FTS5 syntax)')
    .option('--author <handle>', 'Filter by author handle')
    .option('--after <date>', 'Posted after (YYYY-MM-DD)')
    .option('--before <date>', 'Posted before (YYYY-MM-DD)')
    .option('--category <category>', 'Filter by category')
    .option('--domain <domain>', 'Filter by domain')
    .option('--limit <n>', 'Max results', (v: string) => Number(v), 30)
    .option('--offset <n>', 'Offset into results', (v: string) => Number(v), 0)
    .option('--json', 'JSON output')
    .action(async (options) => {
      const items = await listBookmarks({
        query: options.query ? String(options.query) : undefined,
        author: options.author ? String(options.author) : undefined,
        after: options.after ? String(options.after) : undefined,
        before: options.before ? String(options.before) : undefined,
        category: options.category ? String(options.category) : undefined,
        domain: options.domain ? String(options.domain) : undefined,
        limit: Number(options.limit) || 30,
        offset: Number(options.offset) || 0,
      });
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      for (const item of items) {
        const tags = [item.primaryCategory, item.primaryDomain].filter(Boolean).join(' \u00b7 ');
        const summary = item.text.length > 120 ? `${item.text.slice(0, 117)}...` : item.text;
        console.log(`${item.id}  ${item.authorHandle ? `@${item.authorHandle}` : '@?'}  ${item.postedAt?.slice(0, 10) ?? '?'}${tags ? `  ${tags}` : ''}`);
        console.log(`  ${summary}`);
        console.log(`  ${item.url}`);
        console.log();
      }
    });

  // ── show ─────────────────────────────────────────────────────────────────

  program
    .command('show')
    .description('Show one bookmark in detail')
    .argument('<id>', 'Bookmark id')
    .option('--json', 'JSON output')
    .action(async (id: string, options) => {
      const item = await getBookmarkById(String(id));
      if (!item) {
        console.error(`Unknown bookmark: ${String(id)}`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(item, null, 2));
        return;
      }
      console.log(`${item.id} \u00b7 ${item.authorHandle ? `@${item.authorHandle}` : '@?'}`);
      console.log(item.url);
      console.log(item.text);
      if (item.links.length) console.log(`links: ${item.links.join(', ')}`);
      if (item.categories) console.log(`categories: ${item.categories}`);
      if (item.domains) console.log(`domains: ${item.domains}`);
    });

  // ── stats ───────────────────────────────────────────────────────────────

  program
    .command('stats')
    .description('Aggregate statistics from your bookmarks')
    .action(async () => {
      const stats = await getStats();
      console.log(`Bookmarks: ${stats.totalBookmarks}`);
      console.log(`Unique authors: ${stats.uniqueAuthors}`);
      console.log(`Date range: ${stats.dateRange.earliest?.slice(0, 10) ?? '?'} to ${stats.dateRange.latest?.slice(0, 10) ?? '?'}`);
      console.log(`\nTop authors:`);
      for (const a of stats.topAuthors) console.log(`  @${a.handle}: ${a.count}`);
      console.log(`\nLanguages:`);
      for (const l of stats.languageBreakdown) console.log(`  ${l.language}: ${l.count}`);
    });

  // ── viz ─────────────────────────────────────────────────────────────────

  program
    .command('viz')
    .description('Visual dashboard of your bookmarking patterns')
    .action(async () => {
      console.log(await renderViz());
    });

  // ── classify ────────────────────────────────────────────────────────────

  program
    .command('classify')
    .description('Classify bookmarks by category')
    .option('--deep', 'Use LLM classification (requires claude or codex CLI)')
    .action(async (options) => {
      if (options.deep) {
        process.stderr.write('Classifying bookmarks with LLM...\n');
        const result = await classifyWithLlm({
          onBatch: (done: number, total: number) => {
            process.stderr.write(`  Processing ${done}/${total} bookmarks...\n`);
          },
        });
        console.log(`Engine: ${result.engine}`);
        console.log(`Classified ${result.classified}/${result.totalUnclassified} (${result.batches} batches, ${result.failed} failed)`);
      } else {
        process.stderr.write('Classifying bookmarks (regex)...\n');
        const result = await classifyAndRebuild();
        console.log(`Indexed ${result.recordCount} bookmarks \u2192 ${result.dbPath}`);
        console.log(formatClassificationSummary(result.summary));
      }
    });

  // ── classify-domains ────────────────────────────────────────────────────

  program
    .command('classify-domains')
    .description('Classify bookmarks by subject domain using LLM (ai, finance, etc.)')
    .option('--all', 'Re-classify all bookmarks, not just missing')
    .action(async (options) => {
      process.stderr.write('Classifying bookmark domains with LLM...\n');
      const result = await classifyDomainsWithLlm({
        all: options.all ?? false,
        onBatch: (done: number, total: number) => {
          process.stderr.write(`  Processing ${done}/${total} bookmarks...\n`);
        },
      });
      console.log(`Engine: ${result.engine}`);
      console.log(`Classified ${result.classified}/${result.totalUnclassified} (${result.batches} batches, ${result.failed} failed)`);
    });

  // ── categories ──────────────────────────────────────────────────────────

  program
    .command('categories')
    .description('Show category distribution')
    .action(async () => {
      const counts = await getCategoryCounts();
      if (Object.keys(counts).length === 0) {
        console.log('No categories found. Run: ft classify');
        return;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      for (const [cat, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / total) * 100).toFixed(1);
        console.log(`  ${cat.padEnd(14)} ${String(count).padStart(5)}  (${pct}%)`);
      }
    });

  // ── domains ─────────────────────────────────────────────────────────────

  program
    .command('domains')
    .description('Show domain distribution')
    .action(async () => {
      const counts = await getDomainCounts();
      if (Object.keys(counts).length === 0) {
        console.log('No domains found. Run: ft classify-domains');
        return;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      for (const [dom, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / total) * 100).toFixed(1);
        console.log(`  ${dom.padEnd(20)} ${String(count).padStart(5)}  (${pct}%)`);
      }
    });

  // ── index ───────────────────────────────────────────────────────────────

  program
    .command('index')
    .description('Rebuild the SQLite search index from the JSONL cache')
    .action(async () => {
      process.stderr.write('Building search index...\n');
      const result = await buildIndex();
      console.log(`Indexed ${result.recordCount} bookmarks \u2192 ${result.dbPath}`);
    });

  // ── auth ────────────────────────────────────────────────────────────────

  program
    .command('auth')
    .description('Set up OAuth for API-based sync (needed for ft sync --api)')
    .action(async () => {
      const result = await runTwitterOAuthFlow();
      console.log(`Saved token to ${result.tokenPath}`);
      if (result.scope) console.log(`Scope: ${result.scope}`);
    });

  // ── status ──────────────────────────────────────────────────────────────

  program
    .command('status')
    .description('Show sync status and data location')
    .action(async () => {
      const view = await getBookmarkStatusView();
      console.log(formatBookmarkStatus(view));
    });

  // ── path ────────────────────────────────────────────────────────────────

  program
    .command('path')
    .description('Print the data directory path')
    .action(() => { console.log(dataDir()); });

  // ── sample ──────────────────────────────────────────────────────────────

  program
    .command('sample')
    .description('Sample bookmarks by category')
    .argument('<category>', 'Category: tool, security, technique, launch, research, opinion, commerce')
    .option('--limit <n>', 'Max results', (v: string) => Number(v), 10)
    .action(async (category: string, options) => {
      const results = await sampleByCategory(category, Number(options.limit) || 10);
      if (results.length === 0) {
        console.log(`No bookmarks found with category "${category}". Run: ft classify`);
        return;
      }
      for (const r of results) {
        const text = r.text.length > 120 ? r.text.slice(0, 120) + '...' : r.text;
        console.log(`[@${r.authorHandle ?? '?'}] ${text}`);
        console.log(`  ${r.url}  [${r.categories}]`);
        if (r.githubUrls) console.log(`  github: ${r.githubUrls}`);
        console.log();
      }
    });

  // ── fetch-media ─────────────────────────────────────────────────────────

  program
    .command('fetch-media')
    .description('Download media assets for bookmarks')
    .option('--limit <n>', 'Max bookmarks to process', (v: string) => Number(v), 100)
    .option('--max-bytes <n>', 'Per-asset byte limit', (v: string) => Number(v), 50 * 1024 * 1024)
    .action(async (options) => {
      const result = await fetchBookmarkMediaBatch({
        limit: Number(options.limit) || 100,
        maxBytes: Number(options.maxBytes) || 50 * 1024 * 1024,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  // ── hidden backward-compat aliases ────────────────────────────────────

  const bookmarksAlias = program.command('bookmarks').description('(alias) Bookmark commands').helpOption(false);
  for (const cmd of ['sync', 'search', 'list', 'show', 'stats', 'viz', 'classify', 'classify-domains',
    'categories', 'domains', 'index', 'auth', 'status', 'path', 'sample', 'fetch-media']) {
    bookmarksAlias.command(cmd).description(`Alias for: ft ${cmd}`).allowUnknownOption(true)
      .action(async () => {
        const args = ['node', 'ft', cmd, ...process.argv.slice(4)];
        await program.parseAsync(args);
      });
  }
  bookmarksAlias.command('enable').description('Alias for: ft sync').action(async () => {
    const args = ['node', 'ft', 'sync', ...process.argv.slice(4)];
    await program.parseAsync(args);
  });

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildCli().parseAsync(process.argv);
}
