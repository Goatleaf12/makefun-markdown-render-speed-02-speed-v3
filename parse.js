// SPDX-License-Identifier: MIT
// Fast marked-exact Markdown renderer: parse(markdown) returns the same HTML
// as marked 18.1.3 with default options (GFM on, breaks off). Written from
// scratch from the CommonMark 0.31.2 + GFM 0.29 specs and marked's observed
// behaviour. Dependency-free ES module.

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));
const PRE_TAGS = new Set(['script', 'pre', 'style', 'textarea']);

// ---------- character helpers ----------
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function isPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isAsciiPunct(ch) { const c = ch.charCodeAt(0); return isPunctCode(c); }
function isWordCharCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
function isAlphaCode(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isDigitCode(c) { return c >= 48 && c <= 57; }
function isUnicodeSpace(ch) {
  if (!ch) return true;
  const c = ch.charCodeAt(0);
  if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0x85 || c === 0xa0) return true;
  if (c >= 0x1680 && c <= 0x200a && c !== 0x2007) return true;
  return c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
const PUNCT_RE = /^[\p{P}\p{S}]$/u;
function isUnicodePunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (isPunctCode(c)) return true;
  return PUNCT_RE.test(ch);
}

// ---------- escaping ----------
// marked escapes & < > " ' in text, code and attribute values. A bare & that
// starts an entity-like reference (&word; / &#123; / &#x1F;) is passed through
// verbatim; numeric references are decoded to the character (invalid -> U+FFFD)
// and that character is then escaped if needed.
const ENT_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);|[&<>"']/g;
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return s.replace(ENT_RE, (m, ent) => {
    if (ent === undefined) {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    }
    if (ent[0] === '#') {
      let cp;
      if (ent[1] === 'x' || ent[1] === 'X') cp = parseInt(ent.slice(2), 16);
      else cp = parseInt(ent.slice(1), 10);
      if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
      const ch = String.fromCodePoint(cp);
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      if (ch === "'") return '&#39;';
      return ch;
    }
    return m;
  });
}
// Full escape for code spans / code blocks: no entity passthrough, all five.
function escCode(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === '&') rep = '&amp;';
    else if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}
