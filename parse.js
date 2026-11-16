// SwiftMark — a fast drop-in renderer for marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29).
// Written from scratch against the CommonMark/GFM specifications and the practice set.
// Single-pass block parser + delimiter-stack inline parser, dependency free.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isWs(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11; }

// Unicode punctuation / symbol test (for flanking rules). Cached per char via a small map.
const punctCache = new Map();
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isUniPunct(ch) {
  let v = punctCache.get(ch);
  if (v === undefined) { v = PUNCT_RE.test(ch); if (punctCache.size < 4096) punctCache.set(ch, v); }
  return v;
}

// Escape &, <, >, ", ' — but leave a valid entity reference (&name; &#123; &#xAB;) untouched.
function escText(s) {
  if (!s) return s;
  let out = '', i = 0, n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const m = entityAt(s, i);
      if (m > 0) { out += s.slice(i, m); i = m; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    out += s[i]; i++;
  }
  return out;
}

// Escape every &, <, >, ", ' (code spans, code blocks).
function escAll(s) {
  if (!s) return s;
  let out = '', i = 0, n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += '&amp;'; i++; continue; }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    out += s[i]; i++;
  }
  return out;
}

// If s has a valid entity reference at i (&word; &#123; &#xAB;), return the index after it, else 0.
function entityAt(s, i) {
  const n = s.length;
  if (s[i] !== '&') return 0;
  let j = i + 1;
  if (j < n && s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    let count = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? ((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))
              : (c >= 48 && c <= 57)) { j++; count++; }
      else break;
    }
    if (count === 0) return 0;
    if (hex ? count > 6 : count > 7) return 0;
    if (j < n && s[j] === ';') return j + 1;
    return 0;
  }
  let count = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c)) { j++; count++; }
    else break;
  }
  if (count === 0) return 0;
  if (j < n && s[j] === ';') return j + 1;
  return 0;
}

// Decode a numeric character reference at i (s[i] === '&', s[i+1] === '#').
// Returns {ch, next} or null.
function decodeNumeric(s, i) {
  const n = s.length;
  let j = i + 2;
  let hex = false;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
  const start = j;
  let count = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (hex ? ((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))
            : (c >= 48 && c <= 57)) { j++; count++; }
    else break;
  }
  if (count === 0) return null;
  if (hex ? count > 6 : count > 7) return null;
  if (j >= n || s[j] !== ';') return null;
  let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return { ch: String.fromCodePoint(cp), next: j + 1 };
}

// Percent-encode a URL the way marked's cleanUrl does (encodeURI-like) and block
// dangerous schemes. Returns the cleaned URL or null when it must not link.
function cleanUrl(url) {
  let u = '';
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c < 32 || c === 127) continue; // drop control chars; spaces are encoded
    u += url[i];
  }
  if (!u) return '';
  try { u = encodeURI(u).replace(/%25/g, '%'); } catch (e) { /* keep raw */ }
  const low = u.toLowerCase();
  if (/^(?:javascript|vbscript|data):/.test(low)) {
    if (/^data:image\/(?:png|gif|jpe?g|webp)/.test(low)) return u;
    return null;
  }
  return u;
}

function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Flanking info for a delimiter run at [start,end) in src.
function flanking(src, start, end) {
  const before = start > 0 ? src[start - 1] : '';
  const after = end < src.length ? src[end] : '';
  const beforeWs = before === '' || isWs(before.charCodeAt(0));
  const afterWs = after === '' || isWs(after.charCodeAt(0));
  const beforePunct = before !== '' && isUniPunct(before);
  const afterPunct = after !== '' && isUniPunct(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { leftFlanking, rightFlanking };
}

// (canOpen / canClose are computed inline in inline() from flanking())

// Scan a backtick run starting at i. Returns its length.
function tickRun(src, i) {
  let j = i;
  while (j < src.length && src.charCodeAt(j) === 96) j++;
  return j - i;
}

// Find the end of a code span whose opener is a run of `run` backticks starting
// just after `from`. Returns index just after the closing run, or -1.
function findCodeEnd(src, from, run) {
  let i = from;
  const n = src.length;
  while (i < n) {
    if (src.charCodeAt(i) === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      if (j - i === run) return j;
      i = j;
    } else i++;
  }
  return -1;
}

// Parse a link label starting at src[i] === '['. Returns {label, next} or null.
function parseLabel(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      const run = tickRun(src, j);
      const end = findCodeEnd(src, j + run, run);
      if (end === -1) { j += run; continue; }
      j = end; continue;
    }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return { label: src.slice(i + 1, j), next: j + 1 };
    }
    j++;
  }
  return null;
}

function skipWsNl(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse a link destination starting at i (after '(' + optional whitespace).
// Returns {dest, next} where dest is the raw destination (escapes kept) or null.
function parseDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src.charCodeAt(i) === 60) { // <...>
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 10 || c === 60) return null;
      if (c === 92) { j += 2; continue; }
      if (c === 62) return { dest: src.slice(i + 1, j), next: j + 1, angle: true };
      j++;
    }
    return null;
  }
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 32 || c === 9 || c === 10) break;
    if (c < 32) break;
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return { dest: '', next: j, angle: false };
  return { dest: src.slice(i, j), next: j, angle: false };
}

// Process backslash escapes in a destination or title (only before ASCII punct).
function unescapeDest(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '', i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Parse a link title starting at i. Returns {title, next} or null.
function parseTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const q = src.charCodeAt(i);
  let close;
  if (q === 34) close = 34;
  else if (q === 39) close = 39;
  else if (q === 40) close = 41;
  else return null;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === close) return { title: src.slice(i + 1, j), next: j + 1 };
    j++;
  }
  return null;
}

// Parse an inline link "(...)" starting at src[i] === '('. Returns {dest, title, next} or null.
function parseInlineLink(src, i) {
  let j = skipWsNl(src, i + 1);
  const d = parseDest(src, j);
  if (!d) return null;
  j = skipWsNl(src, d.next);
  let title = null;
  if (j < src.length) {
    const q = src.charCodeAt(j);
    if (q === 34 || q === 39 || q === 40) {
      const t = parseTitle(src, j);
      if (!t) return null;
      title = t.title;
      j = skipWsNl(src, t.next);
    }
  }
  if (j < src.length && src.charCodeAt(j) === 41) {
    return { dest: d.dest, angle: d.angle, title, next: j + 1 };
  }
  return null;
}

// Extended autolink helpers -------------------------------------------------
const TRAIL_PUNCT = new Set([63, 33, 46, 44, 58, 59, 42, 95, 126]); // ? ! . , : ; * _ ~

