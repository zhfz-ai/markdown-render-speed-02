// SwiftMark — a dependency-free, single-pass Markdown renderer producing
// byte-identical HTML to marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29,
// default options: gfm on, breaks off, pedantic off, async off), but faster.
//
// Architecture: a hand-written line-based block parser builds a small node
// tree, and a single-pass inline scanner with a CommonMark delimiter stack
// renders straight to HTML — no intermediate inline token tree, no
// per-token regex engine on the hot path. Link reference definitions are
// collected during the block pass and applied by the inline pass, so a
// definition later in the document applies to links earlier in it (the way
// marked defers inline lexing).
//
// ASCII fast paths: punctuation / whitespace classification uses small
// lookup tables; non-ASCII characters fall back to a cached Unicode test,
// which is rare in practice.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_NOENC_RE = /[<>\"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));/;
const NUM_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
const PUNCT_ESC_RE = /\\([\p{P}\p{S}])/gu;

// ASCII classification tables, built once at load.
const ASCII_PUNCT = new Uint8Array(128);
const ASCII_SPACE = new Uint8Array(128);
const ASCII_ALNUM = new Uint8Array(128);
const ASCII_EMAIL = new Uint8Array(128);
{
  const punct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  for (let i = 0; i < punct.length; i++) ASCII_PUNCT[punct.charCodeAt(i)] = 1;
  const space = ' \t\n\r\f\v';
  for (let i = 0; i < space.length; i++) ASCII_SPACE[space.charCodeAt(i)] = 1;
  for (let i = 48; i <= 57; i++) ASCII_ALNUM[i] = 1;
  for (let i = 65; i <= 90; i++) ASCII_ALNUM[i] = 1;
  for (let i = 97; i <= 122; i++) ASCII_ALNUM[i] = 1;
  const email = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-";
  for (let i = 0; i < email.length; i++) ASCII_EMAIL[email.charCodeAt(i)] = 1;
}
// Unicode fallbacks, memoised per code point.
const PUNCT_CACHE = new Map();
const SPACE_CACHE = new Map();
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
const UNICODE_SPACE_RE = /\s/u;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT[c] === 1;
  let v = PUNCT_CACHE.get(c);
  if (v === undefined) { v = UNICODE_PUNCT_RE.test(ch); PUNCT_CACHE.set(c, v); }
  return v;
}
function isSpaceCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_SPACE[c] === 1;
  let v = SPACE_CACHE.get(c);
  if (v === undefined) { v = UNICODE_SPACE_RE.test(ch); SPACE_CACHE.set(c, v); }
  return v;
}
// Punctuation for delimiter flanking, with '~' excluded (GFM strikethrough).
function isPunctNoTilde(ch) {
  return ch !== '~' && isPunctCh(ch);
}
// Unicode letter/number (for the '_' intraword rule), code-point aware.
const ALNUM_CACHE = new Map();
const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;
function isAlnumU(ch) {
  if (ch === '') return false;
  const c = ch.codePointAt(0);
  if (c < 128) return ASCII_ALNUM[c] === 1;
  let v = ALNUM_CACHE.get(c);
  if (v === undefined) { v = UNICODE_ALNUM_RE.test(ch); ALNUM_CACHE.set(c, v); }
  return v;
}
// Code-point-aware character reads (astral characters are two UTF-16 units).
function charBefore(src, pos) {
  if (pos <= 0) return '';
  const lo = src.charCodeAt(pos - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && pos >= 2) {
    const hi = src.charCodeAt(pos - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return src.slice(pos - 2, pos);
  }
  return src[pos - 1];
}
function charAt(src, pos) {
  if (pos >= src.length) return '';
  const hi = src.charCodeAt(pos);
  if (hi >= 0xD800 && hi <= 0xDBFF && pos + 1 < src.length) {
    const lo = src.charCodeAt(pos + 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF) return src.slice(pos, pos + 2);
  }
  return src[pos];
}
// Punctuation-or-space for marked's `punctuation` rule (excludes '*' and '_').
function isPunctSpaceNt(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && (isSpaceCh(ch) || isPunctCh(ch));
}

// Escape HTML text. encode=true escapes & < > " ' unconditionally (code
// spans, autolink text); encode=false leaves valid entities alone.
function esc(s, encode) {
  if (!ESC_TEST.test(s)) return s;
  if (encode) return s.replace(ESC_RE, (m) => ESC_MAP[m]);
  return s.replace(ESC_NOENC_RE, (m) => ESC_MAP[m]);
}

// Decode numeric character references in a text run (marked's unescape).
// Only runs when the string actually holds a numeric reference; a bare '&'
// becomes '&amp;' in that case, and a decoded '&' (code point 38) is
// re-escaped to '&amp;' so it survives the renderer's escaping pass.
function decodeNumeric(s) {
  if (!NUM_REF_RE.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// encodeURI with %25 restored to %, null on failure (marked's cleanUrl core).
function cleanHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// Normalise a link label: trim, collapse inner whitespace, case-fold.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove backslash escapes before punctuation characters.
function unescapePunct(s) {
  return s.indexOf('\\') === -1 ? s : s.replace(PUNCT_ESC_RE, '$1');
}

// Strip trailing occurrences of `ch` from a string (marked's rtrim helper:
// it strips while the last char equals ch, or while it differs when
// `invert` is set — used for closing '#' runs and trailing newlines).
function stripTrailing(s, ch, invert) {
  let n = s.length;
  if (n === 0) return '';
  let i = 0;
  for (;;) {
    const r = s.charAt(n - i - 1);
    if (r === ch && !invert) i++;
    else if (r !== ch && invert) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Trim trailing blank lines the way marked does for block tokens: if at most
// one trailing blank line, keep the text as-is; otherwise drop all trailing
// blank lines.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, starting at column `col` (marked's tab expansion).
function expandTabs(s, col) {
  let c = col, out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') { const r = 4 - (c % 4); out += ' '.repeat(r); c += r; }
    else { out += ch; c++; }
  }
  return out;
}

// Find the index of an unmatched closer in `s` for the pair `pair`
// (e.g. "()"): returns the index of a closer with no opener, -2 when an
// opener is left unclosed, -1 when balanced (marked's paren scan).
function findUnmatched(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes (marked's splitCells).
function splitCells(row, colCount) {
  const out = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) { cur += ch + row[i + 1]; i++; continue; }
    if (ch === '|') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  // Drop a leading empty cell and a trailing empty cell (outer pipes).
  if (out.length > 0 && out[0].trim() === '') out.shift();
  if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  if (colCount !== undefined) {
    if (out.length > colCount) out.length = colCount;
    while (out.length < colCount) out.push('');
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i].trim().replace(/\\\|/g, '|');
  return out;
}

// Block-level tag names (CommonMark HTML block type 6).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?: +|$|/?>)`, 'i');
const HTML_OPEN_RE = new RegExp(`^ {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Token kinds.
const TK_TEXT = 0, TK_CODE = 1, TK_LINK = 2, TK_IMAGE = 3, TK_HTML = 4;
const TK_BR = 5, TK_DELIM = 6, TK_EM = 7, TK_STRONG = 8, TK_DEL = 9, TK_CHECK = 10;

const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const TAG_RE = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[A-Za-z][A-Za-z0-9-]*\s*>|^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|^<\?[\s\S]*?\?>|^<![A-Za-z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const START_A_RE = /^<a /i;
const END_A_RE = /^<\/a>/i;
const START_RAW_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Trim a GFM extended autolink the way marked's backpedal loop does.
function backpedalUrl(text) {
  let prev = text;
  for (;;) {
    const m = BACKPEDAL_RE.exec(prev);
    const cur = m ? m[0] : '';
    if (cur === prev) return cur;
    prev = cur;
  }
}

function isEmailLocalChar(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? ASCII_EMAIL[c] === 1 : false;
}
function isDomainChar(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return true;
  if (c >= 65 && c <= 90) return true;
  if (c >= 97 && c <= 122) return true;
  return ch === '-';
}
function isAlnumChar(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? ASCII_ALNUM[c] === 1 : false;
}

// Parse an email address starting at i (restricted local part, as in
// marked's url rule). Returns the end index or -1.
// When `extUnd` is true, a trailing run of '_' after the final domain
// label belongs to an emphasis delimiter, not the address: labels are
// backtracked to their last alphanumeric character and the address ends
// there (marked parses the emphasis first, so the email inside it is whole).
function parseEmail(src, i, extUnd) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    j++;
  }
  if (j === i || j >= n || src[j] !== '@') return -1;
  j++;
  // First domain label: [A-Za-z0-9-_]*
  let ls = j;
  while (j < n && (isDomainChar(src[j]) || src[j] === '_')) j++;
  if (j === ls) return -1;
  let dots = 0;
  while (j < n && src[j] === '.') {
    let k = j + 1;
    while (k < n && (isDomainChar(src[k]) || src[k] === '_')) k++;
    if (extUnd) { while (k > j + 1 && !isAlnumChar(src[k - 1])) k--; }
    if (k === j + 1) break; // no label char after the dot
    if (!isAlnumChar(src[k - 1])) break; // label must end with alnum
    dots++;
    j = k;
  }
  if (dots === 0) return -1;
  if (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45) {
      if (!(extUnd && c === 95)) return -1;
    }
  }
  return j;
}

// Try to match a GFM extended autolink at position i. `wordStart` says the
// previous character is not an email-local character (needed for bare
// emails). `openUnder` is the count of unmatched '_' emphasis openers seen
// so far in this scan; when it is positive, a trailing '_' run after an
// email belongs to the emphasis closer, not the address. Returns
// {text, href, end} or null.
function tryUrl(src, i, st, wordStart, openUnder) {
  if (st.inLink) return null;
  const n = src.length;
  const c0 = src.charCodeAt(i);
  const extUnd = openUnder > 0;
  // mailto: / xmpp:
  if (c0 === 109 || c0 === 77 || c0 === 120 || c0 === 88) {
    const low = src.slice(i, i + 7).toLowerCase();
    if (low.startsWith('mailto:')) {
      const e = parseEmail(src, i + 7, extUnd);
      if (e > 0) return { text: src.slice(i, e), href: src.slice(i, e), end: e };
    } else if (src.slice(i, i + 5).toLowerCase() === 'xmpp:') {
      const e = parseEmail(src, i + 5, extUnd);
      if (e > 0) {
        let end = e;
        if (src[end] === '/') {
          let k = end + 1;
          while (k < n && /[A-Za-z0-9@.]/.test(src[k])) k++;
          end = k;
        }
        return { text: src.slice(i, end), href: src.slice(i, end), end };
      }
    }
  }
  // scheme:// or www.
  if (c0 === 104 || c0 === 72 || c0 === 102 || c0 === 70 || c0 === 119) {
    let slen = 0, isWww = false;
    const low7 = src.slice(i, i + 8).toLowerCase();
    if (low7.startsWith('https://')) slen = 8;
    else if (low7.startsWith('http://')) slen = 7;
    else if (low7.startsWith('ftp://')) slen = 6;
    else if (src.startsWith('www.', i)) { slen = 4; isWww = true; }
    if (slen > 0) {
      if (isWww) {
        const prev = i === 0 ? '' : src[i - 1];
        if (!(i === 0 || isSpaceCh(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(')) return null;
      }
      let j = i + slen, lastEnd = j;
      for (;;) {
        const ls = j;
        while (j < n && isDomainChar(src[j])) j++;
        if (j === ls) break;
        lastEnd = j;
        if (j < n && src[j] === '.') { j++; lastEnd = j; continue; }
        break;
      }
      if (lastEnd === i + slen) return null;
      let k = lastEnd;
      while (k < n && !isSpaceCh(src[k]) && src[k] !== '<') k++;
      const text = backpedalUrl(src.slice(i, k));
      if (text.length === 0) return null;
      return { text, href: isWww ? 'http://' + text : text, end: i + text.length };
    }
  }
  // Bare email.
  if (wordStart) {
    const e = parseEmail(src, i, extUnd);
    if (e > 0) {
      const text = backpedalUrl(src.slice(i, e));
      if (text.length > 0) return { text, href: 'mailto:' + text, end: i + text.length };
    }
  }
  return null;
}

// Find the end of a code span starting at `pos` (a backtick run).
// Returns {end, content} or null.
function findCodeSpan(src, pos) {
  const n = src.length;
  let run = 0;
  while (pos + run < n && src[pos + run] === '`') run++;
  const start = pos + run;
  let i = start;
  while (i < n) {
    if (src[i] !== '`') { i++; continue; }
    let m = 0;
    while (i + m < n && src[i + m] === '`') m++;
    if (m === run) return { end: i + m, content: src.slice(start, i) };
    i += m;
  }
  return null;
}

// Process a code span's raw content: newlines become spaces, and one
// leading/trailing space is stripped when the content is padded both sides.
function codeContent(raw) {
  let s = raw.indexOf('\n') === -1 ? raw : raw.replace(/\n/g, ' ');
  if (s.length > 1 && s.charCodeAt(0) === 32 && s.charCodeAt(s.length - 1) === 32 && /[^ ]/.test(s)) {
    s = s.slice(1, -1);
  }
  return s;
}

// Does a blockSkip-link-like span start at the '[' at `open`? Returns the
// index just past its closing ')' or -1. Mirrors marked's blockSkip link
// pattern after its backtick masking: the label holds plain characters
// (not '[', ']', '`') or code spans whose opening and closing runs match
// in length and whose content starts and ends with a non-backtick; the
// destination is a run of escapes, non-paren characters, or balanced
// paren groups. Such a span is a *failed* link whose delimiters marked's
// emphasis search cannot see (its masking replaces the span with
// '[aaa...]'), so the caller treats `*`, `_` and `~` inside it as text.
function maskedSpanEnd(src, open) {
  const n = src.length;
  let j = open + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === ']') break;
    if (ch === '[') return -1;
    if (ch === '`') {
      let run = 0;
      while (j + run < n && src[j + run] === '`') run++;
      // Content must start with a non-backtick character.
      const k = j + run;
      if (k >= n || src[k] === '`') return -1;
      // The closing run has the same length, with a non-backtick before
      // it (the content's last character).
      let found = -1;
      let p = k;
      while (p < n) {
        if (src[p] === '`') {
          let r2 = 0;
          while (p + r2 < n && src[p + r2] === '`') r2++;
          if (r2 === run && src[p - 1] !== '`') { found = p + r2; break; }
          p += r2;
        } else p++;
      }
      if (found < 0) return -1;
      j = found;
      continue;
    }
    j++;
  }
  if (j >= n || src[j] !== ']' || src[j + 1] !== '(') return -1;
  // Destination: escapes, non-paren characters, or balanced paren groups.
  let k = j + 2;
  let depth = 0;
  while (k < n) {
    const ch = src[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '(') { depth++; k++; continue; }
    if (ch === ')') {
      if (depth === 0) return k + 1;
      depth--; k++; continue;
    }
    k++;
  }
  return -1;
}

// Scan a bracket label starting at the '[' at `open`, following marked's
// inline-link label regex: nested brackets (two levels deep), escapes, a
// code span whose content holds no backtick (either backtick run may be
// any length), a run of 2+ backticks immediately before ']', or any char
// except '[', ']', '\\' and '`'. Returns the index of the matching ']'
// or -1. `allowBlank` permits blank lines inside the label.
function scanLabelInner(src, i, depth, allowBlank) {
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === ']') return i;
    if (ch === '[') {
      if (depth >= 3) return -1;
      const end = scanLabelInner(src, i + 1, depth + 1, allowBlank);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      // Inside a nested bracket a backtick is a plain character
      // (marked's nested-bracket pattern has no code-span alternative
      // and its plain class does not exclude backticks); only the
      // outermost label treats backticks as code spans.
      if (depth > 1) { i++; continue; }
      let run = 0;
      while (i + run < n && src[i + run] === '`') run++;
      // Try the code-span alternative first (marked's label regex
      // order): the next backtick run (any length) closes it, its
      // content holding no backtick. But the span must still let the
      // label complete afterwards — if it runs past the label's
      // closing ']' into later text, the label cannot end, so fall
      // back to the literal-backticks alternative below (the regex
      // engine backtracks the same way).
      let j = i + run;
      while (j < n && src[j] !== '`') j++;
      if (j < n) {
        let run2 = 0;
        while (j + run2 < n && src[j + run2] === '`') run2++;
        const rest = scanLabelInner(src, j + run2, depth, allowBlank);
        if (rest >= 0) return rest;
      }
      // ``+(?=])``: a run of 2+ backticks immediately before ']'
      // is literal, and the label ends at that ']'.
      if (run >= 2 && src[i + run] === ']') return i + run;
      return -1;
    }
    if (ch === '\n' && !allowBlank) {
      // A newline is fine unless it starts a blank line.
      let k = i + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n && src[k] === '\n') return -1;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

function scanLabel(src, open, allowBlank) {
  return scanLabelInner(src, open + 1, 1, allowBlank);
}

// Scan a reference label starting at the '[' at `open`, following marked's
// `le` pattern (used for reflink refs and shortcut links): escapes, or any
// character except '[', ']', '\\' and a newline that starts a blank line;
// backticks are plain characters here. Returns the index of the closing
// ']' or -1.
function scanRefLabel(src, open) {
  const n = src.length;
  let i = open + 1;
  // The label must not be empty or whitespace-only up to ']'.
  let j = i;
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  if (j >= n || src[j] === ']') return -1;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === ']') return i;
    if (ch === '[') return -1;
    if (ch === '\n') {
      let k = i + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n && src[k] === '\n') return -1;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// marked's Be() check: a link is invalid when its text holds an unescaped
// '<' that opens a tag or autolink reaching past the end of the text.
function hasBadAngle(src, label, off) {
  if (label.indexOf('<') === -1) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const cs = findCodeSpan(label, s);
      if (cs) { s = cs.end - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(off + s);
    const m = TAG_RE.exec(rest) || AUTOLINK_RE.exec(rest);
    if (m && m[0].length > label.length - s) return true;
  }
  return false;
}

// Count backslashes immediately before position `end` in src.
function backslashRun(src, end) {
  let k = 0;
  while (end - 1 - k >= 0 && src[end - 1 - k] === '\\') k++;
  return k;
}

// Parse a title starting at i ('"' or '\'' or '('). Returns {title, end}
// where end is just past the closing quote, or null.
function parseTitle(src, i) {
  const n = src.length;
  const q = src[i];
  let j = i + 1;
  if (q === '"') {
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '"') return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === "'") {
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === "'") return { title: src.slice(i + 1, j), end: j + 1 };
      if (src[j] === '\n') {
        let k = j + 1;
        if (k < n && src[k] === '\n') return null;
      }
      j++;
    }
    return null;
  }
  // '(' title: no unescaped '(' or ')' inside.
  while (j < n) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === ')') return { title: src.slice(i + 1, j), end: j + 1 };
    if (src[j] === '(') return null;
    j++;
  }
  return null;
}