// href / title / autolink href: encodeURI first, then entity-aware escape.
// marked's cleanUrl: encodeURI then turn %25 back into % (a bare % in the
// source stays a literal %; %20 stays %20).
function escHref(s) {
  return escText(encodeURI(s).replace(/%25/g, '%'));
}
function escTitle(s) {
  return escText(s);
}
// Remove backslash escapes before ASCII punctuation.
function unescapeStr(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Label normalisation for reference lookup: collapse whitespace, trim, lowercase.
function normLabel(s) {
  // Unicode case folding: ß/ẞ fold to `ss` (toLowerCase alone gives ß)
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// ---------- tab / indent helpers ----------
// columns of leading whitespace (space=1, tab to next multiple of 4) and the
// index of the first non-whitespace char.
function leadingInfo(line) {
  let cols = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, idx: i };
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Remove `n` columns from the start of a line (space/other char = 1 col,
// tab expands to the next multiple of 4). A tab that would overshoot is
// replaced by spaces for the remainder.
function stripCols(line, n) {
  let cols = 0, i = 0;
  while (i < line.length && cols < n) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      const w = 4 - (cols % 4);
      if (cols + w <= n) { cols += w; i++; }
      else {
        // partial tab: keep the leftover as spaces
        return ' '.repeat(cols + w - n) + line.slice(i + 1);
      }
    } else {
      cols++;
      i++;
    }
  }
  return line.slice(i);
}
// Remove up to n columns of LEADING WHITESPACE only (fence dedent: a line
// with less leading whitespace keeps its content intact — never eat
// non-whitespace characters).
function stripIndentWs(line, n) {
  let cols = 0, i = 0;
  while (i < line.length && cols < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) {
      const w = 4 - (cols % 4);
      if (cols + w <= n) { cols += w; i++; }
      else return ' '.repeat(cols + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}
function trimLine(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

// ---------- inline parsing ----------
const SPEC_RE = /[\\`*_~\[\]!<&\n]/;
// Flanking info for a delimiter run at [start, end) in s.
function flankInfo(s, start, end) {
  const prev = start > 0 ? s[start - 1] : '';
  const next = end < s.length ? s[end] : '';
  const prevWs = prev === '' ? true : isUnicodeSpace(prev);
  const nextWs = next === '' ? true : isUnicodeSpace(next);
  const prevPunct = prev !== '' && isUnicodePunct(prev);
  const nextPunct = next !== '' && isUnicodePunct(next);
  const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct);
  const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { leftFlanking, rightFlanking };
}

// Parse an inline HTML tag / comment / PI / declaration / CDATA starting at i
// (s[i] === '<'). Returns {end, raw} or null.
function parseHtmlTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { end: i + 5, raw: s.slice(i, i + 5) };
    if (s.startsWith('<!--->', i)) return { end: i + 6, raw: s.slice(i, i + 6) };
    const j = s.indexOf('-->', i + 4);
    if (j < 0) return null;
    return { end: j + 3, raw: s.slice(i, j + 3) };
  }
  if (s.startsWith('<?', i)) {
    const j = s.indexOf('?>', i + 2);
    if (j < 0) return null;
    return { end: j + 2, raw: s.slice(i, j + 2) };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const j = s.indexOf(']]>', i + 9);
    if (j < 0) return null;
    return { end: j + 3, raw: s.slice(i, j + 3) };
  }
  if (s.startsWith('<!', i)) {
    // declaration: <! + uppercase letter ... >
    if (i + 2 < n) {
      const c = s.charCodeAt(i + 2);
      if (c >= 65 && c <= 90) {
        const j = s.indexOf('>', i + 3);
        if (j < 0) return null;
        return { end: j + 1, raw: s.slice(i, j + 1) };
      }
    }
    return null;
  }
  // open / close tag
  let j = i + 1;
  let closing = false;
  if (j < n && s[j] === '/') { closing = true; j++; }
  if (j >= n || !isAlphaCode(s.charCodeAt(j))) return null;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlphaCode(c) || isDigitCode(c) || c === 45) j++;
    else break;
  }
  // a closing tag cannot have attributes (`</a href="foo">` is not a tag)
  if (closing) {
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k >= n || s[k] !== '>') return null;
    return { end: k + 1, raw: s.slice(i, k + 1) };
  }
  // attributes
  while (true) {
    // skip whitespace (space, tab, newline)
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k < n && s[k] === '/') {
      if (k + 1 < n && s[k + 1] === '>') return { end: k + 2, raw: s.slice(i, k + 2) };
      return null;
    }
    if (k < n && s[k] === '>') return { end: k + 1, raw: s.slice(i, k + 1) };
    if (k === j) return null; // no progress: not a tag
    j = k;
    // attribute name
    if (j >= n) return null;
    let c = s.charCodeAt(j);
    if (!(isAlphaCode(c) || c === 95 || c === 58)) return null;
    j++;
    while (j < n) {
      c = s.charCodeAt(j);
      if (isAlphaCode(c) || isDigitCode(c) || c === 95 || c === 58 || c === 46 || c === 45) j++;
      else break;
    }
    // optional = value
    k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k < n && s[k] === '=') {
      k++;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
      if (k >= n) return null;
      if (s[k] === '"') {
        const e = s.indexOf('"', k + 1);
        if (e < 0) return null;
        j = e + 1;
      } else if (s[k] === "'") {
        const e = s.indexOf("'", k + 1);
        if (e < 0) return null;
        j = e + 1;
      } else {
        let e = k;
        while (e < n) {
          const cc = s.charCodeAt(e);
          if (cc === 32 || cc === 9 || cc === 10 || cc === 34 || cc === 39 || cc === 61 || cc === 60 || cc === 62 || cc === 96) break;
          e++;
        }
        if (e === k) return null;
        j = e;
      }
    }
    // no '=': a boolean attribute — leave j just past the name so the
    // next loop iteration skips the whitespace and makes progress
    // (`<a _boolean zoop:33=…>`; setting j past the whitespace here
    // would make the next iteration see no progress and reject the tag)
  }
}

// Autolink <...> starting at i. Returns {end, href, text} or null.
function parseAngleAutolink(s, i) {
  const j = s.indexOf('>', i + 1);
  if (j < 0) return null;
  const inner = s.slice(i + 1, j);
  if (inner.length === 0 || inner.indexOf(' ') >= 0 || inner.indexOf('\n') >= 0 || inner.indexOf('<') >= 0) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):([^\s<>]*)$/.exec(inner);
  if (m) return { end: j + 1, href: inner, text: inner, mailto: false };
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
    return { end: j + 1, href: 'mailto:' + inner, text: inner, mailto: true };
  }
  return null;
}

// Find the end of a code span's closing run of exactly `len` backticks starting
// search at `from`. Returns index of the run start or -1.
function findClosingBackticks(s, from, len) {
  let i = from;
  while (i < s.length) {
    if (s[i] === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      if (j - i === len) return i;
      i = j;
    } else i++;
  }
  return -1;
}

// Trim a bare GFM autolink URL per the GFM rules (entity ;, trailing punct,
// paren balance). Input is the raw run; returns the trimmed URL.
function trimAutolinkUrl(u) {
  while (u.length > 0) {
    // entity-like trailing ;  (e.g. ...foo&copy; -> cut before &)
    if (u.endsWith(';')) {
      const amp = u.lastIndexOf('&');
      if (amp >= 0 && /^&[A-Za-z0-9]+;$/.test(u.slice(amp))) { u = u.slice(0, amp); continue; }
    }
    const last = u[u.length - 1];
    if (last === '?' || last === '!' || last === '.' || last === ',' || last === ':' || last === ';' || last === '*' || last === '_' || last === '~' || last === "'" || last === '"') {
      u = u.slice(0, -1); continue;
    }
    if (last === ')') {
      let open = 0, close = 0;
      for (let k = 0; k < u.length; k++) { if (u[k] === '(') open++; else if (u[k] === ')') close++; }
      if (close > open) { u = u.slice(0, -1); continue; }
    }
    // unmatched '(' : cut at the last '(' that has no ')' after it
    let open = 0, close = 0;
    for (let k = 0; k < u.length; k++) { if (u[k] === '(') open++; else if (u[k] === ')') close++; }
    if (open > close) {
      // find the '(' whose match is missing: scan from the end
      let depth = 0;
      let cut = -1;
      for (let k = u.length - 1; k >= 0; k--) {
        if (u[k] === ')') depth++;
        else if (u[k] === '(') { if (depth === 0) { cut = k; break; } depth--; }
      }
      if (cut >= 0) { u = u.slice(0, cut); continue; }
    }
    break;
  }
  return u;
}
function validDomain(dom) {
  // marked's bare-url rule: after www. / scheme there must be at least one
  // domain char (alnum or hyphen); a dot is NOT required (http://foo,
  // www.foo are links). The domain prefix is (label .?)+ so a leading
  // alnum/hyphen char is enough; the rest is consumed by [^\s<]*.
  return dom.length > 0 && /^[A-Za-z0-9-]/.test(dom);
}
// case-insensitive http:// or https:// at s[j], without slicing/regex
function hasScheme(s, j) {
  const a = s[j + 1], b = s[j + 2], c = s[j + 3], d = s[j + 4];
  if ((a === 't' || a === 'T') && (b === 't' || b === 'T') && (c === 'p' || c === 'P')) {
    if (s[j + 4] === ':' && s[j + 5] === '/' && s[j + 6] === '/') return true;
    if ((d === 's' || d === 'S') && s[j + 5] === ':' && s[j + 6] === '/' && s[j + 7] === '/') return true;
  }
  return false;
}

// Try a bare GFM autolink (www. / scheme) at position i. Returns
// {end, href, text} or null. prevCh is the char before i ('' at start).
// Email autolinks are handled separately at the '@' (see inlineParse).
function tryBareAutolink(s, i, prevCh, inLink) {
  if (inLink) return null;
  if (s.startsWith('www.', i)) {
    if (!(prevCh === '' || prevCh === ' ' || prevCh === '\t' || prevCh === '\n' || prevCh === '(' || prevCh === '*' || prevCh === '_' || prevCh === '~')) return null;
    let end = i;
    while (end < s.length && !isSpace(s[end]) && s[end] !== '<') end++;
    const url = trimAutolinkUrl(s.slice(i, end));
    if (url.length <= 4) return null;
    const after = url.slice(4);
    const domEnd = after.search(/[\/?#]/);
    const dom = domEnd < 0 ? after : after.slice(0, domEnd);
    if (!validDomain(dom)) return null;
    return { end: i + url.length, href: 'http://' + url, text: url };
  }
  // scheme is case-insensitive (Https://, HTTP://, FTP:// all link) and the
  // original case is preserved in the href; www. stays case-sensitive
  let scheme = null;
  const sm = /^(https?:\/\/|ftp:\/\/)/i.exec(s.slice(i, i + 8));
  if (sm) scheme = sm[0];
  if (scheme) {
    let end = i;
    while (end < s.length && !isSpace(s[end]) && s[end] !== '<') end++;
    const url = trimAutolinkUrl(s.slice(i, end));
    const after = url.slice(scheme.length);
    const domEnd = after.search(/[\/?#]/);
    const dom = domEnd < 0 ? after : after.slice(0, domEnd);
    if (!validDomain(dom)) return null;
    return { end: i + url.length, href: url, text: url };
  }
  return null;
}

// Parse a link destination + optional title starting at j (just after '(').
// Returns {dest, title, end} (end = index just past ')') or null.
function parseInlineLinkTail(s, j) {
  const n = s.length;
  let p = j;
  while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  if (p >= n) return null;
  let dest = '';
  if (s[p] === '<') {
    // the closing '>' must not be escaped (a `\>` inside the dest does
    // not close it) and the dest must not contain a newline or an
    // unescaped '<'
    let e = -1;
    let q2 = p + 1;
    while (q2 < n) {
      if (s[q2] === '\\' && q2 + 1 < n) { q2 += 2; continue; }
      if (s[q2] === '>') { e = q2; break; }
      if (s[q2] === '\n') return null;
      q2++;
    }
    if (e < 0) return null;
    const inner = s.slice(p + 1, e);
    for (let t = 0; t < inner.length; t++) {
      if (inner[t] === '\\') { t++; continue; }
      if (inner[t] === '<') return null;
    }
    dest = unescapeStr(inner);
    p = e + 1;
  } else {
    // bare dest: no spaces, balanced parens
    let depth = 0;
    const start = p;
    while (p < n) {
      const c = s[p];
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '\\' && p + 1 < n) { p += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    dest = unescapeStr(s.slice(start, p));
  }
  // optional title
  let title = null;
  let q = p;
  while (q < n && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
  if (q < n && (s[q] === '"' || s[q] === "'" || s[q] === '(')) {
    const open = s[q];
    const close = open === '(' ? ')' : open;
    let r = q + 1;
    let ok = false;
    if (open === '(') {
      while (r < n) {
        if (s[r] === '\\' && r + 1 < n) { r += 2; continue; }
        if (s[r] === '(') break; // unescaped ( inside paren title -> invalid
        if (s[r] === ')') { ok = true; break; }
        r++;
      }
    } else {
      while (r < n) {
        if (s[r] === '\\' && r + 1 < n) { r += 2; continue; }
        if (s[r] === close) { ok = true; break; }
        r++;
      }
    }
    if (!ok) return null;
    title = unescapeStr(s.slice(q + 1, r));
    q = r + 1;
    while (q < n && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
  }
  if (q >= n || s[q] !== ')') return null;
  return { dest, title, end: q + 1 };
}

// Scan a bracket label starting at i (s[i] === '['). Returns {label, end}
// where end is just past the closing ']', or null.
function scanLabel(s, i) {
  const n = s.length;
  let depth = 1;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const len = k - j;
      const close = findClosingBackticks(s, k, len);
      if (close < 0) { j = k; continue; }
      // a code span in a label only hides a `]` when it closes on the
      // same line: an unclosed `` ``url` `` must not swallow the `]` by
      // closing at a `` `` `` on a later line (the label ends here)
      if (s.slice(k, close).indexOf('\n') >= 0) { j = k; continue; }
      let m = close;
      while (m < n && s[m] === '`') m++;
      j = m;
      continue;
    }
    if (c === '<') {
      // a '<' that could start an HTML tag or autolink must be closed
      // by a '>' before the label ends — an unclosed one makes the
      // whole link fail (`[foo <bar attr="](baz)">`, `[foo<https://…](uri)>`)
      const nc = s[j + 1];
      if (nc && (/[A-Za-z]/.test(nc) || nc === '/' || nc === '!' || nc === '?')) {
        let k = j + 1;
        let closed = false;
        while (k < n) {
          const d = s[k];
          if (d === '"') { k++; while (k < n && s[k] !== '"') k++; k++; continue; }
          if (d === "'") { k++; while (k < n && s[k] !== "'") k++; k++; continue; }
          if (d === '>') { closed = true; break; }
          if (d === ']') break;
          k++;
        }
        if (!closed) return null;
        j = k + 1;
        continue;
      }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

// ---------- inline parsing ----------
// Plain-text extraction of inline tokens (for img alt).
function plainText(toks) {
  let out = '';
  for (const t of toks) {
    if (t.k === 'text' || t.k === 'code') out += t.s;
    else if (t.k === 'link') {
      if (t.autolink) out += t.text;
      else out += plainText(t.inner);
    } else if (t.k === 'img') out += t.alt;
    else if (t.k === 'br') out += '\n';
    else if (t.k === 'delim') out += t.ch.repeat(t.len);
    else if (t.k === 'html') out += escText(t.s);
  }
  return out;
}

// Emphasis / strikethrough resolution over a token list (CommonMark
// delimiter-stack algorithm, with marked's ~ equal-length rule).
function processEmphasis(toks) {
  const delims = [];
  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx];
    if (t.k !== 'delim') continue;
    t.tokIdx = idx;
    t.delimIdx = delims.length;
    delims.push(t);
  }
  // stack of delimiter objects still available
  const stack = [];
  // suffix: strongAfter[ch][i] = a closer of char ch with len>=2 exists
  // at a delimiter index >= i (precomputed so the lone-`*` lookahead
  // below is O(1) instead of a scan)
  const strongAfter = { '*': new Array(delims.length + 1).fill(false), '_': new Array(delims.length + 1).fill(false), '~': new Array(delims.length + 1).fill(false) };
  for (let i = delims.length - 1; i >= 0; i--) {
    for (const ch of ['*', '_', '~']) strongAfter[ch][i] = strongAfter[ch][i + 1];
    const dd = delims[i];
    if (dd.canClose && dd.len >= 2) strongAfter[dd.ch][i] = true;
  }
  // barrier per delimiter char: openers at or before this delim index are
  // blocked for future closers of that char — but only openers SHORTER
  // than the inner opener that set the barrier. Set when a closer that
  // can also open is matched (e.g. `*a **b**c*`: the `**` closer can
  // open, so the outer `*` — shorter than the inner `**` — must not
  // match the final `*`; but `**line **same**private**` still matches
  // because the outer `**` is as long as the inner one).
  const barriers = new Map();
  for (const d of delims) {
    if (d.canClose) {
      // keep matching while the closer still has length (a *** closer can
      // close a strong and then an em with the same opener)
      while (d.len > 0) {
        let matched = false;
        const bar = barriers.get(d.ch);
        for (let s = stack.length - 1; s >= 0; s--) {
          const o = stack[s];
          if (bar !== undefined && o.delimIdx <= bar.idx && o.len < bar.len) break;
          if (o.ch !== d.ch) continue;
          if (!o.canOpen) continue;
          if (d.ch === '~' && o.len !== d.len) continue;
          if ((o.canClose || d.canOpen) && ((o.len + d.len) % 3 === 0) && !((o.len % 3 === 0) && (d.len % 3 === 0))) continue;
          // a single `*` closer must not eat one star of a `**` opener
          // when a later `**` closer would take the whole opener as
          // strong (`**public as *so*other* option html**`: the lone
          // `*` after `other` stays literal, the outer `**` pairs with
          // the final `**`). But a `***` opener has stars to spare
          // (`***foo* bar**`: the `*` takes one, the final `**` takes
          // the other two) — only skip when the opener would be left
          // with fewer than 2 stars for the later strong closer.
          if (d.len === 1 && o.len === 2) {
            if (strongAfter[d.ch][d.delimIdx + 1]) continue;
          }
          // match
          let use;
          if (d.ch === '~') use = d.len;
          else use = (o.len >= 2 && d.len >= 2) ? 2 : 1;
          const tag = d.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
          const oi = o.tokIdx, ci = d.tokIdx;
          const oLenBefore = o.len;
          // insert open tag after opener token, close tag before closer token
          toks.splice(oi + 1, 0, { k: 'tag', s: '<' + tag + '>' });
          // closer index shifted by the insertion
          toks.splice(ci + 1, 0, { k: 'tag', s: '</' + tag + '>' });
          // re-index delimiter token positions after splice: recompute tokIdx
          for (let k = 0; k < toks.length; k++) if (toks[k].k === 'delim') toks[k].tokIdx = k;
          o.len -= use;
          d.len -= use;
          // delimiters between the opener and closer are now inside the
          // emphasis and cannot span outside it — drop them from the stack
          stack.splice(s + 1);
          if (o.len === 0) stack.splice(s, 1);
          if (d.len === 0) {
            // remove d from stack if present (it may not be in stack yet)
            const di = stack.indexOf(d);
            if (di >= 0) stack.splice(di, 1);
          }
          // a closer that can also open, matched against a pure opener
          // (one that cannot close), blocks shorter outer openers for
          // later closers of the same char
          if (d.canOpen && !o.canClose) {
            const prev = barriers.get(d.ch);
            if (prev === undefined || o.delimIdx > prev.idx) barriers.set(d.ch, { idx: o.delimIdx, len: oLenBefore });
          }
          matched = true;
          break;
        }
        if (!matched) break;
      }
    }
    if (d.len > 0 && !stack.includes(d)) stack.push(d);
  }
  // render
  let out = '';
  for (const t of toks) {
    if (t.k === 'text' || t.k === 'html' || t.k === 'tag') out += t.s;
    else if (t.k === 'code') out += '<code>' + t.s + '</code>';
    else if (t.k === 'br') out += '<br>';
    else if (t.k === 'delim') out += t.ch.repeat(t.len);
    else if (t.k === 'link') {
      if (t.autolink) out += '<a href="' + t.href + '">' + t.text + '</a>';
      else {
        out += '<a href="' + t.href + '"' + (t.title !== null ? ' title="' + t.title + '"' : '') + '>';
        out += renderTokens(t.inner);
        out += '</a>';
      }
    } else if (t.k === 'img') {
      out += '<img src="' + t.src + '" alt="' + t.alt + '"' + (t.title !== null ? ' title="' + t.title + '"' : '') + '>';
    }
  }
  return out;
}
function renderTokens(toks) {
  // render a (nested) token list: emphasis already resolved in outer pass?
  // For link inner tokens, emphasis was resolved by their own inlineParse.
  let out = '';
  for (const t of toks) {
    if (t.k === 'text' || t.k === 'html' || t.k === 'tag') out += t.s;
    else if (t.k === 'code') out += '<code>' + t.s + '</code>';
    else if (t.k === 'br') out += '<br>';
    else if (t.k === 'delim') out += t.ch.repeat(t.len);
    else if (t.k === 'link') {
      if (t.autolink) out += '<a href="' + t.href + '">' + t.text + '</a>';
      else {
        out += '<a href="' + t.href + '"' + (t.title !== null ? ' title="' + t.title + '"' : '') + '>';
        out += renderTokens(t.inner);
        out += '</a>';
      }
    } else if (t.k === 'img') {
      out += '<img src="' + t.src + '" alt="' + t.alt + '"' + (t.title !== null ? ' title="' + t.title + '"' : '') + '>';
    }
  }
  return out;
}


// Try a bare email autolink at the '@' at position i. The local part must lie
// entirely inside the current text buffer `txt` (it never spans a token
// boundary). Returns {end, href, text, localLen} or null.
const EMAIL_LOCAL = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-".split(''));
function tryEmailAt(s, i, txt) {
  // local part: scan back through txt for email-local chars
  let k = txt.length - 1;
  // txt is already escaped html; local part chars that need escaping are
  // & < > " ' -- a local part containing those would have been escaped, so
  // only plain alnum / . ! # $ % & ' * + / = ? ^ _ ` { | } ~ - can appear.
  // '&' in txt appears as '&amp;' -- that cannot be part of a local part in
  // the raw source at this point, so stop at '&'.
  while (k >= 0 && EMAIL_LOCAL.has(txt[k])) k--;
  const localEsc = txt.slice(k + 1);
  if (localEsc.length === 0) return null;
  // the raw local part must not contain a backslash escape: `<foo\+@…>`
  // is not an email (the `\+` is an escape, so the raw local part is not
  // a plain email local part). Scan the raw source back from the '@'.
  let j = i - 1;
  while (j >= 0) {
    const ch = s[j];
    if (EMAIL_LOCAL.has(ch)) { j--; continue; }
    if (ch === '\\' && j + 1 < i && EMAIL_LOCAL.has(s[j + 1])) return null;
    break;
  }
  // the raw local part equals the escaped one unless it contains chars that
  // escText changed; those chars (' " < >) are not in EMAIL_LOCAL except
  // none of them are, so localEsc is the raw local part.
  const local = localEsc;
  // a scheme directly before the local part (`mailto:`, `xmpp:`) makes
  // the whole `scheme:email` one link (href = scheme + email, not
  // mailto: + email). The scheme is 2-32 chars, starts with a letter.
  let prefix = '';
  let localStart = k + 1;
  const pre = txt.slice(0, localStart);
  const sm = /(?:^|[^A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{1,31}):$/.exec(pre);
  if (sm) {
    prefix = sm[1] + ':';
    localStart -= prefix.length;
  }
  const rest = s.slice(i + 1);
  const m = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/.exec(rest);
  if (!m) return null;
  // the domain must not be immediately followed by '-' or '_': those
  // would be part of the domain and make it invalid (`a.b-c_d@a.b-`,
  // `a.b-c_d@a.b_` are not emails). EXCEPT when the `_` is an emphasis
  // closer (an unmatched `_` opener precedes the email in this line):
  // `_warning when@atlas.example.com_` IS an email. Otherwise marked
  // backtracks one domain segment (`when@atlas.example.com_` ->
  // `when@atlas.example`), and if no dotted domain remains, no email.
  const after = rest[m[0].length];
  if (after === '-') return null;
  let dom = m[0];
  if (after === '_') {
    // is there a `_` opener before the email in this line?
    let hasOpener = false;
    for (let q = i - 1; q >= 0 && i - q < 400; q--) {
      const ch = s[q];
      if (ch === '\n') break;
      if (ch === '_' && (q === 0 || s[q - 1] === ' ' || s[q - 1] === '\t' || s[q - 1] === '\n') && q + 1 < s.length && s[q + 1] !== ' ' && s[q + 1] !== '\t' && s[q + 1] !== '\n') { hasOpener = true; break; }
    }
    if (!hasOpener) {
      const dot = dom.lastIndexOf('.');
      if (dot <= 0) return null;
      dom = dom.slice(0, dot);
      if (dom.indexOf('.') < 0) return null;
    }
  }
  let email = local + '@' + dom;
  let end = i + 1 + dom.length;
  if (prefix) {
    // a scheme link may extend over one path segment after the email
    // (`xmpp:foo@bar.baz/txt` but not `/txt/bin`)
    if (rest[m[0].length] === '/') {
      let e = m[0].length + 1;
      while (e < rest.length) {
        const cc = rest[e];
        if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '<' || cc === '>' || cc === '/') break;
        e++;
      }
      if (e > m[0].length + 1) {
        email += rest.slice(m[0].length, e);
        end = i + 1 + e;
      }
    }
    const full = prefix + email;
    return { end, href: full, text: full, localLen: (txt.length - localStart) };
  }
  return { end, href: 'mailto:' + email, text: prefix + email, localLen: (txt.length - localStart) };
}

// Full inline parse of a string -> {html, hasLink}
function inlineParse(s, refs, st) {
  if (s === '') return { html: '', hasLink: false, toks: [] };
  // Integrated scan: like inlineTokens but with bare-autolink detection.
  // We re-implement the scan here so text runs can be split at autolink starts.
  const toks = [];
  const n = s.length;
  let i = 0;
  let txt = '';
  const flush = () => { if (txt) { toks.push({ k: 'text', s: txt }); txt = ''; } };
  let hasLink = false;
  while (i < n) {
    const c = s[i];
    // bare autolink attempt (www. / scheme); email is handled at '@'
    if (!st.inLink && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F')) {
      const prevCh = i > 0 ? s[i - 1] : '';
      const al = tryBareAutolink(s, i, prevCh, false);
      if (al) {
        flush();
        toks.push({ k: 'link', href: escHref(al.href), title: null, inner: null, autolink: true, text: escText(al.text) });
        i = al.end;
        continue;
      }
    }
    // '@' : possible bare email autolink; local part may start inside the
    // current text buffer (never across a token boundary)
    if (c === '@' && !st.inLink) {
      const em = tryEmailAt(s, i, txt);
      if (em) {
        txt = txt.slice(0, txt.length - em.localLen);
        flush();
        toks.push({ k: 'link', href: escHref(em.href), title: null, inner: null, autolink: true, text: escText(em.text) });
        i = em.end;
        continue;
      }
      txt += '@';
      i++;
      continue;
    }
    if (!(c === '\\' || c === '`' || c === '*' || c === '_' || c === '~' || c === '[' || c === '!' || c === '<' || c === '&' || c === '\n')) {
      let j = i + 1;
      while (j < n) {
        const cc = s[j];
        if (cc === '\\' || cc === '`' || cc === '*' || cc === '_' || cc === '~' || cc === '[' || cc === '!' || cc === '<' || cc === '&' || cc === '\n' || cc === '@') break;
        // stop text run at a possible autolink start so it can be detected
        if (!st.inLink && cc === 'w' && s.startsWith('www.', j)) break;
        if (!st.inLink && (cc === 'h' || cc === 'H') && hasScheme(s, j)) break;
        if (!st.inLink && (cc === 'f' || cc === 'F') && s.slice(j, j + 6).toLowerCase() === 'ftp://') break;
        j++;
      }
      txt += escText(s.slice(i, j));
      i = j;
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      for (let k = txt.length - 1; k >= 0 && txt[k] === ' '; k--) sp++;
      if (sp >= 2) {
        txt = txt.slice(0, txt.length - sp);
        flush();
        toks.push({ k: 'br' });
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        txt += '\n';
        i++;
      }
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && s[i + 1] === '\n') {
        flush();
        toks.push({ k: 'br' });
        i += 2;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(s[i + 1])) { txt += escText(s[i + 1]); i += 2; continue; }
      txt += '\\';
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const len = j - i;
      const close = findClosingBackticks(s, j, len);
      if (close < 0) { txt += '`'.repeat(len); i = j; continue; }
      let content = s.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') content = content.slice(1, -1);
      flush();
      toks.push({ k: 'code', s: escCode(content) });
      let m = close;
      while (m < n && s[m] === '`') m++;
      i = m;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && s[j] === c) j++;
      const len = j - i;
      if (c === '~' && len > 2) { txt += '~'.repeat(len); i = j; continue; }
      const fl = flankInfo(s, i, j);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = fl.leftFlanking && (!fl.rightFlanking || isUnicodePunct(i > 0 ? s[i - 1] : ''));
        canClose = fl.rightFlanking && (!fl.leftFlanking || isUnicodePunct(j < n ? s[j] : ''));
      } else {
        canOpen = fl.leftFlanking;
        canClose = fl.rightFlanking;
      }
      if (!canOpen && !canClose) { txt += c.repeat(len); i = j; continue; }
      flush();
      toks.push({ k: 'delim', ch: c, len, canOpen, canClose, afterWs: j >= n || s[j] === ' ' || s[j] === '\t' || s[j] === '\n' });
      i = j;
      continue;
    }
    if (c === '&') {
      const m = /^&(#\d+|#[xX][0-9a-fA-F]+|\w+);/.exec(s.slice(i));
      if (m) { txt += escText(m[0]); i += m[0].length; }
      else { txt += '&amp;'; i++; }
      continue;
    }
    if (c === '<') {
      const tag = parseHtmlTag(s, i);
      if (tag) {
        flush();
        toks.push({ k: 'html', s: tag.raw });
        if (/^<a /i.test(tag.raw)) st.inLink = true;
        else if (/^<\/a>/i.test(tag.raw)) st.inLink = false;
        i = tag.end;
        continue;
      }
      const al = parseAngleAutolink(s, i);
      if (al) {
        flush();
        toks.push({ k: 'link', href: escHref(al.href), title: null, inner: null, autolink: true, text: escText(al.text) });
        i = al.end;
        continue;
      }
      txt += '&lt;';
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && i + 1 < n && s[i + 1] === '[')) {
      const isImg = c === '!';
      const lb = isImg ? i + 1 : i;
      const lab = scanLabel(s, lb);
      if (!lab) { txt += c; i++; continue; }
      let href = null, title = null, end = -1;
      let p = lab.end;
      if (p < n && s[p] === '(') {
        const tail = parseInlineLinkTail(s, p + 1);
        if (tail) { href = tail.dest; title = tail.title; end = tail.end; }
      }
      let fullRefTried = false;
      if (href === null && p < n && s[p] === '[') {
        const ref = scanLabel(s, p);
        if (ref) {
          const key = normLabel(ref.label === '' ? lab.label : ref.label);
          const r = refs.get(key);
          if (r) { href = r.href; title = r.title; end = ref.end; }
          else if (ref.label !== '') fullRefTried = true;
        }
      }
      // a full reference `[foo][bar]` whose ref is undefined does not
      // fall back to the shortcut `[foo]` — the `[foo]` stays literal
      // and `[bar][baz]` after it can still link
      if (href === null && !fullRefTried) {
        const key = normLabel(lab.label);
        const r = refs.get(key);
        if (r) { href = r.href; title = r.title; end = lab.end; }
      }
      if (href === null) { txt += c; i++; continue; }
      const savedInLink = st.inLink;
      st.inLink = true;
      const inner = inlineParse(s.slice(lb + 1, lab.end - 1), refs, st);
      st.inLink = savedInLink;
      if (!isImg && inner.hasLink) { txt += c; i++; continue; }
      flush();
      if (isImg) {
        toks.push({ k: 'img', src: escHref(href), title: title === null ? null : escTitle(title), alt: plainText(inner.toks) });
      } else {
        hasLink = true;
        toks.push({ k: 'link', href: escHref(href), title: title === null ? null : escTitle(title), inner: inner.toks, autolink: false });
      }
      i = end;
      continue;
    }
    txt += c;
    i++;
  }
  flush();
  const html = processEmphasis(toks);
  return { html, hasLink, toks };
}

