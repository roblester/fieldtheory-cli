#!/usr/bin/env node
/**
 * Extracts bookmark statistics from the SQLite DB and JSONL cache,
 * outputs a JSON blob for the visualizer.
 */

import { readFileSync, createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dataDir = process.env.FT_DATA_DIR || join(homedir(), '.ft-bookmarks');
const dbPath = join(dataDir, 'bookmarks.db');
const jsonlPath = join(dataDir, 'bookmarks.jsonl');

// ── Open DB ─────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js-fts5');
const wasmBinary = readFileSync(require.resolve('sql.js-fts5/dist/sql-wasm.wasm'));
const SQL = await initSqlJs({ wasmBinary });
const db = new SQL.Database(readFileSync(dbPath));

function query(sql) {
  const result = db.exec(sql);
  if (!result.length) return [];
  return result[0].values.map(row => {
    const obj = {};
    result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function queryOne(sql) {
  const rows = query(sql);
  return rows[0] || {};
}

// ── Totals ──────────────────────────────────────────────────────────────────

const totals = queryOne(`SELECT
  COUNT(*) as bookmarks,
  COUNT(DISTINCT author_handle) as authors,
  COUNT(DISTINCT language) as languages
FROM bookmarks`);

// ── Year distribution (from snowflake IDs) ──────────────────────────────────

const yearDist = query(`SELECT
  CASE
    WHEN CAST(id AS INTEGER) < 940000000000000000 THEN '2017'
    WHEN CAST(id AS INTEGER) < 1080000000000000000 THEN '2018'
    WHEN CAST(id AS INTEGER) < 1210000000000000000 THEN '2019'
    WHEN CAST(id AS INTEGER) < 1345000000000000000 THEN '2020'
    WHEN CAST(id AS INTEGER) < 1477000000000000000 THEN '2021'
    WHEN CAST(id AS INTEGER) < 1610000000000000000 THEN '2022'
    WHEN CAST(id AS INTEGER) < 1742000000000000000 THEN '2023'
    WHEN CAST(id AS INTEGER) < 1874000000000000000 THEN '2024'
    WHEN CAST(id AS INTEGER) < 2010000000000000000 THEN '2025'
    ELSE '2026'
  END as year,
  COUNT(*) as count
FROM bookmarks GROUP BY year ORDER BY year`);

const yearDistribution = {};
for (const r of yearDist) yearDistribution[r.year] = r.count;

// ── Domain distribution ─────────────────────────────────────────────────────

const domains = query(`SELECT primary_domain as name, COUNT(*) as count
FROM bookmarks WHERE primary_domain IS NOT NULL
GROUP BY primary_domain ORDER BY count DESC LIMIT 15`);

// ── Category distribution ───────────────────────────────────────────────────

const categories = query(`SELECT primary_category as name, COUNT(*) as count
FROM bookmarks WHERE primary_category IS NOT NULL
GROUP BY primary_category ORDER BY count DESC LIMIT 15`);

// ── Like distribution ───────────────────────────────────────────────────────

const likeDist = queryOne(`SELECT
  SUM(CASE WHEN like_count < 10 THEN 1 ELSE 0 END) as under10,
  SUM(CASE WHEN like_count BETWEEN 10 AND 99 THEN 1 ELSE 0 END) as to100,
  SUM(CASE WHEN like_count BETWEEN 100 AND 999 THEN 1 ELSE 0 END) as to1k,
  SUM(CASE WHEN like_count BETWEEN 1000 AND 9999 THEN 1 ELSE 0 END) as to10k,
  SUM(CASE WHEN like_count BETWEEN 10000 AND 99999 THEN 1 ELSE 0 END) as to100k,
  SUM(CASE WHEN like_count >= 100000 THEN 1 ELSE 0 END) as over100k
FROM bookmarks WHERE like_count IS NOT NULL`);

// ── Author loyalty ──────────────────────────────────────────────────────────

const loyalty = queryOne(`WITH ac AS (SELECT author_handle, COUNT(*) as n FROM bookmarks GROUP BY author_handle)
SELECT
  SUM(CASE WHEN n = 1 THEN 1 ELSE 0 END) as once,
  SUM(CASE WHEN n = 2 THEN 1 ELSE 0 END) as twice,
  SUM(CASE WHEN n BETWEEN 3 AND 4 THEN 1 ELSE 0 END) as threeFour,
  SUM(CASE WHEN n >= 5 THEN 1 ELSE 0 END) as fivePlus,
  COUNT(*) as totalAuthors
FROM ac`);

const topAuthors = query(`SELECT author_handle as handle, COUNT(*) as count
FROM bookmarks GROUP BY author_handle ORDER BY count DESC LIMIT 15`);

// ── Top bookmarks by likes ──────────────────────────────────────────────────

const topBookmarks = query(`SELECT author_handle as author, like_count as likes,
  repost_count as retweets, substr(text, 1, 140) as text,
  primary_category as category, primary_domain as domain, url
FROM bookmarks WHERE like_count IS NOT NULL ORDER BY like_count DESC LIMIT 12`);

// ── Engagement by domain ────────────────────────────────────────────────────

const engByDomain = query(`SELECT primary_domain as name, COUNT(*) as count,
  ROUND(AVG(like_count)) as avgLikes
FROM bookmarks WHERE primary_domain IS NOT NULL AND like_count IS NOT NULL
GROUP BY primary_domain HAVING count >= 10 ORDER BY avgLikes DESC LIMIT 12`);

// ── Engagement by category ──────────────────────────────────────────────────

const engByCategory = query(`SELECT primary_category as name, COUNT(*) as count,
  ROUND(AVG(like_count)) as avgLikes
FROM bookmarks WHERE primary_category IS NOT NULL AND like_count IS NOT NULL
GROUP BY primary_category HAVING count >= 10 ORDER BY avgLikes DESC LIMIT 12`);

// ── Link counts ─────────────────────────────────────────────────────────────

const mediaBreakdown = queryOne(`SELECT
  ROUND(100.0 * SUM(CASE WHEN media_count > 0 THEN 1 ELSE 0 END) / COUNT(*)) as mediaPct,
  ROUND(100.0 * SUM(CASE WHEN link_count > 0 AND media_count = 0 THEN 1 ELSE 0 END) / COUNT(*)) as linkPct,
  ROUND(100.0 * SUM(CASE WHEN media_count = 0 AND link_count = 0 THEN 1 ELSE 0 END) / COUNT(*)) as textPct
FROM bookmarks`);

// Count specific external domains from links_json
const allLinks = query(`SELECT links_json FROM bookmarks WHERE links_json IS NOT NULL AND links_json != ''`);
const linkDomainCounts = {};
for (const row of allLinks) {
  try {
    const links = JSON.parse(row.links_json);
    for (const link of (Array.isArray(links) ? links : [])) {
      try {
        const host = new URL(link).hostname.replace(/^www\./, '');
        linkDomainCounts[host] = (linkDomainCounts[host] || 0) + 1;
      } catch {}
    }
  } catch {}
}
const topLinkDomains = Object.entries(linkDomainCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([domain, count]) => ({ domain, count }));

// ── Heatmap: category × domain ─────────────────────────────────────────────

const heatmapRows = query(`SELECT primary_category as cat, primary_domain as dom, COUNT(*) as count
FROM bookmarks WHERE primary_category IS NOT NULL AND primary_domain IS NOT NULL
GROUP BY cat, dom ORDER BY count DESC`);

const topCats = categories.slice(0, 6).map(c => c.name);
const topDoms = domains.slice(0, 6).map(d => d.name);
const heatmap = {};
for (const r of heatmapRows) {
  if (topCats.includes(r.cat) && topDoms.includes(r.dom)) {
    heatmap[`${r.cat}|${r.dom}`] = r.count;
  }
}

// ── Language distribution ───────────────────────────────────────────────────

const languages = query(`SELECT language as name, COUNT(*) as count
FROM bookmarks WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC LIMIT 8`);

// ── Read some JSONL for author bios (top authors) ───────────────────────────

const topHandles = new Set(topAuthors.map(a => a.handle));
const authorBios = {};

const rl = createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
for await (const line of rl) {
  try {
    const obj = JSON.parse(line);
    if (obj.authorHandle && topHandles.has(obj.authorHandle) && !authorBios[obj.authorHandle]) {
      authorBios[obj.authorHandle] = {
        name: obj.authorName || obj.authorHandle,
        bio: obj.author?.bio?.slice(0, 100) || '',
        followers: obj.author?.followerCount || 0,
        verified: obj.author?.isVerified || false,
      };
    }
  } catch {}
}

// ── Assemble output ─────────────────────────────────────────────────────────

db.close();

const output = {
  totals: {
    bookmarks: totals.bookmarks,
    authors: totals.authors,
    languages: totals.languages,
    firstYear: Object.keys(yearDistribution)[0],
    lastYear: Object.keys(yearDistribution).slice(-1)[0],
  },
  yearDistribution,
  domains,
  categories,
  likeDistribution: likeDist,
  authorLoyalty: { ...loyalty, topAuthors, authorBios },
  topBookmarks,
  engagementByDomain: engByDomain,
  engagementByCategory: engByCategory,
  linkDomains: topLinkDomains,
  mediaBreakdown,
  heatmap: { rows: topCats, cols: topDoms, cells: heatmap },
  languages,
};

console.log(JSON.stringify(output, null, 2));