function isDomainLabelChar(c) { return isAlnum(c) || c === 45; }

// Match a domain starting at i: labels of [A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?
// joined by '.', last label letters only, >= 2 chars. Returns end index or -1.
function matchDomain(src, i) {
  const n = src.length;
  let j = i;
  let labels = 0;
  let lastStart = -1, lastEnd = -1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (!isAlnum(c)) return -1;
    const ls = j;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (isAlnum(d) || d === 45) j++;
      else break;
    }
    // label must not end with '-'
    if (src.charCodeAt(j - 1) === 45) return -1;
    labels++;
    lastStart = ls; lastEnd = j;
    if (j < n && src.charCodeAt(j) === 46) { // .
      // dot must be followed by a label char
      if (j + 1 < n && isAlnum(src.charCodeAt(j + 1))) { j++; continue; }
      break;
    }
    break;
  }
  if (labels < 2) return -1;
  // TLD: letters only, >= 2
  if (lastEnd - lastStart < 2) return -1;
  for (let k = lastStart; k < lastEnd; k++) {
    if (!isAlpha(src.charCodeAt(k))) return -1;
  }
  return lastEnd;
}

// Match an email starting at i (local part). Returns end index or -1.
// Domain labels need at least one dot; the char after must not be [A-Za-z0-9_-].
function matchEmail(src, i) {
  const n = src.length;
  let j = i;
  const localStart = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
        c === 39 || c === 42 || c === 43 || c === 45 || c === 47 || c === 61 || c === 63 ||
        c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126) j++;
    else break;
  }
  if (j === localStart) return -1;
  if (j >= n || src.charCodeAt(j) !== 64) return -1; // @
  j++;
  // domain: labels, at least one dot
  let labels = 0;
  let dots = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (!isAlnum(c)) return -1;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (isAlnum(d) || d === 45) j++;
      else break;
    }
    if (src.charCodeAt(j - 1) === 45) return -1;
    labels++;
    if (j < n && src.charCodeAt(j) === 46) {
      if (j + 1 < n && isAlnum(src.charCodeAt(j + 1))) { dots++; j++; continue; }
      break;
    }
    break;
  }
  if (labels < 2 || dots < 1) return -1;
  // char after must not be alnum, '-', '_'
  if (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnum(c) || c === 45 || c === 95) return -1;
  }
  return j;
}

// Trim trailing punctuation / unbalanced ')' / entity-like '&...;' from an autolink.
function trimAutolink(s) {
  let end = s.length;
  let changed = true;
  while (changed && end > 0) {
    changed = false;
    // entity-like suffix &word;
    if (end >= 2 && s.charCodeAt(end - 1) === 59) { // ;
      let k = end - 2;
      while (k >= 0 && isAlnum(s.charCodeAt(k))) k--;
      if (k >= 0 && s.charCodeAt(k) === 38 && k < end - 2) {
        // only strip if the '&' is preceded by start or a non-word char within the link
        end = k; changed = true; continue;
      }
    }
    if (end > 0 && TRAIL_PUNCT.has(s.charCodeAt(end - 1))) { end--; changed = true; continue; }
    if (end > 0 && s.charCodeAt(end - 1) === 41) { // )
      let open = 0, close = 0;
      for (let k = 0; k < end; k++) {
        if (s.charCodeAt(k) === 40) open++;
        else if (s.charCodeAt(k) === 41) close++;
      }
      if (close > open) { end--; changed = true; continue; }
    }
  }
  return s.slice(0, end);
}

// Try an extended autolink (www. / scheme / email) at position i.
// prevOk: the char before i is start / whitespace / * _ ~ ( . Returns {html, next} or null.
function tryExtAutolink(src, i, prevOk) {
  const n = src.length;
  if (!prevOk) return null;
  // www.
  if (src.charCodeAt(i) === 119 && src.startsWith('www.', i)) {
    const d = matchDomain(src, i + 4);
    if (d === -1) return null;
    let j = d;
    if (j < n && src.charCodeAt(j) === 47) { // path
      while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
        j++;
      }
    }
    const raw = trimAutolink(src.slice(i, j));
    if (!raw) return null;
    const href = 'http://' + raw;
    return { html: '<a href="' + escText(cleanUrl(href) ?? href) + '">' + escText(raw) + '</a>', next: i + raw.length };
  }
  // scheme or email: must start with a letter
  const c0 = src.charCodeAt(i);
  if (!isAlpha(c0)) return null;
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  let j = i + 1;
  while (j < n && j - i < 32) {
    const c = src.charCodeAt(j);
    if (isAlnum(c) || c === 43 || c === 45 || c === 46) j++;
    else break;
  }
  if (j - i >= 2 && j < n && src.charCodeAt(j) === 58) { // :
    const scheme = src.slice(i, j);
    let k = j + 1;
    if (src.startsWith('//', k)) {
      const d = matchDomain(src, k + 2);
      if (d !== -1) {
        let m = d;
        if (m < n && src.charCodeAt(m) === 47) {
          while (m < n) {
            const c = src.charCodeAt(m);
            if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
            m++;
          }
        }
        const raw = trimAutolink(src.slice(i, m));
        if (raw) {
          return { html: '<a href="' + escText(cleanUrl(raw) ?? raw) + '">' + escText(raw) + '</a>', next: i + raw.length };
        }
      }
      return null;
    }
    // scheme:email[/segment]
    const e = matchEmail(src, k);
    if (e !== -1) {
      let m = e;
      if (m < n && src.charCodeAt(m) === 47) { // single path segment
        let q = m + 1;
        while (q < n) {
          const c = src.charCodeAt(q);
          if (c === 32 || c === 9 || c === 10 || c === 60 || c === 47 || c < 32) break;
          q++;
        }
        if (q > m + 1) m = q;
      }
      const raw = trimAutolink(src.slice(i, m));
      if (raw) {
        return { html: '<a href="' + escText(cleanUrl(raw) ?? raw) + '">' + escText(raw) + '</a>', next: i + raw.length };
      }
    }
    return null;
  }
  // bare email (only at a word start: caller guarantees)
  const e = matchEmail(src, i);
  if (e !== -1) {
    const raw = src.slice(i, e);
    return { html: '<a href="mailto:' + escText(raw) + '">' + escText(raw) + '</a>', next: e };
  }
  return null;
}

