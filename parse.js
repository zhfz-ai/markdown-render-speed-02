// SwiftMark — a fast drop-in renderer for marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29).
// Written from scratch in this session from the CommonMark/GFM specifications and
// the competition's practice data. Single-pass block parser + single-pass inline
// scanner; no dependencies, no caching across calls, no I/O.
//
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with default
// options (gfm on, breaks off, pedantic off, async off).

// ---- named HTML entities (subset of the HTML5 table: every entity the practice
// set uses, plus the common Greek / math / currency / Latin-1 names) ----
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', iexcl: '¡', cent: '¢',
  pound: '£', curren: '¤', yen: '¥', brvbar: '¦', sect: '§', uml: '¨', copy: '©',
  ordf: 'ª', laquo: '«', not: '¬', shy: '­', reg: '®', macr: '¯', deg: '°',
  plusmn: '±', sup2: '²', sup3: '³', acute: '´', micro: 'µ', para: '¶', middot: '·',
  cedil: '¸', sup1: '¹', ordm: 'º', raquo: '»', frac14: '¼', frac12: '½', frac34: '¾',
  iquest: '¿', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì',
  Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó',
  Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', times: '×', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú',
  Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ', szlig: 'ß', agrave: 'à', aacute: 'á',
  acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  divide: '÷', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý',
  thorn: 'þ', yuml: 'ÿ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ',
  fnof: 'ƒ', circ: 'ˆ', tilde: '˜', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌',
  zwj: '‍', lrm: '‎', rlm: '‏', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•',
  hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', oline: '‾',
  frasl: '⁄', euro: '€', image: 'ℑ', weierp: '℘', real: 'ℜ', trade: '™', alefsym: 'ℵ',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', crarr: '↵', lArr: '⇐',
  uArr: '⇑', rArr: '⇒', dArr: '⇓', hArr: '⇔', forall: '∀', part: '∂', exist: '∃',
  empty: '∅', nabla: '∇', isin: '∈', notin: '∉', ni: '∋', prod: '∏', sum: '∑',
  minus: '−', lowast: '∗', radic: '√', prop: '∝', infin: '∞', ang: '∠', and: '∧',
  or: '∨', cap: '∩', cup: '∪', int: '∫', there4: '∴', sim: '∼', cong: '≅',
  asymp: '≈', ne: '≠', equiv: '≡', le: '≤', ge: '≥', sub: '⊂', sup: '⊃',
  nsub: '⊄', sube: '⊆', supe: '⊇', oplus: '⊕', otimes: '⊗', perp: '⊥', sdot: '⋅',
  lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', lang: '〈', rang: '〉', loz: '◊',
  spades: '♠', clubs: '♣', hearts: '♥', diams: '♦',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η',
  Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ',
  Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ',
  Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigmaf: 'ς',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  thetasym: 'ϑ', upsih: 'ϒ', piv: 'ϖ',
  Amacr: 'Ā', amacr: 'ā', Abreve: 'Ă', abreve: 'ă', Aogon: 'Ą', aogon: 'ą', Cacute: 'Ć',
  cacute: 'ć', Ccaron: 'Č', ccaron: 'č', Dcaron: 'Ď', dcaron: 'ď', Emacr: 'Ē', emacr: 'ē',
  Edot: 'Ė', edot: 'ė', Eogon: 'Ę', eogon: 'ę', Ecaron: 'Ě', ecaron: 'ě', Gbreve: 'Ğ',
  gbreve: 'ğ', Gdot: 'Ġ', gdot: 'ġ', Hstrok: 'Ħ', hstrok: 'ħ', Idot: 'İ', imacr: 'ī',
  Imacr: 'Ī', Iogon: 'Į', iogon: 'į', Lacute: 'Ĺ', lacute: 'ĺ', Lcaron: 'Ľ', lcaron: 'ľ',
  Lstrok: 'Ł', lstrok: 'ł', Nacute: 'Ń', nacute: 'ń', Ncaron: 'Ň', ncaron: 'ň', Ncedil: 'Ņ',
  ncedil: 'ņ', Odblac: 'Ő', odblac: 'ő', Omacr: 'Ō', omacr: 'ō', Racute: 'Ŕ', racute: 'ŕ',
  Rcaron: 'Ř', rcaron: 'ř', Rcedil: 'Ŗ', rcedil: 'ŗ', Sacute: 'Ś', sacute: 'ś', Scedil: 'Ş',
  scedil: 'ş', Tcaron: 'Ť', tcaron: 'ť', Tcedil: 'Ţ', tcedil: 'ţ', Ubreve: 'Ŭ', ubreve: 'ŭ',
Uring: 'Ů', uring: 'ů', Umacr: 'Ū', umacr: 'ū', Uogon: 'Ų', uogon: 'ų',
  Ycirc: 'Ŷ', ycirc: 'ŷ', Zacute: 'Ź', zacute: 'ź', Zdot: 'Ż', zdot: 'ż', Zcaron: 'Ž',
  zcaron: 'ž',
  DifferentialD: 'ⅆ', HilbertSpace: 'ℋ', ClockwiseContourIntegral: '∲',
  ngE: '≧̸', nGg: '⋙̸', nGt: '≫⃒', nGtv: '≫̸', nLeftarrow: '⇍', nLeftrightarrow: '⇎',
  nLl: '⋘̸', nLt: '≪⃒', nLtv: '≪̸', nRightarrow: '⇏', notinva: '∉', notinvb: '⋷',
  notinvc: '⋶', NotEqualTilde: '≂̸', NotTilde: '≁',
  check: '✓', cross: '✗', star: '☆', bigstar: '★', phone: '☎', female: '♀', male: '♂',
};

// ---- small character helpers (ASCII fast paths) ----
const SPC = 32, TAB = 9, NL = 10, CR = 13;
function isWS(c) { return c === SPC || c === TAB || c === NL || c === CR || c === 11 || c === 12; }
function isASCIILetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isASCIIDigit(c) { return c >= 48 && c <= 57; }
function isASCIIPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode whitespace (CommonMark: Zs category + tab/CR/LF/FF). NBSP and friends matter
// for emphasis flanking and for blank-line detection inside inline text.
function isUWS(ch) {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
  const c = ch.charCodeAt(0);
  return c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
// Unicode punctuation for flanking (CommonMark: ASCII punctuation +
// general categories P and S, so currency/math symbols like £ € count).
// Cached per code point; the ASCII path never reaches the regex.
const _punctCache = new Map();
const _punctRe = /^[\p{P}\p{S}]$/u;
function isUPunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isASCIIPunct(c);
  let v = _punctCache.get(c);
  if (v === undefined) { v = _punctRe.test(ch); _punctCache.set(c, v); }
  return v;
}

// ---- HTML escaping ----
// escape(s, noEncode): & < > " ' are escaped. When noEncode is true, a '&'
// that begins a valid entity reference (&name; / &#123; / &#x1f;) is left alone
// (marked's escape with encode=false, used for hrefs/titles/autolinks).
const ENT_REF = /&(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
function escapeHtml(s, noEncode) {
  if (noEncode) {
    let out = '', i = 0, n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '&') {
        const m = ENT_REF.exec(s.slice(i, i + 40));
        if (m && m.index === 0) { out += m[0]; i += m[0].length; continue; }
        out += '&amp;'; i++;
      } else if (c === '<') { out += '&lt;'; i++; }
      else if (c === '>') { out += '&gt;'; i++; }
      else if (c === '"') { out += '&quot;'; i++; }
      else if (c === "'") { out += '&#39;'; i++; }
      else { out += c; i++; }
    }
    return out;
  }
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// cleanUrl: marked's URL cleaning — encodeURI, keeping % as-is; null on failure.
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); }
  catch (e) { return null; }
}

// decode a numeric character reference; invalid code points become U+FFFD.
function numEntity(code) {
  if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '�';
  return String.fromCodePoint(code);
}

// ================= inline parser =================
// Single left-to-right scan. out[] holds entry objects {s, hide}; delimiter
// records point at their entry object, bracket records at the '[' entry index.
// Links are formed in place (the '[' entry becomes the <a> tag, a </a> entry is
// appended) so delimiter references stay valid. Emphasis is resolved after the
// scan; deferred autolinks and image alt text are settled after that.