// Expand tabs in a string to spaces, starting at column `start` (marked's J).
function expandTabs(s, start) {
  let col = start, out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') { const r = 4 - (col % 4); out += ' '.repeat(r); col += r; }
    else { out += c; col++; }
  }
  return out;
}
// Expand the leading whitespace (spaces/tabs) of a line to spaces.
function expandLeadingWs(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i === 0) return line;
  return expandTabs(line.slice(0, i), 0) + line.slice(i);
}

// ---------- block parsing ----------
function splitLines(src) {
  return src.replace(/\r\n?/g, '\n').split('\n');
}

// Parse link reference definitions at the start of `text` (paragraph raw
// text, lines joined by \n). Adds to refs (first-wins). Returns the text
// with leading definitions removed.
function stripRefDefs(text, refs) {
  let s = text;
  for (;;) {
    // skip up to 3 leading spaces on the definition line
    let p = 0;
    while (p < s.length && s[p] === ' ' && p < 3) p++;
    if (p >= s.length || s[p] !== '[' || s[p + 1] === ']') return s;
    const lab = scanLabel(s, p);
    if (!lab) return s;
    let q = lab.end;
    if (q >= s.length || s[q] !== ':') return s;
    q++;
    // skip whitespace (incl. newlines) before dest
    while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
    if (q >= s.length) return s;
    let dest = null;
    if (s[q] === '<') {
      const e = s.indexOf('>', q + 1);
      if (e < 0) return s;
      const inner = s.slice(q + 1, e);
      if (inner.indexOf('\n') >= 0 || inner.indexOf('<') >= 0) return s;
      dest = unescapeStr(inner);
      q = e + 1;
    } else {
      let depth = 0;
      const start = q;
      while (q < s.length) {
        const c = s[q];
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (c === '\\' && q + 1 < s.length) { q += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) break;
          depth--;
        }
        q++;
      }
      if (q === start) return s;
      dest = unescapeStr(s.slice(start, q));
    }
    // optional title (may be on a following line, may span lines)
    let title = null;
    let endPos = q;
    let r = q;
    while (r < s.length && (s[r] === ' ' || s[r] === '\t' || s[r] === '\n')) r++;
    if (r < s.length && (s[r] === '"' || s[r] === "'" || s[r] === '(')) {
      // a title must be separated from the dest by whitespace
      if (r > q) {
        const open = s[r];
        const close = open === '(' ? ')' : open;
        let t = r + 1;
        let ok = false;
        while (t < s.length) {
          if (s[t] === '\\' && t + 1 < s.length) { t += 2; continue; }
          if (s[t] === close) { ok = true; break; }
          if (open === '(' && s[t] === '(') break;
          // a blank line inside the title ends it (invalid)
          if (s[t] === '\n') {
            let u = t + 1;
            while (u < s.length && (s[u] === ' ' || s[u] === '\t')) u++;
            if (u >= s.length || s[u] === '\n') break;
          }
          t++;
        }
        if (ok) {
          title = unescapeStr(s.slice(r + 1, t));
          endPos = t + 1;
        }
      }
    }
    // after dest/title the rest of the line must be blank (spaces/tabs only,
    // then newline or end). If a title was found but junk follows it, fall
    // back to the definition without a title.
    let e2 = endPos;
    while (e2 < s.length && (s[e2] === ' ' || s[e2] === '\t')) e2++;
    if (e2 < s.length && s[e2] !== '\n') {
      if (title !== null) {
        // retry without the title
        title = null;
        endPos = q;
        e2 = q;
        while (e2 < s.length && (s[e2] === ' ' || s[e2] === '\t')) e2++;
        if (e2 < s.length && s[e2] !== '\n') return s;
      } else return s;
    }
    const key = normLabel(lab.label);
    // a label containing an UNESCAPED '[' (nested bracket, `[ref[bar]]`,
    // `[[[foo]]]`) or normalising to empty (`[\n ]`) is not a valid
    // definition: the line stays as paragraph text. An escaped `\[`
    // (`[ref\[]`) is fine.
    let hasOpen = false;
    for (let t = 0; t < lab.label.length; t++) {
      if (lab.label[t] === '\\') { t++; continue; }
      if (lab.label[t] === '[') { hasOpen = true; break; }
    }
    if (key === '' || hasOpen) return s;
    if (!refs.has(key)) refs.set(key, { href: dest, title });
    // consume the definition (through the newline)
    s = e2 < s.length ? s.slice(e2 + 1) : '';
  }
}