// Resolve emphasis / strikethrough delimiters in `parts` (strings and delim objects).
function resolveDelims(parts) {
  const stacks = { '*': [], '_': [], '~': [] };
  for (let j = 0; j < parts.length; j++) {
    const p = parts[j];
    if (typeof p !== 'object' || p.n === 0) continue;
    if (p.close) {
      const stack = stacks[p.d];
      let oi = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        const cand = parts[stack[k]];
        if (!cand || cand.n === 0) { stack.splice(k, 1); continue; }
        if (p.d !== '~' && (cand.open && cand.close || p.open && p.close) &&
            (cand.n + p.n) % 3 === 0 && !(cand.n % 3 === 0 && p.n % 3 === 0)) continue;
        if (p.d === '~' && cand.n !== p.n) continue;
        oi = stack[k]; break;
      }
      if (oi === -1) { if (p.open) stack.push(j); continue; }
      const o = parts[oi];
      const use = p.d === '~' ? 2 : (o.n >= 2 && p.n >= 2 ? 2 : 1);
      const ot = p.d === '~' ? '<del>' : (use === 2 ? '<strong>' : '<em>');
      const ct = p.d === '~' ? '</del>' : (use === 2 ? '</strong>' : '</em>');
      o.n -= use; p.n -= use;
      o.otags = ot + (o.otags || '');
      p.ctags = (p.ctags || '') + ct;
      if (o.n === 0) { const ix = stack.indexOf(oi); if (ix >= 0) stack.splice(ix, 1); }
      if (p.n > 0 && p.open) stack.push(j);
    } else if (p.open) {
      stacks[p.d].push(j);
    }
  }
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') { out += p; continue; }
    out += (p.ctags || '');
    if (p.n > 0) out += p.d.repeat(p.n);
    out += (p.otags || '');
  }
  return out;
}

// Inline HTML tag at i. Returns {html, next} or null.
function parseHtmlTag(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) !== 60) return null;
  // comment
  if (src.startsWith('<!--', i)) {
    const end = src.indexOf('-->', i + 4);
    if (end === -1) return { html: src.slice(i), next: n };
    return { html: src.slice(i, end + 3), next: end + 3 };
  }
  // processing instruction
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    if (end === -1) return { html: src.slice(i), next: n };
    return { html: src.slice(i, end + 2), next: end + 2 };
  }
  // declaration
  if (src.startsWith('<!', i)) {
    const c = src.charCodeAt(i + 2);
    if (c >= 65 && c <= 90) {
      const end = src.indexOf('>', i + 2);
      if (end === -1) return null;
      return { html: src.slice(i, end + 1), next: end + 1 };
    }
  }
  // CDATA
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    if (end === -1) return { html: src.slice(i), next: n };
    return { html: src.slice(i, end + 3), next: end + 3 };
  }
  // open / close tag (validated, so `<https://x>` falls through to autolink)
  const end = parseTagAt(src, i);
  if (end === -1) return null;
  return { html: src.slice(i, end), next: end };
}

// Angle-bracket autolink <...> at i. Returns {html, next} or null.
function parseAngleAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 10 || c === 60) return null;
    if (c === 62) break;
    j++;
  }
  if (j >= n || j === i + 1) return null;
  const inner = src.slice(i + 1, j);
  if (inner.indexOf('@') !== -1 && /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner)) {
    // scheme:email form
    return { html: '<a href="' + escText(cleanUrl(inner) ?? inner) + '">' + escText(inner) + '</a>', next: j + 1 };
  }
  if (inner.indexOf('@') !== -1) {
    return { html: '<a href="mailto:' + escText(inner) + '">' + escText(inner) + '</a>', next: j + 1 };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner) && inner.indexOf(':/') !== -1) {
    return { html: '<a href="' + escText(cleanUrl(inner) ?? inner) + '">' + escText(inner) + '</a>', next: j + 1 };
  }
  return null;
}

// Main inline parser. refs: Map<label, {dest, title}>.
function inline(src, refs, inLink, inImg) {
  const parts = [];
  let text = '';
  const n = src.length;
  let i = 0;
  const flush = () => { if (text) { parts.push(escText(text)); text = ''; } };
  const pushHtml = (s) => { flush(); parts.push(s); };
  const localChars = (c) => isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
    c === 38 || c === 39 || c === 42 || c === 43 || c === 45 || c === 47 || c === 61 || c === 63 ||
    c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126;

  while (i < n) {
    const c = src.charCodeAt(i);
    // backslash escape
    if (c === 92) {
      const d = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      if (d === 10) { pushHtml('<br>'); i += 2; continue; }
      if (d >= 0 && isPunct(d)) { flush(); parts.push(ESCAPES[src[i + 1]] || src[i + 1]); i += 2; continue; }
      text += '\\'; i++; continue;
    }
    // code span
    if (c === 96) {
      const run = tickRun(src, i);
      const end = findCodeEnd(src, i + run, run);
      if (end === -1) { text += src.slice(i, i + run); i += run; continue; }
      let content = src.slice(i + run, end - run);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== '') {
        content = content.slice(1, -1);
      }
      pushHtml('<code>' + escAll(content) + '</code>');
      i = end; continue;
    }
    // emphasis / strikethrough delimiters
    if (c === 42 || c === 95 || c === 126) {
      const ch = src[i];
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const len = j - i;
      if (ch === '~' && len >= 3) { text += src.slice(i, j); i = j; continue; }
      const f = flanking(src, i, j);
      const before = i > 0 ? src[i - 1] : '';
      const after = j < n ? src[j] : '';
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = f.leftFlanking && (!f.rightFlanking || (before !== '' && isUniPunct(before)));
        canClose = f.rightFlanking && (!f.leftFlanking || (after !== '' && isUniPunct(after)));
      } else {
        canOpen = f.leftFlanking;
        canClose = f.rightFlanking;
      }
      if (!canOpen && !canClose) { text += src.slice(i, j); i = j; continue; }
      flush();
      parts.push({ d: ch, n: len, open: canOpen, close: canClose, ctags: '', otags: '' });
      i = j; continue;
    }
    // image / link
    if ((c === 33 && src.charCodeAt(i + 1) === 91 && !inImg) || (c === 91 && !inLink)) {
      const isImg = c === 33;
      const lb = parseLabel(src, isImg ? i + 1 : i);
      if (!lb) { text += isImg ? '!' : '['; i++; continue; }
      let dest = null, title = null, next = -1;
      const after = lb.next;
      if (after < n && src.charCodeAt(after) === 40) {
        const il = parseInlineLink(src, after);
        if (il) { dest = il.dest; title = il.title; next = il.next; }
      } else if (after < n && src.charCodeAt(after) === 91) {
        const lb2 = parseLabel(src, after);
        if (lb2) {
          const key = normalizeLabel(lb2.label === '' ? lb.label : lb2.label);
          const ref = refs.get(key);
          if (ref) { dest = ref.dest; title = ref.title; next = lb2.next; }
        }
      } else {
        const key = normalizeLabel(lb.label);
        const ref = refs.get(key);
        if (ref) { dest = ref.dest; title = ref.title; next = after; }
      }
      if (dest === null) { text += isImg ? '!' : '['; i++; continue; }
      const clean = cleanUrl(unescapeDest(dest));
      if (clean === null) { text += isImg ? '!' : '['; i++; continue; }
      if (isImg) {
        const alt = inline(lb.label, refs, true, true).replace(/"/g, '&quot;');
        let img = '<img src="' + escText(clean) + '" alt="' + alt + '"';
        if (title !== null && title !== undefined) img += ' title="' + escText(unescapeDest(title)) + '"';
        img += '>';
        pushHtml(img);
      } else {
        const inner = inline(lb.label, refs, true, false);
        let a = '<a href="' + escText(clean) + '"';
        if (title !== null && title !== undefined) a += ' title="' + escText(unescapeDest(title)) + '"';
        a += '>' + inner + '</a>';
        pushHtml(a);
      }
      i = next; continue;
    }
    // '<' autolink or html tag
    if (c === 60) {
      const al = parseAngleAutolink(src, i);
      if (al) { pushHtml(al.html); i = al.next; continue; }
      const tag = parseHtmlTag(src, i);
      if (tag) { pushHtml(tag.html); i = tag.next; continue; }
      text += '&lt;'; i++; continue;
    }
    // entity / &
    if (c === 38) {
      const dec = decodeNumeric(src, i);
      if (dec) { flush(); parts.push(escText(dec.ch)); i = dec.next; continue; }
      const ent = entityAt(src, i);
      if (ent > 0) { flush(); parts.push(src.slice(i, ent)); i = ent; continue; }
      text += '&'; i++; continue;
    }
    // newline: hard / soft break
    if (c === 10) {
      let k = text.length;
      let spaces = 0;
      while (k > 0 && text.charCodeAt(k - 1) === 32) { k--; spaces++; }
      if (spaces >= 2) { text = text.slice(0, k); pushHtml('<br>'); }
      else { text += '\n'; }
      i++; continue;
    }
    // extended autolinks: www. / scheme / email
    if (c === 119 || isAlpha(c)) {
      const prev = i === 0 ? '' : src[i - 1];
      const prevOk = i === 0 || isWs(prev.charCodeAt(0)) || prev === '*' || prev === '_' ||
        prev === '~' || prev === '(';
      if (prevOk || isAlnum(c)) {
        // email attempt only at a word start (prev char not a local-part char)
        const wordStart = i === 0 || !localChars(prev.charCodeAt(0));
        if (wordStart || c === 119) {
          const r = tryExtAutolink(src, i, prevOk);
          if (r) { pushHtml(r.html); i = r.next; continue; }
        }
      }
      text += src[i]; i++; continue;
    }
    text += src[i]; i++;
  }
  flush();
  return resolveDelims(parts);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Advance st by n columns of whitespace. Partially consumed tabs become spaces
