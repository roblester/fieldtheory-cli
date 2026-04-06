#!/usr/bin/env node
/**
 * Reads data.json and the HTML template, injects the data, outputs the final HTML.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = readFileSync(join(__dirname, '..', 'viz', 'data.json'), 'utf8');
const template = readFileSync(join(__dirname, '..', 'viz', 'template.html'), 'utf8');

const output = template.replace('/*__INJECTED_DATA__*/', `const DATA = ${data};`);
writeFileSync(join(__dirname, '..', 'viz', 'you-are-what-you-bookmark.html'), output);
console.log('Built: viz/you-are-what-you-bookmark.html');
