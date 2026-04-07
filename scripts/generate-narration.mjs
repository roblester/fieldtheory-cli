#!/usr/bin/env node
/**
 * Generate narration audio with word-level timestamps via ElevenLabs TTS.
 * Produces title announcements, numbered field notes, and interlude outtakes.
 *
 * Output: viz/narration.json
 * Usage: node scripts/generate-narration.mjs
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = join(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY || API_KEY === 'your_key_here') {
  console.error('Set ELEVENLABS_API_KEY in .env.local');
  process.exit(1);
}

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'Z2zOlkLWgzhSV8b5LZrr';
const MODEL_ID = 'eleven_multilingual_v2';

// ── All narration clips ────────────────────────────────────────────────────

const CLIPS = {
  // Boot intro
  boot: "Accessing subject file. Clearance level: eyes only. Stand by.",

  // Section title announcements (spoken while visuals animate in)
  'title-a': "Exhibit A. Subject Matter Allocation.",
  'title-b': "Exhibit B. Stated Intentions versus Actual Behavior.",
  'title-c': "Exhibit C. The Discrepancy Report.",
  'title-d': "Exhibit D. Taste versus Conformity Index.",
  'title-e': "Exhibit E. Interpersonal Attachment Analysis.",
  'title-f': "Exhibit F. Items of Highest Public Interest.",
  'title-g': "Exhibit G. Temporal Activity Log.",
  'title-h': "Exhibit H. Materials Seized.",
  'title-i': "Exhibit I. Cross-Reference Matrix.",
  'title-j': "Exhibit J. Final Classification.",

  // Numbered field notes — text MUST match template.html punchlines exactly
  // (after the "> " prefix). "Field note number N." prefix is spoken only.
  'note-a': `Field note number one. Over 60% of intercepts fall within three domains. Subject appears to be a design-curious AI enthusiast who occasionally remembers that the physical world exists. The 4% politics allocation is consistent with an "I should probably stay informed" impulse that activates every 2-4 years, usually in November.`,

  'note-b': `Field note number two. 31% tutorials. 22% opinions. 17% tools. The subject saves how-tos they will never follow, perspectives they already hold, and software they will install, open once, and never return to. This pattern is classified internally as "Collector Syndrome." It is not dangerous, but it is very, very common. We have a whole wing.`,

  'note-c': `Field note number three. The subject's "serious professional interests" (AI, design) average roughly 4,000 likes per saved item. Their health takes and political commentary average 20,000+. The Bureau would like the record to reflect that the subject's most private bookmarking behavior is indistinguishable from their aunt's Facebook feed. We do not say this to be cruel. We say it because it is our job.`,

  'note-d': `Field note number four. Peak saving activity occurs in the 100-1K like bracket. This suggests the subject does possess genuine curatorial instinct and is not simply saving whatever is trending. However, the 276 items exceeding 10,000 likes indicate periodic lapses in which the subject saves things they could have found by opening literally any app. The Bureau classifies this as "I discovered this first" syndrome, complicated by occasional herd behavior. Prognosis: stable.`,

  'note-e': `Field note number five. Of 1,807 persons of interest, 1,458 (81%) were contacted exactly once. The subject saved their single best thought and moved on without acknowledgment. Only 55 individuals earned repeat engagement. The Bureau has seen this pattern before. It is technically not ghosting if you never followed them in the first place, but the effect is the same.`,

  'note-f': `Field note number six. The subject's most treasured saves include a Jackass cast member's sobriety anniversary, a baked goods conspiracy, and a philosophical inquiry into whether sheep could survive without human intervention. The Bureau does not editorialize. The Bureau does not need to.`,

  'note-g': `Field note number seven. Activity peaked in 2021 at 467 intercepts. A marked decline followed in 2022-2023. The Bureau investigated several hypotheses: personal growth, app fatigue, a new hobby involving sunlight. None could be confirmed. Activity resumed in 2024, suggesting the 2022-2023 period was not a recovery but a remission. The condition is chronic.`,

  'note-h': `Field note number eight. 106 open-source repositories saved with no record of cloning. 139 video links saved with no record of viewing. 23 academic papers saved with no record of reading past the abstract. The Bureau has assigned the subject a Digital Hoarding Index of 7.2 out of 10. This is within normal parameters. The normal parameters are very sad.`,

  'note-i': `Field note number nine. The intersection of "technique" and "AI" is where the subject resides most of the time. This is their apartment. The intersection of "opinion" and "media" is where they go to feel things. The rest of the grid represents places they visited once, took a photo, and left. The Bureau does not judge. The Bureau simply observes and takes very detailed notes.`,

  'note-j': `Field note number ten. The Bureau would like to close this file with an observation that does not appear in our standard reporting templates. 2,644 saves across 8 years, 15 domains, and 8 languages is not the profile of a hoarder. It is the profile of someone who finds the world genuinely interesting. The subject saves tutorials because they want to understand how things are made. They save opinions because they are forming their own. They save tools because they believe, each time, that the next one might change everything. The Bureau's official position is that this is not a disorder. It is, on balance, a good way to be alive. File closed. Subject released.`,

  // Interlude outtakes — brief, character-breaking asides
  'interlude-1': "This is where it gets interesting. Fair warning.",
  'interlude-2': "Between you and me? This next exhibit was my favorite.",
  'interlude-3': "The Deputy Director reviewed this section. He circled several items. In red.",
  'interlude-4': "We're almost done here. I just need to say one more thing.",
};

// Words to skip in field note sync (the "Field note number X." prefix is spoken
// but doesn't appear in the HTML text). Always 4 words.
const NOTE_SYNC_SKIP = 4;

// ── Compute word-level timestamps from character alignment ─────────────────

function computeWordTimings(alignment) {
  const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
  const words = [];
  let currentWord = '';
  let wordStart = null;
  let wordEnd = null;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (ch === ' ' || ch === '\n' || ch === '\t') {
      if (currentWord) {
        words.push({ word: currentWord, start: wordStart, end: wordEnd });
        currentWord = '';
        wordStart = null;
      }
    } else {
      if (wordStart === null) wordStart = character_start_times_seconds[i];
      wordEnd = character_end_times_seconds[i];
      currentWord += ch;
    }
  }
  if (currentWord) {
    words.push({ word: currentWord, start: wordStart, end: wordEnd });
  }
  return words;
}

// ── Generate a single clip with timestamps ─────────────────────────────────

async function generateClip(text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': API_KEY },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.75, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
      }),
    }
  );

  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { audio: data.audio_base64, words: computeWordTimings(data.alignment) };
}

// ── Main ───────────────��───────────────────────────────────────────────────

const entries = Object.entries(CLIPS);
console.log(`Generating ${entries.length} narration clips with timestamps...`);
console.log(`Voice: ${VOICE_ID}  Model: ${MODEL_ID}\n`);

const clips = {};
for (let i = 0; i < entries.length; i++) {
  const [key, text] = entries[i];
  const wc = text.split(/\s+/).length;
  process.stdout.write(`  [${i + 1}/${entries.length}] ${key} (${wc}w)...`);
  try {
    const clip = await generateClip(text);
    // For field notes, mark how many words to skip for sync
    if (key.startsWith('note-')) clip.syncSkip = NOTE_SYNC_SKIP;
    clips[key] = clip;
    console.log(` ok (${clip.words.length} timestamps)`);
  } catch (err) {
    console.log(` FAIL: ${err.message}`);
  }
  if (i < entries.length - 1) await new Promise(r => setTimeout(r, 400));
}

const outputPath = join(__dirname, '..', 'viz', 'narration.json');
writeFileSync(outputPath, JSON.stringify({ clips }, null, 2));
const sizeMB = (readFileSync(outputPath).length / 1024 / 1024).toFixed(1);
console.log(`\nSaved ${Object.keys(clips).length} clips → viz/narration.json (${sizeMB} MB)`);