// in st.s. Returns true on success, false when a non-ws char / EOL is hit first.
function adv(st, n) {
  const target = st.col + n;
  while (st.col < target) {
    if (st.i >= st.s.length) return false;
    const c = st.s[st.i];
    if (c === ' ') { st.i++; st.col++; }
    else if (c === '\t') {
      const w = 4 - (st.col % 4);
      if (st.col + w <= target) { st.i++; st.col += w; }
      else {
        const rem = st.col + w - target;
        st.s = st.s.slice(0, st.i) + ' '.repeat(rem) + st.s.slice(st.i + 1);
        st.col = target;
      }
    } else return false;
  }
  return true;
}

// Remove up to n columns of leading whitespace from a string (a partially
// consumed tab becomes spaces). Used for fence-indent stripping and blank
// lines inside indented code.
function stripUpTo(s, n) {
  const st = { s, i: 0, col: 0 };
  while (st.col < n && st.i < st.s.length) {
    const c = st.s[st.i];
    if (c === ' ') { st.i++; st.col++; }
    else if (c === '\t') {
      const w = 4 - (st.col % 4);
      if (st.col + w <= n) { st.i++; st.col += w; }
      else {
        const rem = st.col + w - n;
        st.s = st.s.slice(0, st.i) + ' '.repeat(rem) + st.s.slice(st.i + 1);
        st.col = n;
      }
    } else break;
  }
  return st.s.slice(st.i);
}

// Columns of leading whitespace in st.s from st.i (without consuming).
function indentCols(st) {
  let col = st.col, i = st.i;
  while (i < st.s.length) {
    const c = st.s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - st.col;
}

const ATX_RE = /^([ \t]{0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const SETEXT_RE = /^([ \t]{0,3})(=+|-+)[ \t]*$/;
const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/;
const HR_RE = /^([ \t]{0,3})((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET_RE = /^([ \t]{0,3})([*+-])([ \t]+|$)(.*)$/;
const ORDERED_RE = /^([ \t]{0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const BLOCKQUOTE_RE = /^([ \t]{0,3})>([ \t]?)(.*)$/;

const BLOCK_TAGS = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;
const RAW_TAGS = /^(?:pre|script|style|textarea)$/i;

// Parse one complete open/close tag starting at s[i] === '<'.
// Returns the index just after '>' or -1 when the tag is not well formed
// (attribute names/values are validated, so `<https://x>` is not a tag).
function parseTagAt(s, i) {
  const n = s.length;
  if (s.charCodeAt(i) !== 60) return -1;
  let j = i + 1;
  if (s.charCodeAt(j) === 47) j++; // /
  if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  while (j < n && isAlnum(s.charCodeAt(j))) j++;
  for (;;) {
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    if (j >= n) return -1;
    const c = s.charCodeAt(j);
    if (c === 62) return j + 1; // >
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2; // />
    if (c === 10 || c === 60) return -1;
    // attribute name: no whitespace, " ' > / = or control chars
    const astart = j;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 62 ||
          d === 47 || d === 61 || d < 32) break;
      j++;
    }
    if (j === astart) return -1;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    if (j < n && s.charCodeAt(j) === 61) { // =
      j++;
      while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 32 || d === 9 || d === 34 || d === 39 || d === 61 || d === 60 ||
              d === 62 || d === 96) break;
          j++;
        }
      }
    }
  }
}

// Are all quotes in s terminated? (An incomplete tag with an unterminated
// quote, e.g. `<a title="a lot`, is not an HTML block start.)
function quotesBalanced(s) {
  let q = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (q === 0 && (c === 34 || c === 39)) q = c;
    else if (q !== 0 && c === q) q = 0;
  }
  return q === 0;
}

// A line that is only HTML tags (open/close/self-closing, with attributes) and
// whitespace, or an incomplete tag with balanced quotes. Such a line starts a
// generic (type 6) HTML block but cannot interrupt a paragraph.
function isGenericHtmlLine(rest) {
  const m = /^[ \t]{0,3}<\/?[A-Za-z]/.exec(rest);
  if (!m) return false;
  if (rest.indexOf('>') === -1) return quotesBalanced(rest); // incomplete tag
  let i = rest.indexOf('<');
  const n = rest.length;
  while (i < n) {
    const c = rest.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c !== 60) return false; // text outside a tag
    const end = parseTagAt(rest, i);
    if (end === -1) return false;
    i = end;
  }
  return true;
}