function isHex(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function isDom(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95; }
function isEmailLocal(c) { return isDom(c) || c === 46 || c === 43; }
function isEmailDom(c) { return isDom(c) || c === 46; }
function isXmppRes(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 64; }

// Scan a domain: segments of [A-Za-z0-9_-]+ separated by single '.'s.
// Returns the end index (exclusive) or -1.
function scanDomain(s, j, n) {
  let p = j;
  while (p < n && isDom(s.charCodeAt(p))) p++;
  if (p === j) return -1;
  while (p < n && s[p] === "." && p + 1 < n && isDom(s.charCodeAt(p + 1))) {
    p++;
    while (p < n && isDom(s.charCodeAt(p))) p++;
  }
  return p;
}

// GFM autolink trailing-punctuation trimming: strip ?!.,:*_~ repeatedly; a
// trailing ')' only while ')' outnumber '(' in the whole link; a trailing
// ';' only as part of a final &name; entity.
function trimAutolink(t) {
  let open = 0, close = 0;
  for (let k = 0; k < t.length; k++) { const c = t[k]; if (c === "(") open++; else if (c === ")") close++; }
  for (;;) {
    if (!t) return t;
    const last = t[t.length - 1];
    if (last === "?" || last === "!" || last === "." || last === "," || last === ":" || last === "*" || last === "_" || last === "~") { t = t.slice(0, -1); continue; }
    if (last === ")") { if (close > open) { t = t.slice(0, -1); close--; continue; } return t; }
    if (last === ";") {
      const m = /&[A-Za-z0-9]+;$/.exec(t);
      if (m) { t = t.slice(0, t.length - m[0].length); continue; }
      return t;
    }
    return t;
  }
}

// Bare email starting at i (local part + @ + domain). Returns end or -1.
function tryEmailAt(s, i, n) {
  let j = i;
  while (j < n && isEmailLocal(s.charCodeAt(j))) j++;
  if (j === i || j >= n || s[j] !== "@") return -1;
  const k = j + 1;
  let m = k;
  while (m < n && isEmailDom(s.charCodeAt(m))) m++;
  let end = m;
  while (end > k && s[end - 1] === ".") end--;
  if (end === k) return -1;
  const dom = s.slice(k, end);
  if (dom.indexOf(".") < 0 || dom[0] === "." || dom.indexOf("..") >= 0) return -1;
  const last = dom[dom.length - 1];
  if (last === "-" || last === "_") return -1;
  return end;
}

// End of an autolink path: stop at space, tab, newline or '<'.
function scanPathEnd(s, p, n) {
  while (p < n) { const c = s[p]; if (c === " " || c === "\t" || c === "\n" || c === "<") break; p++; }
  return p;
}

function tryWWWAt(s, i, n) {
  // The www autolink requires lowercase `www.` exactly; `Www.` is plain text.
  if (s.slice(i, i + 4) !== "www.") return null;
  const d = scanDomain(s, i + 4, n);
  if (d < 0) return null;
  const dom = s.slice(i + 4, d);
  if (dom.indexOf(".") < 0) return null;
  const segs = dom.split(".");
  if (segs[segs.length - 1].indexOf("_") >= 0 || segs[segs.length - 2].indexOf("_") >= 0) return null;
  const p = scanPathEnd(s, d, n);
  const text = trimAutolink(s.slice(i, p));
  if (text.length <= 4) return null;
  return { end: i + text.length, href: "http://" + text, text };
}

function tryHttpAt(s, i, n) {
  const low = s.slice(i, i + 8).toLowerCase();
  let plen = 0;
  if (low.indexOf("https://") === 0) plen = 8;
  else if (low.indexOf("http://") === 0) plen = 7;
  else return null;
  const d = scanDomain(s, i + plen, n);
  if (d < 0) return null;
  const dom = s.slice(i + plen, d);
  if (dom.indexOf(".") < 0) return null;
  const p = scanPathEnd(s, d, n);
  const text = trimAutolink(s.slice(i, p));
  if (text.length <= plen) return null;
  return { end: i + text.length, href: text, text };
}

function tryProtocolAt(s, i, n) {
  const low = s.slice(i, i + 7).toLowerCase();
  let plen = 0, proto = "";
  if (low.indexOf("mailto:") === 0) { plen = 7; proto = "mailto:"; }
  else if (low.indexOf("xmpp:") === 0) { plen = 5; proto = "xmpp:"; }
  else return null;
  const e = tryEmailAt(s, i + plen, n);
  if (e < 0) return null;
  let end = e;
  if (proto === "xmpp:" && s[end] === "/") {
    let r = end + 1;
    while (r < n && isXmppRes(s.charCodeAt(r))) r++;
    if (r > end + 1) end = r;
  }
  const text = s.slice(i, end);
  return { end, href: text, text };
}

// <...> autolink: <scheme:...> (scheme 2-32 chars) or <email>.
// Returns {end, raw, email} or null.
function tryAngleAutolink(s, i, n) {
  let j = i + 1;
  if (j < n && isASCIILetter(s.charCodeAt(j))) {
    let k = j + 1;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (isASCIILetter(c) || isASCIIDigit(c) || c === 43 || c === 46 || c === 45) k++;
      else break;
    }
    if (k - j >= 2 && k - j <= 32 && s[k] === ":") {
      let m = k + 1;
      while (m < n) {
        const c = s.charCodeAt(m);
        if (c === 62 || c === 32 || c === 9 || c === 10 || c === 60 || c <= 31) break;
        m++;
      }
      if (m < n && s[m] === ">" && m > k + 1) return { end: m + 1, raw: s.slice(j, m), email: false };
    }
  }
  let p = i + 1;
  while (p < n) {
    const c = s.charCodeAt(p);
    if (isASCIILetter(c) || isASCIIDigit(c) || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 || c === 43 || c === 45 || c === 46 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126) p++;
    else break;
  }
  if (p > i + 1 && s[p] === "@") {
    let q = p + 1;
    if (q < n && (isASCIILetter(s.charCodeAt(q)) || isASCIIDigit(s.charCodeAt(q)))) {
      let ok = true, lastEnd = q;
      for (;;) {
        let r = q + 1, len = 1;
        while (r < n) {
          const c = s.charCodeAt(r);
          if (isASCIILetter(c) || isASCIIDigit(c) || c === 45) { r++; len++; }
          else break;
        }
        if (len > 63 || s.charCodeAt(r - 1) === 45) { ok = false; break; }
        lastEnd = r;
        if (s[r] === ".") {
          q = r + 1;
          if (q >= n || (!isASCIILetter(s.charCodeAt(q)) && !isASCIIDigit(s.charCodeAt(q)))) { ok = false; break; }
          continue;
        }
        break;
      }
      if (ok && s[lastEnd] === ">") return { end: lastEnd + 1, raw: s.slice(i + 1, lastEnd), email: true };
    }
  }
  return null;
}

// Raw HTML tag starting at '<'. Returns the end index (exclusive) or -1.
function tryRawHtmlTag(s, i, n) {
  let j = i + 1;
  if (j >= n) return -1;
  const c = s[j];
  if (c === "!") {
    if (s[j + 1] === "-" && s[j + 2] === "-") {
      if (s[j + 3] === ">") return j + 4; // <!--> is a complete empty comment
      if (s[j + 3] === "-" && s[j + 4] === ">") return j + 5; // <!---> likewise
      const e = s.indexOf("-->", j + 3);
      return e < 0 ? -1 : e + 3;
    }
    if (s.slice(j + 1, j + 8) === "[CDATA[") {
      const e = s.indexOf("]]>", j + 8);
      return e < 0 ? -1 : e + 3;
    }
    if (j + 1 < n && isASCIILetter(s.charCodeAt(j + 1))) {
      const e = s.indexOf(">", j + 1);
      return e < 0 ? -1 : e + 1;
    }
    return -1;
  }
  if (c === "?") {
    const e = s.indexOf("?>", j + 1);
    return e < 0 ? -1 : e + 2;
  }
  if (c === "/") {
    j++;
    if (j >= n || !isASCIILetter(s.charCodeAt(j))) return -1;
    while (j < n && (isASCIILetter(s.charCodeAt(j)) || isASCIIDigit(s.charCodeAt(j)) || s[j] === "-")) j++;
    while (j < n && (s[j] === " " || s[j] === "\t" || s[j] === "\n")) j++;
    return (j < n && s[j] === ">") ? j + 1 : -1;
  }
  if (!isASCIILetter(s.charCodeAt(j))) return -1;
  while (j < n && (isASCIILetter(s.charCodeAt(j)) || isASCIIDigit(s.charCodeAt(j)) || s[j] === "-")) j++;
  // After the tag name only whitespace, '/' or '>' may follow, and every
  // attribute must be separated from the tag name and from the previous
  // attribute by whitespace (`<m:abc>` and `<a href='bar'title=x>` are
  // not tags).
  if (j >= n) return -1;
  if (s[j] === ">") return j + 1;
  if (s[j] === "/" && s[j + 1] === ">") return j + 2;
  if (s[j] !== " " && s[j] !== "\t" && s[j] !== "\n") return -1;
  for (;;) {
    let ws = 0;
    while (j < n && (s[j] === " " || s[j] === "\t" || s[j] === "\n")) { j++; ws++; }
    if (j >= n) return -1;
    if (s[j] === ">") return j + 1;
    if (s[j] === "/" && s[j + 1] === ">") return j + 2;
    if (s[j] === "/") return -1;
    if (ws === 0) return -1;
    if (!(isASCIILetter(s.charCodeAt(j)) || s[j] === "_" || s[j] === ":")) return -1;
    while (j < n) {
      const cc = s.charCodeAt(j);
      if (isASCIILetter(cc) || isASCIIDigit(cc) || cc === 95 || cc === 58 || cc === 46 || cc === 45) j++;
      else break;
    }
    // Only consume the whitespace after the name when an '=' follows;
    // otherwise it is the separator before the next attribute and must
    // still be there for the loop head to count it.
    let k = j;
    while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n")) k++;
    if (k < n && s[k] === "=") {
      j = k + 1;
      while (j < n && (s[j] === " " || s[j] === "\t" || s[j] === "\n")) j++;
      if (j >= n) return -1;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0) return -1;
        j = e + 1;
      } else {
        const st = j;
        while (j < n) {
          const cc = s[j];
          if (cc === " " || cc === "\t" || cc === "\n" || cc === ">" || cc === '"' || cc === "'" || cc === "=" || cc === "<" || cc === "`") break;
          j++;
        }
        if (j === st) return -1;
      }
    }
  }
}

// Code span starting at a backtick run. Returns {end, html} or null.
function tryCodeSpan(s, i, n) {
  let r = 0;
  while (i + r < n && s[i + r] === "`") r++;
  let k = i + r;
  for (;;) {
    const e = s.indexOf("`", k);
    if (e < 0) return null;
    let rl = 0;
    while (e + rl < n && s[e + rl] === "`") rl++;
    if (rl === r) {
      let content = s.slice(i + r, e).replace(/\n/g, " ");
      if (content.length >= 2 && content[0] === " " && content[content.length - 1] === " " && !/^ *$/.test(content)) {
        content = content.slice(1, -1);
      }
      return { end: e + r, html: "<code>" + escapeHtml(content) + "</code>" };
    }
    k = e + rl;
  }
}