// Split a table row into cells. Returns array of raw cell strings.
function splitTableRow(line) {
  let s = line;
  // strip leading/trailing pipe (with surrounding spaces)
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a++;
  if (s[a] === '|') a++;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  if (b > a && s[b - 1] === '|') b--;
  s = s.slice(a, b);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // `\|` is an escaped pipe: it does not split the row and the backslash
    // is consumed (even inside a code span, the cell shows a plain `|`)
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map(x => x.trim());
}

// Parse a table delimiter row. Returns array of alignments
// ('left'|'right'|'center'|null) or null if not a delimiter row.
function parseTableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  let hasPipeOrColon = line.indexOf('|') >= 0;
  const aligns = [];
  for (const c of cells) {
    const m = /^(:?)-+(:?)$/.exec(c);
    if (!m) return null;
    if (m[1] === ':' || m[2] === ':') hasPipeOrColon = true;
    aligns.push(m[1] === ':' && m[2] === ':' ? 'center' : m[2] === ':' ? 'right' : m[1] === ':' ? 'left' : null);
  }
  if (!hasPipeOrColon) return null;
  return aligns;
}

// Does a line (already dedented to `content`, indent `cols`) start an ATX heading?
function atxHeading(content) {
  if (content.charCodeAt(0) !== 35) return null;
  const m = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(content);
  if (!m) return null;
  let text = m[2] || '';
  text = text.replace(/(?:[ \t]+|^)#+[ \t]*$/, '').replace(/[ \t]+$/, '');
  return { level: m[1].length, text };
}

// Fence opener at a line: returns {ch, len, info, cols} or null.
function fenceOpener(line, cols, idx) {
  const content = line.slice(idx);
  const ch = content[0];
  if (ch !== '`' && ch !== '~') return null;
  let j = 0;
  while (j < content.length && content[j] === ch) j++;
  if (j < 3) return null;
  const infoRaw = content.slice(j);
  const infoWord = infoRaw.trim().split(/\s+/)[0] || '';
  const info = unescapeStr(infoWord);
  // a backtick fence's info must not contain a backtick anywhere (not just
  // in the first word): ``` aa ``` is a paragraph, not a fence
  if (ch === '`' && infoRaw.indexOf('`') >= 0) return null;
  return { ch, len: j, info, cols };
}

// Is this line a closing fence for the given opener?
function isClosingFence(line, opener) {
  const { cols, idx } = leadingInfo(line);
  if (cols > 3) return false;
  const content = line.slice(idx);
  if (content[0] !== opener.ch) return false;
  let j = 0;
  while (j < content.length && content[j] === opener.ch) j++;
  if (j < opener.len) return false;
  return content.slice(j).trim() === '';
}

// HR line? (***, ---, ___, - - -, etc.)
function isHr(line, cols, idx) {
  const content = line.slice(idx);
  const ch = content[0];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

// Setext underline? Returns 1 (===) or 2 (---) or 0.
function setextLevel(line, cols, idx) {
  const content = line.slice(idx);
  if (/^=+[ \t]*$/.test(content)) return 1;
  if (/^-+[ \t]*$/.test(content)) return 2;
  return 0;
}

// HTML block start at a line (content = line after leading ws, cols <= 3).
// Returns {type, end} where type 1..7, or null. `lines`, `i`, `end` bound the
// document; `realEnd` is the count of real lines (excl. split artifact).
function htmlBlockStart(lines, i, realEnd, content) {
  if (content[0] !== '<') return null;
  const lower = content.toLowerCase();
  // type 1: script/pre/style/textarea
  const m1 = /^<(script|pre|style|textarea)([\s>\/]|$)/.exec(lower);
  if (m1) return { type: 1, tag: m1[1] };
  if (content.startsWith('<!--')) return { type: 2 };
  if (content.startsWith('<?')) return { type: 3 };
  if (/^<![A-Z]/.test(content)) return { type: 4 };
  if (content.startsWith('<![CDATA[')) return { type: 5 };
  // type 6: block tag open/close — the tag may span lines, so the `>` need
  // not be on this line; the name must be a block tag followed by ws, `>`,
  // `/` or end of line
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>\/]|$)/.exec(content);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
  // type 7: any other tag alone on the line — validated with the same
  // tag grammar as inline tags, so `<a h*#ref="hi">` (bad attribute
  // name) is not a block
  const t7 = parseHtmlTag(content, 0);
  if (t7) {
    let rest = content.slice(t7.end);
    if (/^[ \t]*$/.test(rest)) return { type: 7 };
  }
  return null;
}

