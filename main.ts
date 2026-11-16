// SPDX-License-Identifier: MIT
// Driver for the markdown-render-speed-02 entry: reads the kit's
// /input/cases.json and writes /output/html.json. Written from scratch
// for this entry (not copied from any baseline).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const inputPath = process.argv[2] ?? '/input/cases.json';
const outputPath = process.argv[3] ?? '/output/html.json';

const cases = JSON.parse(readFileSync(inputPath, 'utf8'));
const out = [];
for (const c of cases) {
  out.push({ id: c.id, html: parse(c.markdown) });
}
mkdirSync(outputPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
writeFileSync(outputPath, JSON.stringify(out));