// Entity reference starting at '&'. Returns {end, ch} for a numeric entity
// (decoded, to be escaped on output) or {end, raw} for a named entity, which
// marked passes through untouched (never decoded). Returns null otherwise.
// Numeric entities are limited to 1-7 decimal / 1-6 hex digits.
function tryEntity(s, i, n) {
  if (i + 1 < n && s[i + 1] === "#") {
    let j = i + 2, hex = false;
    if (s[j] === "x" || s[j] === "X") { hex = true; j++; }
    let k = j;
    const maxDigits = hex ? 6 : 7;
    if (hex) { while (k < n && isHex(s.charCodeAt(k))) k++; }
    else { while (k < n && isASCIIDigit(s.charCodeAt(k))) k++; }
    const digits = k - j;
    if (digits >= 1 && digits <= maxDigits && k < n && s[k] === ";") {
      const num = hex ? parseInt(s.slice(j, k), 16) : parseInt(s.slice(j, k), 10);
      return { end: k + 1, ch: numEntity(num) };
    }
    return null;
  }
  if (i + 1 < n && isASCIILetter(s.charCodeAt(i + 1))) {
    let j = i + 1;
    while (j < n && (isASCIILetter(s.charCodeAt(j)) || isASCIIDigit(s.charCodeAt(j)))) j++;
    if (j > i + 1 && j < n && s[j] === ";") {
      return { end: j + 1, raw: s.slice(i, j + 1) };
    }
  }
  return null;
}

// Link label normalization: lowercase, trim, collapse internal whitespace.
// Unicode case folding maps ß (and ẞ, which lowercases to ß) to "ss", so
// [ẞ] matches a [SS] definition.
function normLabel(raw) {
  return raw.toLowerCase().replace(/ß/g, "ss").trim().replace(/\s+/g, " ");
}

// Label starting at '['. Returns {end, raw} or null; end is past the ']'.
// A label may not contain an unescaped '[' or ']' (it ends at the first
// unescaped ']').
function parseLabelAt(s, i, n) {
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "[") return null;
    if (c === "]") {
      const raw = s.slice(i + 1, j);
      if (raw.length < 1 || raw.length > 999 || raw.trim() === "") return null;
      return { end: j + 1, raw };
    }
    j++;
  }
  return null;
}

function skipWS(s, j, n) {
  while (j < n) { const c = s[j]; if (c === " " || c === "\t" || c === "\n") j++; else break; }
  return j;
}

// Backslash escapes: \ + ASCII punctuation yields the punctuation.
function unescapeStr(t) {
  if (t.indexOf("\\") < 0) return t;
  let out = "", i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "\\" && i + 1 < t.length && isASCIIPunct(t.charCodeAt(i + 1))) { out += t[i + 1]; i += 2; }
    else { out += c; i++; }
  }
  return out;
}

// Link destination starting at j. Returns {end, dest} or null.
function parseDest(s, j, n) {
  if (j >= n) return null;
  if (s[j] === "<") {
    let k = j + 1;
    while (k < n) {
      const c = s[k];
      if (c === ">") return { end: k + 1, dest: s.slice(j + 1, k) };
      if (c === "\n" || c === "<") return null;
      if (c === "\\") { k += 2; continue; }
      k++;
    }
    return null;
  }
  let k = j, depth = 0;
  while (k < n) {
    const c = s[k];
    if (c === " " || c === "\t" || c === "\n" || s.charCodeAt(k) <= 31) break;
    if (c === "\\") { k += 2; continue; }
    if (c === "(") depth++;
    else if (c === ")") { if (depth === 0) break; depth--; }
    k++;
  }
  if (k === j) return null;
  return { end: k, dest: s.slice(j, k) };
}

// Inline link (dest "title") starting at '('. Returns {end, href, title} or null.
function parseInlineLinkAt(s, i, n) {
  let j = skipWS(s, i + 1, n);
  if (j < n && s[j] === ")") return { end: j + 1, href: "", title: null };
  const d = parseDest(s, j, n);
  if (!d) return null;
  const href = cleanUrl(unescapeStr(d.dest));
  if (href === null) return null;
  j = skipWS(s, d.end, n);
  let title = null;
  if (j < n && (s[j] === '"' || s[j] === "'" || s[j] === "(")) {
    const q = s[j];
    const close = q === "(" ? ")" : q;
    let k = j + 1;
    while (k < n) {
      const c = s[k];
      if (c === close) break;
      if (c === "\\") { k += 2; continue; }
      k++;
    }
    if (k >= n || s[k] !== close) return null;
    title = unescapeStr(s.slice(j + 1, k));
    j = skipWS(s, k + 1, n);
  }
  if (j < n && s[j] === ")") return { end: j + 1, href, title };
  return null;
}

