// SwiftMark driver: renders every case in /input/cases.json with parse.js
// and writes the HTML array to /output/html.json.
//
// Input shape (competition.yaml): /input/cases.json is a JSON array of
// objects {"id", "markdown"} — the markdown string lives in case.markdown,
// so each case is rendered with parse(case.markdown), never parse(case).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  // Defensive: a case without a markdown string renders as an empty string
  // rather than crashing the whole run.
  const md = cases[i].markdown ?? '';
  out[i] = parse(md);
}
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(out));
