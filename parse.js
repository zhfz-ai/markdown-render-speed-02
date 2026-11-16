// SwiftMark — a dependency-free, single-pass Markdown renderer that returns
// byte-identical HTML to marked 18.1.3 with its default options (GFM on,
// breaks off, pedantic off, async off). Written fresh in this session from
// the kit's RULES.txt and marked 18.1.3's documented behaviour: a block
// scanner walks the source once into light tokens, then a renderer turns
// inline spans straight into HTML (no token tree on the hot path).
//
// Design notes (my own structure):
// - parse() is stateless per call: nothing is kept from an earlier case.
// - Link reference definitions are collected during the block scan, before
//   any inline rendering, so a definition anywhere in the document applies.
// - Inline parsing mirrors marked's delimiter rules: a masked copy of the
//   inline source (code spans, links and tags neutralised) drives the search
//   for the last possible emphasis / strikethrough closer, and the same
//   right-delimiter patterns decide whether a run opens or closes.
// - Named-group backreferences use \k<name> (a single backslash) inside
//   regex literals; building them from strings would need a doubled one.

// ---------------------------------------------------------------- helpers

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PERCENT_DECODE = /%25/g;
const BLANK_LINE = /^[ \t]*$/;
const NON_SPACE = /[^ ]/;
const BEGIN_SPACE = /^\s+/;
const LEADING_SPACE_TAB = /^[ \t]+/;
const TAB_GLOBAL = /\t/g;
const NEWLINE_GLOBAL = /\n/g;
const MULTI_SPACE = /\s+/g;
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const HREF_BRACKETS = /^<(.*)>$/;
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const ENDING_HASH = /#$/;
const ENDING_SPACE_TAB = /[ \t]$/;
const START_SPACE = /^ /;
const END_SPACE = / $/;
const END_NEWLINE = /\n$/;
const NOT_SPACE_START = /^\S*/;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

/** Escape HTML the way marked does: encode=true escapes all five chars. */
function esc(s, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(s)) return s.replace(ESCAPE_REPLACE, (c) => ESCAPE_MAP[c]);
  } else if (ESCAPE_TEST_NO_ENCODE.test(s)) {
    return s.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPE_MAP[c] || '&amp;');
  }
  return s;
}

/** Decode numeric character references; a bare & becomes &amp;. */
function decodeEntities(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/** encodeURI a link href, keeping literal % signs; null when it throws. */
function encodeHref(s) {
  try {
    return encodeURI(s).replace(PERCENT_DECODE, '%');
  } catch {
    return null;
  }
}

/** Strip trailing runs of one char (or, when flip, of any other char). */
function stripTail(s, ch, flip) {
  const n = s.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !flip) cut++;
    else if (c !== ch && flip) cut++;
    else break;
  }
  return s.slice(0, n - cut);
}

/** Drop trailing blank lines, keeping at most one. */
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && BLANK_LINE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