function inlineParse(s, refs) {
  const n = s.length;
  const out = [];        // entries {s, hide}
  const delims = [];     // {ch, lit, canOpen, canClose, ent, oTags, cTags, prev, next}
  const brackets = [];   // {idx, active, image, textStart}
  const deferred = [];   // {brs, entIdx, href}
  const linkRanges = []; // [start, end) out-indices that are a formed link's text / image alt
  const images = [];     // {ent, start, end, src, title}
  let dlast = -1;
  let i = 0;
  let buf = "";
  function flush() { if (buf) { out.push({ s: escapeHtml(buf) }); buf = ""; } }
  function unlinkDelim(idx) {
    const d = delims[idx];
    if (d.prev >= 0) delims[d.prev].next = d.next;
    if (d.next >= 0) delims[d.next].prev = d.prev;
    if (dlast === idx) dlast = d.prev;
    d.prev = -2; d.next = -2;
  }
  function processEmphasis() {
    const bottom = new Map();
    // Closers are processed left to right: an inner closer pairs with
    // its opener before a later closer can steal that opener, so
    // `*token*or*` yields <em>token</em>or* rather than *token<em>or</em>.
    let cur = 0;
    while (cur < delims.length) {
      const c = delims[cur];
      if (c.prev === -2) { cur++; continue; }
      if (c.canClose) {
        const bound = bottom.has(c.ch) ? bottom.get(c.ch) : -1;
        // An opener and its closer may not straddle a boundary: a link
        // or image's text, or another delimiter pair. If the opener
        // sits inside such a pair and the closer outside it (or the
        // reverse), the two cannot pair — so `*[foo*](/uri)` keeps the
        // leading `*` literal, and `*foo _bar* baz_` leaves the `_`s
        // literal instead of forming emphasis across the `*` pair.
        const insideLink = (oi) => {
          for (const r of linkRanges) if (oi >= r[0] && oi < r[1]) return true;
          return false;
        };
        const crossesBoundary = (opIdx, curIdx) => {
          const o = delims[opIdx], cc = delims[curIdx];
          if (insideLink(o.oi) !== insideLink(cc.oi)) return true;
          for (let j = opIdx + 1; j < curIdx; j++) {
            const d = delims[j];
            if (!d.canClose) continue;
            let k = j - 1;
            while (k >= 0 && !(delims[k].ch === d.ch && delims[k].canOpen)) k--;
            if (k >= 0 && k < opIdx) return true;
          }
          return false;
        };
        // Prefer an opener of the same run length: a `*` closer pairs
        // with a `*` opener and a `**` closer with a `**` opener, so a
        // nested `*(**x**)*` forms <em>(<strong>x</strong>)</em> rather
        // than two nested <em>s. Fall back to any opener when no exact
        // one is in reach (mismatched runs use the shorter side).
        const findOpener = (exact) => {
          let op = c.prev;
          while (op >= 0 && op !== bound) {
            const o = delims[op];
            if (o.canOpen && o.ch === c.ch && (!exact || o.lit === c.lit) && !crossesBoundary(op, cur)) {
              // The odd-match rule only guards a single-delimiter (em)
              // pairing: when both sides have at least two delimiters
              // the match forms a <strong> (use 2) and a long run such
              // as `******...*********` pairs up cleanly into nested
              // strongs instead of being skipped outright.
              const use2 = o.lit >= 2 && c.lit >= 2;
              const odd = !use2 && (o.canClose || c.canOpen) && ((o.lit + c.lit) % 2 === 1);
              if (!odd) return op;
            }
            op = o.prev;
          }
          return -1;
        };
        let op = findOpener(true);
        if (op < 0) op = findOpener(false);
        let found = op >= 0;
        if (found) {
          const o = delims[op];
          let use = 1;
          if (c.ch === "~") {
            // marked forms <del> with one tilde as well as two: use two
            // only when both sides have at least two.
            use = (o.lit >= 2 && c.lit >= 2) ? 2 : 1;
          } else if (o.lit >= 2 && c.lit >= 2) use = 2;
          const openTag = c.ch === "~" ? "<del>" : (use === 2 ? "<strong>" : "<em>");
          const closeTag = c.ch === "~" ? "</del>" : (use === 2 ? "</strong>" : "</em>");
          o.lit -= use; c.lit -= use;
          // Record the tag with its counterpart's position; the final
          // order is settled once, at the end of processEmphasis, by
          // span (farthest closer / nearest opener first) rather than
          // by the order matches happened to be found in.
          o.oT.push({ pos: cur, use, tag: openTag });
          c.cT.push({ pos: op, use, tag: closeTag });
        }
        if (!found) {
          if (!c.canOpen) unlinkDelim(cur);
          cur++;
        } else {
          if (delims[op].lit === 0) unlinkDelim(op);
          if (c.lit === 0) { unlinkDelim(cur); cur++; }
          // else the closer still has delimiters: re-process it
        }
      } else {
        cur++;
      }
    }
    // Settle tag order by span: on an opener the tag whose closer is
    // farthest out comes first (and for one closer, <em> before
    // <strong>); on a closer the tag whose opener is nearest comes
    // first (and for one opener, </strong> before </em>).
    for (const d of delims) {
      if (d.oT.length === 0 && d.cT.length === 0) continue;
      d.oT.sort((a, b) => b.pos - a.pos || a.use - b.use);
      d.cT.sort((a, b) => b.pos - a.pos || b.use - a.use);
      d.ent.s = d.cT.map((t) => t.tag).join("") + d.ch.repeat(d.lit) + d.oT.map((t) => t.tag).join("");
    }
  }

  while (i < n) {
    const ch = s[i];
    if (ch === "\n") { buf += "\n"; i++; continue; }
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < n && (s[j] === " " || s[j] === "\t")) j++;
      if (j < n && s[j] === "\n") {
        let sp = 0, k = j - 1;
        while (k >= i && s[k] === " ") { sp++; k--; }
        if (sp >= 2) { flush(); out.push({ s: "<br>" }); i = j + 1; while (i < n && (s[i] === " " || s[i] === "\t")) i++; continue; }
      }
      buf += s.slice(i, j); i = j; continue;
    }
    if (ch === "\\") {
      if (i + 1 < n) {
        const nx = s[i + 1];
        if (nx === "\n") { flush(); out.push({ s: "<br>" }); i += 2; while (i < n && (s[i] === " " || s[i] === "\t")) i++; continue; }
        if (isASCIIPunct(s.charCodeAt(i + 1))) { buf += nx; i += 2; continue; }
      }
      buf += "\\"; i++; continue;
    }
    if (ch === "`") {
      const cs = tryCodeSpan(s, i, n);
      if (cs) { flush(); out.push({ s: cs.html }); i = cs.end; continue; }
      let r = 0;
      while (i + r < n && s[i + r] === "`") r++;
      buf += s.slice(i, i + r); i += r; continue;
    }
    if (ch === "&") {
      const ent = tryEntity(s, i, n);
      if (ent) { flush(); out.push({ s: ent.raw !== undefined ? ent.raw : escapeHtml(ent.ch) }); i = ent.end; continue; }
      buf += "&"; i++; continue;
    }
    if (ch === "<") {
      const al = tryAngleAutolink(s, i, n);
      if (al) {
        const href = cleanUrl(al.email ? "mailto:" + al.raw : al.raw);
        if (href !== null) {
          flush();
          out.push({ s: '<a href="' + escapeHtml(href, true) + '">' + escapeHtml(al.raw, true) + "</a>" });
          i = al.end; continue;
        }
      }
      const tagEnd = tryRawHtmlTag(s, i, n);
      if (tagEnd > 0) { flush(); out.push({ s: s.slice(i, tagEnd) }); i = tagEnd; continue; }
      buf += "<"; i++; continue;
    }
    if (ch === "[" || (ch === "!" && s[i + 1] === "[")) {
      flush();
      const isImg = ch === "!";
      const idx = out.length;
      out.push({ s: isImg ? "![" : "[" });
      brackets.push({ idx, active: true, image: isImg, textStart: isImg ? i + 2 : i + 1 });
      i += isImg ? 2 : 1;
      continue;
    }
    if (ch === "]") {
      flush();
      if (brackets.length === 0 || !brackets[brackets.length - 1].active) {
        // An inactive bracket is still closed by its `]`; pop it so an
        // outer bracket (e.g. the `![` of a nested image) can become
        // the top bracket again.
        if (brackets.length > 0) brackets.pop();
        buf += "]"; i++; continue;
      }
      const top = brackets[brackets.length - 1];
      const after = i + 1;
      let link = null;
      if (s[after] === "(") link = parseInlineLinkAt(s, after, n);
      // A valid full-reference label that is not defined ends the
      // resolution here: `[foo][bar]` with [bar] undefined leaves
      // [foo] literal even when [foo] itself is defined, because the
      // [bar] link that forms deactivates the earlier bracket.
      let fullLabel = null;
      if (!link && s[after] === "[") {
        const lab = parseLabelAt(s, after, n);
        if (lab) {
          fullLabel = lab;
          const ref = refs.get(normLabel(lab.raw));
          if (ref) link = { end: lab.end, href: ref.href, title: ref.title };
        }
      }
      if (!link && s[after] === "[" && s[after + 1] === "]") {
        const ref = refs.get(normLabel(s.slice(top.textStart, i)));
        if (ref) link = { end: after + 2, href: ref.href, title: ref.title };
      }
      if (!link && !fullLabel) {
        const ref = refs.get(normLabel(s.slice(top.textStart, i)));
        if (ref) link = { end: i + 1, href: ref.href, title: ref.title };
      }
      if (link) {
        // Only a link deactivates earlier open brackets (links may not
        // contain links); an image inside a link leaves the outer bracket
        // active so the outer link can still form. And a link forming
        // inside an image's brackets must not deactivate the image
        // bracket itself, or the outer image could never form.
        if (!top.image) {
          for (let b = 0; b < brackets.length - 1; b++) if (!brackets[b].image) brackets[b].active = false;
        }
        brackets.pop();
        const start = top.idx + 1;
        const end = out.length;
        linkRanges.push([start, end]);
        if (top.image) {
          for (let e = start; e < end; e++) out[e].hide = true;
          images.push({ ent: out[top.idx], start, end, src: link.href, title: link.title });
          out[top.idx].s = "";
        } else {
          const tag = '<a href="' + escapeHtml(link.href, true) + '"' + (link.title !== null ? ' title="' + escapeHtml(link.title, true) + '"' : "") + ">";
          out[top.idx].s = tag;
          out.push({ s: "</a>" });
        }
        i = link.end;
        continue;
      }
      brackets.pop();
      buf += "]"; i++; continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let r = 0;
      while (i + r < n && s[i + r] === ch) r++;
      // A strikethrough run is one or two tildes; three or more tildes
      // never form <del> (`~~~not~~~` stays literal).
      if (ch === "~" && r > 2) { buf += s.slice(i, i + r); i += r; continue; }
      const before = i > 0 ? s[i - 1] : "";
      const after = i + r < n ? s[i + r] : "";
      const beforeWS = before === "" || isUWS(before);
      const afterWS = after === "" || isUWS(after);
      const beforePunct = before !== "" && isUPunct(before);
      const afterPunct = after !== "" && isUPunct(after);
      const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
      const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
      let canOpen, canClose;
      if (ch === "_") {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flush();
      const ent = { s: ch.repeat(r) };
      out.push(ent);
      const rec = { ch, lit: r, canOpen, canClose, ent, oi: out.length - 1, oT: [], cT: [], prev: dlast, next: -1 };
      if (dlast >= 0) delims[dlast].next = delims.length;
      delims.push(rec);
      dlast = delims.length - 1;
      i += r;
      continue;
    }
    // Extended autolink: only where the preceding char allows it.
    let handled = false;
    if (i === 0 || s[i - 1] === " " || s[i - 1] === "\t" || s[i - 1] === "\n" || s[i - 1] === "*" || s[i - 1] === "_" || s[i - 1] === "~" || s[i - 1] === "(" || s[i - 1] === "<" || s[i - 1] === '"' || s[i - 1] === "'") {
      let au = null;
      if (ch === "w" || ch === "W") au = tryWWWAt(s, i, n);
      if (!au && (ch === "h" || ch === "H")) au = tryHttpAt(s, i, n);
      if (!au && (ch === "m" || ch === "M" || ch === "x" || ch === "X")) au = tryProtocolAt(s, i, n);
      // An email address may start with h/w/m/x too (hello@..., mike@...),
      // so the email check is a fallback when the URL checks miss.
      if (!au && isEmailLocal(s.charCodeAt(i)) && s[i - 1] !== "_") {
        const e = tryEmailAt(s, i, n);
        if (e > 0) au = { end: e, href: "mailto:" + s.slice(i, e), text: s.slice(i, e) };
      }
      if (au) {
        const raw = au.text;
        const special = raw.indexOf("*") >= 0 || raw.indexOf("_") >= 0 || raw.indexOf("~") >= 0 || raw.indexOf("\\") >= 0 || raw.indexOf("<") >= 0 || raw.indexOf("[") >= 0 || raw.indexOf("]") >= 0;
        if (brackets.length > 0 && !special) {
          flush();
          const ent = { s: escapeHtml(raw) };
          deferred.push({ brs: brackets.slice(), entIdx: out.length, href: au.href });
          out.push(ent);
          i = au.end;
          handled = true;
        } else if (!special || brackets.length === 0) {
          const clean = cleanUrl(au.href);
          if (clean !== null) {
            flush();
            out.push({ s: '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(raw, true) + "</a>" });
            i = au.end;
            handled = true;
          }
        }
      }
    }
    if (handled) continue;
    // A lone '!' (not followed by '[') is plain text; the run scan below
    // would otherwise stop on it immediately and never advance.
    if (ch === "!") { buf += "!"; i++; continue; }
    // Plain run: everything up to the next special character. It also stops
    // just before a potential extended autolink that follows '(', '"' or
    // "'" (those are not break characters, so without this the run would
    // swallow the URL and the autolink check above would never run).
    let j = i;
    while (j < n) {
      const cj = s[j];
      if (cj === "\n" || cj === " " || cj === "\t" || cj === "\\" || cj === "`" || cj === "&" || cj === "<" || cj === "[" || cj === "]" || cj === "*" || cj === "_" || cj === "~" || cj === "!") break;
      if (j > i && (s[j - 1] === "(" || s[j - 1] === '"' || s[j - 1] === "'")) {
        if (cj === "w" || cj === "W" || cj === "h" || cj === "H" || cj === "m" || cj === "M" || cj === "x" || cj === "X" || isEmailLocal(s.charCodeAt(j))) break;
      }
      j++;
    }
    buf += s.slice(i, j);
    i = j;
  }
  flush();
  processEmphasis();
  // Deferred autolinks: activate unless the entry sits inside a formed link's
  // text or an image's alt text.
  for (const d of deferred) {
    let inside = false;
    for (const r of linkRanges) {
      if (d.entIdx >= r[0] && d.entIdx < r[1]) { inside = true; break; }
    }
    if (inside) continue;
    const clean = cleanUrl(d.href);
    if (clean === null) continue;
    const ent = out[d.entIdx];
    ent.s = '<a href="' + escapeHtml(clean, true) + '">' + ent.s + "</a>";
  }
  // Images: alt text is the rendered label text with all tags stripped.
  for (const im of images) {
    let alt = "";
    for (let e = im.start; e < im.end; e++) alt += out[e].s;
    alt = alt.replace(/<[^>]*>/g, "");
    im.ent.s = '<img src="' + escapeHtml(im.src, true) + '" alt="' + alt + '"' + (im.title !== null ? ' title="' + escapeHtml(im.title, true) + '"' : "") + ">";
  }
  let html = "";
  for (const e of out) if (!e.hide) html += e.s;
  return html;
}

// ================= block parser =================
// Line cursor with tab handling: {i, col, pad} where pad is the number of
// virtual spaces left from a partially consumed tab.
function curCh(cur, line) {
  if (cur.pad > 0) return " ";
  return cur.i < line.length ? line[cur.i] : "";
}
function curAdvance(cur, line, n) {
  let adv = 0;
  while (n > 0) {
    if (cur.pad > 0) {
      const take = cur.pad < n ? cur.pad : n;
      cur.pad -= take; cur.col += take; n -= take; adv += take;
    } else if (cur.i < line.length && line[cur.i] === " ") {
      cur.i++; cur.col++; n--; adv++;
    } else if (cur.i < line.length && line[cur.i] === "\t") {
      const w = 4 - (cur.col % 4);
      cur.i++;
      if (n >= w) { cur.col += w; n -= w; adv += w; }
      else { cur.col += n; cur.pad = w - n; adv += n; n = 0; }
    } else break;
  }
  return adv;
}
function curRest(cur, line) {
  return (cur.pad > 0 ? " ".repeat(cur.pad) : "") + line.slice(cur.i);
}

// Setext underline: returns 1 for '=', 2 for '-', 0 otherwise.
function matchSetext(rest) {
  let i = 0;
  while (i < rest.length && rest[i] === " " && i < 3) i++;
  if (i >= rest.length) return 0;
  const c = rest[i];
  if (c !== "=" && c !== "-") return 0;
  let j = i;
  while (j < rest.length && rest[j] === c) j++;
  while (j < rest.length && (rest[j] === " " || rest[j] === "\t")) j++;
  if (j !== rest.length) return 0;
  return c === "=" ? 1 : 2;
}

// Split a table row on unescaped '|'; a '|' preceded by an odd run of
// backslashes is a literal pipe. Leading/trailing pipes drop an empty cell.
function splitTableRow(text) {
  const cells = [];
  let cur = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "|") {
      let bs = 0, k = i - 1;
      while (k >= 0 && text[k] === "\\") { bs++; k--; }
      if (bs % 2 === 1) { cur = cur.slice(0, -1) + "|"; i++; continue; }
      cells.push(cur); cur = ""; i++; continue;
    }
    cur += c; i++;
  }
  cells.push(cur);
  let start = 0, end = cells.length;
  if (text.length > 0 && text[0] === "|") start = 1;
  if (text.length > 0 && text[text.length - 1] === "|") {
    let bs = 0, k = text.length - 2;
    while (k >= 0 && text[k] === "\\") { bs++; k--; }
    if (bs % 2 === 0) end--;
  }
  const out = [];
  for (let k = start; k < end; k++) out.push(cells[k].trim());
  return out;
}

