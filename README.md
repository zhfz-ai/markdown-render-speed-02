# SwiftMark

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zhfz-ai/markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zhfz-ai/markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A fast drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3,
written for the [make.fun](https://make.fun/c/markdown-render-speed-02) bounty
"Make Markdown rendering faster". `parse(markdown)` returns exactly the HTML
marked 18.1.3 renders with its default options (CommonMark 0.31.2 + GFM 0.29),
for less CPU.

## How it works

`parse.js` is a single dependency-free ES module with two passes:

- **Block pass** — a single-pass, line-oriented parser that builds the block
  tree (headings, fences, lists, block quotes, tables, raw HTML blocks, link
  reference definitions) with CommonMark's container rules: lazy continuation,
  tab stops, setext headings, and tight/loose lists.
- **Inline pass** — a scanner that tokenizes code spans, links, images,
  autolinks (including GFM `www.` / email autolinks), entities and emphasis
  delimiters, then resolves emphasis and strikethrough with the CommonMark
  delimiter-stack algorithm.

No caching across cases: every `parse()` call computes its output from the
markdown it was given, and nothing is kept between calls.

## Correctness notes

The renderer is written to match marked 18.1.3 byte for byte on the tricky
corners, including: HTML blocks (trailing newline depends on whether the
block ends at a blank line, at EOF, or because its parent container closes),
lazy continuation lines inside block quotes and list items (leading
indentation is dropped), setext headings (each line trimmed), link reference
definitions with multi-line titles, empty link destinations (`<>` renders
`<a href="">`), GFM tables (a body line without a pipe is still a row), and
fenced/indented code blocks (content dedented by the fence's own indent,
trailing blank lines removed).

## Benchmark

On the 720 practice cases (680 CommonMark/GFM spec examples plus 40
generated READMEs of 20–100k characters) the renderer completes in well
under the 777.3 ms house baseline on a single CPU, measured with
`node /tmp/check.mjs` locally.

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

`main.ts` is the program the make.fun harness runs: it reads
`/input/cases.json` (an array of `{"id", "markdown"}` objects), renders each
case with `parse(case.markdown)`, and writes the HTML array to
`/output/html.json`.

## License

MIT.