// Parse an HTML block starting at line i. Returns {text, next} where next is
// the index of the first line after the block.
function parseHtmlBlock(lines, i, end, realEnd, hb) {
  let j = i;
  if (hb.type === 1) {
    // type 1 ends ONLY at the line containing the closing tag (a blank line
    // inside <pre>/<script>/<style>/<textarea> does not end it)
    const closeRe = new RegExp('</' + hb.tag, 'i');
    for (j = i; j < end; j++) {
      if (closeRe.test(lines[j])) { j++; break; }
    }
  } else if (hb.type >= 2 && hb.type <= 5) {
    const term = hb.type === 2 ? '-->' : hb.type === 3 ? '?>' : hb.type === 4 ? '>' : ']]>';
    // ends at the line containing the terminator
    for (j = i; j < end; j++) {
      if (lines[j].indexOf(term) >= 0) { j++; break; }
    }
  } else {
    // types 6-7 end at the first blank line
    for (j = i + 1; j < end; j++) {
      if (isBlank(lines[j])) break;
    }
  }
  let text = lines.slice(i, j).join('\n');
  if (j < lines.length) text += '\n';
  // one trailing \n is deleted only when the next line is TRULY empty
  // (zero characters) — a whitespace-only line (spaces/tabs) is a blank
  // line for block separation but does NOT delete the \n
  if (j < realEnd && lines[j] === '') text = text.slice(0, -1);
  return { text, next: j };
}