// Classify an HTML block start at `rest` (after container stripping).
// Returns {type, tag} or null. Types 1-4 end at a marker, 5-6 at a blank line,
// 8 (pre/script/style/textarea) at the matching close tag. Type 6 cannot
// interrupt a paragraph.
function htmlBlockType(rest) {
  const m = /^[ \t]{0,3}/.exec(rest);
  const s = rest.slice(m[0].length);
  if (s.startsWith('<!--')) return { type: 1 };
  if (s.startsWith('<?')) return { type: 2 };
  if (/^<![A-Z]/.test(s)) return { type: 3 };
  if (s.startsWith('<![CDATA[')) return { type: 4 };
  const raw = /^<\/?(pre|script|style|textarea)(?=[ \t]|\/?>|$)/i.exec(s);
  if (raw && !s.startsWith('</')) return { type: 8, tag: raw[1].toLowerCase() };
  const bt = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t]|\/?>|$|<)/.exec(s);
  if (bt && BLOCK_TAGS.test(bt[1])) return { type: 5 };
  if (isGenericHtmlLine(rest)) return { type: 6 };
  return null;
}

function htmlBlockEnds(rest, htype, tag) {
  switch (htype) {
    case 1: return rest.indexOf('-->') !== -1;
    case 2: return rest.indexOf('?>') !== -1;
    case 3: return rest.indexOf('>') !== -1;
    case 4: return rest.indexOf(']]>') !== -1;
    case 8: return rest.toLowerCase().indexOf('</' + tag) !== -1;
    default: return false;
  }
}

// Parse a link reference definition from the start of `text` (paragraph lines
// joined with \n). Returns {label, dest, title, next} (next = index after the
// def, at a newline or end) or null.
function parseRefDef(text) {
  const n = text.length;
  let i = 0;
  // optional <= 3 spaces
  let sp = 0;
  while (i < n && text.charCodeAt(i) === 32 && sp < 3) { i++; sp++; }
  if (i >= n || text.charCodeAt(i) !== 91) return null; // [
  const lb = parseLabel(text, i);
  if (!lb) return null;
  if (lb.label === '' || lb.label.length > 999) return null;
  let j = lb.next;
  if (j >= n || text.charCodeAt(j) !== 58) return null; // :
  j++;
  j = skipWsNl(text, j);
  const d = parseDest(text, j);
  if (!d) return null;
  // After the destination, an optional title may follow on the same line
  // (separated by spaces) or on the next line. The definition ends at the
  // end of the line holding the destination or the title.
  const afterDest = d.next;
  // scan the rest of the destination's line for a title
  let k = afterDest;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  const sameLineTitle = k > afterDest &&
    k < n && (text.charCodeAt(k) === 34 || text.charCodeAt(k) === 39 || text.charCodeAt(k) === 40);
  if (sameLineTitle) {
    const t = parseTitle(text, k);
    if (!t) return null; // a title-looking token that does not parse: invalid def
    let m = t.next;
    while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
    if (m < n && text.charCodeAt(m) !== 10) return null; // extra text after title
    if (m < n) m++;
    return { label: normalizeLabel(lb.label), dest: d.dest, title: t.title, next: m };
  }
  // no title on the destination's line: it must end here (only spaces)
  if (k < n && text.charCodeAt(k) !== 10) {
    // A title-looking token with no separating space is not a title at all:
    // the definition is invalid (e.g. `[foo]: <bar>(baz)`).
    return null;
  }
  // the destination's line ends at k; a title may sit on the next line
  let nextLine = k < n ? k + 1 : k;
  let k2 = nextLine;
  while (k2 < n && (text.charCodeAt(k2) === 32 || text.charCodeAt(k2) === 9)) k2++;
  if (k2 < n && (text.charCodeAt(k2) === 34 || text.charCodeAt(k2) === 39 || text.charCodeAt(k2) === 40)) {
    const t = parseTitle(text, k2);
    if (t) {
      let m = t.next;
      while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
      if (m >= n || text.charCodeAt(m) === 10) {
        if (m < n) m++;
        return { label: normalizeLabel(lb.label), dest: d.dest, title: t.title, next: m };
      }
      // title on the next line followed by extra text: the definition still
      // stands without a title; the title line stays as paragraph text.
    }
  }
  return { label: normalizeLabel(lb.label), dest: d.dest, title: null, next: nextLine };
}

// Split a table row / header line into cells (unescaped |, code-span aware).
function splitTableRow(s) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = s.length;
  // optional leading pipe
  if (i < n && s.charCodeAt(i) === 124) i++;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && s.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
    if (c === 96) {
      const run = tickRun(s, i);
      const end = findCodeEnd(s, i + run, run);
      if (end !== -1) { cur += s.slice(i, end); i = end; continue; }
      cur += '`'; i++; continue;
    }
    if (c === 124) { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  // trailing pipe: drop the empty cell it creates
  if (n > 0 && s.charCodeAt(n - 1) === 124) { cells.push(cur.trim()); cells.pop(); }
  else cells.push(cur.trim());
  return cells;
}