// Skip the whitespace that may precede a link title: spaces/tabs, or one
// newline with following spaces/tabs. Returns the new index, or -1 when the
// whitespace run is not of that shape.
function skipTitleSpace(src, i) {
  const n = src.length;
  let j = i;
  if (src[j] === ' ' || src[j] === '\t') {
    while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
    if (src[j] === '\n') {
      j++;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
    }
    return j;
  }
  if (src[j] === '\n') {
    j++;
    while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
    return j;
  }
  return i;
}

// After a link destination: optional title, then ')'. Returns
// {title, end} or null. `i` is the index just after the destination.
function parseAfterDest(src, i) {
  const n = src.length;
  let j = i;
  // Whitespace before an optional title.
  const ws = skipTitleSpace(src, j);
  if (ws !== j) {
    j = ws;
    if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
      const t = parseTitle(src, j);
      if (!t) return null;
      // Whitespace before the closing paren (at most one newline).
      j = skipTitleSpace(src, t.end);
      if (j < n && src[j] === ')') return { title: t.title, end: j + 1 };
      return null;
    }
    // No title: the next character must be ')'.
    if (j < n && src[j] === ')') return { title: null, end: j + 1 };
    return null;
  }
  if (j < n && src[j] === ')') return { title: null, end: j + 1 };
  return null;
}