// Parse a list marker at the start of `content` (line after leading ws).
// Returns {bullet, ordered, num, delim, markerLen} or null.
// markerLen is the width of the marker itself (without following spaces).
function parseListMarker(content) {
  const c = content[0];
  if (c === '-' || c === '+' || c === '*') {
    if (content.length === 1 || content[1] === ' ' || content[1] === '\t') {
      return { bullet: c, ordered: false, num: 0, delim: '', markerLen: 1 };
    }
    return null;
  }
  const m = /^(\d{1,9})([.)])(?:[ \t]|$)/.exec(content);
  if (m) {
    return { bullet: '', ordered: true, num: parseInt(m[1], 10), delim: m[2], markerLen: m[1].length + 1 };
  }
  return null;
}

// Content indent (in columns) for a list item whose marker line has `cols`
// leading columns and a marker of width `markerLen`, with `after` = the text
// after the marker (starting with spaces/tabs or empty).
function listContentIndent(cols, markerLen, after) {
  // count spaces/tabs after the marker (columns)
  let sp = 0, k = 0;
  while (k < after.length && (after[k] === ' ' || after[k] === '\t')) {
    if (after[k] === ' ') sp++;
    else sp += 4 - ((cols + markerLen + sp) % 4);
    k++;
  }
  if (k >= after.length) return cols + markerLen + 1; // empty item
  if (sp >= 5) return cols + markerLen + 1;
  return cols + markerLen + sp;
}

// Does this line (content after leading ws, indent cols) start a list that
// would interrupt a paragraph? bullet: first item non-empty; ordered: 1./1)
function listInterruptsPara(content, marker) {
  if (!marker) return false;
  const after = content.slice(marker.markerLen);
  const empty = after.trim() === '';
  if (marker.ordered) {
    return !empty && marker.num === 1;
  }
  return !empty;
}

// Is a content line (after leading ws) a paragraph-continuation line, i.e.
// it does NOT start a block that would close an open paragraph?
function isParaLine(content) {
  if (content.trim() === '') return false;
  // 4+ leading spaces = indented code, not a paragraph line
  const { cols } = leadingInfo(content);
  if (cols >= 4) return false;
  if (atxHeading(content)) return false;
  if (fenceOpener(content, 0, 0)) return false;
  const hb = htmlBlockStart(null, 0, 0, content);
  if (hb && hb.type !== 7) return false;
  if (content[0] === '>') return false;
  const marker = parseListMarker(content);
  if (marker && listInterruptsPara(content, marker)) return false;
  if (isHr(content, 0, 0)) return false;
  return true;
}

// Does a lazy continuation line after this blockquote content line get
// accepted? True when the line ends in a paragraph — possibly nested inside
// inner blockquotes (`> > > foo` + lazy `bar` continues the innermost
// paragraph) or inside a list item (`> 1. > Blockquote` + lazy `continued`
// continues the quote inside the item). A heading / fence / list / html
// line does not accept it.
function lazyAccepts(cl) {
  let s = cl;
  for (;;) {
    const { cols, idx } = leadingInfo(s);
    if (cols > 3) return false;
    const content = s.slice(idx);
    if (content[0] === '>') {
      let mEnd = idx + 1;
      while (mEnd < s.length && (s[mEnd] === ' ' || s[mEnd] === '\t')) mEnd++;
      const expanded = expandTabs(s.slice(idx + 1, mEnd), idx + 1);
      s = (expanded.length > 0 ? expanded.slice(1) : '') + s.slice(mEnd);
      continue;
    }
    const marker = parseListMarker(content);
    if (marker) {
      // list item: strip the marker and following whitespace, recurse
      // into the item's content
      const after = content.slice(marker.markerLen);
      let sp = 0;
      while (sp < after.length && (after[sp] === ' ' || after[sp] === '\t')) sp++;
      s = after.slice(sp);
      if (s.trim() === '') return false;
      continue;
    }
    return isParaLine(content);
  }
}
function paraInterruptLine(line, cols, idx) {
  if (cols > 3) return false;
  const content = line.slice(idx);
  if (atxHeading(content)) return true;
  if (fenceOpener(line, cols, idx)) return true;
  const hb = htmlBlockStart(null, 0, 0, content);
  if (hb && hb.type !== 7) return true;
  if (content[0] === '>') return true;
  const marker = parseListMarker(content);
  if (marker && listInterruptsPara(content, marker)) return true;
  if (isHr(line, cols, idx)) return true;
  return false;
}