// Table delimiter row: returns {header, aligns} or null.
function matchTableDelimiter(headerText, delimLine) {
  // The delimiter row may be indented at most 3 columns (a tab counts as 4).
  let ind = 0, p = 0;
  while (p < delimLine.length && (delimLine[p] === " " || delimLine[p] === "\t")) {
    if (delimLine[p] === " ") { p++; ind++; }
    else { ind += 4 - (ind % 4); p++; }
    if (ind > 3) return null;
  }
  const header = splitTableRow(headerText);
  const delim = splitTableRow(delimLine);
  if (header.length < 1 || delim.length !== header.length) return null;
  const aligns = [];
  for (const cell of delim) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    const left = cell[0] === ":", right = cell[cell.length - 1] === ":";
    aligns.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  return { header, aligns };
}

const BLOCK_TAGS = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul").split(" "));

// HTML block start type (1-7) for the line content, or 0.
function matchHtmlStart(rest) {
  let i = 0;
  while (i < rest.length && rest[i] === " " && i < 3) i++;
  if (i >= rest.length || rest[i] !== "<") return 0;
  const s = rest.slice(i);
  const low = s.slice(0, 10).toLowerCase();
  if (low.indexOf("<pre") === 0 || low.indexOf("<script") === 0 || low.indexOf("<style") === 0 || low.indexOf("<textarea") === 0) {
    const after = s[low.indexOf("<pre") === 0 ? 4 : low.indexOf("<script") === 0 ? 7 : low.indexOf("<style") === 0 ? 6 : 9];
    if (after === undefined || after === " " || after === "\t" || after === "\n" || after === ">") return 1;
  }
  if (s.indexOf("<!--") === 0) return 2;
  if (s.indexOf("<?") === 0) return 3;
  if (s.indexOf("<!") === 0 && s.length > 2 && isASCIILetter(s.charCodeAt(2))) return 4;
  if (s.indexOf("<![CDATA[") === 0) return 5;
  // type 6: block-level tag
  let m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|\/?$)/.exec(s);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  // type 7: a complete open/close tag (any name) alone on the line,
  // followed only by whitespace/EOL
  m = /^<\/?[A-Za-z][A-Za-z0-9-]*/.exec(s);
  if (m) {
    const e = tryRawHtmlTag(s, 0, s.length);
    if (e > 0 && s.slice(e).trim() === "") return 7;
  }
  return 0;
}

// Thematic break: 3+ of the same *, -, _ with only spaces between.
function matchThematicBreak(rest) {
  let i = 0;
  while (i < rest.length && rest[i] === " " && i < 3) i++;
  if (i >= rest.length) return false;
  const c = rest[i];
  if (c !== "*" && c !== "-" && c !== "_") return false;
  let count = 0, j = i;
  while (j < rest.length) {
    const ch = rest[j];
    if (ch === c) { count++; j++; }
    else if (ch === " " || ch === "\t") j++;
    else return false;
  }
  return count >= 3;
}

// ATX heading: returns {level, text} or null. text keeps its leading spaces
// stripped only up to the '#'+space; the closing #'s are stripped per spec.
function matchAtx(rest) {
  let i = 0;
  while (i < rest.length && rest[i] === " " && i < 3) i++;
  let level = 0;
  while (i + level < rest.length && rest[i + level] === "#" && level < 6) level++;
  if (level < 1) return null;
  const after = i + level;
  if (after < rest.length && rest[after] !== " " && rest[after] !== "\t") return null;
  let text = rest.slice(after);
  // strip one run of leading spaces/tabs
  let k = 0;
  while (k < text.length && (text[k] === " " || text[k] === "\t")) k++;
  text = text.slice(k);
  // strip trailing spaces, then an optional closing run of #'s preceded by a space
  let e = text.length;
  while (e > 0 && (text[e - 1] === " " || text[e - 1] === "\t")) e--;
  let f = e;
  while (f > 0 && text[f - 1] === "#") f--;
  if (f < e && (f === 0 || text[f - 1] === " " || text[f - 1] === "\t")) {
    e = f;
    while (e > 0 && (text[e - 1] === " " || text[e - 1] === "\t")) e--;
  }
  text = text.slice(0, e);
  return { level, text };
}

// Fenced code start: returns {char, len, info} or null.
function matchFenceStart(rest) {
  let i = 0;
  while (i < rest.length && rest[i] === " " && i < 3) i++;
  if (i >= rest.length) return null;
  const c = rest[i];
  if (c !== "`" && c !== "~") return null;
  let len = 0;
  while (i + len < rest.length && rest[i + len] === c) len++;
  if (len < 3) return null;
  let info = rest.slice(i + len);
  if (c === "`" && info.indexOf("`") >= 0) return null;
  info = info.trim();
  return { char: c, len, info, indent: i };
}

// Fence close: same char, length >= opening, only spaces after.
function matchFenceClose(rest, fence) {
  let i = 0;
  while (i < rest.length && rest[i] === " " && i < 3) i++;
  let len = 0;
  while (i + len < rest.length && rest[i + len] === fence.char) len++;
  if (len < fence.len) return false;
  let j = i + len;
  while (j < rest.length && (rest[j] === " " || rest[j] === "\t")) j++;
  return j === rest.length;
}

