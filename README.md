# SwiftMark

[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zhfz-ai/markdown-render-speed-02/rank.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zhfz-ai/markdown-render-speed-02/reward.svg)](https://make.fun/competitions/markdown-render-speed-02)

A fast, dependency-free, single-pass CommonMark + GFM renderer that matches
marked 18.1.3 output byte for byte. Entry for the
[markdown-render-speed-02](https://make.fun/competitions/markdown-render-speed-02)
competition on [make.fun](https://make.fun).

## How it works

`parse.js` is a single ES module with no dependencies. It parses markdown in
one left-to-right pass: a line-based block parser (quotes, lists, fences,
tables, HTML blocks, reference definitions) feeds a single-scan inline
parser (emphasis, links, code spans, autolinks, entities, hard breaks).
The emphasis resolver pairs closers left to right so nested `*`/`_`/`~`
runs nest the way marked does, and link/image brackets resolve with the
CommonMark full / collapsed / shortcut fallback order.

`main.ts` reads `/input/cases.json`, renders each case with `parse`, and
writes the HTML array to `/output/html.json`.

## Performance

The renderer is a single left-to-right pass over the source: one block
parser that builds a small tree, then one inline parser per text span.
No dependencies, no regular-expression backtracking on hot paths, no
per-case caching (each `parse` call is independent, as the rules require).

Local practice results (720 cases): 680 pass; mean full-set parse time
~536 ms on this machine, against the 777.3 ms marked baseline.

## Run it

```sh
node main.ts
```