// Create a link or image token from the '[' at `open` (the caller has
// already checked the '[' exists). Returns {tok, end} or null.
function tryLink(src, open, isImage, links, st) {
  const labelEnd = scanLabel(src, open, true);
  // When the inline-link label does not scan, marked still tries the
  // shortcut form (whose label follows `le`), so fall through to it
  // instead of failing outright.
  let label = labelEnd >= 0 ? src.slice(open + 1, labelEnd) : '';
  const labelOff = open + 1;
  const next = labelEnd >= 0 ? labelEnd + 1 : -1;
  let href = null, title = null, end = -1;
  if (labelEnd >= 0 && src[next] === '(' && st.linkParenPossible) {
    // Inline link: [text](dest "title"). Any failure here falls through
    // to the reference forms below (marked tries its reflink tokenizer
    // after its link tokenizer fails), except the bad-angle check, which
    // invalidates the link outright in both tokenizers.
    let j = next + 1;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    if (j < src.length) {
      if (src[j] === ')') {
        href = ''; end = j + 1;
      } else if (src[j] === '<') {
        // <dest> (escapes allowed, no newline or unescaped '<' '>')
        let k = j + 1, ok = false;
        while (k < src.length) {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === '>') { ok = true; break; }
          if (src[k] === '\n' || src[k] === '<') break;
          k++;
        }
        if (ok) {
          href = src.slice(j + 1, k);
          const after = parseAfterDest(src, k + 1);
          if (after) { title = after.title; end = after.end; }
        }
      } else {
        // Bare destination: a run of non-space, non-control characters.
        let k = j;
        while (k < src.length) {
          const c = src.charCodeAt(k);
          if (c <= 32 || c === 127) break;
          k++;
        }
        if (k > j) {
          const run = src.slice(j, k);
          if (run.indexOf(')') !== -1) {
            const lastParen = run.lastIndexOf(')');
            const cand = run.slice(0, lastParen);
            const u = findUnmatched(cand, '(', ')');
            if (u !== -2) {
              if (u >= 0) { href = cand.slice(0, u); end = j + u + 1; }
              else { href = cand; end = j + lastParen + 1; }
            } else if (findUnmatched(run, '(', ')') === -1) {
              // The whole run is itself a balanced destination, e.g.
              // `.../(when)`, and the link's closing paren (with an
              // optional title) follows it: `[t](u(v) "title")`.
              const after = parseAfterDest(src, k);
              if (after) { href = run; title = after.title; end = after.end; }
            }
          } else {
            const u = findUnmatched(run, '(', ')');
            if (u !== -2) {
              href = run;
              const after = parseAfterDest(src, k);
              if (after) { title = after.title; end = after.end; }
              else { href = null; end = -1; }
            }
          }
        }
      }
      if (end >= 0) {
        // The closing ')' must not be escaped by an odd run of backslashes.
        if (backslashRun(src, end - 1) % 2 === 1) end = -1;
        else if (hasBadAngle(src, label, labelOff)) return null;
      }
    }
  }
  if (end < 0 && src[next] === '[') {
    // Reference link: [text][ref] or [text][] (collapsed). The ref uses
    // marked's `le` pattern (no brackets inside, backticks plain).
    const refEnd = scanRefLabel(src, next);
    if (refEnd >= 0) {
      const ref = src.slice(next + 1, refEnd);
      const def = links[normLabel(ref === '' ? label : ref)];
      if (def) {
        if (hasBadAngle(src, label, labelOff)) return null;
        href = def.href; title = def.title; end = refEnd + 1;
      } else {
        // A full reference link with no definition: marked emits just
        // the first character ('[' or '!') as text and moves on — it
        // does NOT fall back to the shortcut form.
        return { tok: { k: TK_TEXT, s: isImage ? '!' : '[', r: false, raw: st.inRawBlock }, end: isImage ? open : open + 1 };
      }
    }
  }
  if (end < 0) {
    // Shortcut reference link: [text] — marked's nolink form, whose
    // label follows `le` (no brackets, backticks plain), not the
    // inline-link label pattern.
    const refEnd = scanRefLabel(src, open);
    if (refEnd >= 0) {
      const shortLabel = src.slice(open + 1, refEnd);
      if (shortLabel !== '') {
        const def = links[normLabel(shortLabel)];
        if (def) {
          if (hasBadAngle(src, shortLabel, labelOff)) return null;
          href = def.href; title = def.title; end = refEnd + 1;
          // Collapsed reference: [text][] — marked's nolink consumes
          // the empty brackets too.
          if (src[end] === '[' && src[end + 1] === ']') end += 2;
          // Rebind `label` so the link text renders from this scan.
          label = shortLabel;
        }
      }
    }
    if (end < 0) return null;
  }
  href = unescapePunct(href);
  if (title !== null && title !== undefined) title = unescapePunct(title);
  // Render the link text (recursively), tracking nested-link emission.
  const savedInLink = st.inLink, savedEmitted = st.linkEmitted, savedRaw = st.inRawBlock;
  st.inLink = true; st.linkEmitted = false;
  const inner = scanInline(label, links, st);
  processEmphasis(inner, label, 0, label.length, links);
  const nestedLink = st.linkEmitted;
  st.linkEmitted = savedEmitted; st.inLink = savedInLink;
  if (!isImage) {
    if (nestedLink) { st.inRawBlock = savedRaw; return null; }
    st.linkEmitted = true;
    return { tok: { k: TK_LINK, href, title, h: renderTokens(inner), c: inner }, end };
  }
  return { tok: { k: TK_IMAGE, href, title, alt: plainText(inner), c: inner }, end };
}

// Delimiter flanking for a run of `ch` starting at `pos` with length `len`.
function flank(src, pos, len, tilde) {
  const before = pos > 0 ? src[pos - 1] : '';
  const after = pos + len < src.length ? src[pos + len] : '';
  const bSpace = before === '' || isSpaceCh(before);
  const bPunct = before !== '' && (tilde ? isPunctNoTilde(before) : isPunctCh(before));
  const aSpace = after === '' || isSpaceCh(after);
  const aPunct = after !== '' && (tilde ? isPunctNoTilde(after) : isPunctCh(after));
  const left = !aSpace && (!aPunct || bSpace || bPunct);
  const right = !bSpace && (!bPunct || aSpace || aPunct);
  return { before, after, bSpace, bPunct, aSpace, aPunct, left, right };
}

// Find the closer run for a strikethrough opener of length `len` starting
// the search at `from`. Classifies each candidate run of the same length as
// opener-like (skipped, counted) or closer-like, mirroring marked's del
// closer scan. Returns the index of the closer run or -1.
function findDelCloser(src, from, len) {
  const n = src.length;
  let p = len;
  let i = from;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      const cs = findCodeSpan(src, i);
      if (cs) { i = cs.end; continue; }
      i++;
      continue;
    }
    if (ch !== '~') { i++; continue; }
    let run = 0;
    while (i + run < n && src[i + run] === '~') run++;
    if (run !== len) { i += run; continue; }
    const f = flank(src, i, run, true);
    const before = f.before, after = f.after;
    const bSpace = f.bSpace, bPunct = f.bPunct;
    const aSpace = f.aSpace, aPunct = f.aPunct;
    const aNonPunctNonSpace = after !== '' && !aSpace && !aPunct && after !== '~';
    // Opener-like: preceded by space/punct and followed by a non-space,
    // non-punctuation character; or preceded by a space and followed by
    // punctuation.
    const openerLike = (bSpace && !aSpace && after !== '~') ||
      (bPunct && aNonPunctNonSpace);
    if (openerLike) { p += len; i += run; continue; }
    // Closer-like: preceded by punctuation and followed by space, end or
    // punctuation; or preceded by a non-space, non-punctuation character.
    const closerLike = (bPunct && (aSpace || aPunct)) ||
      (before !== '' && !bSpace && !bPunct);
    if (!closerLike) { i += run; continue; }
    p -= len;
    if (p <= 0) return i;
    i += run;
  }
  return -1;
}