/** Normalise a link label for lookup (collapse space, fold case). */
function normLabel(s) {
  return s.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Expand tabs to spaces, tracking the column we start at. */
function expandTabs(s, col = 0) {
  let t = col, out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

/**
 * Parenthesis balance of s: -1 balanced, -2 an unclosed "(", else the index
 * of the first unmatched ")". Backslash escapes skip the next character.
 */
function parenBalance(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

/** Split a table row on unescaped pipes, honouring a target cell count. */
function splitRow(s, count) {
  const t = s.replace(FIND_PIPE, (m, off, str) => {
    let escaped = false, p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1).trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// ------------------------------------------------------- regex composition
// Small helper in the spirit of a regex builder: replace a placeholder in a
// pattern source with another pattern's source, dropping a ^ the inserted
// pattern carried (it no longer anchors the start once embedded).

const CARET_STRIP = /(^|[^\[])\^/g;
function sub(src, from, to) {
  const ins = typeof to === 'string' ? to : to.source;
  return src.replace(from, ins.replace(CARET_STRIP, '$1'));
}
function re(src, flags) {
  return new RegExp(src, flags);
}

// ------------------------------------------------------------ block regexes

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT_SRC = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_PARA_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const BULL_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HTML_PARA_SRC = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

const NEWLINE_RE = /^(?:[ \t]*(?:\n|$))+/;
const CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR_RE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_TEXT_RE = /^[^\n]+/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const LIST_REPLACE_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

const LIST_RE = re(sub('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)', /bull/g, BULL_SRC));

// Link reference definition: [label]: <href or bare> "optional title"
const LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
const DEF_RE = re(sub(sub('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)', 'label', LABEL_SRC), 'title', TITLE_SRC));

// Setext heading: the same in every set, with a table row allowed as the
// "text" line in GFM mode (a table delimiter row is not a setext underline).
let LHEADING_SRC = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
LHEADING_SRC = sub(LHEADING_SRC, /bull/g, BULL_SRC);
LHEADING_SRC = sub(LHEADING_SRC, /blockCode/g, '(?: {4}| {0,3}\\t)');
LHEADING_SRC = sub(LHEADING_SRC, /fences/g, ' {0,3}(?:`{3,}|~{3,})');
LHEADING_SRC = sub(LHEADING_SRC, /blockquote/g, BLOCKQUOTE_SRC);
LHEADING_SRC = sub(LHEADING_SRC, /heading/g, HEADING_SRC);
LHEADING_SRC = sub(LHEADING_SRC, /hr/g, ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)');
LHEADING_SRC = sub(LHEADING_SRC, /html/g, ' {0,3}<[^\\n>]+>\\n');
LHEADING_SRC = sub(LHEADING_SRC, /table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n');
const LHEADING_RE = re(LHEADING_SRC);

// Paragraph: a run of lines, stopping before any block start. Built twice:
// once for top level (a table may interrupt, a list only from marker 1 or a
// bullet) and once for blockquote interiors (no table, any list marker).
const PARA_SRC = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
function buildPara(listSrc, tableSrc) {
  let s = PARA_SRC;
  s = sub(s, 'hr', HR_SRC);
  s = sub(s, 'heading', HEADING_SRC);
  s = sub(s, '|lheading', '');
  s = sub(s, tableSrc === null ? '|table' : 'table', tableSrc === null ? '' : tableSrc);
  s = sub(s, 'blockquote', BLOCKQUOTE_SRC);
  s = sub(s, 'fences', FENCES_PARA_SRC);
  s = sub(s, 'list', listSrc);
  s = sub(s, 'html', HTML_PARA_SRC);
  s = sub(s, 'tag', BLOCK_TAGS);
  return re(s);
}

// GFM table: header line, delimiter row, then body rows that stop before any
// block start. Built first because the top-level paragraph embeds it.
let TABLE_SRC = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
TABLE_SRC = sub(TABLE_SRC, 'hr', HR_SRC);
TABLE_SRC = sub(TABLE_SRC, 'heading', HEADING_SRC);
TABLE_SRC = sub(TABLE_SRC, 'blockquote', BLOCKQUOTE_SRC);
TABLE_SRC = sub(TABLE_SRC, 'code', '(?: {4}| {0,3}\\t)[^\\n]');
TABLE_SRC = sub(TABLE_SRC, 'fences', FENCES_PARA_SRC);
TABLE_SRC = sub(TABLE_SRC, 'list', ' {0,3}(?:[*+-]|1[.)])[ \\t]');
TABLE_SRC = sub(TABLE_SRC, 'html', HTML_PARA_SRC);
TABLE_SRC = sub(TABLE_SRC, 'tag', BLOCK_TAGS);
const TABLE_RE = re(TABLE_SRC);

const PARA_RE = buildPara(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', TABLE_RE.source);
const PARA_QUOTE_RE = buildPara(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', null);

// Blockquote: > lines plus lazy paragraph continuation lines.
const BLOCKQUOTE_RE = re(sub('^((?: {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+)', 'paragraph', PARA_QUOTE_RE.source));

// Block HTML, types 1-7: script/pre/style/textarea to its close tag, comment,
// processing instruction, declaration, CDATA, a block-level tag to a blank
// line, any other tag (not a raw-text tag) to a blank line, or a close tag.
let HTML_SRC = '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))';
HTML_SRC = sub(HTML_SRC, 'comment', COMMENT_SRC);
HTML_SRC = sub(HTML_SRC, 'tag', BLOCK_TAGS);
HTML_SRC = sub(HTML_SRC, 'attribute', ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?');
const HTML_RE = re(HTML_SRC, 'i');

// Indent-sensitive helpers used inside lists (cached by clamped indent).
function byIndent(mk) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = mk(n));
  };
}
const nextBulletRe = byIndent((n) => re(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrIndentRe = byIndent((n) => re(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = byIndent((n) => re(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = byIndent((n) => re(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = byIndent((n) => re(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRe = byIndent((n) => re(`^ {0,${n}}>`));
function listItemRe(marker) {
  return re(`^( {0,3}${marker})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
}

// ----------------------------------------------------------- inline regexes

const ESCAPE_INLINE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const TAG_COMMENT_SRC = '<!--(?:-?>|[\\s\\S]*?-->)';
const TAG_ATTR_SRC = '\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?';
const TAG_RE = re(sub(sub('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', 'comment', TAG_COMMENT_SRC), 'attribute', TAG_ATTR_SRC));
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const EMAIL_IT = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_RE = re('^(?:mailto:' + EMAIL_IT + '|xmpp:' + EMAIL_IT + '(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])');
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const PUNCT_TEST_RE = /^((?![*_])[\s\p{P}\p{S}])/u;

// Link label pieces. A label may hold balanced brackets, escaped chars and
// code spans, but no bare newline; a reference label may span one line.
const BRACKETS_SRC = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LABEL_INLINE_SRC = '(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LABEL_DEF_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const HREF_SRC = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const TITLE_INLINE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const LINK_RE = re(sub(sub(sub('^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)', 'label', LABEL_INLINE_SRC), 'href', HREF_SRC), 'title', TITLE_INLINE_SRC).replace(/brackets/g, BRACKETS_SRC));
const REFLINK_RE = re(sub(sub('^!?\\[(label)\\]\\[(ref)\\]', 'label', LABEL_INLINE_SRC), 'ref', LABEL_DEF_SRC).replace(/brackets/g, BRACKETS_SRC));
const NOLINK_RE = re(sub('^!?\\[(ref)\\](?:\\[\\])?', 'ref', LABEL_DEF_SRC));

// The search form of a reference link, used only to mask link labels when
// hunting for emphasis closers. Its label pattern is bounded (0..999) so the
// mask stays linear.
const LABEL_SEARCH_SRC = '(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const REF_SEARCH_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const REFLINK_SEARCH_PART = sub(sub('^!?\\[(label)\\]\\[(ref)\\]', 'label', LABEL_SEARCH_SRC), 'ref', REF_SEARCH_SRC).replace(/brackets/g, BRACKETS_SRC);
const NOLINK_SEARCH_PART = sub('^!?\\[(ref)\\](?:\\[\\])?', 'ref', REF_SEARCH_SRC);
const REFLINK_SEARCH_RE = re(sub(sub('reflink|nolink(?!\\()', 'reflink', REFLINK_SEARCH_PART), 'nolink', NOLINK_SEARCH_PART), 'g');

// blockSkip: an inline link, a code span, or a tag — replaced wholesale by
// "[aaa…]" in the mask. NOTE the named-group backreferences \k<a> and \k<b>
// below carry a single backslash: in a regex literal that IS a backreference.
const BLOCK_SKIP_RE = re('(?:\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>)', 'g');
const PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

// Emphasis delimiters. The right-delimiter patterns list, in order, the
// runs that cannot close (groups 3-4), the runs that can close only under
// the rule of three (groups 5-6), and the plain closable runs (groups 1-2).
const LDELIM_RE = re('^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?', 'u');
const RDELIM_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const RDELIM_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const DEL_RDELIM_SRC = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
function delimRe(src, tildeAware) {
  let s = src;
  if (tildeAware) {
    s = sub(s, /notPunctSpace/g, '(?:[^\\s\\p{P}\\p{S}]|~)');
    s = sub(s, /punctSpace/g, '(?!~)[\\s\\p{P}\\p{S}]');
    s = sub(s, /punct/g, '(?!~)[\\p{P}\\p{S}]');
  } else {
    s = sub(s, /notPunctSpace/g, '[^\\s\\p{P}\\p{S}]');
    s = sub(s, /punctSpace/g, '[\\s\\p{P}\\p{S}]');
    s = sub(s, /punct/g, '[\\p{P}\\p{S}]');
  }
  return re(s, 'gu');
}
const RDELIM_AST_RE = delimRe(RDELIM_AST_SRC, true);
const RDELIM_UND_RE = delimRe(RDELIM_UND_SRC, false);
const DEL_RDELIM_RE = delimRe(DEL_RDELIM_SRC, false);
const DEL_LDELIM_RE = re('^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])', 'u');
const DEL_RE = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// GFM inline text: one chunk up to the next token start (a delimiter, a
// backtick, a link open, a tag open, an autolink scheme, www., an email, or
// a hard break). The first alternative keeps a character that starts a
// mailto:/xmpp: address inside the text.
const TEXT_RE = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/;

// ------------------------------------------------------- emphasis masking
// A masked copy of an inline source, the same length, in which code spans,
// links and tags are replaced by "[aaa…]" and backslash-escaped punctuation
// by "+" — so the search for the last possible emphasis closer only ever
// sees delimiters that could really close.

function linkInText(s, links) {
  if (!s.includes('[')) return false;
  BLOCK_SKIP_RE.lastIndex = 0;
  for (const m of s.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  REFLINK_SEARCH_RE.lastIndex = 0;
  for (const m of s.matchAll(REFLINK_SEARCH_RE)) {
    const t = m[0], r = t.lastIndexOf('[');
    if (!(t.charAt(0) === '!' || !Object.hasOwn(links, normLabel(t.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(t.slice(1, r - 1), links))) return true;
  }
  return false;
}

function maskEmStrong(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskReflink = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, maskReflink) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, maskReflink);
  }
  t = t.replace(PUNCT_OUTSIDE_CODE_RE, (n, s, r) => {
    if (r) return '+'.repeat(n.length);
    if (s) return s + n.slice(s.length, -s.length).replace(/`/g, '+') + s;
    return n;
  });
  t = t.replace(BLOCK_SKIP_RE, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

/** Last delimiter run preceded by a non-space char, per delimiter kind. */
function scanClosers(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return [em, del];
}

// ---------------------------------------------------------- block tokenizers

function checkboxHtml(cb) {
  return '<input ' + (cb.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// Cheap necessary-condition filters for two expensive block regexes. A
// setext underline is a line starting with 0-3 spaces then = or -; a table
// delimiter row is the second line and holds only | : - and spaces, with at
// least one -. If the filter fails the regex cannot match; if it passes the
// regex still decides.
function hasSetextUnderline(s) {
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) {
    let j = i + 1, sp = 0;
    while (sp < 3 && s[j] === ' ') { j++; sp++; }
    const c = s[j];
    if (c === '=' || c === '-') return true;
  }
  return false;
}

function tableDelimiterLine(s) {
  const nl = s.indexOf('\n');
  if (nl === -1) return false;
  let j = nl + 1, sp = 0;
  while (sp < 3 && s[j] === ' ') { j++; sp++; }
  let hasDash = false;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\n') break;
    if (c === '-') { hasDash = true; continue; }
    if (c === '|' || c === ':' || c === ' ') continue;
    return false;
  }
  return hasDash;
}

/** Whether s ends with a blank line (a \n, only spaces/tabs, another \n). */
function endsDoubleBlank(a) {
  let i = a.length;
  while (i > 0 && (a[i - 1] === ' ' || a[i - 1] === '\t')) i--;
  if (i === 0 || a[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (a[i - 1] === ' ' || a[i - 1] === '\t')) i--;
  return i > 0 && a[i - 1] === '\n';
}

function tokenizeSpace(src) {
  const t = NEWLINE_RE.exec(src);
  if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
  return null;
}

function tokenizeCode(src) {
  const t = CODE_RE.exec(src);
  if (!t) return null;
  const n = trimBlankTail(t[0]);
  return { type: 'code', raw: n, codeBlockStyle: 'indented', text: n.replace(CODE_REMOVE_INDENT, '') };
}

function tokenizeFences(src) {
  const t = FENCES_RE.exec(src);
  if (!t) return null;
  let text = t[3] || '';
  const m = INDENT_CODE_COMP.exec(t[0]);
  if (m) {
    const ind = m[1];
    text = text.split('\n').map((line) => {
      const o = BEGIN_SPACE.exec(line);
      if (!o) return line;
      return line.slice(Math.min(o[0].length, ind.length));
    }).join('\n');
  }
  return { type: 'code', raw: t[0], lang: t[2] ? t[2].trim().replace(ANY_PUNCT, '$1') : t[2], text };
}

function tokenizeHeading(src, ctx) {
  const t = HEADING_RE.exec(src);
  if (!t) return null;
  let n = t[2].trim();
  if (ENDING_HASH.test(n)) {
    const s = stripTail(n, '#');
    if (!s || ENDING_SPACE_TAB.test(s)) n = s.trim();
  }
  const tok = { type: 'heading', raw: stripTail(t[0], '\n'), depth: t[1].length, text: n };
  ctx.inlineSrcs.push(tok);
  return tok;
}

function tokenizeHr(src) {
  const t = HR_RE.exec(src);
  if (!t) return null;
  return { type: 'hr', raw: stripTail(t[0], '\n') };
}

function tokenizeHtml(src) {
  const t = HTML_RE.exec(src);
  if (!t) return null;
  const n = trimBlankTail(t[0]);
  return { type: 'html', raw: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: n };
}

function tokenizeDef(src) {
  const t = DEF_RE.exec(src);
  if (!t) return null;
  if (!START_ANGLE.test(t[2]) && parenBalance(t[2], '()') !== -1) return null;
  return {
    type: 'def',
    tag: normLabel(t[1]),
    raw: stripTail(t[0], '\n'),
    href: t[2] ? t[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '',
    title: t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT, '$1') : t[3],
  };
}

function tokenizeTable(src, ctx) {
  if (!tableDelimiterLine(src)) return null;
  const t = TABLE_RE.exec(src);
  if (!t || !TABLE_DELIM.test(t[2])) return null;
  const head = splitRow(t[1]);
  const delim = t[2].replace(TABLE_ALIGN_CHARS, '').split('|');
  const body = t[3] && t[3].trim() ? t[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
  const out = { type: 'table', raw: stripTail(t[0], '\n'), header: [], align: [], rows: [] };
  if (head.length !== delim.length) return null;
  for (const cell of delim) {
    if (TABLE_ALIGN_RIGHT.test(cell)) out.align.push('right');
    else if (TABLE_ALIGN_CENTER.test(cell)) out.align.push('center');
    else if (TABLE_ALIGN_LEFT.test(cell)) out.align.push('left');
    else out.align.push(null);
  }
  for (let i = 0; i < head.length; i++) {
    const c = { text: head[i], header: true, align: out.align[i] };
    ctx.inlineSrcs.push(c);
    out.header.push(c);
  }
  for (const line of body) {
    out.rows.push(splitRow(line, out.header.length).map((cell, p) => {
      const c = { text: cell, header: false, align: out.align[p] };
      ctx.inlineSrcs.push(c);
      return c;
    }));
  }
  return out;
}

function tokenizeLheading(src, ctx) {
  if (!hasSetextUnderline(src)) return null;
  const t = LHEADING_RE.exec(src);
  if (!t) return null;
  const tok = { type: 'heading', raw: stripTail(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: t[1].trim() };
  ctx.inlineSrcs.push(tok);
  return tok;
}

function tokenizeParagraph(src, ctx) {
  const t = PARA_RE.exec(src);
  if (!t) return null;
  const n = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
  const tok = { type: 'paragraph', raw: t[0], text: n };
  ctx.inlineSrcs.push(tok);
  return tok;
}

function tokenizeText(src, ctx) {
  const t = BLOCK_TEXT_RE.exec(src);
  if (!t) return null;
  const tok = { type: 'text', raw: t[0], text: t[0] };
  ctx.inlineSrcs.push(tok);
  return tok;
}

function tokenizeBlockquote(src, ctx) {
  const t = BLOCKQUOTE_RE.exec(src);
  if (!t) return null;
  let n = stripTail(t[0], '\n').split('\n');
  let s = '', r = '';
  const o = [];
  for (; n.length > 0;) {
    let hasMarker = false;
    const l = [];
    let p;
    for (p = 0; p < n.length; p++) {
      if (BLOCKQUOTE_START.test(n[p])) { l.push(n[p]); hasMarker = true; }
      else if (!hasMarker) l.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const h = l.join('\n');
    const u = h
      .replace(BLOCKQUOTE_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
      .replace(BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(BLOCKQUOTE_SETEXT2, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    const d = ctx.state.top;
    ctx.state.top = true;
    blockTokens(u, o, ctx, true);
    ctx.state.top = d;
    if (n.length === 0) break;
    const k = o.at(-1);
    if (k && (k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table')) break;
    if (k && k.type === 'blockquote') {
      const g = k;
      const b = n.join('\n');
      const mm = g.raw + '\n' + b.replace(BLOCKQUOTE_SETEXT2, '');
      const f = tokenizeBlockquote(mm, ctx);
      o[o.length - 1] = f;
      const y = mm.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - g.text.length) + f.text;
      n = n.slice(A.length);
      if (n.length > 0 && BLOCKQUOTE_START.test(n[0])) continue;
      break;
    } else if (k && k.type === 'list') {
      const g = k;
      const b = g.raw + '\n' + n.join('\n');
      const mm = tokenizeList(b, ctx);
      o[o.length - 1] = mm;
      const f = mm.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      n = n.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw: s, tokens: o, text: r };
}

function tokenizeList(src, ctx) {
  let t = LIST_RE.exec(src);
  if (!t) return null;
  const orig = src;
  let rest = src;
  const used = () => orig.length - rest.length;
  let r = t[1].trim();
  const ordered = r.length > 1;
  const item = { type: 'list', raw: '', ordered, start: ordered ? +r.slice(0, -1) : '', loose: false, items: [] };
  r = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRe = listItemRe(r);
  let p = false;
  for (; rest;) {
    let u = false, d = '';
    if (!(t = itemRe.exec(rest)) || HR_RE.test(rest)) break;
    const k = used();
    rest = rest.substring(t[0].length);
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let mstr = g.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, b));
    let f = rest.split('\n', 1)[0];
    let y = !mstr.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = mstr.search(NON_SPACE);
      R = R > 4 ? 1 : R;
      d = mstr.slice(R);
      R += b;
    }
    if (y && BLANK_LINE.test(f)) {
      rest = rest.substring(f.length + 1);
      u = true;
    }
    if (!u) {
      const v = nextBulletRe(R), Q = hrIndentRe(R), ee = fencesBeginRe(R);
      const te = headingBeginRe(R), M = htmlBeginRe(R), ne = blockquoteBeginRe(R);
      for (; rest;) {
        const U = rest.split('\n', 1)[0];
        let Z;
        f = U;
        Z = f.replace(LEADING_SPACE_TAB, (me) => expandTabs(me));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(NON_SPACE) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || mstr.replace(TAB_GLOBAL, '    ').search(NON_SPACE) >= 4 || ee.test(mstr) || te.test(mstr) || M.test(mstr) || Q.test(mstr)) break;
          const qe = SETEXT_LINE.test(f) && LHEADING_RE.test(mstr + '\n' + f) ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        rest = rest.substring(U.length + 1);
        mstr = Z.slice(R);
      }
    }
    const A = orig.slice(k, used());
    if (!item.loose) {
      if (p) item.loose = true;
      else if (endsDoubleBlank(A)) p = true;
    }
    item.items.push({ type: 'list_item', raw: A, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const h = item.items.at(-1);
  if (h) {
    h.raw = h.raw.trimEnd();
    h.text = h.text.trimEnd();
  } else return null;
  item.raw = orig.slice(0, used()).trimEnd();
  for (const u of item.items) {
    ctx.state.top = false;
    u.tokens = blockTokens(u.text, [], ctx, false);
    if (!item.loose) {
      const spaces = u.tokens.filter((g) => g.type === 'space');
      if (spaces.length > 0 && spaces.some((g) => ANY_LINE.test(g.raw))) item.loose = true;
    }
  }
  for (const u of item.items) {
    const d0 = u.tokens[0];
    if (u.task && (d0 && (d0.type === 'text' || d0.type === 'paragraph'))) {
      u.text = u.text.replace(LIST_REPLACE_TASK, '');
      d0.raw = d0.raw.replace(LIST_REPLACE_TASK, '');
      d0.text = d0.text.replace(LIST_REPLACE_TASK, '');
      // The last inline source created so far that starts with a task
      // marker loses it too (it may live in a later paragraph of this item).
      for (let gi = ctx.inlineSrcs.length - 1; gi >= 0; gi--) {
        const tok = ctx.inlineSrcs[gi];
        if (tok !== d0 && LIST_IS_TASK.test(tok.text)) {
          tok.text = tok.text.replace(LIST_REPLACE_TASK, '');
          break;
        }
      }
      const k = LIST_TASK_CHECKBOX.exec(u.raw);
      if (k) {
        const cb = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        u.checked = cb.checked;
        if (item.loose) {
          if (d0 && (d0.type === 'paragraph' || d0.type === 'text')) {
            d0.pre = (d0.pre || '') + checkboxHtml(cb);
          } else {
            u.tokens.unshift({ type: 'paragraph', raw: cb.raw, text: '', pre: checkboxHtml(cb) });
          }
        } else {
          u.tokens.unshift(cb);
        }
      }
    } else if (u.task) u.task = false;
  }
  if (item.loose) {
    for (const u of item.items) {
      u.loose = true;
      for (const d0 of u.tokens) if (d0.type === 'text') d0.type = 'paragraph';
    }
  }
  return item;
}

// ------------------------------------------------------------ block scanner
// Walks the source once, in marked's tokenizer order, collecting link
// reference definitions into ctx.links as it goes. Inline rendering happens
// later, from the tokens, so a definition anywhere applies everywhere.

function blockTokens(src, tokens, ctx, mergeFirst) {
  let rest = src;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    let tok;
    if ((tok = tokenizeSpace(rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeCode(rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeFences(rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokenizeHeading(rest, ctx))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokenizeHr(rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokenizeBlockquote(rest, ctx))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokenizeList(rest, ctx))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokenizeHtml(rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokenizeDef(rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
      } else {
        if (!ctx.links[tok.tag]) ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tokenizeTable(rest, ctx))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokenizeLheading(rest, ctx))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if (ctx.state.top && (tok = tokenizeParagraph(rest, ctx))) {
      const prev = tokens.at(-1);
      if (mergeFirst && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else tokens.push(tok);
      mergeFirst = false;
      rest = rest.substring(tok.raw.length);
      continue;
    }
    if ((tok = tokenizeText(rest, ctx))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  ctx.state.top = true;
  return tokens;
}

// ------------------------------------------------------------ inline scanner
// Renders inline Markdown straight to HTML (mode 'html') or to plain text
// (mode 'text', the image-alt rendering). The tokenization decisions are
// identical in both modes; only what is emitted differs. `st` is the shared
// lexer state for this parse: inLink, inRawBlock, linkEmitted and
// linkParenPossible survive across the block tokens of one document, exactly
// as marked's lexer state does; inRawBlock is reset before each top-level
// inline run by the block renderer.

function hasUnclosedTag(src, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = CODE_SPAN_RE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const o = TAG_RE.exec(src.slice(off + s)) || AUTOLINK_RE.exec(src.slice(off + s));
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

function buildLink(m, raw, href, title, isImage, links, st, mode) {
  const label = m[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const prevInLink = st.inLink, prevEmitted = st.linkEmitted, prevRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  // The label is parsed once, in the mode its rendering needs: plain text
  // for an image's alt, HTML for a link's text (or plain text throughout
  // when this whole run is already a plain-text rendering).
  const innerMode = mode === 'text' || isImage ? 'text' : 'html';
  const inner = inlineRun(label, links, st, innerMode);
  const hadLink = st.linkEmitted;
  st.linkEmitted = prevEmitted;
  st.inLink = prevInLink;
  if (!isImage) {
    if (hadLink) { st.inRawBlock = prevRaw; return null; }
    st.linkEmitted = true;
  }
  if (mode === 'text') return { html: inner, len: raw.length };
  if (isImage) {
    const enc = encodeHref(href);
    if (enc === null) return { html: esc(inner), len: raw.length };
    let out = `<img src="${esc(enc)}" alt="${esc(inner)}"`;
    if (title) out += ` title="${esc(title)}"`;
    return { html: out + '>', len: raw.length };
  }
  const enc = encodeHref(href);
  if (enc === null) return { html: inner, len: raw.length };
  let out = '<a href="' + esc(enc) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return { html: out + '>' + inner + '</a>', len: raw.length };
}

function tryInlineLink(rest, links, st, mode) {
  const m = LINK_RE.exec(rest);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  const labelOff = isImage ? 2 : 1;
  if (hasUnclosedTag(rest, m[1], labelOff)) return null;
  const hrefPart = m[2].trim();
  let m0 = m[0], m2 = m[2], m3 = m[3];
  if (START_ANGLE.test(hrefPart)) {
    if (!END_ANGLE.test(hrefPart)) return null;
    const l = stripTail(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - l.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m2, '()');
    if (bal === -2) return null;
    if (bal > -1) {
      const h = (isImage ? 5 : 4) + m[1].length + bal;
      m2 = m2.substring(0, bal);
      m0 = m0.substring(0, h).trim();
      m3 = '';
    }
  }
  const r = stripTail(m0.slice(0, -1), '\\');
  if ((m0.length - r.length) % 2 === 0) return null;
  let href = m2;
  let title = m3 ? m3.slice(1, -1) : '';
  href = href.trim();
  if (START_ANGLE.test(href)) href = href.slice(1, -1);
  href = href.replace(ANY_PUNCT, '$1');
  title = title.replace(ANY_PUNCT, '$1');
  return buildLink(m, m0, href, title, isImage, links, st, mode);
}

function tryReflink(rest, links, st, mode) {
  const m = REFLINK_RE.exec(rest) || NOLINK_RE.exec(rest);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  const labelOff = isImage ? 2 : 1;
  if (hasUnclosedTag(rest, m[1], labelOff)) return null;
  const ref = links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { html: mode === 'text' ? ch : esc(ch), len: 1 };
  }
  return buildLink(m, m[0], ref.href, ref.title, isImage, links, st, mode);
}

// Emphasis / strong emphasis. `pos` is the offset of `rest` inside the
// full (masked) source of this inline run; `prev` is the last character of
// the text token just before this run, or "" after any other token.
function tryEmStrong(rest, masked, pos, prev, lastEm, links, st, mode) {
  const s = LDELIM_RE.exec(rest);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0];
  const sameAsPrev = prev === delim;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!PUNCT_TEST_RE.exec(p);
  if (l < i) prev = p;
  const u = l < i ? h : !!PUNCT_TEST_RE.exec(prev);
  if (s[4] && UNICODE_ALNUM.test(prev)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !prev || u) {
    const k = [...s[0]].length - 1;
    let m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const A = delim === '*' ? RDELIM_AST_RE : RDELIM_UND_RE;
    const v = lastEm[delim];
    const Q = i + k;
    if (v < Q) return null;
    const t2 = masked.slice(i + k);
    const ee = v - Q;
    let s2;
    A.lastIndex = 0;
    while ((s2 = A.exec(t2)) !== null && !(s2.index > ee)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      let b = [...g].length;
      if (s2[3] || s2[4]) { m += b; continue; }
      else if (s2[5] || s2[6] || R) {
        if (sameAsPrev && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if (m -= b, m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s2[0]][0].length;
      const M = rest.slice(0, k + s2.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { html: mode === 'text' ? inlineRun(U, links, st, 'text') : '<em>' + inlineRun(U, links, st, 'html') + '</em>', len: M.length };
      }
      const ne = M.slice(2, -2);
      return { html: mode === 'text' ? inlineRun(ne, links, st, 'text') : '<strong>' + inlineRun(ne, links, st, 'html') + '</strong>', len: M.length };
    }
  }
  return null;
}

function tryDel(rest, masked, pos, prev, lastDel, links, st, mode) {
  const s = DEL_LDELIM_RE.exec(rest);
  if (!s) return null;
  if (!(s[1] || '') || !prev || PUNCT_TEST_RE.exec(prev)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const u = lastDel;
    const d = pos + o;
    if (u < d) return null;
    const t2 = masked.slice(pos + o);
    const kk = u - d;
    let s2;
    DEL_RDELIM_RE.lastIndex = 0;
    while ((s2 = DEL_RDELIM_RE.exec(t2)) !== null && !(s2.index > kk)) {
      const g2 = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g2) continue;
      let l = [...g2].length;
      if (l !== o) continue;
      if (s2[3] || s2[4]) { p += l; continue; }
      if (p -= l, p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...s2[0]][0].length;
      const b = rest.slice(0, o + s2.index + g + l);
      const mm = b.slice(o, -o);
      return { html: mode === 'text' ? inlineRun(mm, links, st, 'text') : '<del>' + inlineRun(mm, links, st, 'html') + '</del>', len: b.length };
    }
  }
  return null;
}

function renderAutolink(text, href, mode) {
  if (mode === 'text') return text;
  const enc = encodeHref(href);
  if (enc === null) return esc(text, true);
  return '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>';
}

function inlineRun(src, links, st, mode) {
  const savedLPP = st.linkParenPossible;
  st.linkParenPossible = savedLPP && src.includes(')');
  let masked = src;
  let lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskEmStrong(src, links);
    [lastEm, lastDel] = scanClosers(masked);
  }
  let out = '';
  let rest = src;
  let pos = 0;
  let prev = '';
  let wasText = false;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!wasText) prev = '';
    wasText = false;
    let m, r;
    if ((m = ESCAPE_INLINE_RE.exec(rest))) {
      out += mode === 'text' ? m[1] : esc(m[1]);
      rest = rest.slice(m[0].length);
      pos += m[0].length;
      continue;
    }
    if ((m = TAG_RE.exec(rest))) {
      const tag = m[0];
      if (!st.inLink && START_A_TAG.test(tag)) st.inLink = true;
      else if (st.inLink && END_A_TAG.test(tag)) st.inLink = false;
      if (!st.inRawBlock && START_PRE_TAG.test(tag)) st.inRawBlock = true;
      else if (st.inRawBlock && END_PRE_TAG.test(tag)) st.inRawBlock = false;
      out += tag;
      rest = rest.slice(tag.length);
      pos += tag.length;
      continue;
    }
    if (st.linkParenPossible && (r = tryInlineLink(rest, links, st, mode))) {
      out += r.html;
      rest = rest.slice(r.len);
      pos += r.len;
      continue;
    }
    if ((r = tryReflink(rest, links, st, mode))) {
      out += r.html;
      rest = rest.slice(r.len);
      pos += r.len;
      continue;
    }
    if ((r = tryEmStrong(rest, masked, pos, prev, lastEm, links, st, mode))) {
      out += r.html;
      rest = rest.slice(r.len);
      pos += r.len;
      continue;
    }
    if ((m = CODE_SPAN_RE.exec(rest))) {
      let n = m[2].replace(NEWLINE_GLOBAL, ' ');
      if (NON_SPACE.test(n) && START_SPACE.test(n) && END_SPACE.test(n)) n = n.substring(1, n.length - 1);
      out += mode === 'text' ? n : '<code>' + esc(n, true) + '</code>';
      rest = rest.slice(m[0].length);
      pos += m[0].length;
      continue;
    }
    if ((m = BR_RE.exec(rest))) {
      if (mode !== 'text') out += '<br>';
      rest = rest.slice(m[0].length);
      pos += m[0].length;
      continue;
    }
    if ((r = tryDel(rest, masked, pos, prev, lastDel, links, st, mode))) {
      out += r.html;
      rest = rest.slice(r.len);
      pos += r.len;
      continue;
    }
    if ((m = AUTOLINK_RE.exec(rest))) {
      const text = m[1];
      const href = m[2] === '@' ? 'mailto:' + text : text;
      out += renderAutolink(text, href, mode);
      rest = rest.slice(m[0].length);
      pos += m[0].length;
      continue;
    }
    if (!st.inLink && (m = URL_RE.exec(rest))) {
      let text, href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let t0 = m[0], rr;
        do {
          rr = t0;
          t0 = BACKPEDAL_RE.exec(t0)?.[0] ?? '';
        } while (rr !== t0);
        text = t0;
        href = m[1] === 'www.' ? 'http://' + t0 : t0;
      }
      out += renderAutolink(text, href, mode);
      rest = rest.slice(text.length);
      pos += text.length;
      continue;
    }
    if ((m = TEXT_RE.exec(rest))) {
      const raw = m[0];
      out += st.inRawBlock ? raw : mode === 'text' ? decodeEntities(raw) : esc(decodeEntities(raw));
      if (raw.slice(-1) !== '_') prev = raw.slice(-1);
      wasText = true;
      rest = rest.slice(raw.length);
      pos += raw.length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  st.linkParenPossible = savedLPP;
  return out;
}

// ------------------------------------------------------------ block renderer

function renderInline(tok, links, st) {
  st.inRawBlock = false;
  return (tok.pre || '') + inlineRun(tok.text, links, st, 'html');
}

function renderCell(cell, links, st) {
  st.inRawBlock = false;
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + inlineRun(cell.text, links, st, 'html') + `</${tag}>\n`;
}

function renderBlocks(tokens, links, st) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok, links, st)}</h${tok.depth}>\n`;
        break;
      case 'code': {
        const lang = (tok.lang || '').match(NOT_SPACE_START)?.[0] || '';
        const text = tok.text ? tok.text.replace(END_NEWLINE, '') + '\n' : '';
        const body = esc(text, true);
        out += lang
          ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n`
          : `<pre><code>${body}</code></pre>\n`;
        break;
      }
      case 'table': {
        let headCells = '';
        for (const c of tok.header) headCells += renderCell(c, links, st);
        const headRow = `<tr>\n${headCells}</tr>\n`;
        let bodyRows = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const c of row) cells += renderCell(c, links, st);
          bodyRows += `<tr>\n${cells}</tr>\n`;
        }
        if (bodyRows) bodyRows = `<tbody>${bodyRows}</tbody>`;
        out += `<table>\n<thead>\n${headRow}</thead>\n${bodyRows}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens, links, st)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const it of tok.items) items += `<li>${renderBlocks(it.tokens, links, st)}</li>\n`;
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += checkboxHtml(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(tok, links, st)}</p>\n`;
        break;
      case 'text':
        out += renderInline(tok, links, st);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// ------------------------------------------------------------------- entry
// parse(markdown) returns exactly the HTML marked 18.1.3 renders for it
// with its default options. Nothing is kept from an earlier call: the link
// map, the lexer state and the inline-source list are all fresh per call.

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const ctx = { links: Object.create(null), state: { top: true }, inlineSrcs: [] };
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  const tokens = blockTokens(src, [], ctx, false);
  return renderBlocks(tokens, ctx.links, st);
}