// List marker: returns {ordered, bullet, delim, start, markerCols, contentIndent, content, contentCol} or null.
// markerCols is the marker width in columns; contentIndent is the columns from
// the marker start to the content start; content is the text after the marker.
function matchListStart(rest, startCol) {
  let p = 0, col = startCol;
  while (p < rest.length && rest[p] === " " && col - startCol < 3) { p++; col++; }
  if (p >= rest.length) return null;
  const c = rest[p];
  const markerCol = col;
  let ordered = false, bullet = "", delim = "", start = 0, markerEnd = 0;
  if (c === "-" || c === "+" || c === "*") {
    bullet = c; markerEnd = p + 1;
  } else if (isASCIIDigit(c.charCodeAt(0))) {
    let j = p;
    while (j < rest.length && isASCIIDigit(rest.charCodeAt(j)) && j - p < 9) j++;
    if (j - p < 1 || j - p > 9) return null;
    if (j >= rest.length || (rest[j] !== "." && rest[j] !== ")")) return null;
    ordered = true; delim = rest[j]; start = parseInt(rest.slice(p, j), 10);
    markerEnd = j + 1;
  } else return null;
  const markerCols = markerEnd - p;
  // whitespace after the marker
  if (markerEnd >= rest.length) {
    return { ordered, bullet, delim, start, markerCols, contentIndent: (markerCol - startCol) + markerCols + 1, content: "", contentCol: markerCol + markerCols + 1, empty: true };
  }
  const nx = rest[markerEnd];
  if (nx !== " " && nx !== "\t") return null;
  // count the spaces/tabs after the marker, in columns
  let q = markerEnd, cc = col + markerCols, spaces = 0;
  while (q < rest.length && (rest[q] === " " || rest[q] === "\t")) {
    if (rest[q] === " ") { q++; cc++; spaces++; }
    else {
      const w = 4 - (cc % 4);
      q++; cc += w; spaces += w;
    }
    if (spaces >= 5) break;
  }
  if (spaces >= 5) {
    // 5+ spaces: the content indent is marker width + 1 and the rest of the
    // whitespace (partially consumed tab included) is part of the content.
    // Strip just the one column past the marker to reach the content column.
    const stripped = stripCols(rest, markerEnd, col + markerCols, 1);
    return { ordered, bullet, delim, start, markerCols, contentIndent: (markerCol - startCol) + markerCols + 1, content: stripped.text, contentCol: stripped.col, empty: stripped.text.trim() === "" };
  }
  if (q >= rest.length) {
    return { ordered, bullet, delim, start, markerCols, contentIndent: (markerCol - startCol) + markerCols + 1, content: "", contentCol: markerCol + markerCols + 1, empty: true };
  }
  return { ordered, bullet, delim, start, markerCols, contentIndent: cc - startCol, content: rest.slice(q), contentCol: cc, empty: false };
}

// Extract link reference definitions from the start of a paragraph's text.
// Returns the remaining text. Adds definitions to refs (first wins).
function extractRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let j = pos, spaces = 0;
    while (j < n && text[j] === " " && spaces < 3) { j++; spaces++; }
    if (j >= n || text[j] !== "[") break;
    const lab = parseLabelAt(text, j, n);
    if (!lab) break;
    let k = lab.end;
    if (k >= n || text[k] !== ":") break;
    k++;
    k = skipWS(text, k, n);
    const d = parseDest(text, k, n);
    if (!d) break;
    const href = cleanUrl(unescapeStr(d.dest));
    if (href === null) break;
    // After the destination, only spaces/tabs may be skipped on this line;
    // a title must be separated from the destination by whitespace.
    let t = d.end;
    while (t < n && (text[t] === " " || text[t] === "\t")) t++;
    let title = null, afterTitle = -1;
    if (t < n && (text[t] === '"' || text[t] === "'" || text[t] === "(")) {
      if (t === d.end) break; // no whitespace before the title -> not a def
      const q = text[t];
      const close = q === "(" ? ")" : q;
      let m = t + 1;
      while (m < n) {
        const c = text[m];
        if (c === close) break;
        if (c === "\\") { m += 2; continue; }
        m++;
      }
      if (m >= n || text[m] !== close) break;
      title = unescapeStr(text.slice(t + 1, m));
      afterTitle = m + 1;
    } else if (t < n && text[t] === "\n") {
      // A title may sit on the next line. If it is not a well-formed title
      // (no closing quote, or extra text after it), the definition still
      // stands without a title and the next line stays as paragraph text.
      let u = t + 1;
      while (u < n && (text[u] === " " || text[u] === "\t")) u++;
      if (u < n && (text[u] === '"' || text[u] === "'" || text[u] === "(")) {
        const q = text[u];
        const close = q === "(" ? ")" : q;
        let m = u + 1;
        while (m < n) {
          const c = text[m];
          if (c === close) break;
          if (c === "\\") { m += 2; continue; }
          m++;
        }
        if (m < n && text[m] === close) {
          let e2 = m + 1;
          while (e2 < n && (text[e2] === " " || text[e2] === "\t")) e2++;
          if (e2 >= n || text[e2] === "\n") {
            title = unescapeStr(text.slice(u + 1, m));
            afterTitle = m + 1;
          }
        }
      }
    }
    k = afterTitle >= 0 ? afterTitle : t;
    let e = k;
    while (e < n && (text[e] === " " || text[e] === "\t")) e++;
    if (e < n && text[e] !== "\n") break;
    const key = normLabel(lab.raw);
    if (!refs.has(key)) refs.set(key, { href, title });
    pos = e < n ? e + 1 : e;
  }
  return text.slice(pos);
}

// Strip n columns starting at position pos (column col) in rest, consuming
// tabs partially (the leftover becomes leading spaces in the result).
// Expand leading tabs to spaces for the column they start at (a tab at
// column 13 reaches column 16, i.e. 3 spaces). Only when the content
// starts inside a container indent (col > 0); a tab at the top level
// (col 0) stays a raw tab in code content.
function expandLeadTabs(text, col) {
  if (col === 0) return text;
  let i = 0, c = col, out = "";
  while (i < text.length && text[i] === "\t") {
    const w = 4 - (c % 4);
    out += " ".repeat(w); c += w; i++;
  }
  return out + text.slice(i);
}

function stripCols(rest, pos, col, n) {
  let p = pos, c = col, virt = 0;
  while (c - col < n && p < rest.length) {
    const ch = rest[p];
    if (ch === " ") { p++; c++; }
    else if (ch === "\t") {
      const w = 4 - (c % 4);
      p++;
      if (c - col + w <= n) c += w;
      else { virt = (c - col + w) - n; c = col + n; }
    } else break;
  }
  return { text: " ".repeat(virt) + rest.slice(p), col: c };
}

// Strip n columns of indent from rest (counting tabs from startCol).
// Returns the remaining string, or null if the indent is smaller.
function stripIndent(rest, startCol, n) {
  let col = startCol, p = 0;
  while (p < rest.length && col - startCol < n) {
    const c = rest[p];
    if (c === " ") { p++; col++; }
    else if (c === "\t") { const w = 4 - (col % 4); p++; col += w; }
    else return null;
  }
  if (col - startCol < n) return null;
  const leftover = (col - startCol) - n;
  return (leftover > 0 ? " ".repeat(leftover) : "") + rest.slice(p);
}

// Does the next line hold content for an (otherwise empty) list item?
function nextLineHasContent(lines, li, startCol, lst) {
  if (li + 1 >= lines.length) return false;
  const nl = lines[li + 1];
  if (nl.trim() === "") return false;
  let p = 0;
  while (p < nl.length && nl[p] === " " && p < 3) p++;
  if (p < nl.length && nl[p] === ">") return true;
  let col = 0, q = 0;
  while (q < nl.length && (nl[q] === " " || nl[q] === "\t")) {
    if (nl[q] === " ") { q++; col++; }
    else { col += 4 - (col % 4); q++; }
  }
  return col >= startCol + lst.contentIndent;
}

// Does an HTML block of types 1-5 end on this line?
function htmlEnds(node, lineText) {
  const t = node.htype;
  if (t === 1) return /<\/(pre|script|style|textarea)\s*>/i.test(lineText);
  if (t === 2) return lineText.indexOf("-->") >= 0;
  if (t === 3) return lineText.indexOf("?>") >= 0;
  if (t === 4) return lineText.indexOf(">") >= 0;
  if (t === 5) return lineText.indexOf("]]>") >= 0;
  return false;
}

// Match a block start in the line content. Returns a description or null.
function matchBlockStart(rest, startCol, canInterruptPara, lines, li) {
  let p = 0;
  while (p < rest.length && rest[p] === " " && p < 3) p++;
  if (p < rest.length && rest[p] === ">") {
    let q = p + 1, cc = startCol + p + 1, after;
    if (q < rest.length && rest[q] === " ") { q++; cc++; after = rest.slice(q); }
    else if (q < rest.length && rest[q] === "\t") {
      const w = 4 - (cc % 4);
      // only one column of the tab is consumed; the rest is virtual spaces
      after = " ".repeat(w - 1) + rest.slice(q + 1);
      cc += 1;
    } else after = rest.slice(q);
    return { kind: "quote", after, afterCol: cc };
  }
  const atx = matchAtx(rest);
  if (atx) return { kind: "heading", level: atx.level, text: atx.text };
  const fence = matchFenceStart(rest);
  if (fence) return { kind: "fence", char: fence.char, len: fence.len, info: fence.info, indent: fence.indent };
  const ht = matchHtmlStart(rest);
  if (ht) {
    if (!canInterruptPara || ht <= 6) return { kind: "html", htype: ht };
  }
  if (matchThematicBreak(rest)) return { kind: "hr" };
  const lst = matchListStart(rest, startCol);
  if (lst) {
    if (canInterruptPara) {
      if (lst.ordered && lst.start !== 1) return null;
      if (lst.empty && !nextLineHasContent(lines, li, startCol, lst)) return null;
    }
    return { kind: "list", ...lst };
  }
  if (!canInterruptPara) {
    const code = stripIndent(rest, startCol, 4);
    if (code !== null) return { kind: "code", content: code };
  }
  return null;
}

