// SwiftMark entrypoint: render every case in /input/cases.json with the
// fast single-pass renderer in parse.js and write the HTML array to
// /output/html.json. Runs under Node's native TypeScript type stripping,
// so only erasable syntax is used here.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "./parse.js";

const inputPath = "/input/cases.json";
const outputPath = "/output/html.json";

const raw = readFileSync(inputPath, "utf8");
const cases = JSON.parse(raw);

const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  html[i] = parse(typeof c === "string" ? c : c.markdown);
}

writeFileSync(outputPath, JSON.stringify(html));