function parseParagraph(lines, i, end, realEnd, refs, inList) {
  const paraLines = [];
  let j = i;
  let setext = 0;
  let tableNode = null;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) break;
    const { cols, idx } = leadingInfo(line);
    const content = line.slice(idx);
    if (paraLines.length > 0 && cols <= 3) {
      const sl = setextLevel(line, cols, idx);
      if (sl) { setext = sl; j++; break; }
      if (paraLines.length === 1) {
        const aligns = parseTableDelimiter(line);
        if (aligns) {
          const header = splitTableRow(paraLines[0]);
          if (header.length === aligns.length) {
            const rows = [];
            let k = j + 1;
            // a tab-only line is a row of empty cells, not a blank line
            // ending the table
            const isTabRow = (ln) => ln.indexOf('\t') >= 0 && ln.trim() === '';
            while (k < end && (!isBlank(lines[k]) || isTabRow(lines[k]))) {
              // a body row ends at a line that starts another block
              // (`> bar` after a table is a blockquote, not a row)
              const lline = lines[k];
              const { cols: lcols, idx: lidx } = leadingInfo(lline);
              const lcontent = lline.slice(lidx);
              if (lcols <= 3) {
                if (lcontent[0] === '>') break;
                if (atxHeading(lcontent)) break;
                if (fenceOpener(lline, lcols, lidx)) break;
                if (isHr(lline, lcols, lidx)) break;
                if (parseListMarker(lcontent)) break;
                const lhb = htmlBlockStart(lines, k, realEnd, lcontent);
                if (lhb && lhb.type !== 7) break;
              }
              rows.push(splitTableRow(lines[k])); k++;
            }
            const body = rows.map(r => {
              while (r.length < header.length) r.push('');
              return r.slice(0, header.length);
            });
            tableNode = { t: 'table', header, aligns, rows: body };
            j = k;
            break;
          }
        }
      }
      if (atxHeading(content)) break;
      if (fenceOpener(line, cols, idx)) break;
      const hb = htmlBlockStart(lines, j, realEnd, content);
      if (hb && hb.type !== 7) break;
      if (content[0] === '>') break;
      const marker = parseListMarker(content);
      // inside a list item ANY list marker starts a nested list (a
      // sibling block of this paragraph), even `49.` — the "only 1."
      // rule is for a list interrupting a paragraph at the same level
      if (marker && (inList || listInterruptsPara(content, marker))) break;
      if (isHr(line, cols, idx)) break;
    }
    paraLines.push(line);
    j++;
  }
  if (tableNode) return { nodes: [tableNode], next: j };
  const text = paraLines.join('\n');
  const stripped = stripRefDefs(text, refs);
  if (stripped === '') {
    // a paragraph of only link reference definitions produces no output —
    // but a setext underline after it is NOT a heading: give the underline
    // back so it joins the following paragraph (`[foo]: /url\n===\n[foo]`
    // is a paragraph `===\n[foo]`, not a heading)
    if (setext) return { nodes: [], next: j - 1 };
    return { nodes: [], next: j };
  }
  // a setext heading's text is trimmed (leading/trailing whitespace of the
  // paragraph is dropped)
  if (setext) return { nodes: [{ t: 'heading', level: setext, text: stripped.trim() }], next: j };
  return { nodes: [{ t: 'para', text: stripped }], next: j };
}

function parseBlockquote(lines, i, end, realEnd, refs) {
  const content = [];
  let j = i;
  let inPara = false;
  let prevLazy = false;
  // a line without '>' inside a fenced code block ends the blockquote —
  // lazy continuation does not apply inside a fence
  let fence = null;
  while (j < end) {
    const line = lines[j];
    const { cols, idx } = leadingInfo(line);
    if (cols <= 3 && line.slice(idx)[0] === '>') {
      // marked: expand the whitespace after '>' (starting at the column
      // after the '>' part), then strip '>' + one space.
      const b = line.slice(0, idx + 1);
      let mEnd = idx + 1;
      while (mEnd < line.length && (line[mEnd] === ' ' || line[mEnd] === '\t')) mEnd++;
      const expanded = expandTabs(line.slice(idx + 1, mEnd), b.length);
      const cl = (expanded.length > 0 ? expanded.slice(1) : '') + line.slice(mEnd);
      // a `>` line that dedents to whitespace-only (e.g. `>  ` -> ` `) is a
      // paragraph continuation carrying a trailing space, not a blank line:
      // glue it onto the previous content line (`> foo\n>  ` is `foo\n `)
      if (cl.length > 0 && cl.trim() === '' && content.length > 0 && inPara) {
        content[content.length - 1] += '\n' + cl;
        prevLazy = false;
        j++;
        continue;
      }
      content.push(cl);
      // track fenced code blocks in the collected content
      if (!fence) {
        const f = fenceOpener(cl, 0, 0);
        if (f) fence = f;
      } else if (isClosingFence(cl, fence)) {
        fence = null;
      }
      inPara = lazyAccepts(cl);
      prevLazy = false;
      j++;
    } else if (isBlank(line)) {
      break;
    } else {
      // inside a fence, a line without '>' ends the blockquote
      if (fence) break;
      if (inPara && !paraInterruptLine(line, cols, idx)) {
        // lazy continuation: strip up to 4 columns of leading whitespace
        // (a lazy `    - bar` is paragraph text `- bar`, not a list)
        let cl = stripIndentWs(line, 4);
        // a lazy setext underline after another lazy line is NOT a
        // heading: indent it 4 columns so it stays paragraph text
        if (prevLazy && setextLevel(cl, 0, 0) === 1) cl = '    ' + cl;
        // if the dedented lazy line would start a block of its own (list,
        // heading, fence, hr, html, quote), it must stay paragraph text:
        // glue it onto the previous content line instead of adding it as
        // a separate line that parseBlocks would re-interpret as a block
        const { cols: ccols, idx: cidx } = leadingInfo(cl);
        if (paraInterruptLine(cl, ccols, cidx) && content.length > 0) {
          content[content.length - 1] += '\n' + cl;
        } else {
          content.push(cl);
        }
        prevLazy = true;
        j++;
      } else {
        break;
      }
    }
  }
  const children = parseBlocks(content, 0, content.length, content.length, refs);
  return { node: { t: 'blockquote', children }, next: j };
}

function parseList(lines, i, end, realEnd, refs) {
  const firstLine = lines[i];
  const { cols: firstCols, idx: firstIdx } = leadingInfo(firstLine);
  const firstContent = firstLine.slice(firstIdx);
  const firstMarker = parseListMarker(firstContent);
  const isOrdered = firstMarker.ordered;
  const bullet = firstMarker.bullet;
  const delim = firstMarker.delim;
  const startNum = firstMarker.num;
  const items = [];
  let loose = false;
  let j = i;
  while (j < end) {
    const itemLine = lines[j];
    const { cols: icols, idx: iidx } = leadingInfo(itemLine);
    const icontent = itemLine.slice(iidx);
    if (isHr(itemLine, icols, iidx)) break;
    const imarker = parseListMarker(icontent);
    // items may sit at a different indent than the first one
    // (`  - a` then `- b` is one list) — only an indent past
    // firstCols+3 ends it
    if (!imarker || imarker.ordered !== isOrdered ||
        (isOrdered ? imarker.delim !== delim : imarker.bullet !== bullet) ||
        icols > firstCols + 3) break;
    // marked: expand the leading whitespace after the marker (starting at
    // the column after the marker), then the content indent is the spaces
    // before the content (capped at 1 if > 4).
    const iafter = icontent.slice(imarker.markerLen);
    let leadEnd = 0;
    while (leadEnd < iafter.length && (iafter[leadEnd] === ' ' || iafter[leadEnd] === '\t')) leadEnd++;
    const gExpanded = expandTabs(iafter.slice(0, leadEnd), icols + imarker.markerLen) + iafter.slice(leadEnd);
    let cIndent, firstContent;
    if (gExpanded.trim() === '') {
      cIndent = icols + imarker.markerLen + 1;
      firstContent = '';
    } else {
      let R = gExpanded.search(/[^ ]/);
      if (R > 4) R = 1;
      firstContent = gExpanded.slice(R);
      cIndent = icols + imarker.markerLen + R;
    }
    const itemLines = [firstContent];
    let k = j + 1;
    let inPara = lazyAccepts(firstContent);
    while (k < end) {
      const l = lines[k];
      if (isBlank(l)) {
        let m = k + 1;
        while (m < end && isBlank(lines[m])) m++;
        if (m >= end) {
          while (k < m) { itemLines.push(''); k++; }
          break;
        }
        const nl = expandLeadingWs(lines[m]);
        const { cols: ncols, idx: nidx } = leadingInfo(nl);
        const ncontent = nl.slice(nidx);
        const nmarker = parseListMarker(ncontent);
        const isNewItem = !!nmarker && nmarker.ordered === isOrdered &&
          (isOrdered ? nmarker.delim === delim : nmarker.bullet === bullet) &&
          ncols >= firstCols && ncols <= firstCols + 3;
        const continuesItem = ncols >= cIndent;
        // an empty item cannot pick up content after a blank line
        // (`-\n\n  foo` is an empty <li> plus a top-level paragraph)
        if (itemLines.length === 1 && itemLines[0] === '' && !isNewItem) break;
        if (isHr(nl, ncols, nidx) && !continuesItem && !isNewItem) break;
        if (isNewItem) loose = true;
        if (isNewItem || continuesItem) {
          while (k < m) { itemLines.push(''); k++; }
          inPara = false;
          continue;
        }
        break;
      }
      const expanded = expandLeadingWs(l);
      const { cols: lcols, idx: lidx } = leadingInfo(expanded);
      const lcontent = expanded.slice(lidx);
      // a line indented to (or past) the item's content indent belongs to
      // this item — including a nested list item and a `---` that is a
      // setext underline inside the item — so it must be consumed BEFORE
      // the HR / sibling-marker checks below
      if (lcols >= cIndent) {
        const cl = expanded.slice(cIndent);
        itemLines.push(cl);
        inPara = lazyAccepts(cl);
        k++;
        continue;
      }
      if (isHr(expanded, lcols, lidx)) break;
      const lmarker = parseListMarker(lcontent);
      if (lmarker && lmarker.ordered === isOrdered &&
          (isOrdered ? lmarker.delim === delim : lmarker.bullet === bullet) &&
          lcols >= firstCols && lcols <= firstCols + 3) break;
      // any other list marker at a valid list indent starts a different
      // list (`3)` after `1.`/`2.`), so the current list ends — it is not
      // a lazy line. (A marker indented past 3 columns is not a list item
      // at all, so it falls through to the lazy branch below.)
      if (lmarker && lcols < cIndent && lcols >= firstCols && lcols <= firstCols + 3) break;
      if (inPara && !paraInterruptLine(expanded, lcols, lidx)) {
        // lazy continuation inside an item is dedented by the item's
        // content indent (`    with two lines.` under a 6-column item
        // is `with two lines.`)
        const cl = stripIndentWs(expanded, cIndent);
        // if the dedented lazy line would start a block of its own (a
        // list marker like `- e`), it must stay paragraph text: glue it
        // onto the previous item line
        const { cols: ccols, idx: cidx } = leadingInfo(cl);
        if (paraInterruptLine(cl, ccols, cidx) && itemLines.length > 0) {
          itemLines[itemLines.length - 1] += '\n' + cl;
        } else {
          itemLines.push(cl);
        }
        k++;
        continue;
      }
      break;
    }
    // looseness is decided by the parsed children: a blank line between
    // two top-level blocks of this item (reported by parseBlocks) makes
    // the list loose. Blanks inside a nested block never reach that
    // check, so only the inner list is loose there.
    const out = {};
    const children = parseBlocks(itemLines, 0, itemLines.length, itemLines.length, refs, out, true);
    if (out.blankBetween) loose = true;
    items.push(children);
    j = k;
  }
  return { node: { t: 'list', ordered: isOrdered, start: startNum, loose, items }, next: j };
}

