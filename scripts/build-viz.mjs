#!/usr/bin/env node
/**
 * Reads data.json and the HTML template, injects data + narration, outputs the final HTML.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = readFileSync(join(__dirname, '..', 'viz', 'data.json'), 'utf8');
const template = readFileSync(join(__dirname, '..', 'viz', 'template.html'), 'utf8');

let output = template.replace('/*__INJECTED_DATA__*/', `const DATA = ${data};`);

// Inject narration if available
const narrationPath = join(__dirname, '..', 'viz', 'narration.json');
if (existsSync(narrationPath)) {
  const narration = readFileSync(narrationPath, 'utf8');
  output = output.replace('/*__INJECTED_NARRATION__*/', `const NARRATION = ${narration};`);
  console.log('Injected narration data');
} else {
  output = output.replace('/*__INJECTED_NARRATION__*/', 'const NARRATION = null;');
  console.log('No narration.json found — audio disabled');
}

writeFileSync(join(__dirname, '..', 'viz', 'you-are-what-you-bookmark.html'), output);
console.log('Built: viz/you-are-what-you-bookmark.html');
