// SwiftMark — a fast drop-in for marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29).
// Single-pass block parser + inline parser, written from scratch.
// parse(markdown) returns exactly the HTML marked renders with default options.
export function parse(markdown) {
  const { root, refs } = parseBlocks(String(markdown));
  return renderBlocksRoot(root, refs);
}

// ---------------------------------------------------------------- utilities
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const r = ESC[s[i]];
    if (r !== undefined) { out += s.slice(last, i) + r; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}
const IS_SPACE = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const IS_PUNCT = c => {
  const n = c.charCodeAt(0);
  return (n >= 33 && n <= 47) || (n >= 58 && n <= 64) || (n >= 91 && n <= 96) || (n >= 123 && n <= 126);
};
// Unicode punctuation (CommonMark "Unicode punctuation character")
const RE_UPUNCT = /\p{P}/u;
const isUniPunct = c => c.length === 1 && c.charCodeAt(0) < 128 ? IS_PUNCT(c) : RE_UPUNCT.test(c);
const isUniSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || /\s/.test(c);

// ------------------------------------------------------- HTML named entities
const ENT = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, AMP: 38, LT: 60, GT: 62, QUOT: 34,
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166,
  sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174,
  macr: 175, deg: 176, plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181,
  para: 182, middot: 183, cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188,
  frac12: 189, frac34: 190, iquest: 191, Agrave: 192, Aacute: 193, Acirc: 194,
  Atilde: 195, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199, Egrave: 200,
  Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206,
  Iuml: 207, ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213,
  Ouml: 214, times: 215, Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219,
  Uuml: 220, Yacute: 221, THORN: 222, szlig: 223, agrave: 224, aacute: 225,
  acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231,
  egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237,
  icirc: 238, iuml: 239, eth: 240, ntilde: 241, ograve: 242, oacute: 243,
  ocirc: 244, otilde: 245, ouml: 246, divide: 247, oslash: 248, ugrave: 249,
  uacute: 250, ucirc: 251, uuml: 252, yacute: 253, thorn: 254, yuml: 255,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402,
  circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204,
  zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216,
  rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224,
  Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465,
  weierp: 8472, real: 8476, trade: 8482, TRADE: 8482, alefsym: 8501,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712,
  notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727,
  radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745,
  cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776,
  ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836,
  sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901,
  lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002,
  loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
  Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Epsilon: 917, Zeta: 918,
  Eta: 919, Theta: 920, Iota: 921, Kappa: 922, Lambda: 923, Mu: 924, Nu: 925,
  Xi: 926, Omicron: 927, Pi: 928, Rho: 929, Sigma: 931, Tau: 932, Upsilon: 933,
  Phi: 934, Chi: 935, Psi: 936, Omega: 937, alpha: 945, beta: 946, gamma: 947,
  delta: 948, epsilon: 949, zeta: 950, eta: 951, theta: 952, iota: 953,
  kappa: 954, lambda: 955, mu: 956, nu: 957, xi: 958, omicron: 959, pi: 960,
  rho: 961, sigmaf: 962, sigma: 963, tau: 964, upsilon: 965, phi: 966, chi: 967,
  psi: 968, omega: 969, thetasym: 977, upsih: 978, piv: 982,
  Tab: 9, NewLine: 10, colon: 58, sol: 47, bsol: 92, equals: 61, comma: 44,
  period: 46, quest: 63, semi: 59, percnt: 37, plus: 43, commat: 64,
  dollar: 36, num: 35, lpar: 40, rpar: 41, ast: 42, excl: 33, Hat: 94,
  lowbar: 95, grave: 96, lcub: 123, rcub: 125, verbar: 124, lsqb: 91, rsqb: 93,
  COPY: 169, REG: 174, check: 10003, cross: 10007, star: 9733, phone: 9742,
  female: 9792, male: 9794, sext: 10038, ApplyFunction: 8289, af: 8289,
  nbsp2: 160, dagger2: 8225, heartsuit: 9829, spadesuit: 9824,
};
// marked's entity model (verified against the practice set): a named entity
// `&name;` is passed through literally, never decoded; a numeric entity is
// decoded only when it is valid (digits present, code point in range).
// tryNumericEntity: valid numeric entity -> [decodedChar, endIndex] or null
function tryNumericEntity(s, i) {
  if (s[i] !== '&' || s[i + 1] !== '#') return null;
  let j = i + 2, hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : /[0-9]/.test(s[j]))) j++;
  if (j === start || s[j] !== ';') return null;
  const cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (cp > 0x10FFFF) return null;
  if (!cp || (cp >= 0xD800 && cp <= 0xDFFF)) return ['\uFFFD', j + 1];
  return [String.fromCodePoint(cp), j + 1];
}
// tryNamedEntity: `&name;` -> [literalText, endIndex] or null
function tryNamedEntity(s, i) {
  if (s[i] !== '&') return null;
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  if (j === i + 1 || s[j] !== ';') return null;
  return [s.slice(i, j + 1), j + 1];
}
// unescape backslash escapes and numeric entities in a raw string (used for
// destinations, titles and fenced-code info strings); named entities stay literal
function unescapeStr(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && IS_PUNCT(s[i + 1])) { out += s[i + 1]; i += 2; continue; }
    if (c === '&') { const e = tryNumericEntity(s, i); if (e) { out += e[0]; i = e[1]; continue; } }
    out += c; i++;
  }
  return out;
}
// escape for attribute values: `&` is escaped unless it starts a named entity
function escAttr(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
      if (j > i + 1 && s[j] === ';') continue;
      out += s.slice(last, i) + '&amp;'; last = i + 1;
    } else {
      const r = ESC[ch];
      if (r !== undefined && ch !== '&') { out += s.slice(last, i) + r; last = i + 1; }
    }
  }
  return last === 0 ? s : out + s.slice(last);
}
// marked's cleanUrl: encodeURI, keep % literal; no sanitize filtering by default
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}
function normalizeRef(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------- inline
const RE_TAGNAME = /^[A-Za-z][A-Za-z0-9-]*/;
const RE_AUTOLINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;
const RE_AUTOLINK_EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
// match an inline HTML tag / comment / PI / declaration / CDATA at s[i] === '<'
function matchHtmlTag(s, i) {
  const n = s.length;
  if (s[i + 1] === '!') {
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end !== -1) return end + 3;
      return -1;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end !== -1) return end + 3;
      return -1;
    }
    // declaration <!A-Z ...>
    if (i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
      let j = i + 2;
      while (j < n && s[j] !== '>') j++;
      return j < n ? j + 1 : -1;
    }
    return -1;
  }
  if (s[i + 1] === '?') {
    const end = s.indexOf('?>', i + 2);
    return end !== -1 ? end + 2 : -1;
  }
  let j = i + 1, closing = false;
  if (s[j] === '/') { closing = true; j++; }
  const m = RE_TAGNAME.exec(s.slice(j));
  if (!m) return -1;
  j += m[0].length;
  // attributes
  while (j < n) {
    const c = s[j];
    if (c === '>') return j + 1;
    if (c === '/' && s[j + 1] === '>') return j + 2;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { j++; continue; }
    // attribute name
    if (!/[^\s"'\/>=<>]/.test(c)) return -1;
    while (j < n && /[^\s"'\/>=<>]/.test(s[j])) j++;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j]; j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        let vlen = 0;
        while (j < n && !/[\s"'=<>`]/.test(s[j])) { j++; vlen++; }
        if (vlen === 0) return -1;
      }
    }
  }
  return -1;
}
// find the index of the ']' matching the '[' at pos i (depth-aware, skips code spans)
function findLinkEnd(s, i) {
  let depth = 0, j = i;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const run = k - j;
      // find a closing run of exactly `run` backticks
      let p = k;
      while (p < n) {
        if (s[p] === '`') {
          let q = p;
          while (q < n && s[q] === '`') q++;
          if (q - p === run) { j = q; break; }
          p = q;
        } else p++;
      }
      if (p >= n) return -1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}
// parse "(dest title)" starting at s[i] === '('; returns {dest, title, end} or null
function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  // skip whitespace/newlines
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= n) return null;
  let dest = '';
  if (s[j] === '<') {
    let k = j + 1;
    while (k < n && s[k] !== '>' && s[k] !== '\n') {
      if (s[k] === '\\' && k + 1 < n && IS_PUNCT(s[k + 1])) { dest += s[k + 1]; k += 2; continue; }
      if (s[k] === '<') return null;
      dest += s[k]; k++;
    }
    if (k >= n || s[k] !== '>') return null;
    j = k + 1;
  } else {
    // bare destination: no spaces, balanced parens
    let depth = 0;
    while (j < n) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && j + 1 < n && IS_PUNCT(s[j + 1])) { dest += s[j + 1]; j += 2; continue; }
      if (c === '(') { depth++; dest += c; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; dest += c; j++; continue;
      }
      if (c === '&') { const e = tryNumericEntity(s, j); if (e) { dest += e[0]; j = e[1]; continue; } }
      dest += c; j++;
    }
    if (dest === '') return null;
  }
  // optional whitespace, optional title, optional whitespace, then ')'
  let title = null;
  let k = j;
  while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  if (k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const q = s[k];
    const close = q === '(' ? ')' : q;
    let t = '', p = k + 1, ok = false;
    while (p < n) {
      const c = s[p];
      if (c === '\\' && p + 1 < n && IS_PUNCT(s[p + 1])) { t += s[p + 1]; p += 2; continue; }
      if (c === '&') { const e = tryNumericEntity(s, p); if (e) { t += e[0]; p = e[1]; continue; } }
      if (c === close) { ok = true; break; }
      if (c === '\n') { t += '\n'; p++; continue; }
      t += c; p++;
    }
    if (!ok) return null;
    title = t;
    k = p + 1;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  }
  if (k >= n || s[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}
// try to parse a link/image starting at '[' (or '!['); returns node or null
function tryLink(s, i, refs, isImage) {
  const n = s.length;
  const start = isImage ? i + 1 : i;
  const end = findLinkEnd(s, start);
  if (end === -1) return null;
  const label = s.slice(start + 1, end);
  if (label.length > 999) return null;
  let j = end + 1;
  // inline link
  if (j < n && s[j] === '(') {
    const link = parseInlineLink(s, j);
    if (link) {
      return { t: isImage ? 'image' : 'link', label, dest: link.dest, title: link.title, end: link.end, ref: null };
    }
    // failed inline link: not a link at all (do not fall through to reference)
    return null;
  }
  // reference link [label]
  if (j < n && s[j] === '[') {
    const close = s.indexOf(']', j + 1);
    if (close !== -1) {
      const refLabel = s.slice(j + 1, close);
      const ref = refs.get(normalizeRef(refLabel === '' ? label : refLabel));
      if (ref) return { t: isImage ? 'image' : 'link', label, dest: ref.dest, title: ref.title, end: close + 1, ref: refLabel };
    }
    // fall through to the shortcut reference below
  }
  // shortcut reference
  const ref = refs.get(normalizeRef(label));
  if (ref) return { t: isImage ? 'image' : 'link', label, dest: ref.dest, title: ref.title, end: end + 1, ref: label };
  return null;
}

// tokenize inline content into a node list; delimiters kept as nodes for emphasis processing
function scanInline(src, refs) {
  const nodes = [];
  const n = src.length;
  let i = 0, textStart = 0;
  const flushText = (upto) => {
    if (upto > textStart) nodes.push({ t: 'text', s: src.slice(textStart, upto) });
  };
  const pushNode = (node, upto) => { flushText(upto); nodes.push(node); };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (i + 1 < n && IS_PUNCT(src[i + 1])) {
        // backslash-newline is handled at '\n'; here it's a punctuation escape
        pushNode({ t: 'text', s: src[i + 1] }, i);
        i += 2; textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      // find a closing run of exactly `run` backticks
      let p = j, found = -1;
      while (p < n) {
        if (src[p] === '`') {
          let q = p;
          while (q < n && src[q] === '`') q++;
          if (q - p === run) { found = p; break; }
          p = q;
        } else p++;
      }
      if (found !== -1) {
        let content = src.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        pushNode({ t: 'code', s: content }, i);
        i = found + run; textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    if (c === '<') {
      const tagEnd = matchHtmlTag(src, i);
      if (tagEnd !== -1) {
        pushNode({ t: 'html', s: src.slice(i, tagEnd) }, i);
        i = tagEnd; textStart = i;
        continue;
      }
      // autolink <scheme:...> or <email>
      const gt = src.indexOf('>', i + 1);
      if (gt !== -1) {
        const inner = src.slice(i + 1, gt);
        if (inner && !/[\s<>]/.test(inner) && (RE_AUTOLINK_SCHEME.test(inner) || RE_AUTOLINK_EMAIL.test(inner))) {
          const isEmail = !/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(inner);
          const href = isEmail ? 'mailto:' + inner : inner;
          pushNode({ t: 'autolink', href, text: inner }, i);
          i = gt + 1; textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      const link = tryLink(src, i, refs, isImage);
      if (link) {
        pushNode(link, i);
        i = link.end; textStart = i;
        continue;
      }
      i += isImage ? 1 : 1;
      continue;
    }
    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const run = j - i;
      const before = i === 0 ? '' : src[i - 1];
      const after = j >= n ? '' : src[j];
      const beforeWs = before === '' || isUniSpace(before);
      const afterWs = after === '' || isUniSpace(after);
      const beforePunct = before !== '' && isUniPunct(before);
      const afterPunct = after !== '' && isUniPunct(after);
      const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else { canOpen = leftFlank && (!rightFlank || beforePunct); canClose = rightFlank && (!leftFlank || afterPunct); }
      if (canOpen || canClose) {
        pushNode({ t: 'delim', ch: c, len: run, canOpen, canClose }, i);
        i = j; textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    if (c === '~') {
      let j = i;
      while (j < n && src[j] === '~') j++;
      const run = j - i;
      if (run >= 2) {
        const before = i === 0 ? '' : src[i - 1];
        const after = j >= n ? '' : src[j];
        const beforeWs = before === '' || isUniSpace(before);
        const afterWs = after === '' || isUniSpace(after);
        const beforePunct = before !== '' && isUniPunct(before);
        const afterPunct = after !== '' && isUniPunct(after);
        const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
        const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
        const canOpen = leftFlank, canClose = rightFlank;
        if (canOpen || canClose) {
          pushNode({ t: 'delim', ch: '~', len: run, canOpen, canClose }, i);
          i = j; textStart = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    if (c === '&') {
      const num = tryNumericEntity(src, i);
      if (num) {
        pushNode({ t: 'text', s: num[0] }, i);
        i = num[1]; textStart = i;
        continue;
      }
      const named = tryNamedEntity(src, i);
      if (named) {
        pushNode({ t: 'entity', s: named[0] }, i);
        i = named[1]; textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '\n') {
      // hard break: backslash-newline (odd run of backslashes) or 2+ trailing spaces
      const seg = src.slice(textStart, i);
      const last = nodes.length && nodes[nodes.length - 1].t === 'text' ? nodes[nodes.length - 1] : null;
      const tail = (last ? last.s : '') + seg;
      let k = 0;
      while (i - 1 - k >= 0 && src[i - 1 - k] === '\\') k++;
      let hard = false, cut = 0;
      if (k % 2 === 1) { hard = true; cut = 1; }
      else {
        const m = / +$/.exec(tail);
        if (m && m[0].length >= 2) { hard = true; cut = m[0].length; }
      }
      if (hard) {
        if (cut <= seg.length) flushText(i - cut);
        else if (last) {
          const intoNode = cut - seg.length;
          last.s = last.s.slice(0, last.s.length - intoNode);
          if (!last.s) nodes.pop();
        }
      } else {
        flushText(i);
      }
      nodes.push({ t: hard ? 'br' : 'softbreak' });
      i++; textStart = i;
      continue;
    }
    // GFM extended autolink: www. / scheme:// / email
    if (c === 'w' && src.startsWith('www.', i) && (i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1])) && (i === 0 || /[\s(*_~]/.test(src[i - 1]))) {
      const m = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[^\s<>\[\]()]*[^\s<>\[\]().,;:!?*_~])?/.exec(src.slice(i));
      if (m && m[0].length > 4) {
        const url = trimExtAutolink(m[0]);
        if (url.length > 4) {
          pushNode({ t: 'autolink', href: 'http://' + url, text: url }, i);
          i += url.length; textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if ((c === 'h' || c === 'f') && (i === 0 || /[\s(*_~]/.test(src[i - 1]))) {
      const m = /^(?:https?|ftp):\/\/[^\s<>]+/.exec(src.slice(i));
      if (m) {
        const url = trimExtAutolink(m[0]);
        if (url) {
          pushNode({ t: 'autolink', href: url, text: url }, i);
          i += url.length; textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === '@') { i++; continue; }
    i++;
  }
  flushText(n);
  // GFM extended email autolinks: scan text nodes for user@domain.tld
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t !== 'text') continue;
    const re = /(^|[\s(*_~])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
    let m, out = [], last = 0, changed = false;
    while ((m = re.exec(nd.s)) !== null) {
      let em = m[2];
      while (/[.,;:!?]$/.test(em)) em = em.slice(0, -1);
      if (!em.includes('@') || em.length < 5) continue;
      const start = m.index + m[1].length;
      const end = start + em.length;
      out.push({ t: 'text', s: nd.s.slice(last, start) });
      out.push({ t: 'autolink', href: 'mailto:' + em, text: em });
      last = end;
      changed = true;
    }
    if (changed) {
      out.push({ t: 'text', s: nd.s.slice(last) });
      const repl = out.filter(x => x.t !== 'text' || x.s !== '');
      nodes.splice(k, 1, ...repl);
      k += repl.length - 1;
    }
  }
  processEmphasis(nodes);
  return nodes;
}
// trim trailing punctuation / unbalanced ')' / ';' from an extended autolink
function trimExtAutolink(url) {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (last === ')' ) {
      let open = 0, close = 0;
      for (const ch of u) { if (ch === '(') open++; else if (ch === ')') close++; }
      if (close > open) { u = u.slice(0, -1); continue; }
      break;
    }
    if (last === ';') {
      const amp = u.lastIndexOf('&');
      if (amp !== -1 && /^&[A-Za-z0-9]+;$/.test(u.slice(amp))) break;
      u = u.slice(0, -1); continue;
    }
    if ('?!.,:*_~'.includes(last)) { u = u.slice(0, -1); continue; }
    break;
  }
  return u;
}
// emphasis / strikethrough: delimiter-stack algorithm (CommonMark appendix)
function processEmphasis(nodes) {
  const delims = [];
  for (let idx = 0; idx < nodes.length; idx++) {
    if (nodes[idx].t === 'delim') delims.push({ node: nodes[idx], idx });
  }
  if (!delims.length) return;
  const bottom = { '*': -1, '_': -1, '~': -1 };
  const bottomStack = { '*': [], '_': [], '~': [] };
  let d = 0;
  while (d < delims.length) {
    const cur = delims[d];
    if (!cur.node.canClose) { d++; continue; }
    // look for opener
    let o = d - 1, found = -1;
    const btm = bottomStack[cur.node.ch].length ? bottomStack[cur.node.ch][bottomStack[cur.node.ch].length - 1] : -1;
    while (o > btm) {
      const od = delims[o];
      if (od.node.ch === cur.node.ch && od.node.canOpen) {
        const odd = (od.node.canOpen && od.node.canClose && cur.node.canOpen && cur.node.canClose)
          && ((od.node.len + cur.node.len) % 3 === 0) && (od.node.len % 3 !== 0 || cur.node.len % 3 !== 0);
        if (!odd) { found = o; break; }
      }
      o--;
    }
    if (found === -1) {
      if (cur.node.canOpen) bottomStack[cur.node.ch].push(d);
      d++;
      continue;
    }
    const opener = delims[found];
    const use = (opener.node.len >= 2 && cur.node.len >= 2) ? 2 : 1;
    const tag = cur.node.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    // wrap nodes between opener.idx and cur.idx
    const inner = nodes.slice(opener.idx + 1, cur.idx);
    const wrapped = { t: 'wrap', tag, children: inner };
    nodes.splice(opener.idx, cur.idx - opener.idx + 1, wrapped);
    // fix up delimiter indices after splice
    const removed = cur.idx - opener.idx;
    opener.node.len -= use;
    cur.node.len -= use;
    // rebuild delims list
    delims.length = 0;
    for (let idx = 0; idx < nodes.length; idx++) if (nodes[idx].t === 'delim') delims.push({ node: nodes[idx], idx });
    // adjust bottom stacks (indices may be stale; rebuild by node identity)
    for (const ch of ['*', '_', '~']) {
      bottomStack[ch] = bottomStack[ch].filter(di => di < delims.length && delims[di] && delims[di].node.len > 0);
    }
    if (opener.node.len === 0) {
      const oi = nodes.indexOf(opener.node);
      if (oi !== -1) nodes.splice(oi, 1);
    }
    if (cur.node.len === 0) {
      const ci = nodes.indexOf(cur.node);
      if (ci !== -1) nodes.splice(ci, 1);
    }
    // rebuild delims and restart scan from the beginning (simple, safe)
    delims.length = 0;
    for (let idx = 0; idx < nodes.length; idx++) if (nodes[idx].t === 'delim') delims.push({ node: nodes[idx], idx });
    for (const ch of ['*', '_', '~']) bottomStack[ch] = [];
    d = 0;
  }
  // leftover delimiters become literal text
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (nd.t === 'delim') nodes[idx] = { t: 'text', s: nd.ch.repeat(nd.len) };
  }
}
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += esc(nd.s);
    else if (nd.t === 'entity') out += nd.s;
    else if (nd.t === 'code') out += '<code>' + esc(nd.s) + '</code>';
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'br') out += '<br>';
    else if (nd.t === 'softbreak') out += '\n';
    else if (nd.t === 'wrap') out += '<' + nd.tag + '>' + renderInline(nd.children) + '</' + nd.tag + '>';
    else if (nd.t === 'autolink') out += '<a href="' + escAttr(cleanUrl(nd.href) || '') + '">' + esc(nd.text) + '</a>';
    else if (nd.t === 'link') {
      const href = cleanUrl(unescapeStr(nd.dest));
      if (href === null) { out += renderInline(scanInline(nd.label, refsGlobal)); }
      else {
        out += '<a href="' + escAttr(href) + '"' + (nd.title != null ? ' title="' + escAttr(unescapeStr(nd.title)) + '"' : '') + '>' + renderInline(scanInline(nd.label, refsGlobal)) + '</a>';
      }
    } else if (nd.t === 'image') {
      const href = cleanUrl(unescapeStr(nd.dest));
      if (href === null) { out += renderInline(scanInline(nd.label, refsGlobal)); }
      else {
        const alt = renderInline(scanInline(nd.label, refsGlobal)).replace(/<[^>]*>/g, '');
        out += '<img src="' + escAttr(href) + '" alt="' + alt + '"' + (nd.title != null ? ' title="' + escAttr(unescapeStr(nd.title)) + '"' : '') + '>';
      }
    }
  }
  return out;
}
let refsGlobal = new Map();
function parseInline(src, refs) {
  refsGlobal = refs;
  return renderInline(scanInline(src, refs));
}

// ---------------------------------------------------------------- blocks
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));
const LEAF_TYPES = new Set(['paragraph', 'heading', 'code', 'html', 'hr', 'table']);
function curCh(c) { return c.vs > 0 ? ' ' : (c.i < c.s.length ? c.s[c.i] : ''); }
function restStr(c) { return (c.vs > 0 ? ' '.repeat(c.vs) : '') + c.s.slice(c.i); }
function snap(c) { return { i: c.i, col: c.col, vs: c.vs }; }
function restore(c, s) { c.i = s.i; c.col = s.col; c.vs = s.vs; }
function advCol(c, n) {
  while (n > 0) {
    if (c.vs > 0) { const t = Math.min(n, c.vs); c.vs -= t; c.col += t; n -= t; }
    else if (c.i >= c.s.length) return false;
    else if (c.s[c.i] === ' ') { c.i++; c.col++; n--; }
    else if (c.s[c.i] === '\t') {
      const next = (Math.floor(c.col / 4) + 1) * 4, w = next - c.col;
      if (w > n) { c.vs = w - n; c.col += n; c.i++; n = 0; }
      else { c.i++; c.col = next; n -= w; }
    } else return false;
  }
  return true;
}
// advance past n non-space characters (markers); drops pending virtual spaces
function advChars(c, n) { c.vs = 0; c.i += n; c.col += n; }
function skipIndent(c, maxCols) {
  let skipped = 0;
  while (skipped < maxCols) {
    if (c.vs > 0) { const t = Math.min(maxCols - skipped, c.vs); c.vs -= t; c.col += t; skipped += t; }
    else if (c.i < c.s.length && c.s[c.i] === ' ') { c.i++; c.col++; skipped++; }
    else if (c.i < c.s.length && c.s[c.i] === '\t') {
      const next = (Math.floor(c.col / 4) + 1) * 4, w = next - c.col;
      if (skipped + w > maxCols) { c.vs = skipped + w - maxCols; c.col += (maxCols - skipped); c.i++; skipped = maxCols; }
      else { c.i++; c.col = next; skipped += w; }
    } else break;
  }
  return skipped;
}
function isBlankRest(c) {
  let j = c.i;
  while (j < c.s.length && (c.s[j] === ' ' || c.s[j] === '\t')) j++;
  return j >= c.s.length;
}
function parseBlocks(src) {
  src = src.replace(/\r\n?/g, '\n');
  const srcEndsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const root = { type: 'doc', children: [] };
  const stack = [root];
  let blankPending = false;
  let li = 0;

  function top() { return stack[stack.length - 1]; }
  function innermostItem() {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].type === 'item') return stack[k];
    return null;
  }
  function closeTop() {
    const b = stack.pop();
    if (b.type === 'code') {
      while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    }
    return b;
  }
  function addBlock(b) {
    markLooseIfNeeded();
    const parent = top();
    parent.children.push(b);
    const item = innermostItem();
    if (item) item.hasContent = true;
    return b;
  }
  function markLooseIfNeeded() {
    if (!blankPending) return;
    const item = innermostItem();
    if (item && item.hasContent) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].type === 'list') { stack[k].loose = true; break; }
        if (stack[k].type === 'item') continue;
        break;
      }
    }
  }
  // walk containers for line `raw`; returns {c, failed, lazy}
  function walkContainers(raw) {
    const c = { s: raw, i: 0, col: 0, vs: 0 };
    let s = 1, failed = -1, lazy = false;
    while (s < stack.length) {
      const b = stack[s];
      if (LEAF_TYPES.has(b.type)) break;
      if (b.type === 'blockquote') {
        const save = snap(c);
        skipIndent(c, 3);
        if (curCh(c) === '>') {
          advChars(c, 1);
          if (curCh(c) === ' ' || curCh(c) === '\t') advCol(c, 1);
          s++;
        } else {
          restore(c, save);
          failed = s;
          if (top().type === 'paragraph') lazy = true;
          break;
        }
      } else if (b.type === 'item') {
        // a blank line stays inside the item (the item does not close)
        if (isBlankRest(c)) { s++; continue; }
        const save = snap(c);
        // advance to contentCol over spaces/tabs
        let ok = true;
        while (c.col < b.contentCol) {
          const ch = curCh(c);
          if (ch === ' ' || ch === '\t') { if (!advCol(c, 1)) { ok = false; break; } }
          else { ok = false; break; }
        }
        if (ok) s++;
        else {
          restore(c, save);
          failed = s;
          if (top().type === 'paragraph') lazy = true;
          break;
        }
      } else if (b.type === 'list') {
        s++;
      } else break;
    }
    return { c, failed, lazy };
  }
  function closeFrom(idx) {
    while (stack.length > idx) {
      const b = top();
      if (b.type === 'html') b.endedByParentClose = true;
      closeTop();
    }
  }
  // is the next source line blank (raw check; the common top-level case)?
  function nextSrcBlank() {
    return li + 1 < lines.length && lines[li + 1].trim() === '';
  }
  function handleBlank(c) {
    const t = top();
    if (t.type === 'code' && t.fenced) { skipIndent(c, t.fenceIndent || 0); t.lines.push(restStr(c)); return; }
    if (t.type === 'code' && !t.fenced) { skipIndent(c, 4); t.lines.push(restStr(c)); return; }
    if (t.type === 'html' && t.htmlType <= 5) { t.lines.push(''); return; }
    if (LEAF_TYPES.has(t.type)) { if (t.type === 'html') t.endAtBlank = true; closeTop(); }
    blankPending = true;
  }
  // blank line for paragraph purposes: nothing left after the containers,
  // or the raw line is whitespace-only (a line like `>  ` leaves one space
  // after the marker, which is paragraph content, not a blank line)
  function isBlankLine(c) {
    return restStr(c) === '' || c.s.trim() === '';
  }
  function processLine(raw) {
    const { c, failed, lazy } = walkContainers(raw);
    if (lazy && !isBlankLine(c)) {
      // a lazy continuation line is still not lazy when it starts a new block
      if (!startsNewBlock(c, false)) {
        // lazy lines lose their leading indentation
        top().lines.push(restStr(c).replace(/^[ \t]+/, ''));
        blankPending = false;
        return;
      }
    }
    if (failed !== -1) closeFrom(failed);
    processContent(c);
  }
  function processContent(c) {
    const t0 = top();
    // whitespace-only line after a container marker (e.g. `>  `) is a
    // continuation of an open paragraph, not a blank line
    if (t0.type === 'paragraph') {
      const rest = restStr(c);
      if (rest !== '' && rest.trim() === '' && c.s.trim() !== '') { t0.lines.push(rest); return; }
    }
    if (isBlankRest(c)) { handleBlank(c); return; }
    blankPending = blankPending; // consumed below where a block starts
    const t = top();
    // open leaf continuations
    if (t.type === 'code' && t.fenced) {
      const save = snap(c);
      skipIndent(c, 3);
      const ch = curCh(c);
      if ((ch === '`' || ch === '~') && ch === t.fenceCh) {
        let j = c.i, run = 0;
        while (j < c.s.length && c.s[j] === ch) { j++; run++; }
        let k = j;
        while (k < c.s.length && (c.s[k] === ' ' || c.s[k] === '\t')) k++;
        if (run >= t.fenceLen && k >= c.s.length) { closeTop(); return; }
      }
      restore(c, save);
      skipIndent(c, t.fenceIndent || 0);
      t.lines.push(restStr(c));
      return;
    }
    if (t.type === 'code' && !t.fenced) {
      const save = snap(c);
      const ind = skipIndent(c, 4);
      if (ind >= 4 || isBlankRest(c)) {
        t.lines.push(restStr(c));
        return;
      }
      restore(c, save);
      closeTop();
      processContent(c);
      return;
    }
    if (t.type === 'html') {
      const line = restStr(c);
      t.lines.push(line);
      t.hasTrailingNL = li < lines.length - 1 || srcEndsWithNL;
      if (t.htmlType === 1 && /<\/(pre|script|style|textarea)>/i.test(line)) { t.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (t.htmlType === 2 && line.includes('-->')) { t.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (t.htmlType === 3 && line.includes('?>')) { t.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (t.htmlType === 4 && line.includes('>')) { t.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (t.htmlType === 5 && line.includes(']]>')) { t.nextLineBlank = nextSrcBlank(); closeTop(); }
      return;
    }
    if (t.type === 'table') {
      {
        const save = snap(c);
        const ind = skipIndent(c, 4);
        if (ind >= 4) { restore(c, save); closeTop(); processContent(c); return; }
        restore(c, save);
      }
      if (startsNewBlock(c, false)) { closeTop(); processContent(c); return; }
      t.rows.push(splitTableRow(restStr(c)));
      return;
    }
    if (t.type === 'paragraph') {
      // setext underline?
      const save = snap(c);
      skipIndent(c, 3);
      const line = restStr(c);
      const mSetext = /^([=-]+)[ \t]*$/.exec(line);
      if (mSetext) {
        const text = t.lines.map(x => x.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')).join('\n');
        const parent = stack[stack.length - 2];
        parent.children[parent.children.length - 1] = { type: 'heading', level: mSetext[1][0] === '=' ? 1 : 2, text };
        stack.pop();
        blankPending = false;
        return;
      }
      restore(c, save);
      // table delimiter row? (paragraph has exactly one line)
      if (t.lines.length === 1) {
        const delim = parseTableDelim(line);
        if (delim) {
          const header = splitTableRow(t.lines[0]);
          const tb = { type: 'table', align: delim, header, rows: [] };
          const parent = stack[stack.length - 2];
          parent.children[parent.children.length - 1] = tb;
          stack.pop();
          stack.push(tb);
          blankPending = false;
          return;
        }
      }
      // new block that interrupts a paragraph?
      if (startsNewBlock(c, true)) { closeTop(); processContent(c); return; }
      // continuation (leading spaces are kept)
      t.lines.push(restStr(c));
      return;
    }
    // no open leaf: start a new block
    if (top().type === 'list') {
      // a non-item block cannot be a child of a list: close it unless the
      // line starts an item that continues this list (a thematic break,
      // which can also look like a list marker, closes the list instead)
      const save = snap(c);
      skipIndent(c, 3);
      const line = restStr(c);
      restore(c, save);
      const lm = matchListMarker(line);
      const isHr = /^([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
      const t2 = top();
      if (!(lm && !isHr && t2.ordered === lm.ordered && t2.delim === lm.delim && t2.bullet === lm.bullet)) {
        closeTop();
        processContent(c);
        return;
      }
    }
    startBlock(c);
  }
  // does the line at cursor start a new block? (inPar: paragraph is open, so
  // indented code and type-7 html cannot interrupt; list rules apply)
  function startsNewBlock(c, inPar) {
    const save = snap(c);
    skipIndent(c, 3);
    const line = restStr(c);
    const ch = curCh(c);
    let r = false;
    if (line.startsWith('>')) r = true;
    else if (/^#{1,6}(?:[ \t]+|$)/.test(line)) r = true;
    else {
      const fm = /^(`{3,}|~{3,})/.exec(line);
      if (fm && !(fm[1][0] === '`' && line.slice(fm[1].length).includes('`'))) r = true;
    }
    if (!r && /^([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) r = true;
    else if (htmlBlockType(line) !== 0 && !(inPar && htmlBlockType(line) === 7)) r = true;
    else if (matchListMarker(line)) {
      const m = matchListMarker(line);
      if (!inPar) r = true;
      else if (m.ordered) r = m.start === 1 && !m.empty;
      else r = !m.empty;
    }
    restore(c, save);
    return r;
  }
  function startBlock(c) {
    const save = snap(c);
    const rawLine = restStr(c);
    skipIndent(c, 3);
    const afterIndent = snap(c);
    const line = restStr(c);
    // blockquote
    if (line.startsWith('>')) {
      const b = { type: 'blockquote', children: [] };
      addBlock(b);
      stack.push(b);
      blankPending = false;
      advChars(c, 1);
      if (curCh(c) === ' ' || curCh(c) === '\t') advCol(c, 1);
      processContent(c);
      return;
    }
    // ATX heading (closing sequence = spaces + #s at the end; the space
    // after the opening marker counts as its leading space)
    const mAtx = /^(#{1,6})(?:[ \t]|$)/.exec(line);
    if (mAtx) {
      let text = line.slice(mAtx[1].length);
      text = text.replace(/[ \t]+$/, '').replace(/[ \t]+#+$/, '').replace(/^[ \t]+/, '');
      addBlock({ type: 'heading', level: mAtx[1].length, text });
      blankPending = false;
      return;
    }
    // fenced code
    const mFence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (mFence) {
      const fence = mFence[1], ch = fence[0];
      const info = mFence[2];
      if (!(ch === '`' && info.includes('`'))) {
        const firstWord = info.trim().split(/[ \t]/)[0] || '';
        const b = { type: 'code', fenced: true, fenceCh: ch, fenceLen: fence.length, fenceIndent: c.col - save.col, info: unescapeStr(firstWord), lines: [] };
        addBlock(b);
        stack.push(b);
        blankPending = false;
        return;
      }
    }
    // thematic break
    if (/^([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      addBlock({ type: 'hr' });
      blankPending = false;
      return;
    }
    // HTML block
    const ht = htmlBlockType(line);
    if (ht !== 0) {
      const b = { type: 'html', htmlType: ht, lines: [rawLine], hasTrailingNL: li < lines.length - 1 || srcEndsWithNL, endAtBlank: false };
      addBlock(b);
      stack.push(b);
      blankPending = false;
      if (ht === 1 && /<\/(pre|script|style|textarea)>/i.test(line)) { b.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (ht === 2 && line.includes('-->')) { b.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (ht === 3 && line.includes('?>')) { b.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (ht === 4 && line.includes('>')) { b.nextLineBlank = nextSrcBlank(); closeTop(); }
      else if (ht === 5 && line.includes(']]>')) { b.nextLineBlank = nextSrcBlank(); closeTop(); }
      return;
    }
    // indented code
    {
      restore(c, save);
      const ind = skipIndent(c, 4);
      if (ind >= 4) {
        const b = { type: 'code', fenced: false, lines: [restStr(c)] };
        addBlock(b);
        stack.push(b);
        blankPending = false;
        return;
      }
      restore(c, save);
    }
    // list
    const lm = matchListMarker(line);
    if (lm) {
      restore(c, afterIndent);
      startList(c, lm, line);
      return;
    }
    // paragraph (with leading link reference definitions)
    restore(c, save);
    startParagraph(c);
  }
  function startList(c, lm, line) {
    markLooseIfNeeded();
    const markerCol = c.col;
    // consume marker
    advChars(c, lm.markerLen);
    // whitespace after marker
    let contentCol, contentStart;
    {
      const save = snap(c);
      let cols = 0;
      while (cols < 5) {
        const ch = curCh(c);
        if (ch === ' ' || ch === '\t') { advCol(c, 1); cols++; }
        else break;
      }
      if (cols === 0) {
        // empty item (end of line or non-space)
        contentCol = markerCol + lm.markerLen + 1;
      } else if (cols >= 5) {
        // only one space consumed
        restore(c, save);
        advCol(c, 1);
        contentCol = markerCol + lm.markerLen + 1;
      } else {
        contentCol = markerCol + lm.markerLen + cols;
      }
      contentStart = snap(c);
    }
    const isEmpty = isBlankRest(c);
    // find or create the list
    let list = null;
    const t = top();
    let listIsNew = false;
    if (t.type === 'list' && t.ordered === lm.ordered && t.delim === lm.delim && t.bullet === lm.bullet) {
      list = t;
    } else {
      list = { type: 'list', ordered: lm.ordered, start: lm.start, delim: lm.delim, bullet: lm.bullet, loose: false, children: [] };
      addBlock(list);
      listIsNew = true;
    }
    if (blankPending && list.children.length > 0) list.loose = true;
    const item = { type: 'item', contentCol, hasContent: false, children: [] };
    list.children.push(item);
    if (listIsNew) stack.push(list);
    stack.push(item);
    blankPending = false;
    if (isEmpty) return;
    // the rest of the line is the item's first content
    restore(c, contentStart);
    processContent(c);
  }
  function startParagraph(c) {
    // try link reference definitions first
    const firstLine = restStr(c);
    let text = firstLine;
    let idx = li;
    let defs = 0;
    const peek = (k) => {
      if (idx + k >= lines.length) return null;
      const w = walkContainers(lines[idx + k]);
      if (w.failed !== -1 || w.lazy) return null;
      if (isBlankRest(w.c)) return null;
      return restStr(w.c);
    };
    while (true) {
      const d = parseRefDef(text, peek);
      if (!d) break;
      const key = normalizeRef(d.label);
      if (!refs.has(key)) refs.set(key, { dest: d.dest, title: d.title });
      defs++;
      idx += d.linesUsed - 1;
      if (idx + 1 >= lines.length) { text = ''; break; }
      const w = walkContainers(lines[idx + 1]);
      if (w.failed !== -1 || w.lazy || isBlankRest(w.c)) { text = ''; break; }
      idx++;
      text = restStr(w.c);
      if (startsNewBlock(w.c, false)) { idx--; text = ''; break; }
    }
    // task list item: "[ ] " / "[x] " at the start of the item's first paragraph
    const item = innermostItem();
    const firstInItem = item && item.children.length === 0;
    const mkPara = (lineText) => {
      let task = false, checked = false;
      if (firstInItem) {
        const m = /^\[([ xX])\](?:[ \t]+(.*)|[ \t]*)$/.exec(lineText);
        if (m) { task = true; checked = m[1] === 'x' || m[1] === 'X'; lineText = m[2] !== undefined ? m[2] : ''; }
      }
      const b = { type: 'paragraph', lines: [lineText], task, checked };
      addBlock(b);
      stack.push(b);
      blankPending = false;
    };
    if (defs > 0) {
      li = idx;
      if (text === '') return; // paragraph was only ref defs
      mkPara(text);
      return;
    }
    mkPara(firstLine);
  }
  for (li = 0; li < lines.length; li++) {
    processLine(lines[li]);
  }
  while (stack.length > 1) closeTop();
  return { root, refs };
}

// ------------------------------------------------------------ block helpers
function matchListMarker(line) {
  const c0 = line[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    if (line.length === 1 || line[1] === ' ' || line[1] === '\t') {
      return { ordered: false, bullet: c0, delim: null, start: 0, markerLen: 1, empty: /^\s*$/.test(line.slice(1)) };
    }
    return null;
  }
  const m = /^(\d{1,9})([.)])(?:[ \t]|$)/.exec(line);
  if (m) {
    return { ordered: true, bullet: null, delim: m[2], start: parseInt(m[1], 10), markerLen: m[1].length + 1, empty: /^\s*$/.test(line.slice(m[0].length)) };
  }
  return null;
}
function htmlBlockType(line) {
  if (/^<(pre|script|style|textarea)(?:[ \t>]|$)/i.test(line)) return 1;
  if (line.startsWith('<!--')) return 2;
  if (line.startsWith('<?')) return 3;
  if (line.startsWith('<![CDATA[')) return 5;
  if (/^<![A-Za-z]/.test(line)) return 4;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|$)/.exec(line);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  if (/^<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>[ \t]*$/.test(line)) return 7;
  return 0;
}
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n && line[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '`') {
      let j = i;
      while (j < n && line[j] === '`') j++;
      const run = j - i;
      let p = j, found = -1;
      while (p < n) {
        if (line[p] === '`') { let q = p; while (q < n && line[q] === '`') q++; if (q - p === run) { found = p; break; } p = q; }
        else p++;
      }
      if (found !== -1) { cur += line.slice(i, found + run); i = found + run; continue; }
      cur += line.slice(i, j); i = j; continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}
function parseTableDelim(line) {
  if (line[0] === ' ' || line[0] === '\t') return null;
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    align.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : null);
  }
  return align;
}
// parse a link reference definition from `text` (first line) with `peek(k)`
// returning the next line's content; returns {label, dest, title, linesUsed} or null
function parseRefDef(text, peek) {
  const parts = [text];
  let k = 1, pk;
  while (k <= 10 && (pk = peek(k)) !== null && pk !== undefined) { parts.push(pk); k++; }
  const buf = parts.join('\n');
  let p = 0;
  let sp = 0;
  while (sp < 3 && buf[p] === ' ') { p++; sp++; }
  if (buf[p] !== '[') return null;
  const end = findLinkEnd(buf, p);
  if (end === -1) return null;
  const label = buf.slice(p + 1, end);
  if (!label || label.length > 999) return null;
  p = end + 1;
  if (buf[p] !== ':') return null;
  p++;
  const skipWs = (allowNL) => {
    while (p < buf.length) {
      const ch = buf[p];
      if (ch === ' ' || ch === '\t') p++;
      else if (ch === '\n' && allowNL) p++;
      else break;
    }
  };
  const linesUsed = () => 1 + (buf.slice(0, p).match(/\n/g) || []).length;
  skipWs(true);
  if (p >= buf.length) return null;
  let dest = '';
  if (buf[p] === '<') {
    p++;
    while (p < buf.length && buf[p] !== '>' && buf[p] !== '\n') {
      if (buf[p] === '\\' && p + 1 < buf.length && IS_PUNCT(buf[p + 1])) { dest += buf[p + 1]; p += 2; continue; }
      if (buf[p] === '<') return null;
      dest += buf[p]; p++;
    }
    if (p >= buf.length || buf[p] !== '>') return null;
    p++;
  } else {
    let depth = 0;
    while (p < buf.length) {
      const ch = buf[p];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) break;
      if (ch === '\\' && p + 1 < buf.length && IS_PUNCT(buf[p + 1])) { dest += buf[p + 1]; p += 2; continue; }
      if (ch === '(') { depth++; dest += ch; p++; continue; }
      if (ch === ')') { if (depth === 0) break; depth--; dest += ch; p++; continue; }
      if (ch === '&') { const e = tryNumericEntity(buf, p); if (e) { dest += e[0]; p = e[1]; continue; } }
      dest += ch; p++;
    }
    if (!dest) return null;
  }
  let title = null;
  const afterDest = p;
  skipWs(false);
  const hadWs = p > afterDest;
  const finishAtLineEnd = () => p >= buf.length || buf[p] === '\n';
  if (finishAtLineEnd()) {
    // maybe the title is on the next line
    const saveP = p;
    skipWs(true);
    if (p < buf.length && (buf[p] === '"' || buf[p] === "'" || buf[p] === '(')) {
      const t = parseTitle();
      if (t !== null) {
        title = t;
        skipWs(false);
        if (!finishAtLineEnd()) return null;
        return { label, dest, title, linesUsed: linesUsed() };
      }
    }
    p = saveP;
    return { label, dest, title: null, linesUsed: linesUsed() };
  }
  if ((buf[p] === '"' || buf[p] === "'" || buf[p] === '(') && !hadWs) return null;
  if (buf[p] === '"' || buf[p] === "'" || buf[p] === '(') {
    const t = parseTitle();
    if (t === null) return null;
    title = t;
    skipWs(false);
    if (!finishAtLineEnd()) return null;
    return { label, dest, title, linesUsed: linesUsed() };
  }
  return null;
  function parseTitle() {
    const q = buf[p], close = q === '(' ? ')' : q;
    p++;
    let t = '';
    while (p < buf.length) {
      const ch = buf[p];
      if (ch === '\\' && p + 1 < buf.length && IS_PUNCT(buf[p + 1])) { t += buf[p + 1]; p += 2; continue; }
      if (ch === '&') { const e = tryNumericEntity(buf, p); if (e) { t += e[0]; p = e[1]; continue; } }
      if (ch === close) { p++; return t; }
      if (q === '(' && ch === '(') return null;
      t += ch; p++;
    }
    return null;
  }
}
// ---------------------------------------------------------------- rendering
function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}
function renderBlock(b, refs) {
  switch (b.type) {
    case 'paragraph': return '<p>' + parseInline(b.lines.join('\n'), refs) + '</p>\n';
    case 'heading': return '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
    case 'code': {
      let end = b.lines.length;
      while (end > 0 && b.lines[end - 1] === '') end--;
      const content = b.lines.slice(0, end).join('\n') + (end ? '\n' : '');
      const cls = b.fenced && b.info ? ' class="language-' + b.info + '"' : '';
      return '<pre><code' + cls + '>' + esc(content) + '</code></pre>\n';
    }
    case 'html': {
      let text = b.lines.join('\n');
      if (!b.endAtBlank && b.hasTrailingNL && !b.endedByParentClose && !b.nextLineBlank) text += '\n';
      return text;
    }
    case 'hr': return '<hr>\n';
    case 'blockquote': return '<blockquote>\n' + renderBlocks(b.children, refs) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + startAttr + '>\n';
      for (const item of b.children) out += renderItem(item, !b.loose, refs);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      const ncols = b.align.length;
      const pad = (cells) => {
        const r = cells.slice(0, ncols);
        while (r.length < ncols) r.push('');
        return r;
      };
      let out = '<table>\n<thead>\n<tr>\n';
      const head = pad(b.header);
      for (let i = 0; i < ncols; i++) {
        out += '<th' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + parseInline(head[i].trim(), refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n<tbody>';
      for (const row of b.rows) {
        const cells = pad(row);
        out += '<tr>\n';
        for (let i = 0; i < ncols; i++) {
          out += '<td' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + parseInline(cells[i].trim(), refs) + '</td>\n';
        }
        out += '</tr>\n';
      }
      return out + '</tbody></table>\n';
    }
    default: return '';
  }
}
function renderItem(item, tight, refs) {
  let out = '';
  for (const child of item.children) {
    if (child.type === 'paragraph' && child.task) {
      const cb = child.checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
      const inner = parseInline(child.lines.join('\n'), refs);
      if (tight) out += cb + ' ' + inner;
      else out += '<p>' + cb + ' ' + inner + '</p>\n';
    } else if (tight && child.type === 'paragraph') {
      out += parseInline(child.lines.join('\n'), refs);
    } else {
      out += renderBlock(child, refs);
    }
  }
  return '<li>' + out + '</li>\n';
}
// task list items are rewritten in renderItem: detect "- [ ]" / "- [x]" at the
// start of an item's first paragraph and render the checkbox inline
function renderBlocksRoot(root, refs) {
  return renderBlocks(root.children, refs);
}