// Is `s` a valid table delimiter row? Returns aligns array or null.
function parseTableDelim(s) {
  const cells = splitTableRow(s);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    const left = cell.charCodeAt(0) === 58;
    const right = cell.charCodeAt(cell.length - 1) === 58;
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

function parseBlocks(src) {
  const rawLines = src.split('\n');
  const lines = rawLines.map(l => (l.charCodeAt(l.length - 1) === 13 ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === '' && src.charCodeAt(src.length - 1) === 10) lines.pop();

  const root = [];
  const refs = new Map();
  const stack = []; // frames: q, i (containers), p, c, h (leaves)
  let curIdx = 0;
  // An HTML block closed by its end marker gets a trailing newline only when
  // the following source line is not blank (or it is the last line).
  function htmlTrailAfter() {
    if (curIdx + 1 >= lines.length) return true;
    return !isBlankLine(lines[curIdx + 1]);
  }

  function parentChildren() {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k];
      if (f.t === 'q') return f.node.children;
      if (f.t === 'i') return f.node.children;
    }
    return root;
  }
  function topFrame() { return stack.length ? stack[stack.length - 1] : null; }

  // Close frames down to (but not including) depth `keep`.
  function closeTo(keep) {
    while (stack.length > keep) {
      const f = stack.pop();
      if (f.t === 'p' && f.node.kind === 'para') finishPara(f.node);
      // code/html: pending blanks are discarded on close
    }
  }

  // Finalize a paragraph node: extract ref defs, maybe become a table.
  function finishPara(node) {
    let text = node.lines.join('\n');
    // extract leading ref defs
    let guard = 0;
    while (guard++ < 50) {
      const def = parseRefDef(text);
      if (!def) break;
      if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
      text = text.slice(def.next);
      // strip one leading newline if present
      if (text.charCodeAt(0) === 10) text = text.slice(1);
    }
    if (text.trim() === '') { node.drop = true; return; }
    node.lines = text.split('\n');
    // table check: line 1 must be a delimiter row with >= header cells
    // (and at most 3 columns of leading indent)
    if (node.lines.length >= 2) {
      const header = splitTableRow(node.lines[0]);
      let dInd = 0;
      { const tmp = { s: node.lines[1], i: 0, col: 0 }; dInd = indentCols(tmp); }
      const aligns = dInd <= 3 ? parseTableDelim(node.lines[1]) : null;
      if (aligns && aligns.length >= header.length && header.length > 0) {
        node.kind = 'table';
        node.header = header;
        node.aligns = aligns;
        node.rows = node.lines.slice(2).map(splitTableRow);
        delete node.lines;
        return;
      }
    }
    node.kind = 'para';
    node.text = text;
  }

  // Mark the innermost list as loose if a blank line fell between blocks.
  function noteBlankInList() {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k];
      if (f.t === 'i') {
        const list = f.list;
        if (!list._blankBefore) {
          const hadContent = f.node.children.length > 0 || list.items.length > 1;
          list._blankBefore = hadContent;
        }
        return;
      }
    }
  }
  // A new block/item starts inside a list after a blank line -> loose.
  function noteContentInList() {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k];
      if (f.t === 'i') {
        const list = f.list;
        if (list._blankBefore) { list.tight = false; list._blankBefore = false; }
        return;
      }
    }
  }

  // The content of a blank line after stripping the container prefixes that
  // are present on it (blank lines never close a container).
  function blankContent(rawLine) {
    const st = { s: rawLine, i: 0, col: 0 };
    for (let k = 0; k < stack.length; k++) {
      const f = stack[k];
      if (f.t === 'p' || f.t === 'c' || f.t === 'h') break;
      if (f.t === 'q') {
        const save = { s: st.s, i: st.i, col: st.col };
        let sp = 0;
        while (st.i < st.s.length && st.s.charCodeAt(st.i) === 32 && sp < 3) { st.i++; st.col++; sp++; }
        if (st.i < st.s.length && st.s.charCodeAt(st.i) === 62) {
          st.i++; st.col++;
          if (st.i < st.s.length && (st.s.charCodeAt(st.i) === 32 || st.s.charCodeAt(st.i) === 9)) adv(st, 1);
        } else {
          st.s = save.s; st.i = save.i; st.col = save.col;
          break;
        }
      } else if (f.t === 'i') {
        // consume up to contentIndent cols of whitespace (the line may have fewer)
        const target = f.contentIndent;
        while (st.col < target && st.i < st.s.length) {
          const c = st.s[st.i];
          if (c === ' ') { st.i++; st.col++; }
          else if (c === '\t') {
            const w = 4 - (st.col % 4);
            if (st.col + w <= target) { st.i++; st.col += w; }
            else {
              const rem = st.col + w - target;
              st.s = st.s.slice(0, st.i) + ' '.repeat(rem) + st.s.slice(st.i + 1);
              st.col = target;
            }
          } else break;
        }
      }
    }
    return st.s.slice(st.i);
  }

  function handleBlankLine(rawLine) {
    const top = topFrame();
    if (top && top.t === 'p') { closeTo(stack.length - 1); }
    else if (top && (top.t === 'c' || top.t === 'h')) {
      if (top.t === 'h' && (top.htype === 5 || top.htype === 6 || top.htype === 7)) {
        closeTo(stack.length - 1);
      } else {
        const bc = blankContent(rawLine);
        if (top.t === 'c' && !top.fenced) top.pending.push(stripUpTo(bc, 4));
        else top.pending.push(bc); // fenced code / html: fence indent stripped on flush
      }
    }
    noteBlankInList();
  }

  // Try to match the open containers against st. Returns the number of
  // container frames matched (a prefix of the container frames in the stack).
  function matchContainers(st) {
    const saved = { s: st.s, i: st.i, col: st.col };
    let matched = 0;
    let contCount = 0;
    for (let k = 0; k < stack.length; k++) {
      const f = stack[k];
      if (f.t === 'p' || f.t === 'c' || f.t === 'h') break; // leaf: stop
      contCount++;
      const snap = { s: st.s, i: st.i, col: st.col };
      let ok = false;
      if (f.t === 'q') {
        // skip up to 3 spaces, then '>', then 1 optional space
        const save2 = { s: st.s, i: st.i, col: st.col };
        let sp = 0;
        while (st.i < st.s.length && st.s.charCodeAt(st.i) === 32 && sp < 3) { st.i++; st.col++; sp++; }
        if (st.i < st.s.length && st.s.charCodeAt(st.i) === 62) {
          st.i++; st.col++;
          if (st.i < st.s.length && st.s.charCodeAt(st.i) === 32) { st.i++; st.col++; }
          else if (st.i < st.s.length && st.s.charCodeAt(st.i) === 9) { adv(st, 1); }
          ok = true;
        } else { st.s = save2.s; st.i = save2.i; st.col = save2.col; }
      } else if (f.t === 'i') {
        ok = adv(st, Math.max(0, f.contentIndent - st.col));
        if (!ok) { st.s = snap.s; st.i = snap.i; st.col = snap.col; }
      }
      if (!ok) break;
      matched = contCount;
    }
    if (matched === 0 && contCount === 0) return { matched: 0, contCount: 0, saved };
    return { matched, contCount, saved };
  }

  // Is the remainder a block start that can interrupt a paragraph?
  function interruptsPara(rest) {
    if (ATX_RE.test(rest)) return true;
    const fm = FENCE_RE.exec(rest);
    if (fm) return true;
    if (HR_RE.test(rest)) return true;
    if (BLOCKQUOTE_RE.test(rest)) return true;
    const bm = BULLET_RE.exec(rest);
    if (bm) return true;
    const om = ORDERED_RE.exec(rest);
    if (om) return true;
    const hb = htmlBlockType(rest);
    if (hb && hb.type !== 6) return true; // types 1-5 and 8 interrupt; 6 does not
    return false;
  }

  // Process one non-blank line.
  function processLine(rawLine) {
    const st = { s: rawLine, i: 0, col: 0 };
    // 1. match containers
    const { matched, contCount } = matchContainers(st);
    // count container frames in stack
    let nCont = 0;
    for (let k = 0; k < stack.length; k++) {
      const f = stack[k];
      if (f.t === 'p' || f.t === 'c' || f.t === 'h') break;
      nCont++;
    }
    const top = topFrame();
    const rest = st.s.slice(st.i);
    // 2. lazy paragraph continuation?
    if (top && top.t === 'p' && matched < nCont && !interruptsPara(rest)) {
      // Lazy continuation. A lazy line that looks like a setext underline is
      // kept as paragraph text, indented so it cannot become a heading.
      if (/^[ \t]*(=+|-+)[ \t]*$/.test(rest)) top.node.lines.push('    ' + rest.trim());
      else top.node.lines.push(rest);
      return;
    }
    // 3. close unmatched containers (and the leaf above them)
    if (matched < nCont) closeTo(matched);
    // 4. handle an open leaf
    let leaf = topFrame();
    if (leaf && leaf.t === 'c') {
      // fenced code?
      if (leaf.fenced) {
        const fm = FENCE_RE.exec(rest);
        if (fm && fm[2].charCodeAt(0) === leaf.fenceChar && fm[2].length >= leaf.fenceLen && fm[3].trim() === '') {
          // closing fence: flush pending blanks, close
          for (const b of leaf.pending) leaf.node.lines.push(stripUpTo(b, leaf.fenceIndent || 0));
          leaf.pending = [];
          closeTo(stack.length - 1);
          return;
        }
        for (const b of leaf.pending) leaf.node.lines.push(stripUpTo(b, leaf.fenceIndent || 0));
        leaf.pending = [];
        leaf.node.lines.push(stripUpTo(rest, leaf.fenceIndent || 0));
        return;
      }
      // indented code: needs >= 4 indent
      if (indentCols(st) >= 4) {
        const save = { s: st.s, i: st.i, col: st.col };
        adv(st, 4);
        for (const b of leaf.pending) leaf.node.lines.push(b);
        leaf.pending = [];
        leaf.node.lines.push(st.s.slice(st.i));
        return;
      }
      // not indented: close the code block, fall through to new blocks
      closeTo(stack.length - 1);
    } else if (leaf && leaf.t === 'h') {
      for (const b of leaf.pending) leaf.node.lines.push(b);
      leaf.pending = [];
      leaf.node.lines.push(rest);
      if (htmlBlockEnds(rest, leaf.htype, leaf.tag)) {
        leaf.node.trail = htmlTrailAfter();
        closeTo(stack.length - 1);
      }
      return;
    } else if (leaf && leaf.t === 'p') {
      // setext heading?
      const sm = SETEXT_RE.exec(rest);
      if (sm) {
        const level = sm[2].charCodeAt(0) === 61 ? 1 : 2;
        const node = leaf.node;
        node.kind = 'head';
        node.level = level;
        node.text = node.lines.join('\n').trim();
        delete node.lines;
        closeTo(stack.length - 1);
        return;
      }
      if (interruptsPara(rest)) {
        closeTo(stack.length - 1);
        // fall through to start a new block
      } else {
        leaf.node.lines.push(rest);
        return;
      }
    }
    // 5. start new blocks from the remainder (loop for quote/list nesting)
    startBlocks(st);
  }

  function startBlocks(st) {
    for (;;) {
      const rest = st.s.slice(st.i);
      if (rest === '') return;
      const ind = indentCols(st);
      noteContentInList();
      // ATX heading
      if (ind < 4) {
        const am = ATX_RE.exec(rest);
        if (am) {
          let text = rest.slice(am[1].length + am[2].length);
          text = text.replace(/[ \t]+#+[ \t]*$/, '').trim();
          parentChildren().push({ kind: 'head', level: am[2].length, text });
          return;
        }
        const fm = FENCE_RE.exec(rest);
        // a backtick fence whose info string contains a backtick is not a fence
        if (fm && !(fm[2].charCodeAt(0) === 96 && fm[3].indexOf('`') !== -1)) {
          const node = { kind: 'code', fenced: true, info: unescapeDest(fm[3].trim()), lines: [] };
          parentChildren().push(node);
          stack.push({ t: 'c', node, fenced: true, fenceChar: fm[2].charCodeAt(0), fenceLen: fm[2].length, fenceIndent: ind, pending: [] });
          return;
        }
        const hb = htmlBlockType(rest);
        if (hb) {
          const node = { kind: 'html', lines: [rest], trail: false };
          parentChildren().push(node);
          if (hb.type !== 5 && hb.type !== 6 && htmlBlockEnds(rest, hb.type, hb.tag)) {
            node.trail = htmlTrailAfter();
            return;
          }
          stack.push({ t: 'h', node, htype: hb.type, tag: hb.tag, pending: [] });
          return;
        }
        if (HR_RE.test(rest)) {
          parentChildren().push({ kind: 'hr' });
          return;
        }
        const qm = BLOCKQUOTE_RE.exec(rest);
        if (qm) {
          const node = { kind: 'quote', children: [] };
          parentChildren().push(node);
          stack.push({ t: 'q', node });
          // consume indent, '>', and one optional space/tab (partial tab -> spaces)
          let indCols = 0;
          for (const ch of qm[1]) indCols += ch === '\t' ? 4 - ((st.col + indCols) % 4) : 1;
          adv(st, indCols);
          st.i++; st.col++; // '>'
          if (st.i < st.s.length && (st.s.charCodeAt(st.i) === 32 || st.s.charCodeAt(st.i) === 9)) adv(st, 1);
          noteContentInList();
          continue;
        }
        const lm = matchListMarker(st);
        if (lm) {
          openListItem(st, lm);
          continue;
        }
      }
      // indented code (only when indent >= 4)
      if (ind >= 4) {
        const node = { kind: 'code', fenced: false, info: '', lines: [] };
        parentChildren().push(node);
        stack.push({ t: 'c', node, fenced: false, pending: [] });
        adv(st, 4);
        node.lines.push(st.s.slice(st.i));
        return;
      }
      // paragraph
      const node = { kind: 'para', lines: [rest] };
      parentChildren().push(node);
      stack.push({ t: 'p', node });
      noteContentInList();
      return;
    }
  }

  // Match a list marker at st's current position. Returns marker info or null.
  function matchListMarker(st) {
    const rest = st.s.slice(st.i);
    const bm = BULLET_RE.exec(rest);
    const om = ORDERED_RE.exec(rest);
    let m = null, ordered = false;
    if (bm && (!om || bm.index <= om.index)) { m = bm; ordered = false; }
    else if (om) { m = om; ordered = true; }
    if (!m) return null;
    const content = ordered ? m[5] : m[4];
    // paragraph-interrupt rules
    const top = topFrame();
    if (top && top.t === 'p') {
      if (ordered) {
        const startNum = parseInt(m[2], 10);
        if (startNum !== 1) return null;
      }
      // empty list item cannot interrupt a paragraph
      if (!content || content.trim() === '') return null;
    }
    const markerText = ordered ? m[2] + m[3] : m[2];
    let indentCols = 0;
    for (const ch of m[1]) indentCols += ch === '\t' ? 4 - ((st.col + indentCols) % 4) : 1;
    const markerCol = st.col + indentCols;
    const afterMarker = ordered ? m[4] : m[3];
    // whitespace after the marker (in columns)
    let wsCols = 0;
    if (afterMarker) {
      // afterMarker is the whitespace run (may include a tab)
      for (const ch of afterMarker) {
        if (ch === ' ') wsCols++;
        else if (ch === '\t') wsCols += 4 - ((markerCol + markerText.length + wsCols) % 4);
      }
    }
    let contentIndent;
    if (!content || content.trim() === '') {
      contentIndent = markerCol + markerText.length + 1;
    } else if (wsCols >= 1 && wsCols <= 4) {
      contentIndent = markerCol + markerText.length + wsCols;
    } else {
      contentIndent = markerCol + markerText.length + 1;
    }
    return {
      ordered, delim: ordered ? m[3] : m[2],
      start: ordered ? parseInt(m[2], 10) : 0,
      markerLen: markerText.length, markerCol,
      contentIndent, wsCols, indentCols,
    };
  }

  function openListItem(st, lm) {
    // A marker continues the list only when it is the last block at this
    // level; a marker found inside an open item starts a nested list.
    const siblings = parentChildren();
    let list = null;
    const last = siblings[siblings.length - 1];
    if (last && last.kind === 'list' && last.ordered === lm.ordered && last.delim === lm.delim) {
      list = last;
    }
    if (!list) {
      list = { kind: 'list', ordered: lm.ordered, delim: lm.delim, start: lm.start, tight: true, items: [], _blankBefore: false };
      siblings.push(list);
    }
    const itemNode = { kind: 'item', children: [] };
    list.items.push(itemNode);
    // consume indent + marker + whitespace up to contentIndent
    adv(st, lm.indentCols);
    st.i += lm.markerLen; st.col += lm.markerLen;
    adv(st, lm.contentIndent - st.col);
    stack.push({ t: 'i', node: itemNode, list, contentIndent: lm.contentIndent });
    noteContentInList();
  }

  for (let li = 0; li < lines.length; li++) {
    curIdx = li;
    const line = lines[li];
    if (isBlankLine(line)) handleBlankLine(line);
    else processLine(line);
  }
  // HTML blocks still open at EOF get a trailing newline.
  for (const f of stack) if (f.t === 'h') f.node.trail = true;
  closeTo(0);
  // drop paragraphs that were all ref defs
  function prune(blocks) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.drop) { blocks.splice(i, 1); continue; }
      if (b.kind === 'quote') prune(b.children);
      else if (b.kind === 'list') { for (const it of b.items) prune(it.children); }
    }
  }
  prune(root);
  return { root, refs };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderParaText(text, refs) {
  return inline(text, refs, false, false);
}