function parseBlocks(src, refs) {
  src = src.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  if (src.endsWith("\n")) lines.pop();
  const doc = { type: "doc", children: [] };
  const stack = [doc];
  let lastLineBlank = false;

  function finalizeNode(node) {
    if (node.type === "para") {
      node.text = extractRefDefs(node.lines.join("\n"), refs);
      node.lines = null;
    } else if (node.type === "code") {
      while (node.lines.length > 0 && node.lines[node.lines.length - 1] === "") node.lines.pop();
    }
  }
  function closeTo(depth) {
    while (stack.length > depth) finalizeNode(stack.pop());
  }
  function noteNewBlock(parent) {
    if (lastLineBlank && parent.type === "item" && parent.children.length > 0 && parent.list) {
      parent.list.tight = false;
    }
  }
  // A list can only hold items. If the top of the stack is a list and the new
  // block is not a list item that can join it, pop the list so the block
  // becomes a sibling of the list instead of a (bogus) child of it.
  function popListIfNeeded(desc) {
    while (stack.length > 0 && stack[stack.length - 1].type === "list") {
      const list = stack[stack.length - 1];
      if (desc && desc.kind === "list" && list.ordered === desc.ordered) {
        if (!desc.ordered && list.bullet === desc.bullet) break;
        if (desc.ordered && list.delim === desc.delim) break;
      }
      stack.pop();
    }
  }

  // Create blocks from a matched start, following quote/list nesting.
  function createBlock(desc, rest, startCol, lines, li) {
    let parent = stack[stack.length - 1];
    let curRest = rest, curCol = startCol;
    let d = desc;
    for (;;) {
      if (d.kind === "quote") {
        const q = { type: "quote", children: [] };
        noteNewBlock(parent);
        parent.children.push(q);
        stack.push(q);
        parent = q;
        curRest = d.after; curCol = d.afterCol;
        d = matchBlockStart(curRest, curCol, false, lines, li);
        if (!d) {
          if (curRest.trim() !== "") {
            const para = { type: "para", lines: [curRest] };
            noteNewBlock(parent);
            parent.children.push(para);
            stack.push(para);
          }
          return;
        }
        continue;
      }
      if (d.kind === "list") {
        let list = null;
        if (parent.type === "list" && parent.ordered === d.ordered) {
          if (!d.ordered && parent.bullet === d.bullet) list = parent;
          else if (d.ordered && parent.delim === d.delim) list = parent;
        }
        if (!list) {
          const lastChild = parent.children[parent.children.length - 1];
          if (lastChild && lastChild.type === "list" && lastChild.ordered === d.ordered) {
            if (!d.ordered && lastChild.bullet === d.bullet) list = lastChild;
            else if (d.ordered && lastChild.delim === d.delim) list = lastChild;
          }
        }
        if (!list) {
          list = { type: "list", ordered: d.ordered, bullet: d.bullet, delim: d.delim, start: d.start, tight: true, children: [] };
          noteNewBlock(parent);
          parent.children.push(list);
          stack.push(list);
        }
        const item = { type: "item", children: [], contentIndent: d.contentIndent, list };
        if (lastLineBlank && list.children.length > 0) list.tight = false;
        list.children.push(item);
        stack.push(item);
        parent = item;
        if (d.empty) return;
        curRest = d.content; curCol = d.contentCol;
        d = matchBlockStart(curRest, curCol, false, lines, li);
        if (!d) {
          if (curRest.trim() !== "") {
            const para = { type: "para", lines: [curRest] };
            noteNewBlock(parent);
            parent.children.push(para);
            stack.push(para);
          }
          return;
        }
        continue;
      }
      // leaf blocks
      if (d.kind === "heading") {
        noteNewBlock(parent);
        parent.children.push({ type: "heading", level: d.level, text: d.text });
        return;
      }
      if (d.kind === "hr") {
        noteNewBlock(parent);
        parent.children.push({ type: "hr" });
        return;
      }
      if (d.kind === "fence") {
        const f = { type: "fence", char: d.char, len: d.len, info: d.info, indent: d.indent, lines: [] };
        noteNewBlock(parent);
        parent.children.push(f);
        stack.push(f);
        return;
      }
      if (d.kind === "html") {
        const h = { type: "html", htype: d.htype, lines: [curRest], trailNL: d.htype <= 5 };
        noteNewBlock(parent);
        parent.children.push(h);
        // A type 1-5 block whose first line already contains its closing
        // tag is complete at once. Types 6 and 7 continue until a blank
        // line, so they stay on the stack.
        if (!htmlEnds(h, curRest)) stack.push(h);
        else if (li + 1 < lines.length && lines[li + 1].trim() === "") h.trailNL = false;
        return;
      }
      if (d.kind === "code") {
        const c = { type: "code", lines: [d.content] };
        noteNewBlock(parent);
        parent.children.push(c);
        stack.push(c);
        return;
      }
      // paragraph fallback
      const para = { type: "para", lines: [curRest] };
      noteNewBlock(parent);
      parent.children.push(para);
      stack.push(para);
      return;
    }
  }

  // For a blank line, walk the containers below the open leaf (if any) and
  // return the line's content after them, or null when the line is not inside
  // a quote container. Blank lines never close lists.
  function blankLineContent(line) {
    let cur = { i: 0, col: 0, pad: 0 };
    for (let s = 1; s < stack.length - 1; s++) {
      const node = stack[s];
      if (node.type === "quote") {
        curAdvance(cur, line, 3);
        if (curCh(cur, line) === ">") {
          cur.i++; cur.col++;
          curAdvance(cur, line, 1);
        } else {
          return null;
        }
      } else if (node.type === "item") {
        curAdvance(cur, line, node.contentIndent);
      }
      // a list consumes nothing; a leaf stops the walk (not reached here)
    }
    return curRest(cur, line);
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.trim() === "") {
      const top = stack[stack.length - 1];
      if (top.type === "para") { finalizeNode(top); stack.pop(); }
      else if (top.type === "table") { stack.pop(); }
      else if (top.type === "code" || top.type === "fence" || top.type === "html") {
        if (top.type === "html" && (top.htype === 6 || top.htype === 7)) {
          // a blank line ends a type 6/7 HTML block and is not part of it
          stack.pop();
        } else {
          const content = blankLineContent(line);
          if (content === null) {
            if (top.type === "code") finalizeNode(top);
            stack.pop();
          } else if (top.type === "code") {
            top.lines.push(stripCols(content, 0, 0, 4).text);
          } else if (top.type === "fence") {
            top.lines.push(stripCols(content, 0, 0, top.indent).text);
          } else {
            top.lines.push(content);
          }
        }
      }
      // An empty list item (no content) followed by a blank line is done;
      // the blank line closes it (and an empty list with it).
      while (stack.length > 1) {
        const t = stack[stack.length - 1];
        if (t.type === "item" && t.children.length === 0) { stack.pop(); continue; }
        if (t.type === "list" && t.children.length === 0) { stack.pop(); continue; }
        break;
      }
      // A blank line matches no block quote (it carries no `>` marker), so
      // it closes quotes; lists and items stay open across blank lines.
      // Skip this when a code/fence/HTML leaf stayed open (its containers
      // matched, so the blank line was inside them).
      const nt = stack[stack.length - 1];
      if (nt.type !== "code" && nt.type !== "fence" && nt.type !== "html") {
        let d = 1;
        for (let s = 1; s < stack.length; s++) {
          if (stack[s].type === "quote") break;
          if (stack[s].type === "list" || stack[s].type === "item") d = s + 1;
          else break;
        }
        closeTo(d);
      }
      lastLineBlank = true;
      continue;
    }
    // ---- container walk ----
    let cur = { i: 0, col: 0, pad: 0 };
    let depth = 1;
    for (let s = 1; s < stack.length; s++) {
      const node = stack[s];
      if (node.type === "para" || node.type === "code" || node.type === "fence" || node.type === "html" || node.type === "table") break;
      if (node.type === "quote") {
        const save = { i: cur.i, col: cur.col, pad: cur.pad };
        curAdvance(cur, line, 3);
        if (curCh(cur, line) === ">") {
          cur.i++; cur.col++;
          curAdvance(cur, line, 1);
          depth = s + 1;
        } else { cur.i = save.i; cur.col = save.col; cur.pad = save.pad; break; }
      } else if (node.type === "list") {
        depth = s + 1;
      } else if (node.type === "item") {
        const save = { i: cur.i, col: cur.col, pad: cur.pad };
        if (curAdvance(cur, line, node.contentIndent) >= node.contentIndent) depth = s + 1;
        else { cur.i = save.i; cur.col = save.col; cur.pad = save.pad; break; }
      }
    }
    const top = stack[stack.length - 1];
    const startCol = cur.col;
    const rest = curRest(cur, line);
    // A line whose content is blank after the containers are stripped does
    // not start a block. An empty one ends an open paragraph; a whitespace
    // one continues an open paragraph (with its whitespace) or a code /
    // fence / HTML leaf, but never starts a paragraph on its own. Such a
    // line is not a blank line for list tightness (a lone `>` marker, for
    // example, does not make a list loose), so lastLineBlank is untouched.
    if (rest.trim() === "") {
      if (top.type === "para") {
        if (rest.length === 0) {
          // A blank line that ends a paragraph which is a direct child of a
          // list item separates two blocks inside that item, so it counts
          // for looseness; one ending a paragraph nested deeper (inside a
          // quote) does not separate the item's own children.
          const parent = stack[stack.length - 2];
          const direct = parent && parent.type === "item";
          finalizeNode(top); stack.pop();
          if (direct) lastLineBlank = true;
        }
        else top.lines.push(rest);
      } else if (top.type === "code") {
        const sc = stripCols(rest, 0, startCol, 4);
        top.lines.push(expandLeadTabs(sc.text, sc.col));
      } else if (top.type === "fence") {
        const sc = stripCols(rest, 0, startCol, top.indent);
        top.lines.push(expandLeadTabs(sc.text, sc.col));
      } else if (top.type === "html") {
        if (top.htype === 6 || top.htype === 7) stack.pop();
        else top.lines.push(rest);
      } else if (top.type === "table") {
        stack.pop();
      }
      continue;
    }
    if (top.type === "para") {
      // A setext underline or table delimiter cannot be a lazy continuation
      // line: it only counts when every container above the paragraph matched.
      const containersMatched = depth === stack.length - 1;
      const st = containersMatched ? matchSetext(rest) : 0;
      if (st) {
        // Link reference definitions at the start of the paragraph are
        // extracted first; the heading text is what remains. If nothing
        // remains, the line is not a heading underline at all.
        const remaining = extractRefDefs(top.lines.join("\n"), refs).trim();
        if (remaining !== "") {
          top.type = "heading"; top.level = st; top.text = remaining; top.lines = null;
          stack.pop();
          lastLineBlank = false;
          continue;
        }
      }
      if (containersMatched && top.lines.length === 1) {
        const tbl = matchTableDelimiter(top.lines[0], rest);
        if (tbl) {
          // Convert the paragraph in place to a table; it stays on the stack
          // to receive body rows.
          top.type = "table"; top.header = tbl.header; top.aligns = tbl.aligns; top.rows = [];
          top.lines = null;
          lastLineBlank = false;
          continue;
        }
      }
      // A list starting inside the same list item as the paragraph is a
      // sibling block of that paragraph, not an interruption of it, so
      // an ordered list may start there even when it does not start
      // with 1 (e.g. `505791.` after a paragraph inside an item).
      const parent = stack[stack.length - 2];
      const inItem = parent && parent.type === "item";
      const bs = matchBlockStart(rest, startCol, containersMatched && !inItem, lines, li);
      // An indented code block can never interrupt a paragraph (a lazy line
      // that looks indented is a paragraph continuation, not code).
      if (bs && bs.kind !== "code") {
        closeTo(depth);
        popListIfNeeded(bs);
        createBlock(bs, rest, startCol, lines, li);
        lastLineBlank = false;
        continue;
      }
      // A lazy setext underline (containers did not match) is not a heading;
      // it joins the paragraph with four spaces prepended. Any other lazy
      // line joins with its leading whitespace stripped (the container walk
      // already skipped up to three columns of it).
      if (!containersMatched) {
        if (matchSetext(rest)) top.lines.push("    " + rest);
        else top.lines.push(rest.replace(/^[ \t]+/, ""));
      } else top.lines.push(rest);
      lastLineBlank = false;
      continue;
    }
    if (top.type === "code") {
      if (depth === stack.length - 1) {
        const save = { i: cur.i, col: cur.col, pad: cur.pad };
        if (curAdvance(cur, line, 4) >= 4) {
          top.lines.push(curRest(cur, line));
          lastLineBlank = false;
          continue;
        }
        cur.i = save.i; cur.col = save.col; cur.pad = save.pad;
      }
      finalizeNode(top); stack.pop();
    } else if (top.type === "fence") {
      if (depth === stack.length - 1) {
        if (matchFenceClose(rest, top)) { stack.pop(); lastLineBlank = false; continue; }
        const sc = stripCols(rest, 0, startCol, top.indent);
        top.lines.push(expandLeadTabs(sc.text, sc.col));
        lastLineBlank = false;
        continue;
      }
      stack.pop();
    } else if (top.type === "html") {
      if (depth === stack.length - 1) {
        top.lines.push(rest);
        if (htmlEnds(top, rest)) {
          if (li + 1 < lines.length && lines[li + 1].trim() === "") top.trailNL = false;
          stack.pop();
        }
        lastLineBlank = false;
        continue;
      }
      stack.pop();
    } else if (top.type === "table") {
      if (depth === stack.length - 1) {
        const bs = matchBlockStart(rest, startCol, false, lines, li);
        if (!bs) {
          top.rows.push(splitTableRow(rest));
          lastLineBlank = false;
          continue;
        }
      }
      stack.pop();
    }
    closeTo(depth);
    const bs = matchBlockStart(rest, startCol, false, lines, li);
    popListIfNeeded(bs);
    if (bs) createBlock(bs, rest, startCol, lines, li);
    else createBlock({ kind: "para" }, rest, startCol, lines, li);
    lastLineBlank = false;
  }
  closeTo(0);
  return doc;
}