// Checkbox prefix at the start of a list-item paragraph's text.
// Returns {html, checked} or null. Requires content after the marker.
function checkboxPrefix(text) {
  const m = /^\[([ xX])\] /.exec(text);
  if (!m || text.length <= 4) return null;
  return m[1] === ' '
    ? { html: '<input disabled="" type="checkbox">' }
    : { html: '<input checked="" disabled="" type="checkbox">' };
}

function renderBlock(node, refs, st) {
  switch (node.t) {
    case 'para': return '<p>' + inlineParse(node.text, refs, st).html + '</p>\n';
    case 'heading': return '<h' + node.level + '>' + inlineParse(node.text, refs, st).html + '</h' + node.level + '>\n';
    case 'hr': return '<hr>\n';
    case 'code': {
      const lang = node.lang ? ' class="language-' + escText(node.lang) + '"' : '';
      return '<pre><code' + lang + '>' + escCode(node.text) + '</code></pre>\n';
    }
    case 'html': return node.text;
    case 'blockquote': return '<blockquote>\n' + renderBlocks(node.children, refs, st) + '</blockquote>\n';
    case 'list': {
      let out = node.ordered ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n' : '<ul>\n';
      for (const item of node.items) out += renderListItem(item, node.loose, refs, st);
      out += node.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        const a = node.aligns[c];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(node.header[c], refs, st).html + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const a = node.aligns[c];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(row[c], refs, st).html + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
  }
  return '';
}

function renderListItem(children, loose, refs, st) {
  let out = '<li>';
  let first = true;
  for (const child of children) {
    if (child.t === 'para' && !loose) {
      // in a tight list every paragraph in the item is inline text, not
      // just the first one (`- Bar\n  ---\n  baz` is <h2>Bar</h2> + baz)
      if (first) {
        first = false;
        const cb = checkboxPrefix(child.text);
        if (cb) {
          out += cb.html + inlineParse(child.text.slice(3), refs, st).html;
          continue;
        }
      }
      out += inlineParse(child.text, refs, st).html;
      first = false;
      continue;
    }
    if (first && child.t === 'para') {
      first = false;
      const cb = checkboxPrefix(child.text);
      if (cb) {
        const inner = cb.html + inlineParse(child.text.slice(3), refs, st).html;
        out += '<p>' + inner + '</p>\n';
        continue;
      }
    }
    first = false;
    out += renderBlock(child, refs, st);
  }
  out += '</li>\n';
  return out;
}

function renderBlocks(blocks, refs, st) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, st);
  return out;
}

function parseBlocks(lines, start, end, realEnd, refs, out, inList) {
  const blocks = [];
  let i = start;
  // a blank line between two top-level blocks here (set on `out` when
  // given) — this is what makes a list item loose; blanks inside a
  // nested block (fence, inner list) are consumed by that block's own
  // parser and never reach this loop
  let pendingBlank = false;
  while (i < end) {
    if (isBlank(lines[i])) {
      if (blocks.length > 0) pendingBlank = true;
      i++;
      continue;
    }
    if (pendingBlank && out) out.blankBetween = true;
    pendingBlank = false;
    const line = lines[i];
    const { cols, idx } = leadingInfo(line);
    const content = line.slice(idx);
    if (cols <= 3) {
      const h = atxHeading(content);
      if (h) { blocks.push({ t: 'heading', level: h.level, text: h.text }); i++; continue; }
      const f = fenceOpener(line, cols, idx);
      if (f) {
        const codeLines = [];
        let k = i + 1;
        let closed = false;
        while (k < end) {
          if (isClosingFence(lines[k], f)) { closed = true; k++; break; }
          codeLines.push(stripIndentWs(lines[k], f.cols));
          k++;
        }
        if (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') codeLines.pop();
        const text = codeLines.length > 0 ? codeLines.join('\n') + '\n' : '';
        blocks.push({ t: 'code', lang: f.info || null, text });
        i = k;
        continue;
      }
      const hb = htmlBlockStart(lines, i, realEnd, content);
      if (hb) {
        const r = parseHtmlBlock(lines, i, end, realEnd, hb);
        blocks.push({ t: 'html', text: r.text });
        i = r.next;
        continue;
      }
      if (content[0] === '>') {
        const r = parseBlockquote(lines, i, end, realEnd, refs);
        blocks.push(r.node);
        i = r.next;
        continue;
      }
      if (isHr(line, cols, idx)) { blocks.push({ t: 'hr' }); i++; continue; }
      const marker = parseListMarker(content);
      if (marker) {
        const r = parseList(lines, i, end, realEnd, refs);
        blocks.push(r.node);
        i = r.next;
        continue;
      }
    }
    if (cols >= 4) {
      const codeLines = [];
      let k = i;
      while (k < end) {
        const l = lines[k];
        if (isBlank(l)) {
          let m = k + 1;
          while (m < end && isBlank(lines[m])) m++;
          if (m < end && leadingInfo(lines[m]).cols >= 4) {
            // blank lines inside indented code keep their whitespace
            // minus the 4-column indent (a 6-space blank line stays 2)
            while (k < m) { codeLines.push(stripCols(lines[k], 4)); k++; }
            continue;
          }
          break;
        }
        if (leadingInfo(l).cols < 4) break;
        codeLines.push(stripCols(l, 4));
        k++;
      }
      while (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') codeLines.pop();
      const text = codeLines.length > 0 ? codeLines.join('\n') + '\n' : '';
      blocks.push({ t: 'code', lang: null, text });
      i = k;
      continue;
    }
    const r = parseParagraph(lines, i, end, realEnd, refs, inList);
    for (const b of r.nodes) blocks.push(b);
    i = r.next;
  }
  return blocks;
}

export function parse(src) {
  const lines = splitLines(src);
  const realEnd = src.endsWith('\n') ? lines.length - 1 : lines.length;
  const refs = new Map();
  const st = { inLink: false };
  const blocks = parseBlocks(lines, 0, realEnd, realEnd, refs);
  return renderBlocks(blocks, refs, st);
}
