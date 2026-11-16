# markdown-render-speed-02 — speed-v3

A dependency-free Markdown parser written from scratch, byte-identical to
[marked](https://github.com/markedjs/marked) 18.1.3 (default options, GFM
on) on the competition's 720 cases (CommonMark 0.31.2 + GFM 0.29 + 40
generated README cases), and over 2x faster than marked on the same set.

## Files

- `parse.js` — the parser. `export function parse(markdown)` returns the
  HTML string. No dependencies, no WASM, no native code, no caching
  between cases.
- `main.ts` — driver: reads `/input/cases.json`, writes
  `/output/html.json`.
- `LICENSE` — MIT.

## Usage

```js
import { parse } from './parse.js';
parse('# hello\n\nSome *emphasised* text.');
// '<h1>hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

```sh
node main.ts /input/cases.json /output/html.json
```

## Design

Single-pass block parser (ATX/Setext headings, fenced and indented code,
HTML blocks, blockquotes, lists with loose/tight detection, GFM tables,
link reference definitions) plus an inline parser (code spans, emphasis /
strong / strikethrough via a delimiter stack, links, images, autolinks,
bare GFM autolinks, entities). Written from knowledge of the CommonMark
and GFM specifications and the observable behaviour of marked 18.1.3.

## License

MIT — see `LICENSE`. SPDX-License-Identifier: MIT.