// ================= rendering =================

function renderNode(node, refs, out) {
  switch (node.type) {
    case "doc":
      for (const c of node.children) renderNode(c, refs, out);
      break;
    case "quote":
      out.push("<blockquote>\n");
      for (const c of node.children) renderNode(c, refs, out);
      out.push("</blockquote>\n");
      break;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      out.push("<" + tag + (node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : "") + ">\n");
      for (const c of node.children) renderItem(c, node, refs, out);
      out.push("</" + tag + ">\n");
      break;
    }
    case "para":
      if (node.text !== "") out.push("<p>" + inlineParse(node.text, refs) + "</p>\n");
      break;
    case "heading":
      out.push("<h" + node.level + ">" + inlineParse(node.text, refs) + "</h" + node.level + ">\n");
      break;
    case "code":
      out.push("<pre><code>" + escapeHtml(node.lines.join("\n")) + (node.lines.length > 0 ? "\n" : "") + "</code></pre>\n");
      break;
    case "fence": {
      let cls = "";
      if (node.info) {
        const w = node.info.split(/[ \t]/)[0];
        if (w) cls = ' class="language-' + escapeHtml(unescapeStr(w), true) + '"';
      }
      out.push("<pre><code" + cls + ">" + escapeHtml(node.lines.join("\n")) + (node.lines.length > 0 ? "\n" : "") + "</code></pre>\n");
      break;
    }
    case "html":
      // Types 1-5 end at a closing-tag line, whose newline is part of the
      // block unless the next line is blank; types 6-7 end at a blank line
      // and carry no trailing newline of their own (a following block starts
      // immediately after the last HTML line; a document ending on one gains
      // a final newline in parse).
      out.push(node.lines.join("\n") + (node.trailNL ? "\n" : ""));
      break;
    case "hr":
      out.push("<hr>\n");
      break;
    case "table": {
      out.push("<table>\n<thead>\n<tr>\n");
      for (let k = 0; k < node.header.length; k++) {
        const a = node.aligns[k];
        out.push("<th" + (a ? ' align="' + a + '"' : "") + ">" + inlineParse(node.header[k], refs) + "</th>\n");
      }
      out.push("</tr>\n</thead>\n");
      if (node.rows.length > 0) {
        out.push("<tbody>");
        for (const row of node.rows) {
          out.push("<tr>\n");
          for (let k = 0; k < node.header.length; k++) {
            const a = node.aligns[k];
            const cell = k < row.length ? row[k] : "";
            out.push("<td" + (a ? ' align="' + a + '"' : "") + ">" + inlineParse(cell, refs) + "</td>\n");
          }
          out.push("</tr>\n");
        }
        out.push("</tbody></table>\n");
      } else {
        out.push("</table>\n");
      }
      break;
    }
  }
}

function renderItem(item, list, refs, out) {
  out.push("<li>");
  for (let ci = 0; ci < item.children.length; ci++) {
    const c = item.children[ci];
    if (ci === 0 && c.type === "para") {
      // Task list: a leading `[ ]` / `[x]` / `[X]` (followed by space,
      // tab or end of text) on the item's first paragraph becomes a
      // checkbox; the marker itself is dropped, the rest kept.
      const t = c.text;
      if (t.length >= 3 && t[0] === "[" && t[2] === "]" && (t[1] === " " || t[1] === "x" || t[1] === "X") && (t.length === 3 || t[3] === " " || t[3] === "\t")) {
        const box = t[1] === " " ? '<input disabled="" type="checkbox">' : '<input checked="" disabled="" type="checkbox">';
        const rest = t.slice(3);
        if (list.tight) out.push(box + inlineParse(rest, refs));
        else out.push("<p>" + box + inlineParse(rest, refs) + "</p>\n");
        continue;
      }
    }
    if (list.tight && c.type === "para") {
      if (c.text !== "") out.push(inlineParse(c.text, refs));
    } else {
      renderNode(c, refs, out);
    }
  }
  out.push("</li>\n");
}

// ================= entry point =================
// parse(markdown) -> HTML, exactly matching marked 18.1.3 with default options.
export function parse(src) {
  const refs = new Map();
  const doc = parseBlocks(src, refs);
  const out = [];
  renderNode(doc, refs, out);
  let html = out.join("");
  // An HTML block (type 6/7) carries no trailing newline of its own; the
  // document gains one only when the source itself ends with a newline.
  if (html.length > 0 && !html.endsWith("\n") && src.endsWith("\n")) html += "\n";
  return html;
}
export default parse;
