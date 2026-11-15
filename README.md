# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zhfz-ai/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zhfz-ai/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

SwiftMark — a dependency-free, single-pass Markdown renderer that produces byte-identical HTML to marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29, default options), but faster: a hand-written block parser over sticky regexes and a direct-to-HTML inline scanner with a delimiter stack, no token-tree allocations on the hot path.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json` (or `/input/cases.json`), renders each with `parse()` from `parse.js`, and writes the HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (or `/output/html.json`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=ygzr8d2m&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