function renderBlocks(blocks, refs, tightItem) {
  let out = '';
  for (const b of blocks) {
    if (b.drop) continue;
    switch (b.kind) {
      case 'para': {
        if (tightItem) out += renderParaText(b.text, refs);
        else out += '<p>' + renderParaText(b.text, refs) + '</p>\n';
        break;
      }
      case 'head': {
        out += '<h' + b.level + '>' + inline(b.text, refs, false, false) + '</h' + b.level + '>\n';
        break;
      }
      case 'code': {
        let content = b.lines.join('\n');
        if (b.lines.length && b.lines[b.lines.length - 1] !== '') content += '\n';
        let tag = '<pre><code';
        if (b.fenced && b.info) tag += ' class="language-' + escText(b.info.split(/\s+/)[0]) + '"';
        out += tag + '>' + escAll(content) + '</code></pre>\n';
        break;
      }
      case 'html': {
        out += b.lines.join('\n') + (b.trail ? '\n' : '');
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'quote': {
        out += '<blockquote>\n' + renderBlocks(b.children, refs, false) + '</blockquote>\n';
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out += '<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
        for (const item of b.items) {
          out += '<li>';
          out += renderListItem(item, b, refs);
          out += '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let i = 0; i < b.header.length; i++) {
          const al = b.aligns[i];
          out += '<th' + (al === 'center' ? ' align="center"' : al === 'right' ? ' align="right"' : '') + '>' +
            inline(b.header[i], refs, false, false) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let i = 0; i < b.header.length; i++) {
              const al = b.aligns[i];
              const cell = i < row.length ? row[i] : '';
              out += '<td' + (al === 'center' ? ' align="center"' : al === 'right' ? ' align="right"' : '') + '>' +
                inline(cell, refs, false, false) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

// Render a list item's children. Handles the task-list checkbox on the first
// paragraph and bare paragraphs in tight lists.
function renderListItem(item, list, refs) {
  const tight = list.tight;
  let out = '';
  const children = item.children;
  for (let idx = 0; idx < children.length; idx++) {
    const b = children[idx];
    if (b.drop) continue;
    if (b.kind === 'para') {
      let text = b.text;
      let prefix = '';
      if (idx === 0) {
        const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(text);
        if (tm) {
          const checked = tm[1] === 'x' || tm[1] === 'X';
          prefix = checked
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ';
          text = text.slice(tm[0].length);
        }
      }
      if (tight) out += prefix + renderParaText(text, refs);
      else out += '<p>' + prefix + renderParaText(text, refs) + '</p>\n';
      continue;
    }
    out += renderBlocks([b], refs, false);
  }
  return out;
}

export function parse(src) {
  const { root, refs } = parseBlocks(src);
  return renderBlocks(root, refs, false);
}