// The inline scanner: one pass over `src`, producing tokens. Delimiter runs
// stay as tokens for the emphasis pass; links, code spans and HTML are
// resolved here.
function scanInline(src, links, st) {
  const toks = [];
  const n = src.length;
  let i = 0, ts = 0;
  // End of the current emphasis-masked span (a failed link whose
  // delimiters marked's emphasis search cannot see): `*`, `_` and `~`
  // runs before this index are literal text, not delimiters.
  let maskEnd = -1;
  // Unmatched '_' emphasis openers seen so far (openers minus closers,
  // clamped at 0): a bare email followed by '_' while one is pending is
  // inside that emphasis, so its trailing '_' run is a closer, not part
  // of the address.
  let openUnder = 0;
  const pushRun = (end) => {
    if (end <= ts) return;
    const s = src.slice(ts, end);
    const last = toks[toks.length - 1];
    if (last && last.k === TK_TEXT && last.r && last.raw === st.inRawBlock) last.s += s;
    else toks.push({ k: TK_TEXT, s, r: true, raw: st.inRawBlock });
  };
  const pushTextChar = (s) => {
    toks.push({ k: TK_TEXT, s, r: false, raw: st.inRawBlock });
  };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') {
        pushRun(i); toks.push({ k: TK_BR }); i += 2;
        // A hard break eats the next line's leading spaces/tabs
        // (marked's br token raw runs to the first non-space).
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        ts = i; continue;
      }
      if (d !== undefined && d.charCodeAt(0) < 128 && ASCII_PUNCT[d.charCodeAt(0)] === 1) {
        pushRun(i); pushTextChar(d); i += 2; ts = i; continue;
      }
      i++;
      continue;
    }
    if (c === '\n') {
      // Hard break: two or more spaces before the newline.
      if (i >= 2 && src[i - 1] === ' ' && src[i - 2] === ' ') {
        let j = i;
        while (j > ts && src[j - 1] === ' ') j--;
        pushRun(j); toks.push({ k: TK_BR }); i++;
        // A hard break eats the next line's leading spaces/tabs.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        ts = i; continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      const cs = findCodeSpan(src, i);
      if (cs) {
        pushRun(i);
        toks.push({ k: TK_CODE, s: codeContent(cs.content) });
        i = cs.end; ts = i; continue;
      }
      // No code span opens here: the whole backtick run is literal text
      // (marked's inline text rule consumes a backtick run as text when
      // no code span starts there — a shorter run inside it must not
      // be retried as an opener).
      let run = 0;
      while (i + run < n && src[i + run] === '`') run++;
      i += run;
      continue;
    }
    if (c === '*' || c === '_') {
      let run = 0;
      while (i + run < n && src[i + run] === c) run++;
      // Inside an emphasis-masked span the run is literal text.
      if (i < maskEnd) { i += run; continue; }
      pushRun(i);
      const f = flank(src, i, run, false);
      let canOpen, canClose;
      if (c === '*') { canOpen = f.left; canClose = f.right; }
      else {
        canOpen = f.left && (!f.right || f.bPunct);
        canClose = f.right && (!f.left || f.aPunct);
      }
      toks.push({ k: TK_DELIM, ch: c, n: run, canOpen, canClose, pos: i });
      if (c === '_') {
        if (canOpen && !canClose) openUnder++;
        else if (canClose && !canOpen) openUnder = Math.max(0, openUnder - 1);
      }
      i += run; ts = i; continue;
    }
    if (c === '~') {
      let run = 0;
      while (i + run < n && src[i + run] === '~') run++;
      // Inside an emphasis-masked span the run is literal text.
      if (i < maskEnd) { i += run; continue; }
      if (run <= 2) {
        const f = flank(src, i, run, true);
        const afterOk = f.after !== '' && !f.aSpace && f.after !== '~';
        const canOpen = afterOk && (!f.aPunct || f.bSpace || f.bPunct || f.before === '');
        if (canOpen) {
          const closer = findDelCloser(src, i + run, run);
          if (closer >= 0) {
            pushRun(i);
            const inner = src.slice(i + run, closer);
            const innerToks = scanInline(inner, links, st);
            processEmphasis(innerToks, inner, 0, inner.length, links);
            toks.push({ k: TK_DEL, c: innerToks });
            i = closer + run; ts = i; continue;
          }
        }
      }
      i += run;
      continue;
    }
    if (c === '<') {
      const rest = src.slice(i);
      const am = AUTOLINK_RE.exec(rest);
      if (am) {
        pushRun(i);
        const text = am[1];
        const isMail = am[0].indexOf('@') !== -1 && am[1].indexOf(':') === -1;
        const href = isMail ? 'mailto:' + text : text;
        toks.push({ k: TK_LINK, href, title: null, h: esc(text, true), txt: text, c: null, auto: true });
        i += am[0].length; ts = i; continue;
      }
      const tm = TAG_RE.exec(rest);
      if (tm) {
        pushRun(i);
        const tag = tm[0];
        if (!st.inLink && START_A_RE.test(tag)) st.inLink = true;
        else if (st.inLink && END_A_RE.test(tag)) st.inLink = false;
        if (!st.inRawBlock && START_RAW_RE.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && END_RAW_RE.test(tag)) st.inRawBlock = false;
        toks.push({ k: TK_HTML, s: tag });
        i += tag.length; ts = i; continue;
      }
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      const open = isImage ? i + 1 : i;
      const hit = tryLink(src, open, isImage, links, st);
      if (hit) {
        pushRun(i);
        toks.push(hit.tok);
        i = hit.end; ts = i; continue;
      }
      // No link here: a blockSkip-link-like span starting at this '['
      // is emphasis-masked in marked (its delimiters are invisible to
      // the emphasis search), so note its end.
      const me = maskedSpanEnd(src, open);
      if (me > maskEnd) maskEnd = me;
      i++;
      continue;
    }
    if (c === 'w' || c === 'h' || c === 'f' || c === 'm' || c === 'x' || c === 'W' || c === 'H' || c === 'F') {
      // Possible GFM extended autolink start (scheme, www., mailto:, xmpp:).
      const prev = i === 0 ? '' : src[i - 1];
      const wordStart = i === 0 || !isEmailLocalChar(prev);
      const u = tryUrl(src, i, st, wordStart, openUnder);
      if (u) {
        pushRun(i);
        toks.push({ k: TK_LINK, href: u.href, title: null, h: esc(u.text, true), txt: u.text, c: null, auto: true });
        i = u.end; ts = i; continue;
      }
      i++;
      continue;
    }
    if (isEmailLocalChar(c)) {
      // Possible bare email start (only when the previous character is not
      // itself an email-local character).
      const prev = i === 0 ? '' : src[i - 1];
      if (i === 0 || !isEmailLocalChar(prev)) {
        const u = tryUrl(src, i, st, true, openUnder);
        if (u) {
          pushRun(i);
          toks.push({ k: TK_LINK, href: u.href, title: null, h: esc(u.text, true), txt: u.text, c: null, auto: true });
          i = u.end; ts = i; continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  pushRun(n);
  return toks;
}

// --- marked's emphasis mask (its `#n`) -----------------------------------
// emStrong's closer search runs on a MASKED copy of the inline string, not
// the raw one: escapes become '++', code spans keep their backticks with
// inner backticks as '+', and link / code / HTML spans become '[aaa...]'.
// Every replacement is length-preserving, so positions in the masked string
// match positions in src. The regexes are transcribed verbatim from marked
// 18.1.3 (its `c()` composer included), because the mask's exact match
// behaviour is load-bearing: Ot neutralises the backticks inside a code
// span first, so blockSkip's code pattern (no backticks in its content)
// can then swallow a whole span — e.g. `[docs each ``url`](...)` plus the
// `_issue table_` after it — making its delimiters invisible to emphasis.
function maskC(a, e = '') {
  let t = typeof a === 'string' ? a : a.source;
  const n = {
    replace: (s, r) => {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(/(^|[^\[])\^/g, '$1');
      t = t.replace(s, o);
      return n;
    },
    getRegex: () => new RegExp(t, e),
  };
  return n;
}
const MASK_PUNCT = /[\p{P}\p{S}]/u;
const MASK_LOOKBEHIND = (() => { try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; } })();
const MASK_LE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const MASK_RE_LABEL = maskC(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', MASK_LE).getRegex();
const MASK_LINK = maskC(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace('label', MASK_RE_LABEL).replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).getRegex();
const MASK_BE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const MASK_LT = maskC(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', MASK_LE).getRegex();
const MASK_REFLINK_SEARCH = maskC('reflink|nolink(?!\\()', 'g')
  .replace('reflink', maskC(/^!?\[(label)\]\[(ref)\]/).replace('label', MASK_LT).replace('ref', MASK_BE).getRegex())
  .replace('nolink', maskC(/^!?\[(ref)\](?:\[\])?/).replace('ref', MASK_BE).getRegex())
  .getRegex();
const MASK_OT = maskC(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, MASK_PUNCT).getRegex();
const MASK_BLOCKSKIP = maskC(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', MASK_LOOKBEHIND ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
// marked's RDelim first alternative, as a standalone check: a `__...*...__`
// span (for a '*' opener) or a `**..._...**` span (for '_') at the start of
// the closer scan swallows its inner delimiter, which then counts neither
// as an opener nor as a closer.
const MASK_ALT1_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/;
const MASK_ALT1_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/;

// Whether the inline string `e` contains a link (marked's linkInText).
function maskLinkInText(e, links) {
  if (e.indexOf('[') === -1) return false;
  for (const n of e.matchAll(MASK_BLOCKSKIP)) {
    if (MASK_LINK.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(MASK_REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && maskLinkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// marked's `#n`: the masked copy of an inline string. Fast path when the
// string holds nothing any mask step can change.
function maskInline(src, links) {
  if (src.indexOf('\\') === -1 && src.indexOf('`') === -1 && src.indexOf('[') === -1 && src.indexOf('<') === -1) return src;
  let t = src;
  if (links && src.indexOf('[') !== -1) {
    // Reference-link spans naming a defined link are masked. Each replace
    // uses a fresh regex instance: the nested replace inside the callback
    // would otherwise clobber the outer one's lastIndex.
    const reflinkReplace = (str) => {
      const re = new RegExp(MASK_REFLINK_SEARCH.source, 'g');
      return str.replace(re, (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const i = r.slice(1, o - 1);
          if (maskLinkInText(i, links)) return '[' + reflinkReplace(i) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      });
    };
    t = reflinkReplace(t);
  }
  t = t.replace(MASK_OT, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(MASK_BLOCKSKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

// Classify a delimiter run for marked's emphasis search, from the
// characters before (B) and after (A) the run in the inline text.
// Returns 0 (not a candidate) or the group number:
// 1/2 pure closer, 3/4 opener-like, 5/6 can both open and close.
// For '*' the GFM rules apply ('~' counts as a word character); for '_'
// the normal rules apply ('~' counts as punctuation) and a word-word run
// is never a candidate (intraword '_').
function emGroup(ch, B, A) {
  if (B === ch) return 0;
  const punct = ch === '*' ? isPunctNoTilde : isPunctCh;
  const bWord = B !== '' && !isSpaceCh(B) && !punct(B);
  const bPunct = B !== '' && punct(B);
  const bSpace = B === '' || isSpaceCh(B);
  const aWord = A !== '' && !isSpaceCh(A) && !punct(A);
  const aPunct = A !== '' && punct(A);
  const aSpace = A === '' || isSpaceCh(A);
  if (bPunct && aSpace) return 1;
  if (bWord && (aPunct || aSpace)) return 2;
  if ((bPunct || bSpace) && aWord) return 3;
  if (bSpace && aPunct) return 4;
  if (bPunct && aPunct) return 5;
  if (ch === '*' && bWord && aWord) return 6;
  return 0;
}

// Marked-style emphasis processing over a token array, mirroring marked's
// `emStrong`: for each delimiter run that can open, scan forward with the
// m/f delimiter accounting (opener-like runs add to m, pure closers
// subtract, both-flanking runs are subject to the rule of three) and form
// the leftmost match; the inner tokens are then processed recursively, as
// if they were a fresh inline string spanning [childStart, childEnd).
// `src` is the inline text the tokens were scanned from; the span bounds
// the fresh-string view for the recursive passes (top level: the whole src).
function processEmphasis(toks, src, spanStart, spanEnd, links, masked) {
  // The mask is only needed when a delimiter run is present; compute it
  // lazily so plain inline strings pay nothing. Top-level callers pass
  // `links` (and leave `masked` undefined); recursive calls pass both.
  if (masked === undefined) {
    let hasDelim = false;
    for (let q = 0; q < toks.length; q++) if (toks[q].k === TK_DELIM) { hasDelim = true; break; }
    if (!hasDelim) return;
    masked = maskInline(src, links);
  }
  let i = 0;
  // marked's tokenizer emits a failed opener one character at a time: the
  // first char becomes literal text and the shorter remainder is retried
  // from the next position. The remainder is an ordinary token: its run
  // still extends left over the emitted char in the masked string, so the
  // intraword check still sees the char before the full run (emStrong's
  // `l<i && (n=p)`) and `o` still sees the emitted delimiter. Skip the
  // literal and leave i on the remainder; a single-char run just
  // advances. Each peel shrinks n, so this always terminates.
  const peel = (t) => {
    if (t.n > 1) {
      toks.splice(i, 1,
        { k: TK_DELIM, ch: t.ch, n: 1, pos: t.pos, canOpen: false, canClose: false },
        { k: TK_DELIM, ch: t.ch, n: t.n - 1, pos: t.pos + 1, canOpen: false, canClose: false });
      i++;
    } else {
      i++;
    }
  };
  while (i < toks.length) {
    const t = toks[i];
    if (t.k !== TK_DELIM) { i++; continue; }
    const ch = t.ch;
    // A run the mask replaced (inside a code/link span, or an escape) is
    // not a delimiter at all in marked's eyes; it renders literally. The
    // mask never outputs '*' or '_', so a masked run start means hidden.
    if (masked[t.pos] !== ch) { i++; continue; }
    // Run bounds within the span, read off the MASKED string: an escaped
    // delimiter is '++' there, so it never extends a run or forms a pair.
    let runStart = t.pos, runEnd = t.pos + t.n;
    while (runStart > spanStart && masked[runStart - 1] === ch) runStart--;
    while (runEnd < spanEnd && masked[runEnd] === ch) runEnd++;
    const y = runEnd - runStart;
    // p/h come from the masked char before the run; nEff/u from the raw
    // previous token's char when the run starts here (marked's `o`-family
    // reads raw), else the masked p (emStrong's `l<i && (n=p)`).
    const p = runStart > spanStart ? charBefore(masked, runStart) : '';
    const h = p === '*' || p === '_' || (p !== '' && (isSpaceCh(p) || isPunctCh(p)));
    const nEff = runStart < t.pos ? p : (t.pos > spanStart ? charBefore(src, t.pos) : '');
    const u = runStart < t.pos ? h : isPunctSpaceNt(nEff);
    const o = t.pos > spanStart && src[t.pos - 1] === ch;
    const aAfter = t.pos + t.n >= spanEnd ? '' : charAt(src, t.pos + t.n);
    // The left delimiter must be followed by punctuation or a non-space
    // character (marked's emStrongLDelim has no match otherwise).
    if (aAfter === '' || isSpaceCh(aAfter)) { peel(t); continue; }
    // '_' intraword: no emphasis with an alphanumeric on both sides.
    if (ch === '_' && isAlnumU(aAfter) && nEff !== '' && isAlnumU(nEff)) { peel(t); continue; }
    const d = isPunctNoTilde(aAfter) ? aAfter : '';
    if (!(d === '' || nEff === '' || u)) { peel(t); continue; }
    const R = p !== '' && p.trim() !== '' && (d !== '' || (ch === '*' && !h));
    const k = t.n;
    // Last possible closer: start of the last run of this delimiter in the
    // span whose preceding character (masked) is not whitespace — marked's
    // `fe`, which reads the masked string and treats position 0 as
    // preceded by '\n' (not a closer start). Hidden runs do not count.
    let v = -1;
    for (let j = i + 1; j < toks.length; j++) {
      const c = toks[j];
      if (c.k !== TK_DELIM || c.ch !== ch || masked[c.pos] !== ch) continue;
      let rs = c.pos;
      while (rs > spanStart && masked[rs - 1] === ch) rs--;
      const before = rs > spanStart ? charBefore(masked, rs) : '';
      if (before !== '' && before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') v = rs;
    }
    if (v < t.pos + k) { peel(t); continue; }
    let m = k, f = 0, formed = false;
    // marked's RDelim first alternative: a `__...*...__` span (or its
    // `**..._...**` mirror) at the start of the closer scan swallows its
    // inner delimiter, which then counts neither as an opener nor closer.
    let skipPos = -1;
    const alt = ch === '*' ? MASK_ALT1_AST.exec(masked.slice(t.pos + k, spanEnd)) : ch === '_' ? MASK_ALT1_UND.exec(masked.slice(t.pos + k, spanEnd)) : null;
    if (alt) skipPos = t.pos + k + alt[0].indexOf(ch);
    for (let j = i + 1; j < toks.length && !formed; j++) {
      const c = toks[j];
      if (c.k !== TK_DELIM || c.ch !== ch) continue;
      if (c.pos > v) break;
      if (c.pos === skipPos && c.n === 1) continue;
      if (masked[c.pos] !== ch) continue;
      const B = c.pos > spanStart ? charBefore(masked, c.pos) : '';
      const A = c.pos + c.n >= spanEnd ? '' : charAt(masked, c.pos + c.n);
      const g = emGroup(ch, B, A);
      if (g === 0) continue;
      const b = c.n;
      if (g === 3 || g === 4) { m += b; continue; }
      if (g === 5 || g === 6 || R) {
        if (o && (g === 5 || g === 6)) break;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const bUsed = Math.min(b, b + m + f);
      const use = (Math.min(k, bUsed) % 2 === 1) ? 1 : 2;
      const children = [];
      if (k > use) children.push({ k: TK_DELIM, ch, n: k - use, pos: t.pos + use, canOpen: false, canClose: false });
      for (let x = i + 1; x < j; x++) children.push(toks[x]);
      if (bUsed > use) children.push({ k: TK_DELIM, ch, n: bUsed - use, pos: c.pos, canOpen: false, canClose: false });
      const node = { k: use === 2 ? TK_STRONG : TK_EM, c: children };
      processEmphasis(children, src, t.pos + use, c.pos + bUsed - use, links, masked);
      const seg = [node];
      if (b > bUsed) seg.push({ k: TK_DELIM, ch, n: b - bUsed, pos: c.pos + bUsed, canOpen: false, canClose: false });
      toks.splice(i, j - i + 1, ...seg);
      i = i + 1;
      formed = true;
    }
    if (!formed) peel(t);
  }
}

// Render a token array to HTML.
function renderTokens(toks) {
  let out = '';
  for (let x = 0; x < toks.length; x++) {
    const t = toks[x];
    switch (t.k) {
      case TK_TEXT:
        out += t.raw ? t.s : esc(decodeNumeric(t.s), false);
        break;
      case TK_CODE:
        out += '<code>' + esc(t.s, true) + '</code>';
        break;
      case TK_LINK: {
        if (t.auto) {
          const h = cleanHref(t.href);
          if (h === null) { out += t.h; break; }
          // Autolinks escape both the href and the text with encode=true.
          out += '<a href="' + esc(h, true) + '">' + t.h + '</a>';
          break;
        }
        const h = cleanHref(t.href);
        if (h === null) { out += t.h; break; }
        out += '<a href="' + esc(h, false) + '"';
        if (t.title) out += ' title="' + esc(t.title, false) + '"';
        out += '>' + t.h + '</a>';
        break;
      }
      case TK_IMAGE: {
        const h = cleanHref(t.href);
        if (h === null) { out += esc(t.alt, false); break; }
        out += '<img src="' + esc(h, false) + '" alt="' + esc(t.alt, false) + '"';
        if (t.title) out += ' title="' + esc(t.title, false) + '"';
        out += '>';
        break;
      }
      case TK_HTML:
        out += t.s;
        break;
      case TK_BR:
        out += '<br>';
        break;
      case TK_DELIM:
        out += t.ch.repeat(t.n);
        break;
      case TK_EM:
        out += '<em>' + renderTokens(t.c) + '</em>';
        break;
      case TK_STRONG:
        out += '<strong>' + renderTokens(t.c) + '</strong>';
        break;
      case TK_DEL:
        out += '<del>' + renderTokens(t.c) + '</del>';
        break;
      case TK_CHECK:
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
    }
  }
  return out;
}

// Plain-text rendering of a token array (image alt text).
function plainText(toks) {
  let out = '';
  for (let x = 0; x < toks.length; x++) {
    const t = toks[x];
    switch (t.k) {
      case TK_TEXT: out += t.raw ? t.s : decodeNumeric(t.s); break;
      case TK_CODE: out += t.s; break;
      case TK_LINK: out += t.auto ? t.txt : plainText(t.c); break;
      case TK_IMAGE: out += plainText(t.c); break;
      case TK_HTML: out += t.s; break;
      case TK_BR: break;
      case TK_DELIM: out += t.ch.repeat(t.n); break;
      case TK_EM: case TK_STRONG: case TK_DEL: out += plainText(t.c); break;
      case TK_CHECK: out += t.rawText; break;
    }
  }
  return out;
}

// Render inline markdown to HTML (top-level entry: resets the raw-block
// state the way marked's lexer does before each queued inline pass).
function inlineToHtml(src, links, st) {
  st.inRawBlock = false;
  const toks = scanInline(src, links, st);
  processEmphasis(toks, src, 0, src.length, links);
  return renderTokens(toks);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
// Node kinds: p paragraph, x text (inside containers), h heading,
// c code, r hr, m html block, q blockquote, l list, t table.

const SPACE_RE = /^(?:[ \t]*(?:\n|$))+/;
const CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const CODE_INDENT_RE = /^(?: {0,3}\t| {1,4})/gm;
const HR_RE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const LIST_START_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const BLANK_LINE_RE = /^[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM_CELL_RE = /^ *:?-+:? *$/;

// The line starting at `pos`: its text (without the newline) and the
// position just past its newline (or the end of the string).
function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return { line: src.slice(pos), next: src.length };
  return { line: src.slice(pos, nl), next: nl + 1 };
}
function isBlankLine(line) { return BLANK_LINE_RE.test(line); }

// Thematic break? Returns the marker character or ''.
function hrChar(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (i >= line.length) return '';
  const ch = line[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return '';
  let count = 0;
  for (let j = i; j < line.length; j++) {
    if (line[j] === ch) count++;
    else if (line[j] !== ' ' && line[j] !== '\t') return '';
  }
  return count >= 3 ? ch : '';
}

// ATX heading? Returns the depth (1-6) or 0.
function atxDepth(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let d = 0;
  while (line[i + d] === '#') d++;
  if (d === 0 || d > 6) return 0;
  const after = line[i + d];
  if (after !== undefined && after !== ' ' && after !== '\t') return 0;
  return d;
}

// Fenced code start? Returns {ch, len, info} or null.
function fenceStart(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (line[i + len] === ch) len++;
  if (len < 3) return null;
  const info = line.slice(i + len);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, info, indent: i };
}

// Setext underline? Returns 1 for '=', 2 for '-', 0 otherwise.
function setextDepth(line) {
  const m = SETEXT_RE.exec(line);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

// Blockquote marker? Returns the marker length (spaces + '>') or -1.
function quoteMarkerLen(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  return line[i] === '>' ? i + 1 : -1;
}

// List marker at the start of a line (0-3 leading spaces). Returns
// {marker, ordered, start, after} where `after` is the index just past the
// marker, or null when the line does not start a list item.
function listMarker(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  if (ch === '-' || ch === '*' || ch === '+') {
    return { marker: ch, ordered: false, start: 0, after: i + 1, indent: i };
  }
  if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j - i > 9) return null;
    const d = line[j];
    if (d !== '.' && d !== ')') return null;
    return { marker: line.slice(i, j + 1), ordered: true, start: +line.slice(i, j), after: j + 1, indent: i };
  }
  return null;
}

// A line that can interrupt a paragraph as a list item (GFM: any bullet, or
// an ordered marker '1.' / '1)'), followed by spaces and content.
function listInterruptsPara(line) {
  const m = listMarker(line);
  if (!m) return false;
  if (!m.ordered) {
    const rest = line.slice(m.after);
    return /^[ \t]+[^ \t]/.test(rest);
  }
  if (m.start !== 1) return false;
  return /^[ \t]+[^ \t]/.test(line.slice(m.after));
}

// A table delimiter line? Returns the alignment array or null.
function tableDelimiter(line) {
  let s = line;
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  s = s.slice(i);
  if (s.indexOf(':') === -1 && s.indexOf('|') === -1) return null;
  // Split on '|' and check every cell.
  const cells = s.split('|');
  // A leading or trailing empty cell comes from an outer pipe.
  let start = 0, end = cells.length;
  if (cells[0].trim() === '') start = 1;
  if (end > start && cells[end - 1].trim() === '') end--;
  if (end <= start) return null;
  const align = [];
  for (let c = start; c < end; c++) {
    const cell = cells[c];
    if (!TABLE_DELIM_CELL_RE.test(cell)) return null;
    const t = cell.trim();
    if (/^:-+:$/.test(t)) align.push('center');
    else if (/^-+:$/.test(t)) align.push('right');
    else if (/^:-+$/.test(t)) align.push('left');
    else align.push(null);
  }
  return align;
}

// Does this line start a block construct that interrupts a paragraph?
// `nextLine` is the following line (for the table lookahead).
function interruptsParagraph(line, nextLine) {
  if (line === '') return false;
  if (isBlankLine(line)) return false;
  if (hrChar(line)) return true;
  if (atxDepth(line)) return true;
  if (setextDepth(line)) return true;
  if (quoteMarkerLen(line) >= 0) return true;
  if (fenceStart(line)) return true;
  if (listInterruptsPara(line)) return true;
  if (HTML_OPEN_RE.test(line)) return true;
  if (nextLine !== undefined && tableDelimiter(nextLine) && !isBlankLine(line)) return true;
  return false;
}

// Strip one blockquote marker (with the tab expansion marked does) from a
// line that starts with one.
function stripQuoteMarker(line) {
  const mw = /^( {0,3}>)([ \t]+)/.exec(line);
  let s = line;
  if (mw) s = mw[1] + expandTabs(mw[2], mw[1].length) + s.slice(mw[0].length);
  const m2 = /^ {0,3}>[ \t]?/.exec(s);
  if (m2) s = s.slice(m2[0].length);
  return s;
}

// Collect the lines of a paragraph (or of a setext heading's text) starting
// at `pos`. Stops at a blank line, a line that interrupts a paragraph, or a
// setext underline. Returns {lines, end} where `end` is the offset of the
// newline ending the last line (so a following blank line is left for the
// space token, as in marked).
function collectParaLines(src, pos) {
  const lines = [];
  let p = pos;
  let end = pos;
  let first = true;
  while (p < src.length) {
    const { line, next } = lineAt(src, p);
    // A blank line ends the paragraph — but only when it ends with a
    // newline: a spaces-only final line with no newline after it is a
    // continuation of the paragraph (marked's paragraph lookahead only
    // treats `[ \t]+\n` as blank).
    const hasNl = next > p && src[next - 1] === '\n';
    if (isBlankLine(line) && hasNl) break;
    if (!first) {
      let nextLine;
      if (next < src.length) nextLine = lineAt(src, next).line;
      if (interruptsParagraph(line, nextLine)) break;
    }
    lines.push(line);
    end = next - (next > p && src[next - 1] === '\n' ? 1 : 0);
    p = next;
    first = false;
  }
  return { lines, end };
}

// Fenced code starting at `pos` (the line is a fence start). Returns
// {node, end} or null.
function tryFences(src, pos) {
  const { line, next } = lineAt(src, pos);
  const fs = fenceStart(line);
  if (!fs) return null;
  const { ch, len, info, indent } = fs;
  const contentLines = [];
  let p = next;
  let end = src.length;
  let closed = false;
  while (p < src.length) {
    const { line: l, next: nx } = lineAt(src, p);
    // Closing fence: up to 3 spaces, a run of the same char >= len, then
    // only spaces/tabs to the end of the line.
    let i = 0;
    while (i < 3 && l[i] === ' ') i++;
    let run = 0;
    while (l[i + run] === ch) run++;
    let rest = l.slice(i + run);
    if (run >= len && /^[ \t]*$/.test(rest)) {
      end = p + i + run + rest.length; // end of the closing line's text
      closed = true;
      break;
    }
    contentLines.push(l);
    p = nx;
  }
  if (!closed) end = src.length;
  let content = contentLines.join('\n');
  if (ch === '`' && indent > 0) {
    content = content.split('\n').map((l) => {
      const mw = /^[ \t]*/.exec(l)[0];
      return l.slice(Math.min(mw.length, indent));
    }).join('\n');
  }
  const lang = info.trim() ? unescapePunct(info.trim()) : info;
  return { node: { k: 'c', lang, t: content }, end };
}

// Indented code / fenced code / ATX heading / hr / HTML block / def / table
// are handled by the regexes below; this is the main block loop.
// `into`, when given, is the node array to append to (blockquote
// sub-chunks share one array so a paragraph can merge across them, the
// way marked passes its token array into each blockTokens call).
function blockTokens(src, top, links, st, mergePara, into) {
  const nodes = into || [];
  let blank = false;
  let pos = 0;
  const n = src.length;
  // Whether a blank-line run (a "space" token in marked) has intervened
  // since the last paragraph/text node: indented code, link definitions
  // and further text lines merge into a preceding paragraph/text node only
  // when no blank line came between them.
  let gapBlank = false;
  // Only the first paragraph of this call may merge with a paragraph from
  // a previous blockquote chunk (marked's `n` flag).
  let canMergePara = mergePara;
  while (pos < n) {
    const rest = src.slice(pos);
    // Blank-line runs.
    let m = SPACE_RE.exec(rest);
    if (m && m[0].length > 0) {
      const nl = (m[0].match(/\n/g) || []).length;
      if (nl >= 2) { blank = true; gapBlank = true; }
      pos += m[0].length;
      continue;
    }
    // Indented code.
    m = CODE_RE.exec(rest);
    if (m) {
      const raw = trimBlankTail(m[0]);
      const text = raw.replace(CODE_INDENT_RE, '');
      const last = nodes[nodes.length - 1];
      if (!gapBlank && last && (last.k === 'p' || last.k === 'x')) {
        last.t += '\n' + text;
      } else {
        nodes.push({ k: 'c', lang: undefined, t: text });
      }
      gapBlank = false;
      pos += raw.length;
      continue;
    }
    // Fenced code.
    const fence = tryFences(src, pos);
    if (fence) {
      nodes.push(fence.node);
      gapBlank = false;
      pos = fence.end;
      continue;
    }
    // ATX heading.
    m = HEADING_RE.exec(rest);
    if (m) {
      let text = m[2].trim();
      if (/#$/.test(text)) {
        const s = stripTrailing(text, '#', false);
        if (!s || /[ \t]$/.test(s)) text = s.trim();
      }
      nodes.push({ k: 'h', d: m[1].length, t: text });
      gapBlank = false;
      pos += m[0].length;
      continue;
    }
    // Thematic break.
    m = HR_RE.exec(rest);
    if (m) {
      nodes.push({ k: 'r' });
      gapBlank = false;
      pos += m[0].length;
      continue;
    }
    // Blockquote.
    const quote = tryBlockquote(src, pos, links, st);
    if (quote) {
      nodes.push(quote.node);
      gapBlank = false;
      pos = quote.end;
      continue;
    }
    // List.
    const list = tryList(src, pos, links, st);
    if (list) {
      nodes.push(list.node);
      gapBlank = false;
      pos = list.end;
      continue;
    }
    // HTML block.
    const html = tryHtmlBlock(src, pos);
    if (html) {
      nodes.push(html.node);
      gapBlank = false;
      pos = html.end;
      continue;
    }
    // Link reference definition.
    const def = tryDef(src, pos, links);
    if (def) {
      const last = nodes[nodes.length - 1];
      if (!gapBlank && last && (last.k === 'p' || last.k === 'x')) {
        last.t += '\n' + def.raw;
      } else {
        if (!Object.hasOwn(links, def.tag)) links[def.tag] = { href: def.href, title: def.title };
        // A registered definition is itself a token, so a following
        // indented-code line no longer merges into the paragraph.
        gapBlank = true;
      }
      pos = def.end;
      continue;
    }
    // Table.
    const table = tryTable(src, pos);
    if (table) {
      nodes.push(table.node);
      gapBlank = false;
      pos = table.end;
      continue;
    }
    // Setext heading or paragraph (top) / text (inside containers).
    const { lines, end } = collectParaLines(src, pos);
    if (lines.length > 0) {
      // A setext underline right after the collected lines?
      const after = lineAt(src, end + (end < n && src[end] === '\n' ? 1 : 0));
      const sd = setextDepth(after.line);
      if (sd > 0 && after.line !== '') {
        const text = lines.join('\n').trim();
        nodes.push({ k: 'h', d: sd, t: text });
        gapBlank = false;
        pos = after.next;
        // Consume following newlines like the lheading regex's (\n+|$).
        while (pos < n && src[pos] === '\n') pos++;
        continue;
      }
      if (top) {
        const text = lines.join('\n');
        const last = nodes[nodes.length - 1];
        if (canMergePara && last && last.k === 'p') last.t += '\n' + text;
        else nodes.push({ k: 'p', t: text });
        canMergePara = false;
        gapBlank = false;
        pos = end;
        continue;
      }
      // Inside a container: one line becomes a text token, merged with a
      // preceding text token.
      const text = lines[0];
      const last = nodes[nodes.length - 1];
      if (!gapBlank && last && last.k === 'x') last.t += '\n' + text;
      else nodes.push({ k: 'x', t: text });
      gapBlank = false;
      pos = pos + text.length;
      continue;
    }
    // Nothing matched: skip one line to avoid an infinite loop (marked
    // would throw here; in practice the text token always matches).
    const { next } = lineAt(src, pos);
    pos = next;
  }
  return { nodes, blank };
}

// HTML block (CommonMark types 1-7). Returns {node, end} or null.
function tryHtmlBlock(src, pos) {
  const { line } = lineAt(src, pos);
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (line[i] !== '<') return null;
  const rest = line.slice(i);
  let endLine = -1; // position (offset in src) of the end of the last line
  let endPos = -1; // offset just past the block (before trailing newlines)
  // True when a type 6/7 block ends at a blank line (not end of input).
  let html67blank = false;
  const lineStart = pos + i;
  // Type 1: script / pre / style / textarea — ends at the closing tag line.
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m1) {
    const tag = m1[1].toLowerCase();
    const closeRe = new RegExp(`</${tag}>`, 'i');
    let p = lineStart;
    while (p < src.length) {
      const { line: l, next } = lineAt(src, p);
      if (closeRe.test(l)) { endLine = p + l.length; break; }
      p = next;
    }
    if (endLine === -1) endPos = src.length;
    else endPos = endLine;
  } else if (rest.startsWith('<!--')) {
    // Type 2: comment — ends at the line holding '-->'.
    if (/^<!--(-?>)/.test(rest)) {
      endPos = lineStart + rest.length;
    } else {
      const idx = src.indexOf('-->', pos);
      if (idx === -1) endPos = src.length;
      else {
        const nl = src.indexOf('\n', idx);
        endPos = nl === -1 ? src.length : nl;
      }
    }
  } else if (rest.startsWith('<?')) {
    // Type 3: processing instruction — ends at the line holding '?>'.
    const idx = src.indexOf('?>', pos);
    if (idx === -1) endPos = src.length;
    else {
      const nl = src.indexOf('\n', idx);
      endPos = nl === -1 ? src.length : nl;
    }
  } else if (/^<![A-Za-z]/.test(rest)) {
    // Type 4: declaration — ends at the line holding the first '>'.
    const idx = src.indexOf('>', pos);
    if (idx === -1) endPos = src.length;
    else {
      const nl = src.indexOf('\n', idx);
      endPos = nl === -1 ? src.length : nl;
    }
  } else if (rest.startsWith('<![CDATA[')) {
    // Type 5: CDATA — ends at the line holding ']]>'.
    const idx = src.indexOf(']]>', pos);
    if (idx === -1) endPos = src.length;
    else {
      const nl = src.indexOf('\n', idx);
      endPos = nl === -1 ? src.length : nl;
    }
  } else {
    // Type 6: a block tag; type 7: any other complete tag on this line.
    // Both run until a blank line.
    let isBlock = false;
    const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)((?: +|\n|\/?>|$))/.exec(rest);
    if (m6) {
      const name = m6[1].toLowerCase();
      const blockNames = BLOCK_TAGS.split('|');
      // The tag must be a block tag, or a closing tag of one.
      const base = name.replace(/^h[1-6]$/, 'h');
      if (blockNames.includes(name) || (base === 'h' && /^h[1-6]$/.test(name))) isBlock = true;
    }
    let isTag7 = false;
    if (!isBlock) {
      isTag7 = isCompleteTagLine(rest);
    }
    if (!isBlock && !isTag7) return null;
    // Run until a blank line.
    let p = lineStart + rest.length;
    endPos = p;
    // The first line is included; consume following lines until a blank one.
    let q = pos;
    // Find the end of the first line.
    const nl0 = src.indexOf('\n', pos);
    q = nl0 === -1 ? src.length : nl0 + 1;
    while (q < src.length) {
      const { line: l, next } = lineAt(src, q);
      if (isBlankLine(l)) { html67blank = true; break; }
      endPos = q + l.length;
      q = next;
    }
  }
  // Consume following newlines (the match's trailing \n*).
  let end = endPos;
  while (end < src.length && src[end] === '\n') end++;
  if (html67blank) {
    // Type 6/7: marked's match runs through the terminating blank line(s)
    // and its `ge` then strips them; consume them so trimBlankTail agrees
    // (a whitespace-only blank line otherwise leaves one stray '\n').
    while (end < src.length) {
      const { line: l, next } = lineAt(src, end);
      if (!isBlankLine(l)) break;
      end = next;
    }
  }
  const text = trimBlankTail(src.slice(pos, end));
  return { node: { k: 'm', t: text }, end };
}

// Is `rest` a complete open or close tag on its own line (type 7)? The tag
// must not be script/pre/style/textarea, must be well-formed, and must be
// followed only by spaces/tabs to the end of the line.
function isCompleteTagLine(rest) {
  if (rest[0] !== '<') return false;
  let i = 1;
  let closing = false;
  if (rest[i] === '/') { closing = true; i++; }
  if (i >= rest.length || !/[A-Za-z]/.test(rest[i])) return false;
  let name = '';
  while (i < rest.length && /[A-Za-z0-9-]/.test(rest[i])) { name += rest[i]; i++; }
  const low = name.toLowerCase();
  if (!closing && (low === 'script' || low === 'pre' || low === 'style' || low === 'textarea')) return false;
  if (closing) {
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
    return rest[i] === '>' && /^[ \t]*$/.test(rest.slice(i + 1));
  }
  // Attributes: each one must be preceded by whitespace (a ':' right
  // after the tag name is not an attribute — '<m:abc>' is not a tag).
  for (;;) {
    let spaces = 0;
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) { i++; spaces++; }
    if (i >= rest.length) return false;
    if (rest[i] === '>') return /^[ \t]*$/.test(rest.slice(i + 1));
    if (rest[i] === '/' && rest[i + 1] === '>') return /^[ \t]*$/.test(rest.slice(i + 2));
    if (spaces === 0 || !/[A-Za-z:_]/.test(rest[i])) return false;
    while (i < rest.length && /[\w.:-]/.test(rest[i])) i++;
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
    if (rest[i] === '=') {
      i++;
      while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
      if (rest[i] === '"' || rest[i] === "'") {
        const q = rest[i];
        i++;
        while (i < rest.length && rest[i] !== q) i++;
        if (i >= rest.length) return false;
        i++;
      } else {
        if (i >= rest.length || /[\s"'=<>`]/.test(rest[i])) return false;
        while (i < rest.length && !/[\s"'=<>`]/.test(rest[i])) i++;
      }
    }
  }
}

const DEF_LABEL_RE = String.raw`(?:\\[\s\S]|[^\[\]\n]|\n(?![ \t]*\n))+`;
const DEF_TITLE_RE = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)`;
const DEF_RE = new RegExp(
  `^ {0,3}\\[((?!\\s*\\])${DEF_LABEL_RE})\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(${DEF_TITLE_RE}))? *(?:\\n+|$)`,
);

// Link reference definition. Returns {tag, href, title, raw, end} or null.
function tryDef(src, pos, links) {
  const rest = src.slice(pos);
  const m = DEF_RE.exec(rest);
  if (!m) return null;
  const dest = m[2];
  if (!dest.startsWith('<') && findUnmatched(dest, '(', ')') !== -1) return null;
  const href = dest ? unescapePunct(dest.replace(/^<(.*)>$/, '$1')) : '';
  const title = m[3] ? unescapePunct(m[3].slice(1, -1)) : null;
  const raw = stripTrailing(m[0], '\n', false);
  return { tag: normLabel(m[1]), href, title, raw, end: pos + m[0].length };
}

// GFM table. Returns {node, end} or null.
function tryTable(src, pos) {
  const { line: hline, next: hnext } = lineAt(src, pos);
  let i = 0;
  while (i < hline.length && hline[i] === ' ') i++;
  if (i >= hline.length) return null;
  const header = hline.slice(i);
  const { line: dline, next: dnext } = lineAt(src, hnext);
  const align = tableDelimiter(dline);
  if (!align) return null;
  const headerCells = splitCells(header);
  if (headerCells.length !== align.length) return null;
  const rows = [];
  let p = dnext;
  let end = dnext;
  while (p < src.length) {
    const { line, next } = lineAt(src, p);
    // marked's table row line must not be blank-of-spaces only (` *\n`):
    // a line holding a tab (even otherwise blank) IS a row, padded out.
    if (/^ *$/.test(line)) break;
    if (hrChar(line) || atxDepth(line) || quoteMarkerLen(line) >= 0 || fenceStart(line)) break;
    if (HTML_OPEN_RE.test(line)) break;
    // Indented code line: 4 spaces, or up to 3 spaces and a tab, each
    // followed by another character (a bare tab line is a row, not code).
    let ci = 0;
    while (ci < 3 && line[ci] === ' ') ci++;
    if ((line.slice(0, 4) === '    ' && line.length > 4) || (line[ci] === '\t' && ci + 1 < line.length)) break;
    // List line (table rows): a bullet, or '1.' / '1)', then a space/tab.
    const lm = listMarker(line);
    if (lm && (lm.ordered ? lm.start === 1 : true)) {
      const after = line[lm.after];
      if (after === ' ' || after === '\t') break;
    }
    rows.push(splitCells(line, headerCells.length));
    end = next;
    p = next;
  }
  // Consume following newlines, like the table regex's trailing \n*.
  while (end < src.length && src[end] === '\n') end++;
  const head = headerCells.map((t, idx) => ({ t, a: align[idx] }));
  const body = rows.map((r) => r.map((t, idx) => ({ t, a: align[idx] })));
  return { node: { k: 't', head, rows: body }, end };
}

// Is `line` a valid lazy paragraph continuation after `lastLine`? Both are
// stripped (marker-less) lines. A setext underline is allowed: it is
// gathered and then indented into paragraph text by the setext replace.
function isParaContinuation(line, lastLine) {
  if (!lastLine || isBlankLine(lastLine)) return false;
  if (isBlankLine(line)) return false;
  // A setext underline continues the paragraph — except '---', which is
  // also a thematic break and ends the quote instead (marked's blockquote
  // paragraph excludes hr lines).
  if (setextDepth(line) > 0 && !hrChar(line)) return true;
  // Only the line itself decides: marked's paragraph lookahead tests the
  // continuation line, not the line before it (a list or quote line can
  // still be continued lazily; the sub-chunk split sorts out the rest).
  // A list marker line is never a lazy continuation, though: marked's
  // blockquote paragraph excludes every list marker (any bullet, any
  // ordered start), unlike a top-level paragraph where only '1.'
  // interrupts — so `> foo` followed by `4. bar` closes the quote.
  const lm = listMarker(line);
  if (lm) {
    const after = line[lm.after];
    if (after === ' ' || after === '\t' || after === undefined) return false;
  }
  if (interruptsParagraph(line)) return false;
  return true;
}

// Blockquote. Returns {node, end} or null.
//
// Mirrors marked's blockquote tokenizer in two phases. Phase 1 gathers the
// lines its blockquote regex matches: marker lines plus lazy paragraph
// continuations (a paragraph started after a marker may span following
// lines that do not interrupt it). Phase 2 splits those lines into
// sub-chunks — a sub-chunk ends at the first non-marker line that follows
// a marker line — parses each one separately (paragraphs merge across
// sub-chunks), and stops after a sub-chunk whose last token is code,
// heading, hr, html or a table, so the lines after it stay outside the
// quote. A nested quote or list at the end of a sub-chunk is re-parsed
// against the remaining matched lines, so it can absorb them.
function tryBlockquote(src, pos, links, st) {
  const { line: firstLine } = lineAt(src, pos);
  if (quoteMarkerLen(firstLine) < 0) return null;
  // Phase 1: the matched lines.
  const matched = [];
  let p = pos;
  let lastInner = null;
  while (p < src.length) {
    const { line, next } = lineAt(src, p);
    const ml = quoteMarkerLen(line);
    if (ml >= 0) {
      matched.push({ line, start: p, next });
      lastInner = line.slice(ml);
      p = next;
      continue;
    }
    if (!isParaContinuation(line, lastInner)) break;
    matched.push({ line, start: p, next });
    lastInner = line;
    p = next;
  }
  if (matched.length === 0) return null;
  // Phase 2: sub-chunks.
  let n = matched.slice();
  let rawAcc = '';
  let textAcc = '';
  const nodes = [];
  for (;;) {
    let i = false;
    const l = [];
    let q = 0;
    for (q = 0; q < n.length; q++) {
      if (quoteMarkerLen(n[q].line) >= 0) { l.push(n[q]); i = true; }
      else if (!i) l.push(n[q]);
      else break;
    }
    n = n.slice(q);
    if (l.length === 0) break;
    const h = l.map((x) => x.line).join('\n');
    // Marker whitespace expansion, setext indent, marker strip.
    let t = h.replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length));
    t = t.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    const u = t.replace(/^ {0,3}>[ \t]?/gm, '');
    rawAcc = rawAcc ? rawAcc + '\n' + h : h;
    textAcc = textAcc ? textAcc + '\n' + u : u;
    // Parse into the shared node array: the first paragraph of this
    // sub-chunk merges with the previous sub-chunk's last paragraph.
    blockTokens(u, true, links, st, true, nodes);
    if (n.length === 0) break;
    const last = nodes[nodes.length - 1];
    if (!last) break;
    if (last.k === 'c' || last.k === 'h' || last.k === 'r' || last.k === 'm' || last.k === 't') break;
    if (last.k === 'q') {
      // The inner quote may continue past the chunk on the remaining
      // matched lines (with their markers stripped).
      const mStr = last.raw + '\n' + n.map((x) => x.line).join('\n').replace(/^ {0,3}>[ \t]?/gm, '');
      const f = tryBlockquote(mStr, 0, links, st);
      if (!f) break;
      const y = mStr.slice(f.end).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) {
        rawAcc += '\n' + A.map((x) => x.line).join('\n');
        textAcc = textAcc.slice(0, textAcc.length - last.text.length) + f.node.text;
        nodes[nodes.length - 1] = f.node;
        n = n.slice(A.length);
        if (n.length > 0 && quoteMarkerLen(n[0].line) >= 0) continue;
      }
      break;
    }
    if (last.k === 'l') {
      // The inner list may continue past the chunk on the remaining
      // matched lines.
      const b = last.raw + '\n' + n.map((x) => x.line).join('\n');
      const mNode = tryList(b, 0, links, st);
      if (!mNode) break;
      const f = mNode.node.raw.length > last.raw.length
        ? b.slice(last.raw.length + 1, mNode.node.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).map((x) => x.line).join('\n');
        rawAcc += '\n' + y;
        textAcc += '\n' + y;
        nodes[nodes.length - 1] = mNode.node;
        n = n.slice(f);
        continue;
      }
      break;
    }
    // Paragraph/text (or anything else): parse the next sub-chunk.
  }
  // `end` sits just past the last consumed line's text, before its newline,
  // so the caller's blank-line handling sees the newline.
  const consumed = matched.length - n.length;
  const lastLine = matched[consumed - 1];
  const end = lastLine.start + lastLine.line.length;
  return { node: { k: 'q', ch: nodes, raw: rawAcc, text: textAcc }, end };
}

// Is `a` valid heading text for the setext line `b` (the lheading test)?
function isLheadingPair(a, b) {
  return setextDepth(b) > 0 && a.trim() !== '' && !interruptsParagraph(a);
}

// List. Returns {node, end} or null.
function tryList(src, pos, links, st) {
  const rest = src.slice(pos);
  const m0 = LIST_START_RE.exec(rest);
  if (!m0) return null;
  const marker = m0[1].trim();
  const ordered = marker.length > 1;
  const start = ordered ? parseInt(marker.slice(0, -1), 10) : 0;
  const delim = ordered ? marker.slice(-1) : marker;
  const esc = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const itemRe = ordered
    ? new RegExp(`^( {0,3}\\d{1,9}${esc})((?:[ \\t][^\\n]*)?(?:\\n|$))`)
    : new RegExp(`^( {0,3}${esc})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
  let e = rest;
  let consumed = 0;
  const items = [];
  let loose = false;
  let pFlag = false;
  while (e.length > 0) {
    const t = itemRe.exec(e);
    if (!t || HR_RE.test(e)) break;
    const itemStart = consumed;
    const rawStart = e.length;
    e = e.substring(t[0].length);
    const g = t[2] ? t[2].split('\n', 1)[0] : '';
    const b = t[1].length;
    const m = g.replace(/^[ \t]+/, (v) => expandTabs(v, b));
    const f0 = e.split('\n', 1)[0];
    const y0 = !m.trim();
    let R = 0;
    let d = '';
    if (y0) R = b + 1;
    else {
      R = m.search(/[^ ]/);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    let u = false;
    if (y0 && BLANK_LINE_RE.test(f0)) {
      e = e.substring(f0.length + 1);
      u = true;
    }
    if (!u) {
      // marked caps these lookahead indents at 3 (its D() cache helper
      // builds them with min(3, R-1)): a sub-list marker with more leading
      // spaces than that is a continuation, not a new sibling item.
      const rc = Math.max(0, Math.min(3, R - 1));
      const nextBulletRe = new RegExp(`^ {0,${rc}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
      const hrRe = new RegExp(`^ {0,${rc}}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
      const fencesRe = new RegExp(`^ {0,${rc}}(?:\\\`\\\`\\\`|~~~)`);
      const headingRe = new RegExp(`^ {0,${rc}}#{1,6}(?:\\s|$)`);
      const htmlRe = new RegExp(`^ {0,${rc}}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>|$)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
      const bqRe = new RegExp(`^ {0,${rc}}>`);
      let prevContent = m;
      let y = y0;
      while (e.length > 0) {
        const U = e.split('\n', 1)[0];
        const Z = U.replace(/^[ \t]+/, (me) => expandTabs(me, 0));
        if (fencesRe.test(U) || headingRe.test(U) || htmlRe.test(U) || bqRe.test(U) || nextBulletRe.test(U) || hrRe.test(U)) break;
        if (Z.search(/[^ ]/) >= R || !U.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || prevContent.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || fencesRe.test(prevContent) || headingRe.test(prevContent) || htmlRe.test(prevContent) || hrRe.test(prevContent)) break;
          const qe = isLheadingPair(prevContent, U) ? '    ' + Z.replace(/^ {0,3}/, '') : U;
          d += '\n' + qe;
        }
        y = !U.trim();
        e = e.substring(U.length + 1);
        prevContent = Z.slice(R);
      }
    }
    consumed += rawStart - e.length;
    const itemRaw = rest.slice(itemStart, consumed);
    if (!loose) {
      if (pFlag) loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(itemRaw)) pFlag = true;
    }
    items.push({ task: /^\[[ xX]\][ \t]+\S/.test(d), text: d, raw: itemRaw });
  }
  if (items.length === 0) return null;
  const lastItem = items[items.length - 1];
  lastItem.text = lastItem.text.trimEnd();
  lastItem.raw = lastItem.raw.trimEnd();
  const listRaw = rest.slice(0, consumed).trimEnd();
  const end = pos + listRaw.length;
  // Parse each item's children (top = false).
  for (const it of items) {
    const inner = blockTokens(it.text, false, links, st, false);
    it.ch = inner.nodes;
    it.hadBlank = inner.blank;
  }
  if (!loose) {
    for (const it of items) { if (it.hadBlank) { loose = true; break; } }
  }
  // Task items: checkbox on the first paragraph/text child.
  for (const it of items) {
    if (!it.task) continue;
    const tm = /^\[([ xX])\]/.exec(it.text);
    const checked = !!(tm && tm[1].toLowerCase() === 'x');
    const first = it.ch[0];
    if (first && (first.k === 'p' || first.k === 'x')) {
      first.check = true;
      first.checked = checked;
      first.t = first.t.replace(/^\[[ xX]\]\s+/, '');
    } else {
      it.ch.unshift({ k: 'p', t: '', check: true, checked });
    }
  }
  // Loose lists: text children become paragraphs.
  for (const it of items) {
    it.loose = loose;
    if (loose) {
      for (const c of it.ch) { if (c.k === 'x') c.k = 'p'; }
    }
  }
  return { node: { k: 'l', ord: ordered, start, loose, items, raw: listRaw }, end };
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------
// Render a block node tree to HTML (marked's Parser, specialised to the
// node shapes above).
function renderBlock(nodes, links, st) {
  let out = '';
  for (let x = 0; x < nodes.length; x++) {
    const nd = nodes[x];
    switch (nd.k) {
      case 'p': {
        out += '<p>';
        if (nd.check) out += '<input ' + (nd.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        out += inlineToHtml(nd.t, links, st);
        out += '</p>\n';
        break;
      }
      case 'x': {
        // Text inside a list item: inline content, no wrapper, no newline.
        if (nd.check) out += '<input ' + (nd.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        out += inlineToHtml(nd.t, links, st);
        break;
      }
      case 'h': {
        out += '<h' + nd.d + '>' + inlineToHtml(nd.t, links, st) + '</h' + nd.d + '>\n';
        break;
      }
      case 'c': {
        // Code: first word of the info string is the language; the text
        // loses one trailing newline and gains one back (empty stays empty).
        const langWord = nd.lang ? nd.lang.match(/^\S*/)[0] : '';
        const text = nd.t ? nd.t.replace(/\n$/, '') + '\n' : '';
        out += '<pre><code';
        if (langWord) out += ' class="language-' + esc(langWord, false) + '"';
        out += '>' + esc(text, true) + '</code></pre>\n';
        break;
      }
      case 'r':
        out += '<hr>\n';
        break;
      case 'm':
        // HTML block: the token text, exactly as collected.
        out += nd.t;
        break;
      case 'q': {
        out += '<blockquote>\n' + renderBlock(nd.ch, links, st) + '</blockquote>\n';
        break;
      }
      case 'l': {
        const tag = nd.ord ? 'ol' : 'ul';
        out += '<' + tag + (nd.ord && nd.start !== 1 ? ' start="' + nd.start + '"' : '') + '>\n';
        for (const it of nd.items) {
          out += '<li>' + renderBlock(it.ch, links, st) + '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 't': {
        let head = '';
        for (const cell of nd.head) {
          head += '<th' + (cell.a ? ' align="' + cell.a + '"' : '') + '>' + inlineToHtml(cell.t, links, st) + '</th>\n';
        }
        let body = '';
        for (const row of nd.rows) {
          let cells = '';
          for (const cell of row) {
            cells += '<td' + (cell.a ? ' align="' + cell.a + '"' : '') + '>' + inlineToHtml(cell.t, links, st) + '</td>\n';
          }
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
        if (body) out += '<tbody>' + body + '</tbody>';
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

// The entry point: the HTML marked 18.1.3 renders for `markdown`, with
// marked's defaults. CR and CRLF line endings are normalised to LF first,
// the way marked's lexer does.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const links = Object.create(null);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  const { nodes } = blockTokens(src, true, links, st, false);
  return renderBlock(nodes, links, st);
}
export { maskInline as __maskInlineForTest };
export { MASK_BLOCKSKIP as __maskBS, MASK_OT as __maskOT };
