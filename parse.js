// Fast marked 18.1.3 drop-in (default options: gfm on, breaks off,
// pedantic off, async off). Single-pass block scan over lines, single-pass
// inline scan with a delimiter stack, HTML written straight into an array
// and joined once. No regexes in the hot paths.

// ---------------------------------------------------------------------------
// Entities. marked's rule, checked against marked 18.1.3:
//  - named &name; (letter then letters/digits, then ';') passes through
//    LITERALLY -- marked never decodes named entities.
//  - numeric &#123; (1-7 decimal digits) or &#x1F; / &#X1F; (1-6 hex)
//    is decoded; 0, > 0x10FFFF and surrogates become U+FFFD.
//  - anything else starting with '&' is not an entity: '&' gets escaped.
// ---------------------------------------------------------------------------

// Decode one entity starting at s[i] === '&'. Returns [decoded, nextIndex,
// isNamed] or null when not a valid entity reference. Named references pass
// through literally; numeric ones are decoded (isNamed false) and the caller
// must escape the decoded char. Valid named chars are [A-Za-z0-9_].
function decodeEntity(s, i, n) {
  const c1 = i + 1 < n ? s.charCodeAt(i + 1) : 0;
  if (c1 === 35) { // '#': numeric
    let j = i + 2, hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    let v = 0, d = 0;
    const maxD = hex ? 6 : 7;
    while (j < n && d < maxD) {
      const c = s.charCodeAt(j);
      if (c >= 48 && c <= 57) { v = v * (hex ? 16 : 10) + (c - 48); d++; j++; }
      else if (hex && c >= 97 && c <= 102) { v = v * 16 + (c - 87); d++; j++; }
      else if (hex && c >= 65 && c <= 70) { v = v * 16 + (c - 55); d++; j++; }
      else break;
    }
    if (d > 0 && j < n && s.charCodeAt(j) === 59) { // ';'
      if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return ['\uFFFD', j + 1, false];
      return [String.fromCodePoint(v), j + 1, false];
    }
    return null;
  }
  // named: &name; -- passes through literally (no lookup, no decoding)
  let j = i + 1;
  if (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      j++;
      while (j < n) {
        const c2 = s.charCodeAt(j);
        if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122) || (c2 >= 48 && c2 <= 57) || c2 === 95) { j++; continue; }
        break;
      }
      if (j < n && s.charCodeAt(j) === 59) return [s.slice(i, j + 1), j + 1, true];
    }
  }
  return null;
}
// Is the char at s[i] the start of a valid entity reference (named or
// numeric)? Used by noEncode escaping: a '&' followed by a valid reference
// is left alone, any other '&' is escaped.
function isEntityStart(s, i, n) {
  if (i + 1 >= n) return false;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) {
    let j = i + 2, hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    let d = 0;
    const maxD = hex ? 6 : 7;
    while (j < n && d < maxD) {
      const c = s.charCodeAt(j);
      if (c >= 48 && c <= 57) { d++; j++; }
      else if (hex && ((c >= 97 && c <= 102) || (c >= 65 && c <= 70))) { d++; j++; }
      else break;
    }
    return d > 0 && j < n && s.charCodeAt(j) === 59;
  }
  if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
    let j = i + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) { j++; continue; }
      break;
    }
    return j > i + 1 && j < n && s.charCodeAt(j) === 59;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Character classes (ASCII fast paths; non-ASCII is never punctuation here).
// ---------------------------------------------------------------------------
function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13; }
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlphaNum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// Unicode whitespace (CommonMark): space, tab, LF, FF, CR + Unicode spaces.
function isUnicodeSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r' ||
    ch === '\u00A0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200A') ||
    ch === '\u202F' || ch === '\u205F' || ch === '\u3000';
}
// Unicode punctuation: ASCII punct + Unicode P* and S* categories (approx:
// everything that is not a letter, digit, space or combining mark). We use a
// conservative check: a char is punctuation when it is ASCII punct, or a
// non-ASCII char that is not a letter/digit. This matches marked's behaviour
// on the practice set (its PUNCT set is the ASCII one plus Unicode P/S).
function isUnicodePunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isPunct(c);
  // Letters (incl. accents, CJK, Greek, Cyrillic, Hebrew, Arabic...) are not
  // punctuation; digits are not; everything else counts as punctuation.
  return !/[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/.test(ch);
}

// Escape text for HTML: & < > " '  (marked escapes quotes in text too).
// Fast path: most text runs contain none of these, so a single native
// regex scan skips the per-character loop entirely.
const NEED_ESCAPE = /[&<>"']/;
function escapeText(s, out) {
  if (!NEED_ESCAPE.test(s)) { out.push(s); return; }
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { if (start < i) out.push(s.slice(start, i)); out.push('&amp;'); start = i + 1; }
    else if (c === 60) { if (start < i) out.push(s.slice(start, i)); out.push('&lt;'); start = i + 1; }
    else if (c === 62) { if (start < i) out.push(s.slice(start, i)); out.push('&gt;'); start = i + 1; }
    else if (c === 34) { if (start < i) out.push(s.slice(start, i)); out.push('&quot;'); start = i + 1; }
    else if (c === 39) { if (start < i) out.push(s.slice(start, i)); out.push('&#39;'); start = i + 1; }
  }
  if (start < s.length) out.push(s.slice(start));
}
// Escape with encode=true (marked's escape(..., true)): escapes ALL of
// & < > " '. Used for code spans/blocks and for autolink href/text.
function escapeEncode(s, out) {
  if (!NEED_ESCAPE.test(s)) { out.push(s); return; }
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { if (start < i) out.push(s.slice(start, i)); out.push('&amp;'); start = i + 1; }
    else if (c === 60) { if (start < i) out.push(s.slice(start, i)); out.push('&lt;'); start = i + 1; }
    else if (c === 62) { if (start < i) out.push(s.slice(start, i)); out.push('&gt;'); start = i + 1; }
    else if (c === 34) { if (start < i) out.push(s.slice(start, i)); out.push('&quot;'); start = i + 1; }
    else if (c === 39) { if (start < i) out.push(s.slice(start, i)); out.push('&#39;'); start = i + 1; }
  }
  if (start < s.length) out.push(s.slice(start));
}
// Escape a single char with encode=true (for numeric-entity decodes).
function escapeEncodeChar(ch, out) {
  if (ch === '&') out.push('&amp;');
  else if (ch === '<') out.push('&lt;');
  else if (ch === '>') out.push('&gt;');
  else if (ch === '"') out.push('&quot;');
  else if (ch === "'") out.push('&#39;');
  else out.push(ch);
}
// Escape an attribute value with noEncode (marked's escape(..., false)):
// escapes < > " ' and a '&' ONLY when it does not start a valid entity
// reference. Used for regular-link href/title and image src/alt/title.
function escapeAttr(s, out) {
  if (!NEED_ESCAPE.test(s)) { out.push(s); return; }
  const n = s.length;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (isEntityStart(s, i, n)) continue;
      if (start < i) out.push(s.slice(start, i)); out.push('&amp;'); start = i + 1;
    }
    else if (c === 60) { if (start < i) out.push(s.slice(start, i)); out.push('&lt;'); start = i + 1; }
    else if (c === 62) { if (start < i) out.push(s.slice(start, i)); out.push('&gt;'); start = i + 1; }
    else if (c === 34) { if (start < i) out.push(s.slice(start, i)); out.push('&quot;'); start = i + 1; }
    else if (c === 39) { if (start < i) out.push(s.slice(start, i)); out.push('&#39;'); start = i + 1; }
  }
  if (start < n) out.push(s.slice(start));
}
// cleanUrl: encodeURI + restore '%' (marked's cleanUrl). Returns null when
// encodeURI throws (lone surrogate in the href).
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Special chars that stop a bulk text run.
const SPECIAL = new Uint8Array(128);
for (const ch of '`*_~[![<&\\\n') SPECIAL[ch.charCodeAt(0)] = 1;

// Flanking helpers (CommonMark): char before/after a delimiter run.
function flanking(before, after) {
  // before/after are single chars (or '' at the edges).
  const bSpace = before === '' || isUnicodeSpace(before);
  const aSpace = after === '' || isUnicodeSpace(after);
  const bPunct = before !== '' && isUnicodePunct(before);
  const aPunct = after !== '' && isUnicodePunct(after);
  const left = !aSpace && (!aPunct || bSpace || bPunct);
  const right = !bSpace && (!bPunct || aSpace || aPunct);
  return [left, right];
}

// Delimiter record: {ch, len, open, close, idx} where idx is the chunk index
// in the output array holding this run's literal text.

// Category of a delimiter run from its neighbours, following marked's
// emStrongRDelimAst/Und groups. Returns 'open' (groups 3-4), 'close'
// (groups 1-2), 'both' (groups 5-6), or '' (no group).
function delimGroup(prev, next) {
  const pPunct = prev !== '' && isUnicodePunct(prev);
  const pSpace = prev !== '' && isSpace(prev.charCodeAt(0));
  const pWord = prev !== '' && !pPunct && !pSpace;
  const nPunct = next !== '' && isUnicodePunct(next);
  const nSpace = next === '' || isSpace(next.charCodeAt(0));
  const nWord = next !== '' && !nPunct && !nSpace;
  if (pPunct && nSpace) return 'close';
  if (pWord && (nPunct || nSpace)) return 'close';
  if ((pPunct || pSpace) && nWord) return 'open';
  if (pSpace && nPunct) return 'open';
  if (pPunct && nPunct) return 'both';
  if (pWord && nWord) return 'both';
  return '';
}

// For each '*'/'_' opener, run marked's emStrong m-balance forward
// scan. Mark it expectsStrong when it closes as strong (len >= 2),
// and mark closes=false when NO k in 1..len closes it (marked's lexer
// advances one delimiter at a time, so a run closes if any partial
// run closes -- e.g. `**foo*` closes with k=1 even though k=2 does
// not; but `*foo **bar**baz*` never closes because the inner
// both-flanking ** closer is skipped by the rule of 3).
function markStrongOpeners(delims) {
  for (let i = 0; i < delims.length; i++) {
    const opener = delims[i];
    if (!opener || !opener.open) continue;
    const ch = opener.ch;
    if (ch === '~') continue;
    const y = opener.len;
    let closes = false;
    for (let k = opener.len; k >= 1; k--) {
      const m0 = scanCloses(delims, i, ch, k, y);
      if (m0.res === 1) { closes = true; break; }
      if (m0.res === 2 && opener.len >= 2) { opener.expectsStrong = true; closes = true; break; }
      if (m0.res === 2) { closes = true; break; }
      // A "never closes" verdict only counts when a both-flanking
      // closer was skipped by the rule of 3 (f > 0). Without a skip,
      // the failure is just an inner open-only run extending m, and
      // the outer opener can still close once the inner emphasis is
      // formed (cm-470: `*foo __bar *baz bim__ bam*`).
      if (m0.skipped) opener.closes = false;
    }
    if (!closes && opener.closes !== false) {
      // No k closed and no skip was recorded: leave unmarked (the
      // closer-first scan decides).
    }
    if (opener.len < 2) continue;
    // (expectsStrong is set inside the k loop above)
    continue;
  }
}

// Run the m-balance from delimiter index i with opener run length k
// and total run length y. Returns {res: 0 (never closes), 1 (em),
// 2 (strong), skipped: whether a both-flanking closer was skipped
// by the rule of 3}.
function scanCloses(delims, i, ch, k, y) {
  {
    let m = k, f = 0;
    const opener = delims[i];
    const prev = opener.prev || '';
    const next = opener.next || '';
    const h = prev === '*' || prev === '_' || isUnicodePunct(prev);
    const R = prev !== '' && prev.trim() !== '' && (next !== '' || (ch === '*' && !h));
    // A len-1 opener nested inside a len>=2 opener (e.g. `*...*` inside
    // `**...**`) cannot close at a len>=2 closer: that closer belongs
    // to the enclosing strong. Its scope ends before such a closer.
    let insideStrong = false;
    if (opener.len === 1) {
      for (let s = i - 1; s >= 0; s--) {
        const od = delims[s];
        if (od && od.ch === ch && od.open && od.len >= 2) { insideStrong = true; break; }
        if (od && od.ch === ch && od.close && od.len >= 2) break;
      }
    }
    for (let t = i + 1; t < delims.length; t++) {
      const d = delims[t];
      if (!d || d.len === 0 || d.ch !== ch) continue;
      const b = d.len;
      const g = delimGroup(d.prev || '', d.next || '');
      if (g === '') continue;
      if (g === 'open') {
        if (!d.open) continue;
        m += b; continue;
      }
      if (!d.close) continue;
      if (g === 'both' || R) {
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      // A len>=2 closer that is not skipped belongs to the enclosing
      // strong when this opener is nested inside one; stop the scan
      // there instead of letting it close the nested opener.
      if (insideStrong && b >= 2) break;
      m -= b;
      if (m > 0) continue;
      const b2 = Math.min(b, b + m + f);
      const use = Math.min(k, b2);
      return { res: use % 2 === 0 ? 2 : 1, skipped: f > 0 };
    }
    return { res: 0, skipped: f > 0 };
  }
}

function processEmphasis(delims, out, src, phantoms, ruleBRegions) {
  // Rule A: a closer whose effective position lies inside a phantom
  // code span (trigger link present) is suppressed.
  // Rule B: a match whose opener AND closer both lie inside the same
  // unformed-link region and whose content wraps an unclean 2+ code
  // span is suppressed.
  // The effective position of a delimiter is the position of the
  // delimiter that THIS match would consume: for a closer the leftmost
  // remaining delimiter, for an opener the rightmost remaining one.
  const inPhantom = (p) => {
    if (!phantoms) return false;
    for (let k = 0; k < phantoms.length; k++) {
      if (p >= phantoms[k][0] && p < phantoms[k][1]) return true;
    }
    return false;
  };
  const suppressed = (opener, closer) => {
    const cPos = closer.pos + (closer.origLen - closer.len);
    if (inPhantom(cPos)) return true;
    if (ruleBRegions && ruleBRegions.length > 0 && src !== undefined) {
      const oPos = opener.pos + opener.len - 1;
      for (let k = 0; k < ruleBRegions.length; k++) {
        const r = ruleBRegions[k];
        if (oPos >= r[0] && oPos < r[1] && cPos >= r[0] && cPos < r[1]) {
          if (hasUncleanCodeSpan(src, oPos + 1, cPos)) return true;
        }
      }
    }
    return false;
  };
  // openersBottom per delimiter char: index into delims (exclusive bound).
  const bottom = { '*': -1, '_': -1, '~': -1 };
  // Pre-pass (marked's emStrong m-balance): for each '*'/'_' opener with
  // len >= 2, determine whether it closes as strong. A lone close-only
  // '*' must NOT match such an opener with use=1 when the opener is
  // going to close as strong at a later '**' (e.g. `**a *b*other* c**`
  // is <strong>, while `**a *b* c* d**` is <em>). The pre-pass only
  // ADDS this one skip rule; all matching stays closer-first.
  markStrongOpeners(delims);
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (!closer || !closer.close) { di++; continue; }
    const ch = closer.ch;
    // find the nearest opener before this closer
    let oi = di - 1, opener = null, sawPotential = false;
    while (oi > bottom[ch]) {
      const d = delims[oi];
      if (d && d.ch === ch && d.open) {
        sawPotential = true;
        // '~' (strikethrough): the regex backreferences the opener's
        // length, so the two runs must have the SAME length, and it must
        // be 1 or 2 (a longer run leaves a '~' adjacent to the delimiter,
        // failing the lookahead). Otherwise this opener cannot match.
        if (ch === '~' && (d.len !== closer.len || d.len > 2)) { oi--; continue; }
        const odd = (d.open && d.close) || (closer.open && closer.close);
        if (!odd || (d.len + closer.len) % 3 !== 0 || (d.len % 3 === 0 && closer.len % 3 === 0)) {
          // A lone close-only run must not steal one delimiter from a
          // '**' opener that the m-balance says closes as strong.
          if (d.len === 2 && closer.len === 1 && !closer.open && !d.close && d.expectsStrong) {
            oi--; continue;
          }
          // The m-balance says this opener never closes (no k in
          // 1..len reaches m <= 0), so it must stay literal.
          if (d.closes === false) { oi--; continue; }
          // Rule A / Rule B: this match is suppressed by a phantom
          // code span or an unformed-link region -- keep searching
          // backwards for another opener for this closer.
          if (suppressed(d, closer)) { oi--; continue; }
          opener = d; break;
        }
      }
      oi--;
    }
    if (!opener) {
      // cmark #383: only advance openers_bottom when NO potential opener
      // was seen. An opener rejected by the odd-match rule may still match
      // a later closer (different length), so it must not be skipped.
      // Advance to di-1 (not di): the delimiter at di itself may be an
      // opener for a later closer, so it must stay searchable.
      if (!sawPotential) bottom[ch] = di - 1;
      di++;
      continue;
    }
    // use 2 delimiters when both runs have >= 2 (strong/del), else 1 (em).
    // '~' uses the run length (1 or 2; opener and closer lengths match).
    let use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    if (ch === '~') use = opener.len;
    const tag = ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    // Chunk layout: an opener's leftover delimiters sit on the LEFT
    // (outer side), its tags after them; a closer's leftover delimiters
    // sit on the RIGHT, its tags before them. A new match consumes the
    // delimiters adjacent to the content, so the new tag goes right
    // after the opener's leftovers / right before the closer's leftovers.
    const oChunk = out[opener.idx];
    const oOldRest = opener.len;
    const oRest = oOldRest - use;
    const oExisting = oChunk.slice(oOldRest);
    out[opener.idx] = (oRest > 0 ? ch.repeat(oRest) : '') + '<' + tag + '>' + oExisting;
    opener.len = oRest;
    const cChunk = out[closer.idx];
    const cOldRest = closer.len;
    const cRest = cOldRest - use;
    const cExisting = cChunk.slice(0, cChunk.length - cOldRest);
    // When an inner both-flanking closer was skipped by the rule of 3
    // (marked's f), the adjusted closer length b exceeds `use`, so the
    // leftover delimiters stay INSIDE the tag (M.slice(2,-2) keeps the
    // first b-use of them as content). Otherwise they go outside.
    if (opener.hasInnerSkip && cRest > 0) {
      out[closer.idx] = cExisting + ch.repeat(cRest) + '</' + tag + '>';
    } else {
      out[closer.idx] = cExisting + '</' + tag + '>' + (cRest > 0 ? ch.repeat(cRest) : '');
    }
    closer.len = cRest;
    // Record a rule-of-3 skip for the nearest enclosing opener: if
    // this closer was both-flanking and (outer.len + closer.len) % 3
    // is 0 while outer.len % 3 is not, marked skips it (f) and the
    // outer match's closer leftover goes inside.
    if (delimGroup(closer.prev || '', closer.next || '') === 'both') {
      for (let s = oi - 1; s > bottom[ch]; s--) {
        const od = delims[s];
        if (od && od.ch === ch && od.open) {
          if (od.len % 3 !== 0 && (od.len + cOldRest) % 3 === 0) od.hasInnerSkip = true;
          break;
        }
      }
    }
    // Trapping rule: delimiters strictly between the opener and closer
    // are now inside the formed emphasis and can no longer match a
    // closer outside it -- remove them from the stack.
    const between = di - oi - 1;
    if (between > 0) {
      delims.splice(oi + 1, between);
      di -= between;
      // Splicing shifts indices, so the openersBottom index bounds
      // (set for the old array) now point at the wrong delimiters
      // and would block valid later matches (e.g. `**is**` after an
      // inner `*3*` inside `_..._`). Reset them: re-scanning is
      // correct, just slightly more work.
      bottom['*'] = -1; bottom['_'] = -1; bottom['~'] = -1;
    }
    // remove exhausted delimiters from the stack
    let spliced = false;
    if (opener.len === 0) {
      const oi2 = delims.indexOf(opener);
      if (oi2 !== -1) delims.splice(oi2, 1);
      if (oi2 < di) di--;
      if (oi2 !== -1) spliced = true;
    } else if (ch === '~' && opener.len < 2) {
      // a leftover single '~' can never form a strikethrough; drop it
      const oi2 = delims.indexOf(opener);
      if (oi2 !== -1) delims.splice(oi2, 1);
      if (oi2 < di) di--;
      if (oi2 !== -1) spliced = true;
    }
    if (closer.len === 0) {
      delims.splice(di, 1);
      spliced = true;
      // do not advance di: the next delimiter slid into this slot
    } else if (ch === '~' && closer.len < 2) {
      // a leftover single '~' can never form a strikethrough; skip it
      di++;
    }
    if (spliced) { bottom['*'] = -1; bottom['_'] = -1; bottom['~'] = -1; }
    // if the closer still has delimiters, keep it as current (di unchanged)
    // so it can match another opener.
  }
}

// Find the index of the ']' matching the '[' at s[i] (i points at '[').
// Skips code spans and backslash escapes. Returns -1 when there is none.
function findClosingBracket(s, i, n) {
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; } // backslash escape
    if (c === 96) { // backtick run: skip the code span
      // marked's link-label regex treats a code span as `+ ... `+ with
      // ANY closing run length (the content has no backticks, so the
      // FIRST backtick run after the opening closes it). This is only
      // for finding the ']' -- the actual code-span renderer still
      // requires equal run lengths, so an unbalanced run like ``url`
      // stays literal in the link text.
      // An UNMATCHED backtick run blocks the label entirely (the label
      // regex cannot consume it), so the link does not form -- except a
      // run of 2+ backticks immediately before ']' (alternative ``+(?=])).
      // BOUND (doc-33): the closer search must not cross the ']' that
      // closes the label followed by '(' -- i.e. a ']' at depth 0
      // followed by '(' starts the link's destination group, and a
      // closer run is only valid if it appears before that group's
      // closing ')'. Otherwise the run is unpaired and the label ends
      // at that ']'. A ']' followed by '(' that is INSIDE a code span
      // (its closer run comes first, e.g. `[a `x](` b](z)`) does not
      // bound the search, because the backtick run is found first.
      let k = j;
      while (k < n && s.charCodeAt(k) === 96) k++;
      const runLen = k - j;
      let m = k;
      let found = -1;
      let d = depth; // bracket depth at the run
      let paren = 0; // >0 while inside a (...) group after a label-closing ']'
      while (m < n) {
        const mc = s.charCodeAt(m);
        if (mc === 92) { m += 2; continue; }
        if (mc === 96) { found = m; while (found < n && s.charCodeAt(found) === 96) found++; break; }
        if (mc === 91) { if (paren === 0) d++; m++; continue; }
        if (mc === 93) {
          if (paren === 0) {
            d--;
            if (d === 0 && m + 1 < n && s.charCodeAt(m + 1) === 40) {
              paren = 1; m += 2;
              // angle destination <...>: skip to '>'
              if (m < n && s.charCodeAt(m) === 60) {
                m++;
                while (m < n && s.charCodeAt(m) !== 62) { if (s.charCodeAt(m) === 92) m++; m++; }
                if (m < n) m++;
              }
              continue;
            }
          }
          m++; continue;
        }
        if (paren > 0) {
          if (mc === 40) { paren++; m++; continue; }
          if (mc === 41) { paren--; if (paren === 0) break; m++; continue; }
          if (mc === 34 || mc === 39) { // skip a quoted title
            const q = mc; m++;
            while (m < n && s.charCodeAt(m) !== q) { if (s.charCodeAt(m) === 92) m++; m++; }
            if (m < n) m++;
            continue;
          }
        }
        m++;
      }
      if (found === -1) {
        // no closing run: blocks the label, unless 2+ backticks right
        // before the closing ']'
        if (runLen >= 2 && k < n && s.charCodeAt(k) === 93) { j = k; continue; }
        return -1;
      }
      j = found;
      continue;
    }
    if (c === 60) { // '<': skip a raw HTML tag / autolink, so a ']'
      // inside a tag's attribute value does not close the bracket
      const raw = tryRawHtml(s, j, n);
      if (raw) { j = raw.next; continue; }
      const auto = tryAngleAutolink(s, j, n);
      if (auto) { j = auto.next; continue; }
      j++;
      continue;
    }
    if (c === 91) { depth++; j++; continue; } // '['
    if (c === 93) { // ']'
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Parse a link destination starting at s[i] (after '(' or after label).
// Returns {dest, next} where next is the index after the destination, or
// null when there is no valid destination here.
function parseDestination(s, i, n) {
  // skip whitespace (including newlines)
  let j = i;
  while (j < n && isSpace(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  if (s.charCodeAt(j) === 60) { // '<...>'
    let k = j + 1;
    let dest = '';
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 10 || c === 60) return null; // newline or '<' not allowed
      if (c === 62) return { dest, next: k + 1 }; // '>'
      if (c === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
      dest += s[k]; k++;
    }
    return null;
  }
  // bare destination: no spaces/control chars, balanced parens
  let k = j, depth = 0, dest = '';
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) break;
    if (c === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
    if (c === 40) { depth++; dest += s[k]; k++; continue; } // '('
    if (c === 41) { // ')'
      if (depth === 0) break;
      depth--; dest += s[k]; k++; continue;
    }
    if (c < 32 || c === 127) return null;
    dest += s[k]; k++;
  }
  // an empty destination is valid ([link]() -> href="")
  return { dest, next: k };
}

// Parse a link title starting at s[i] (after the destination + whitespace).
// Returns {title, next} or null.
function parseTitle(s, i, n) {
  let j = i;
  while (j < n && isSpace(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  const q = s.charCodeAt(j);
  let close;
  if (q === 34 || q === 39) close = q; // " or '
  else if (q === 40) close = 41; // ( ... )
  else return null;
  let k = j + 1, title = '', parenDepth = 0;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { title += s[k + 1]; k += 2; continue; }
    if (c === close) {
      if (close === 41 && parenDepth > 0) { parenDepth--; title += s[k]; k++; continue; }
      return { title, next: k + 1 };
    }
    if (close === 41 && c === 40) { parenDepth++; title += s[k]; k++; continue; }
    // a blank line inside a title is not allowed
    if (c === 10 && k + 1 < n && s.charCodeAt(k + 1) === 10) return null;
    title += s[k]; k++;
  }
  return null;
}

// Normalize a link label: collapse whitespace runs to one space, trim,
// case-fold (toLowerCase). Used for reference lookups.
// true if s contains a '[' not preceded by a backslash (a link label
// may not contain an unescaped '[')
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92) { i++; continue; }
    if (s.charCodeAt(i) === 91) return true;
  }
  return false;
}
function normalizeLabel(s) {
  let out = '';
  let pendingSpace = false, started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) { pendingSpace = true; continue; }
    if (pendingSpace && started) out += ' ';
    pendingSpace = false; started = true;
    out += s[i];
  }
  // Unicode case folding: toLowerCase() alone does not fold ß -> ss
  // (nor ẞ -> ss); CommonMark matches labels case-insensitively.
  return out.toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

// Try to parse a link or image starting at s[i] ('[' or '![').
// Returns {html, next} (html already rendered) or null when not a link.
function tryLink(s, i, n, defs, isImage) {
  const open = isImage ? i + 1 : i; // index of '['
  const close = findClosingBracket(s, open, n);
  if (close === -1) return null;
  const text = s.slice(open + 1, close);
  // a link label may not be empty (except '[]' collapsed form is handled below)
  let j = close + 1;
  // inline link: (dest "title")
  if (j < n && s.charCodeAt(j) === 40) {
    const d = parseDestination(s, j + 1, n);
    if (d) {
      let k = d.next;
      // optional title
      let title = null;
      let m = k;
      while (m < n && isSpace(s.charCodeAt(m))) m++;
      if (m < n && (s.charCodeAt(m) === 34 || s.charCodeAt(m) === 39 || s.charCodeAt(m) === 40)) {
        const t = parseTitle(s, k, n);
        if (t) { title = t.title; k = t.next; }
      }
      // skip whitespace, expect ')'
      while (k < n && isSpace(s.charCodeAt(k))) k++;
      if (k < n && s.charCodeAt(k) === 41) {
        const r = renderLink(text, d.dest, title, isImage, defs, k + 1);
        if (r) { r.text = text; r.inline = true; }
        return r;
      }
      // no closing paren: the inline link fails; fall through to the
      // reference forms (a shortcut reference may still apply).
    } else if (!d) {
      // '(' but no valid destination: the inline link fails; fall through
      // to the reference forms (a shortcut reference may still apply,
      // e.g. [foo](not a link) with [foo]: /url1 defined).
    }
  }
  // full reference: [text][label]
  if (j < n && s.charCodeAt(j) === 91) {
    const close2 = findClosingBracket(s, j, n);
    if (close2 !== -1) {
      if (hasUnescapedBracket(s.slice(j + 1, close2))) return null;
      const label = normalizeLabel(s.slice(j + 1, close2));
      // an empty label means a collapsed reference ([text][]), which
      // uses the link text as the label -- fall through to that case
      if (label.length > 0) {
        const def = defs.get(label);
        if (def) {
          const r = renderLink(text, def.dest, def.title, isImage, defs, close2 + 1);
          if (r) { r.text = text; r.inline = false; }
          return r;
        }
        return null;
      }
    } else {
      return null;
    }
  }
  // collapsed reference: [text][]
  if (j + 1 < n && s.charCodeAt(j) === 91 && s.charCodeAt(j + 1) === 93) {
    const label = normalizeLabel(text);
    const def = defs.get(label);
    if (def) {
      const r = renderLink(text, def.dest, def.title, isImage, defs, j + 2);
      if (r) { r.text = text; r.inline = false; }
      return r;
    }
    return null;
  }
  // shortcut reference: [text] (the text is the label; it may not
  // contain an unescaped '[')
  if (text.length > 0 && !hasUnescapedBracket(text)) {
    const label = normalizeLabel(text);
    const def = defs.get(label);
    if (def) {
      const r = renderLink(text, def.dest, def.title, isImage, defs, close + 1);
      if (r) { r.text = text; r.inline = false; }
      return r;
    }
  }
  return null;
}

// Render a resolved link/image. Returns {html, next}. cleanUrl is applied
// to the href; when it returns null (lone surrogate) a link renders as just
// its text and an image as just its alt text (noEncode-escaped).
function renderLink(text, dest, title, isImage, defs, next) {
  const href = cleanUrl(dest);
  if (isImage) {
    // alt text: parse inline, then strip tags. A nested image's <img>
    // tag is replaced by its alt attribute first (so the nested alt
    // text survives instead of being dropped with the tag).
    const tmp = [];
    parseInline(text, defs, tmp);
    const alt = tmp.join('').replace(/<img\b[^>]*>/g, (m) => {
      const a = / alt="([^"]*)"/.exec(m);
      return a ? a[1] : '';
    }).replace(/<[^>]*>/g, '');
    if (href === null) {
      const out = [];
      escapeAttr(alt, out);
      return { html: out.join(''), next };
    }
    const out = ['<img src="'];
    escapeAttr(href, out);
    out.push('" alt="');
    escapeAttr(alt, out);
    out.push('"');
    if (title !== null && title !== undefined) {
      out.push(' title="');
      escapeAttr(title, out);
      out.push('"');
    }
    out.push('>');
    return { html: out.join(''), next };
  }
  const inner = [];
  const state = { bracketLink: false };
  parseInline(text, defs, inner, true, state);
  const innerHtml = inner.join('');
  // a link's text may not contain another bracket-link (CommonMark:
  // links do not nest). An angle autolink inside is allowed (it renders
  // as a nested <a>), and a bare URL inside is plain text.
  if (state.bracketLink) return null;
  if (href === null) return { html: innerHtml, next };
  const out = ['<a href="'];
  escapeAttr(href, out);
  out.push('"');
  if (title !== null && title !== undefined) {
    out.push(' title="');
    escapeAttr(title, out);
    out.push('"');
  }
  out.push('>');
  out.push(innerHtml);
  out.push('</a>');
  return { html: out.join(''), next };
}

// ---------------------------------------------------------------------------
// Autolinks and raw HTML
// ---------------------------------------------------------------------------

// <scheme:...> or <email>. Returns {html, next} or null.
// marked's autolink rule: <(scheme:[^\s\x00-\x1f<>]*|email)>
//   scheme = [a-zA-Z][a-zA-Z0-9+.-]{1,31}  (2-32 chars)
//   email  = local@[domain.]tld with a (?![-_]) lookahead.
// Autolinks use encode-mode escaping for href AND text, and cleanUrl on the
// href; a null cleanUrl renders just the text.
const ANGLE_EMAIL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])$/;
function tryAngleAutolink(s, i, n) {
  // find the closing '>' (no whitespace/control, '<' or '>' inside)
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) break; // '>'
    if (c <= 32 || c === 60) return null;
    j++;
  }
  if (j >= n) return null;
  const inner = s.slice(i + 1, j);
  const colon = inner.indexOf(':');
  if (colon >= 2 && colon <= 32) {
    const scheme = inner.slice(0, colon);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) {
      const href = cleanUrl(inner);
      if (href === null) {
        const out = [];
        escapeEncode(inner, out);
        return { html: out.join(''), next: j + 1 };
      }
      const out = ['<a href="'];
      escapeEncode(href, out);
      out.push('">');
      escapeEncode(inner, out);
      out.push('</a>');
      return { html: out.join(''), next: j + 1 };
    }
  }
  if (ANGLE_EMAIL.test(inner)) {
    const href = cleanUrl('mailto:' + inner);
    if (href === null) {
      const out = [];
      escapeEncode(inner, out);
      return { html: out.join(''), next: j + 1 };
    }
    const out = ['<a href="'];
    escapeEncode(href, out);
    out.push('">');
    escapeEncode(inner, out);
    out.push('</a>');
    return { html: out.join(''), next: j + 1 };
  }
  return null;
}

// GFM extended autolink starting at s[i]: www., http(s)://, ftp://, or
// email. `prev` is the char before i ('' at start). Returns {html, next}
// or null.
//
// marked's flow: the broad url regex grabs scheme/www + domain +
// [^\s<]*, then the _backpedal regex is applied in a loop until the
// result is stable. Backpedal alternatives, in order:
//   (1) runs of chars not in ?!.,:;*_'"~()&
//   (2) parenthesised groups \([^)]*\)
//   (3) '&' not followed by [a-zA-Z0-9]+; at the end
//   (4) runs of ?!.,:;*_'"~) NOT at the end  ((?!$) -- so a trailing
//       run of those chars is dropped, but one in the middle is kept)
// The url rule itself:
//   ^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*  --
//   protocol = [hH][tT][tT][pP][sS]?|[fF][tT][pP]
//   email    = [A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])
// Note the email branch is NOT backpedalled and NOT trimmed: it uses the
// raw regex match. www. requires a preceding start/space/*/_/~/(
// (the scheme:// and email forms have no such restriction).
// Autolinks use encode-mode escaping for href AND text, and cleanUrl on
// the href; a null cleanUrl means the autolink renders as plain text
// (caller falls back to text).
const URL_BROAD = /^(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const EMAIL_GFM = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_GFM_NOLOOK = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/;
function backpedalUrl(url) {
  let prev;
  do {
    prev = url;
    const m = BACKPEDAL.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return url;
}
// Validate a candidate extended-autolink URL starting at s[i] (the 'w' of
// www. or the scheme start). Returns the end index of the final URL, or -1.
// `wwwOnly` restricts to the www. form (used by the look-back helper).
function matchUrlAt(s, i, n) {
  const m = URL_BROAD.exec(s.slice(i, n));
  if (!m) return -1;
  let end = i + m[0].length;
  // the domain part must be present (the regex guarantees at least one
  // [a-zA-Z0-9-]+ group after the scheme/www.)
  end = i + backpedalUrl(m[0]).length;
  return end <= i ? -1 : end;
}
// Is there a '_' before index `upto` in `s` that can open an emphasis?
// A '_' opens when it is left-flanking and (not right-flanking, or the
// char before it is punctuation) -- the same canOpen rule parseInline
// uses for '_'. Marked resolves emphasis before matching emails, so a
// '_' closer after an email is invisible to its email regex; our
// single-pass scan sees it, so we replicate the effect here: a trailing
// '_' after an email is a closer (not part of the address) exactly when
// a matching opener exists before the email.
function hasUnderscoreOpener(s, upto) {
  for (let i = 0; i < upto; i++) {
    if (s.charCodeAt(i) !== 95) continue;
    const before = i > 0 ? s[i - 1] : '';
    const after = i + 1 < s.length ? s[i + 1] : '';
    const [left, right] = flanking(before, after);
    if (left && (!right || isUnicodePunct(before))) return true;
  }
  return false;
}

// Validate an email autolink whose '@' is at s[at]. The local part is
// scanned back over [A-Za-z0-9._+-] (clamped to `minStart`). Returns
// {start, end} or null.
function matchEmailAt(s, at, n, minStart) {
  let ls = at;
  while (ls > minStart) {
    const c = s.charCodeAt(ls - 1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 45 || c === 95 || c === 43) { ls--; continue; }
    break;
  }
  if (ls >= at) return null;
  const m = EMAIL_GFM.exec(s.slice(ls, n));
  if (!m) {
    // No match with the lookahead: it may have failed on a trailing '_'
    // that is an emphasis closer (marked resolves emphasis first, so its
    // email regex never sees the closer). Try without the lookahead;
    // accept the longer match only if a '_' opener exists before the
    // email -- otherwise marked's regex fails entirely (e.g.
    // `foo@bar.com__` with no opener renders as plain text).
    const m2 = EMAIL_GFM_NOLOOK.exec(s.slice(ls, n));
    if (!m2) return null;
    const end2 = ls + m2[0].length;
    if (end2 >= n) return { start: ls, end: end2 };
    if (s.charCodeAt(end2) === 95 && hasUnderscoreOpener(s, ls)) {
      return { start: ls, end: end2 };
    }
    return null;
  }
  const end = ls + m[0].length;
  // The lookahead may have shortened the match (backtracked past a
  // trailing '_' that is an emphasis closer): the shortened match then
  // ends right before a '.' (the dropped group's dot). Re-match without
  // the lookahead and take the longer match when it ends before a '_'
  // with a '_' opener before the email.
  if (end < n && s.charCodeAt(end) === 46) {
    const m2 = EMAIL_GFM_NOLOOK.exec(s.slice(ls, n));
    if (m2) {
      const end2 = ls + m2[0].length;
      if (end2 > end && end2 < n && s.charCodeAt(end2) === 95 && hasUnderscoreOpener(s, ls)) {
        return { start: ls, end: end2 };
      }
    }
  }
  return { start: ls, end };
}
// GFM extended autolink starting at s[i]. `prev` is the char before i.
// Returns {html, next} or null. The caller (text-run processing) decides
// when to call this; for www. the preceding-char rule applies here.
function tryExtendedAutolink(s, i, n, prev) {
  // mailto: / xmpp: + email (GFM emailProtocol branch; the whole
  // "mailto:foo@bar.baz" is the link, href and text alike). xmpp: may
  // carry one /path segment of [A-Za-z0-9@.]+.
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const isMailto = s.charCodeAt(i) === 109; // 'm'
    const eStart = i + (isMailto ? 7 : 5);
    const eEnd = matchEmailAt(s, eStart, n);
    if (eEnd !== -1) {
      let end = eEnd;
      if (!isMailto && end < n && s.charCodeAt(end) === 47) { // '/'
        let j = end + 1;
        while (j < n && /[A-Za-z0-9@.]/.test(s[j])) j++;
        if (j > end + 1) end = j;
      }
      const body = s.slice(i, end);
      const href = cleanUrl(body);
      if (href === null) return null;
      const out = ['<a href="'];
      escapeEncode(href, out);
      out.push('">');
      escapeEncode(body, out);
      out.push('</a>');
      return { html: out.join(''), next: end };
    }
    return null;
  }
  const isWww = s.startsWith('www.', i);
  if (isWww) {
    if (prev !== '' && !isUnicodeSpace(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') return null;
  } else if (!s.startsWith('http://', i) && !s.startsWith('https://', i) && !s.startsWith('ftp://', i) &&
             !s.startsWith('HTTP://', i) && !s.startsWith('HTTPS://', i) && !s.startsWith('FTP://', i)) {
    // case-insensitive scheme check (the broad regex handles the rest)
    const head = s.slice(i, i + 8).toLowerCase();
    if (!head.startsWith('http://') && !head.startsWith('https://') && !head.startsWith('ftp://')) return null;
  }
  const end = matchUrlAt(s, i, n);
  if (end === -1) return null;
  const body = s.slice(i, end);
  if (isWww) {
    // the host (before any /, ?, #) must contain a dot
    const hostEnd = body.search(/[/?#]/);
    const host = hostEnd === -1 ? body.slice(4) : body.slice(4, hostEnd);
    if (host.indexOf('.') === -1) return null;
  }
  const hrefRaw = isWww ? 'http://' + body : body;
  const href = cleanUrl(hrefRaw);
  if (href === null) return null; // renders as plain text
  const out = ['<a href="'];
  escapeEncode(href, out);
  out.push('">');
  escapeEncode(body, out);
  out.push('</a>');
  return { html: out.join(''), next: end };
}

// Raw HTML tag starting at s[i] === '<'. Returns {html, next} or null.
function tryRawHtml(s, i, n) {
  // comment <!-- ... --> (<!--> and <!---> are empty comments)
  if (s.startsWith('<!--', i)) {
    if (s.charCodeAt(i + 4) === 62) return { html: s.slice(i, i + 5), next: i + 5 }; // <!-->
    if (s.startsWith('->', i + 4)) return { html: s.slice(i, i + 7), next: i + 7 }; // <!--->
    const e = s.indexOf('-->', i + 4);
    if (e !== -1) return { html: s.slice(i, e + 3), next: e + 3 };
    // unterminated comment: everything to the end is the comment? No --
    // marked treats an unterminated comment as literal text. Fall through.
    return null;
  }
  // processing instruction <? ... ?>
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e !== -1) return { html: s.slice(i, e + 2), next: e + 2 };
    return null;
  }
  // declaration <!A ...>  (not <!-- and not <![CDATA[)
  if (s.startsWith('<!', i) && !s.startsWith('<![CDATA[', i)) {
    let j = i + 2;
    if (j < n && /[A-Za-z]/.test(s[j])) {
      while (j < n && s.charCodeAt(j) !== 62) j++;
      if (j < n) return { html: s.slice(i, j + 1), next: j + 1 };
    }
    return null;
  }
  // CDATA <![CDATA[ ... ]]>
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e !== -1) return { html: s.slice(i, e + 3), next: e + 3 };
    return null;
  }
  // open or close tag
  let j = i + 1;
  let closing = false;
  if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; } // '/'
  if (j >= n || !/[A-Za-z]/.test(s[j])) return null;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (closing) {
    // optional whitespace, then '>'
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k < n && s.charCodeAt(k) === 62) return { html: s.slice(i, k + 1), next: k + 1 };
    return null;
  }
  // open tag: attributes then '>' or '/>'. The first character after
  // the tag name must be whitespace, '/' or '>' (an attribute must be
  // preceded by whitespace); e.g. <m:abc> is not a tag.
  {
    const c0 = s.charCodeAt(j);
    if (c0 !== 32 && c0 !== 9 && c0 !== 10 && c0 !== 62 && c0 !== 47) return null;
  }
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) return { html: s.slice(i, j + 1), next: j + 1 }; // '>'
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return { html: s.slice(i, j + 2), next: j + 2 }; // '/>'
    if (c === 32 || c === 9 || c === 10) { j++; continue; }
    // attribute name (must start with a letter, '_' or ':')
    if (!/[A-Za-z_:]/.test(s[j])) return null;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional whitespace
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (j < n && s.charCodeAt(j) === 61) { // '='
      j++;
      while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
      if (j >= n) return null;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) { // quoted value
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++;
        // after a quoted value, whitespace, '/' or '>' must follow
        if (j < n) {
          const nc = s.charCodeAt(j);
          if (nc !== 32 && nc !== 9 && nc !== 10 && nc !== 62 && nc !== 47) return null;
        }
      } else { // unquoted value
        if (s.charCodeAt(j) === 34 || s.charCodeAt(j) === 39 || s.charCodeAt(j) === 61 || s.charCodeAt(j) === 60 || s.charCodeAt(j) === 62 || s.charCodeAt(j) === 96) return null;
        while (j < n) {
          const c2 = s.charCodeAt(j);
          if (c2 === 32 || c2 === 9 || c2 === 10 || c2 === 62 || c2 === 47) break;
          if (c2 === 34 || c2 === 39 || c2 === 61 || c2 === 60 || c2 === 96) return null;
          j++;
        }
        if (j >= n) return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extended-autolink interaction with delimiters.
//
// A '_' that sits inside an email local part (foo_bar@baz.com) must be
// plain text, not an emphasis delimiter; a '*', '_' or '~' inside a bare
// URL (www.mark.com/large_!!) must be plain text too. Both are decided
// when the delimiter is first seen, by looking ahead (email) or back
// (URL) and validating the autolink with marked's own rules.
// ---------------------------------------------------------------------------

// Is the '_' at s[i] part of an email local part? Scan forward over
// local-part chars to an '@', then validate the whole email.
function underscoreInEmail(s, i, n) {
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 45 || c === 95 || c === 43) { j++; continue; }
    break;
  }
  if (j >= n || s.charCodeAt(j) !== 64) return false;
  const em = matchEmailAt(s, j, n, 0);
  return em !== null && em.start <= i && i < em.end;
}

// Is the '_' at s[i] part of an email DOMAIN (foo@bar.com_baz)? Scan
// back over email chars (including '@') to find an '@', then validate
// the whole email.
function underscoreInEmailDomain(s, i, n) {
  let j = i;
  while (j > 0) {
    const c = s.charCodeAt(j - 1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 45 || c === 95 || c === 43 || c === 64) { j--; continue; }
    break;
  }
  const at = s.indexOf('@', j);
  if (at === -1 || at >= i) return false;
  const em = matchEmailAt(s, at, n, 0);
  return em !== null && em.start <= i && i < em.end;
}

// Is the delimiter at s[i] inside a bare extended-autolink URL? Scan back
// over the current token (no whitespace/'<'), find a www. or :// start in
// it, validate the URL (broad match + backpedal) and check i is inside.
function delimInUrl(s, i, n) {
  // fast path: at a token boundary (preceded by space/'<'/start) a
  // delimiter cannot sit inside a URL
  if (i === 0) return false;
  const pc = s.charCodeAt(i - 1);
  if (pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 60) return false;
  let t = i;
  while (t > 0) {
    const c = s.charCodeAt(t - 1);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
    t--;
  }
  let p = t;
  while (p < i) {
    let us = -1;
    const w = s.indexOf('www.', p);
    const c = s.indexOf('://', p);
    if (w !== -1 && w < i && (c === -1 || w <= c)) us = w;
    else if (c !== -1 && c < i) {
      if (s.slice(c - 5, c).toLowerCase() === 'https') us = c - 5;
      else if (s.slice(c - 4, c).toLowerCase() === 'http') us = c - 4;
      else if (s.slice(c - 3, c).toLowerCase() === 'ftp') us = c - 3;
      else { p = c + 3; continue; }
    } else break;
    if (us === -1) break;
    if (s.startsWith('www.', us)) {
      const prev = us > 0 ? s[us - 1] : '';
      if (prev !== '' && !isUnicodeSpace(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') {
        p = us + 4; continue;
      }
    }
    const end0 = matchUrlAt(s, us, n);
    if (end0 !== -1) {
      let end = end0;
      // a URL that is a link destination [text](url) ends at the paren
      // matching the '(' before it: a delimiter after that ')' (e.g. an
      // emphasis closer) is outside the URL, even when the broad match
      // runs on into later text whose balanced parens make the backpedal
      // keep the whole run (e.g. [i](https://e.com)*](https://x.org))
      if (us >= 2 && s.charCodeAt(us - 1) === 40 && s.charCodeAt(us - 2) === 93) {
        let depth = 0, closeAt = -1;
        for (let k = us - 1; k < n; k++) {
          const ck = s.charCodeAt(k);
          if (ck === 40) depth++;
          else if (ck === 41) { depth--; if (depth === 0) { closeAt = k; break; } }
        }
        if (closeAt !== -1 && closeAt < end) end = closeAt;
      }
      if (i < end) return true;
      p = end; // skip past this URL; a www. inside it is not a new start
      continue;
    }
    p = us + 1;
  }
  return false;
}

// Push escaped text for src[start..end) (entities handled inline).
function pushText(src, start, end, out) {
  // Fast path: no '&' means no entity to decode -- escape directly.
  const amp = src.indexOf('&', start);
  if (amp === -1 || amp >= end) {
    escapeText(src.slice(start, end), out);
    return;
  }
  let s = start, k = start;
  while (k < end) {
    const c = src.charCodeAt(k);
    if (c === 38) {
      const dec = decodeEntity(src, k, end);
      if (dec) {
        if (k > s) escapeText(src.slice(s, k), out);
        if (dec[2]) out.push(dec[0]);
        else escapeEncodeChar(dec[0], out);
        k = dec[1]; s = k;
        continue;
      }
      k++;
      continue;
    }
    k++;
  }
  if (end > s) escapeText(src.slice(s, end), out);
}

// Emit a text run [start, end), splitting out GFM extended autolinks
// (www., http(s)://, ftp://, email). `prevChar` is the char before the
// run ('' at the start of the source). Plain segments go through pushText.
// marked's lexer state: an <a> start tag (even self-closing <a />)
// sets inLink, an </a> tag clears it; it persists across blocks for
// the whole document. While inLink, bare URL/email autolinks and
// bracket-links are plain text (doc-33: <a /> before a paragraph
// stops the URL in that paragraph from autolinking).
let inLink = false;
function emitTextRun(src, start, end, prevChar, defs, out, noAuto) {
  // inside a link's text, autolinks are plain text (the outer link still
  // forms); only bracket-links inside can cancel it
  if (noAuto || inLink) { pushText(src, start, end, out); return; }
  let i = start;
  let seg = start; // start of the pending plain-text segment
  while (i < end) {
    let w = src.indexOf('www.', i);
    if (w === -1 || w >= end) w = Infinity;
    let c = src.indexOf('://', i);
    if (c === -1 || c >= end) c = Infinity;
    let a = src.indexOf('@', i);
    if (a === -1 || a >= end) a = Infinity;
    const t = Math.min(w, c, a);
    if (t === Infinity) break;
    if (t === w) {
      // www. candidate
      const prev = w > start ? src[w - 1] : prevChar;
      if (prev !== '' && !isUnicodeSpace(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') {
        i = w + 4; continue;
      }
      const e = matchUrlAt(src, w, src.length);
      if (e === -1 || e > end) { i = w + 4; continue; }
      const body = src.slice(w, e);
      const hostEnd = body.search(/[/?#]/);
      const host = hostEnd === -1 ? body.slice(4) : body.slice(4, hostEnd);
      if (host.indexOf('.') === -1) { i = w + 4; continue; }
      const href = cleanUrl('http://' + body);
      if (href === null) { i = w + 4; continue; }
      if (w > seg) pushText(src, seg, w, out);
      out.push('<a href="');
      escapeEncode(href, out);
      out.push('">');
      escapeEncode(body, out);
      out.push('</a>');
      i = e; seg = e;
      continue;
    }
    if (t === c) {
      // :// candidate: scheme is the 3-5 chars before it
      let us = -1;
      if (src.slice(c - 5, c).toLowerCase() === 'https') us = c - 5;
      else if (src.slice(c - 4, c).toLowerCase() === 'http') us = c - 4;
      else if (src.slice(c - 3, c).toLowerCase() === 'ftp') us = c - 3;
      if (us === -1 || us < start) { i = c + 3; continue; }
      const e = matchUrlAt(src, us, src.length);
      if (e === -1 || e > end) { i = c + 3; continue; }
      const body = src.slice(us, e);
      const href = cleanUrl(body);
      if (href === null) { i = c + 3; continue; }
      if (us > seg) pushText(src, seg, us, out);
      out.push('<a href="');
      escapeEncode(href, out);
      out.push('">');
      escapeEncode(body, out);
      out.push('</a>');
      i = e; seg = e;
      continue;
    }
    // '@' candidate: email -- but a mailto:/xmpp: scheme directly before
    // the address extends the link to include the scheme
    const em = matchEmailAt(src, a, src.length, start);
    if (!em || em.end > end) { i = a + 1; continue; }
    let linkStart = em.start, linkEnd = em.end, scheme = '';
    if (em.start >= 7 && src.slice(em.start - 7, em.start) === 'mailto:') {
      linkStart = em.start - 7; scheme = 'mailto:';
    } else if (em.start >= 5 && src.slice(em.start - 5, em.start) === 'xmpp:') {
      linkStart = em.start - 5; scheme = 'xmpp:';
      // one /path segment of [A-Za-z0-9@.]+
      if (linkEnd < end && src.charCodeAt(linkEnd) === 47) {
        let j = linkEnd + 1;
        while (j < end && /[A-Za-z0-9@.]/.test(src[j])) j++;
        if (j > linkEnd + 1) linkEnd = j;
      }
    }
    const addr = src.slice(linkStart, linkEnd);
    const href = cleanUrl(scheme ? addr : 'mailto:' + addr);
    if (href === null) { i = a + 1; continue; }
    if (linkStart > seg) pushText(src, seg, linkStart, out);
    out.push('<a href="');
    escapeEncode(href, out);
    out.push('">');
    escapeEncode(addr, out);
    out.push('</a>');
    i = linkEnd; seg = linkEnd;
  }
  if (end > seg) pushText(src, seg, end, out);
}

// ---------------------------------------------------------------------------
// The inline scan: one pass over the text, emitting HTML chunks.
// Delimiter runs (* _ ~) are recorded; emphasis is resolved afterwards.
// ---------------------------------------------------------------------------
// Is the backslash at src[i] the trailing char of a bare URL that starts
// in the current text run [textStart, i)? A URL ending in '\' keeps the
// backslash as part of the URL (encoded %5C in the href); it is not a
// hard break (before a newline) nor an escape (before punctuation).
function backslashInUrl(src, textStart, i, n) {
  let us = -1;
  const c = src.indexOf('://', textStart);
  if (c !== -1 && c < i) {
    if (src.slice(c - 5, c).toLowerCase() === 'https') us = c - 5;
    else if (src.slice(c - 4, c).toLowerCase() === 'http') us = c - 4;
    else if (src.slice(c - 3, c).toLowerCase() === 'ftp') us = c - 3;
  }
  if (us === -1) {
    const w = src.indexOf('www.', textStart);
    if (w !== -1 && w < i) us = w;
  }
  if (us === -1) return false;
  const e = matchUrlAt(src, us, n);
  return e > i;
}

// ---------------------------------------------------------------------------
// Rule A / Rule B helpers (marked's emphasis suppression around backticks).
// Rule A: a formed inline link/image whose text tokenizes to BOTH a
// literal single-backtick run AND (a literal 2+ run OR a 2+-code-span
// whose content contains a backtick) suppresses emphasis whose CLOSER
// lies inside a "phantom" code span -- code spans computed over the
// WHOLE paragraph by equal-length backtick pairing, crossing the link
// boundary (the trigger link's own [1] pairs with a later run).
// Rule B: emphasis inside an UNFORMED inline link's brackets is
// suppressed when the emphasis wraps a 2+-code-span whose content
// contains a backtick and the brackets are followed by a closed
// paren group.
// ---------------------------------------------------------------------------
// Equal-length code-span pairing over src: each backtick run opens a
// span closing at the next run of the SAME length; unpaired runs are
// literal. Raw HTML tags / autolinks are skipped (backticks inside a
// tag are not code spans). Returns a list of [start, end) regions.
function codeSpanRegions(src) {
  const n = src.length;
  const regions = [];
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 96) {
      let k = i;
      while (k < n && src.charCodeAt(k) === 96) k++;
      const len = k - i;
      let m = k;
      let close = -1;
      while (m < n) {
        if (src.charCodeAt(m) === 96) {
          let e = m;
          while (e < n && src.charCodeAt(e) === 96) e++;
          if (e - m === len) { close = e; break; }
          m = e;
        } else m++;
      }
      if (close !== -1) { regions.push([i, close]); i = close; }
      else i = k;
      continue;
    }
    if (c === 60) {
      const raw = tryRawHtml(src, i, n);
      if (raw) { i = raw.next; continue; }
      const auto = tryAngleAutolink(src, i, n);
      if (auto) { i = auto.next; continue; }
      i++;
      continue;
    }
    i++;
  }
  return regions;
}

// Does a formed inline link/image's text trigger Rule A? Tokenize the
// text for code spans (equal-length pairing); true iff the text yields
// BOTH a literal single-backtick run AND (a literal 2+ run OR a 2+
// code span whose content contains a backtick).
function linkTextTrigger(text) {
  const n = text.length;
  let lit1 = false, lit2 = false, unclean2 = false;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) !== 96) { i++; continue; }
    let k = i;
    while (k < n && text.charCodeAt(k) === 96) k++;
    const len = k - i;
    let m = k;
    let close = -1;
    while (m < n) {
      if (text.charCodeAt(m) === 96) {
        let e = m;
        while (e < n && text.charCodeAt(e) === 96) e++;
        if (e - m === len) { close = m; break; }
        m = e;
      } else m++;
    }
    if (close !== -1) {
      if (len >= 2) {
        // does the span content contain a backtick?
        for (let p = k; p < close; p++) {
          if (text.charCodeAt(p) === 96) { unclean2 = true; break; }
        }
      }
      i = close + len;
    } else {
      if (len === 1) lit1 = true;
      else lit2 = true;
      i = k;
    }
  }
  return lit1 && (lit2 || unclean2);
}

// Find the ']' matching the '[' at s[i], skipping code spans with
// EQUAL-length pairing and backslash escapes, tracking bracket depth.
// Returns the index of the ']', or -1.
function findBracketCloseLenient(s, i, n) {
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      let k = j;
      while (k < n && s.charCodeAt(k) === 96) k++;
      const len = k - j;
      let m = k;
      let close = -1;
      while (m < n) {
        if (s.charCodeAt(m) === 96) {
          let e = m;
          while (e < n && s.charCodeAt(e) === 96) e++;
          if (e - m === len) { close = e; break; }
          m = e;
        } else m++;
      }
      if (close !== -1) { j = close; continue; }
      j = k;
      continue;
    }
    if (c === 60) {
      const raw = tryRawHtml(s, j, n);
      if (raw) { j = raw.next; continue; }
      const auto = tryAngleAutolink(s, j, n);
      if (auto) { j = auto.next; continue; }
      j++;
      continue;
    }
    if (c === 91) { depth++; j++; continue; }
    if (c === 93) { depth--; if (depth === 0) return j; j++; continue; }
    j++;
  }
  return -1;
}

// Find the ')' matching the '(' at s[i] (paren depth counting, skipping
// backslash escapes, quoted strings and <...> angle groups). -1 if none.
function findParenClose(s, i, n) {
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) { depth--; if (depth === 0) return j; j++; continue; }
    if (c === 34 || c === 39) {
      const q = c; j++;
      while (j < n && s.charCodeAt(j) !== q) { if (s.charCodeAt(j) === 92) j++; j++; }
      if (j < n) j++;
      continue;
    }
    if (c === 60) {
      j++;
      while (j < n && s.charCodeAt(j) !== 62) { if (s.charCodeAt(j) === 92) j++; j++; }
      if (j < n) j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Is there a 2+-backtick code span whose content contains a backtick
// inside src[from, to)? Equal-length pairing; spans are consumed.
function hasUncleanCodeSpan(src, from, to) {
  let i = from;
  while (i < to) {
    if (src.charCodeAt(i) !== 96) { i++; continue; }
    let k = i;
    while (k < to && src.charCodeAt(k) === 96) k++;
    const len = k - i;
    if (len < 2) { i = k; continue; }
    let m = k;
    let close = -1;
    while (m < to) {
      if (src.charCodeAt(m) === 96) {
        let e = m;
        while (e < to && src.charCodeAt(e) === 96) e++;
        if (e - m === len) { close = m; break; }
        m = e;
      } else m++;
    }
    if (close !== -1) {
      for (let p = k; p < close; p++) {
        if (src.charCodeAt(p) === 96) return true;
      }
      i = close + len;
    } else i = k;
  }
  return false;
}
function parseInline(src, defs, out, noAuto, state) {
  const n = src.length;
  const delims = [];
  // Rule A: phantom code spans over the whole paragraph (computed once
  // when a trigger link/image is found). Rule B: regions [start, end)
  // of unformed inline-link brackets followed by a closed paren group.
  let phantoms = null;
  const ruleBRegions = [];
  let i = 0;
  let textStart = 0; // start of the current un-emitted text run
  const flushText = (end) => {
    if (end > textStart) {
      const prevChar = textStart > 0 ? src[textStart - 1] : '';
      emitTextRun(src, textStart, end, prevChar, defs, out, noAuto);
    }
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c < 128 && !SPECIAL[c]) { i++; continue; }
    if (c === 96) { // backtick: code span
      flushText(i);
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const len = j - i;
      // find a matching run of exactly len backticks
      let m = j, found = -1;
      while (m < n) {
        if (src.charCodeAt(m) === 96) {
          let e = m;
          while (e < n && src.charCodeAt(e) === 96) e++;
          if (e - m === len) { found = m; break; }
          m = e;
        } else m++;
      }
      if (found === -1) {
        // literal backticks
        out.push(src.slice(i, j));
        i = j; textStart = i;
        continue;
      }
      let content = src.slice(j, found);
      // line endings become spaces; strip one leading/trailing space
      if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      out.push('<code>');
      escapeEncode(content, out);
      out.push('</code>');
      i = found + len; textStart = i;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~ : delimiter run
      // a '_' inside an email local part, or any of these inside a bare
      // URL, is plain text, not a delimiter
      if (c === 95 && (underscoreInEmail(src, i, n) || underscoreInEmailDomain(src, i, n))) { i++; continue; }
      if (delimInUrl(src, i, n)) { i++; continue; }
      flushText(i);
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const len = j - i;
      const before = i > 0 ? src[i - 1] : '';
      const after = j < n ? src[j] : '';
      const [left, right] = flanking(before, after);
      const ch = String.fromCharCode(c);
      let canOpen, canClose;
      if (ch === '*') { canOpen = left; canClose = right; }
      else if (ch === '_') {
        canOpen = left && (!right || isUnicodePunct(before));
        canClose = right && (!left || isUnicodePunct(after));
      } else { // '~'
        canOpen = left; canClose = right;
      }
      out.push(src.slice(i, j));
      // A run that can neither open nor close can never form emphasis
      // (e.g. '_' inside snake_case) -- do not record it at all. This
      // skips most delimiter allocations in README prose.
      if (canOpen || canClose) {
        delims.push({ ch, len, origLen: len, open: canOpen, close: canClose, idx: out.length - 1, prev: before, next: after, pos: i });
      }
      i = j; textStart = i;
      continue;
    }
    if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) { // '[' or '!['
      const isImage = c === 33;
      // NOTE: marked's inLink does NOT block bracket-links -- its link
      // tokenizer has no inLink check (De only uses inLink to detect a
      // nested link inside the link's own text). Only the bare-URL
      // autolink (url tokenizer) is gated on !inLink (doc-33).
      const res = tryLink(src, i, n, defs, isImage);
      if (res) {
        if (state && !isImage) state.bracketLink = true;
        // Rule A: a formed INLINE link/image whose text is a trigger
        // computes the phantom code spans for this paragraph once.
        if (res.inline && res.text !== undefined && phantoms === null && linkTextTrigger(res.text)) {
          phantoms = codeSpanRegions(src);
        }
        flushText(i);
        out.push(res.html);
        i = res.next; textStart = i;
        continue;
      }
      // Rule B: an unformed link whose brackets are immediately
      // followed by a closed paren group -- record the region so
      // emphasis inside it can be suppressed (only the emphasis that
      // wraps an unclean 2+ code span is actually suppressed).
      {
        const open = isImage ? i + 1 : i;
        const bc = findBracketCloseLenient(src, open, n);
        if (bc !== -1 && bc + 1 < n && src.charCodeAt(bc + 1) === 40) {
          const pc = findParenClose(src, bc + 1, n);
          if (pc !== -1) ruleBRegions.push([open, pc + 1]);
        }
      }
      // not a link: the '[' (or '!') is literal text
      i += 1;
      continue;
    }
    if (c === 60) { // '<': autolink or raw HTML
      const auto = tryAngleAutolink(src, i, n);
      if (auto) {
        flushText(i);
        out.push(auto.html);
        i = auto.next; textStart = i;
        continue;
      }
      const html = tryRawHtml(src, i, n);
      if (html) {
        // Flush the text run BEFORE the tag first: the tag's inLink
        // effect only applies to text AFTER it (a URL before an <a>
        // tag still autolinks; doc-13 regression).
        flushText(i);
        // <a ...> (incl. self-closing <a />) opens the link scope;
        // </a> closes it (marked's tag tokenizer state.inLink)
        const tag = html.html;
        if (tag.length >= 2 && tag.charCodeAt(0) === 60) {
          if (tag.charCodeAt(1) === 97 || tag.charCodeAt(1) === 65) {
            // marked's startATag is /^<a(?:\s[^>]*?)?>/ : after <a must
            // come '>' or whitespace. <a/> (no space) is NOT an <a> tag
            // and does NOT set inLink (doc-04 regression).
            const c2 = tag.length > 2 ? tag.charCodeAt(2) : 0;
            if (c2 === 62 || c2 === 32 || c2 === 9 || c2 === 10) inLink = true;
          } else if (tag.charCodeAt(1) === 47 && tag.length >= 3 && (tag.charCodeAt(2) === 97 || tag.charCodeAt(2) === 65)) {
            const c3 = tag.length > 3 ? tag.charCodeAt(3) : 0;
            if (c3 === 62 || c3 === 32 || c3 === 9 || c3 === 10) inLink = false;
          }
        }
        out.push(html.html);
        i = html.next; textStart = i;
        continue;
      }
      i++; // literal '<', escaped by flushText
      continue;
    }
    if (c === 38) { // '&': handled inside flushText (entity or &amp;)
      i++;
      continue;
    }
    if (c === 92) { // backslash
      if (i + 1 < n) {
        const nch = src.charCodeAt(i + 1);
        // a backslash that is the trailing char of a bare URL is part
        // of the URL, not a hard break / escape -- leave it in the text
        // run so emitTextRun links the whole URL (with %5C)
        if (!backslashInUrl(src, textStart, i, n)) {
          if (nch === 10) { // backslash + newline = hard break
            flushText(i);
            out.push('<br>');
            i += 2;
            while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
            textStart = i;
            continue;
          }
          if (nch < 128 && isPunct(nch)) {
            flushText(i);
            // the escaped char is literal text (still HTML-escaped)
            escapeText(src[i + 1], out);
            i += 2; textStart = i;
            continue;
          }
        }
      }
      i++; // literal backslash
      continue;
    }
    if (c === 10) { // newline: soft break, or hard break (2+ spaces before)
      // count trailing spaces in the pending text run
      let sp = 0, k = i - 1;
      while (k >= textStart && src.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        flushText(i - sp);
        out.push('<br>');
        i++;
        // after a hard break the next line's leading whitespace is stripped
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else {
        flushText(i);
        out.push('\n');
        i++;
      }
      textStart = i;
      continue;
    }
    // any other char (incl. non-ASCII): part of the text run
    i++;
  }
  flushText(n);
  if (delims.length > 0) processEmphasis(delims, out, src, phantoms, ruleBRegions);
}

// ---------------------------------------------------------------------------
// Block parsing (column-tracked)
// ---------------------------------------------------------------------------
// A tab advances to the next multiple of 4. When indentation is consumed,
// a tab that straddles the target leaves spaces (a "partial tab"). All
// indent math below is in visual columns, and content strings carry the
// column at which they start so tab widths inside them are exact.

// Indent (columns of leading whitespace) of string s whose first char is
// at visual column startCol.
function indentOf(s, startCol) {
  let col = startCol, i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - startCol;
}

// Count leading whitespace characters (space/tab, each 1 char) in s.
function countLeadingWS(s) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i;
}

// Remove up to k leading whitespace characters. Marked's fenced-code
// dedent (Dt) is character-based: a tab counts as ONE character, not an
// expanded tab stop -- so a tab at the fence indent is removed whole,
// not left as remainder spaces.
function stripLeadingWSChars(s, k) {
  let i = 0;
  while (i < s.length && i < k && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return s.slice(i);
}

// String s (first char at column startCol) after removing k columns of
// indentation. A straddling tab leaves spaces. Returns null when s has
// less than k columns of indentation.
// Strip up to k columns of leading whitespace (never null: a line with
// less indent just loses what it has). Used for fenced code lines.
function stripUpTo(s, startCol, k) {
  let col = startCol, i = 0;
  const n = s.length;
  while (col - startCol < k && i < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const nx = col + (4 - (col % 4));
      if (nx - startCol > k) return ' '.repeat(nx - (startCol + k)) + s.slice(i + 1);
      col = nx; i++;
    } else break;
  }
  return s.slice(i);
}
// Remove the first k columns of string s (first char at column
// startCol), whatever they are (whitespace or marker characters). A
// straddling tab leaves spaces. Returns null when s is shorter than k
// columns. Unlike stripIndent, this does not stop at non-whitespace.
function sliceCols(s, startCol, k) {
  let col = startCol, i = 0;
  const n = s.length;
  while (col - startCol < k && i < n) {
    const c = s.charCodeAt(i);
    if (c === 9) {
      const nx = col + (4 - (col % 4));
      if (nx - startCol > k) return ' '.repeat(nx - (startCol + k)) + s.slice(i + 1);
      col = nx; i++;
    } else { col++; i++; }
  }
  if (col - startCol < k) return null;
  return s.slice(i);
}

function stripIndent(s, startCol, k) {
  let col = startCol, i = 0;
  const n = s.length;
  while (col - startCol < k && i < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const nx = col + (4 - (col % 4));
      if (nx - startCol > k) return ' '.repeat(nx - (startCol + k)) + s.slice(i + 1);
      col = nx; i++;
    } else break;
  }
  if (col - startCol < k) return null;
  return s.slice(i);
}

// Is the rest of the line (from pos) blank (only spaces/tabs)?
function restIsBlank(line, pos) {
  for (let i = pos; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Is the string blank (only spaces/tabs)?
// True when s is empty or consists only of spaces (no tabs). This is
// marked's notion of a "blank" line for its space/newline regex
// /^(?: *(?:\n|$))+/ -- a tab-only line is NOT blank there.
function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 32) return false;
  }
  return true;
}

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Advance (pos, col) over the line's whitespace up to targetCol. Returns
// [pos, col, pad] (pad = spaces from a straddling tab) or null when a
// non-space is hit or the line ends before targetCol.
function advanceCols(line, pos, col, targetCol) {
  let p = pos, c = col, pad = 0;
  while (c < targetCol && p < line.length) {
    const ch = line.charCodeAt(p);
    if (ch === 32) { p++; c++; }
    else if (ch === 9) {
      const nx = c + (4 - (c % 4));
      if (nx > targetCol) { pad = nx - targetCol; p++; c = nx; break; }
      p++; c = nx;
    } else return null;
  }
  if (c < targetCol) return null;
  // a tab exactly at the target column is entirely beyond the stripped
  // indent: expand it to spaces (it is leading whitespace of the content).
  // Only when no straddling tab already set a pad.
  if (pad === 0 && p < line.length && line.charCodeAt(p) === 9) {
    const nx = c + (4 - (c % 4));
    pad = nx - c;
    p++; c = nx;
  }
  return [p, c, pad];
}

// Match a list marker in string s (s starts at the marker; baseCol is the
// visual column of s[0]). CommonMark 5.2: N = total whitespace columns
// after the marker. N==0 -> not a list item. N>=5 -> content indent is
// W+1 (rule #2, indented-code content). 1<=N<=4 -> content indent W+N.
// An item with no content after the marker is empty (indent W+1).
function matchListMarker(s, baseCol) {
  if (s.length === 0) return null;
  const c0 = s.charCodeAt(0);
  let ordered = false, start = 0, markerLen = 0;
  if (c0 === 42 || c0 === 43 || c0 === 45) {
    markerLen = 1;
  } else if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < s.length && j < 9 && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j === 0 || j >= s.length) return null;
    const d = s.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    const num = parseInt(s.slice(0, j), 10);
    if (num > 999999999) return null;
    ordered = true; start = num; markerLen = j + 1;
  } else return null;
  // whitespace after the marker (columns, tabs to next multiple of 4)
  let col = baseCol + markerLen, j = markerLen, n = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32) { n++; col++; j++; }
    else if (c === 9) { const nx = col + (4 - (col % 4)); n += nx - col; col = nx; j++; }
    else break;
  }
  // a marker with no whitespace after it is not a list item -- unless
  // it is at the end of the line (an empty item)
  if (n === 0 && j < s.length) return null;
  const empty = j >= s.length;
  if (empty) return { ordered, bullet: s[0], start, markerLen, contentIndent: baseCol + markerLen + 1, empty: true };
  if (n >= 5) return { ordered, bullet: s[0], start, markerLen, contentIndent: baseCol + markerLen + 1, empty: false };
  return { ordered, bullet: s[0], start, markerLen, contentIndent: baseCol + markerLen + n, empty: false };
}

// Fenced code start. Returns {ch, len, lang} or null. The fence must be at
// indent < 4 (the caller passes the content after container stripping, and
// its column). `info` is the info string (trimmed).
function matchFence(s, col) {
  const ind = indentOf(s, col);
  if (ind >= 4) return null;
  const t = s.slice(ind);
  if (t.length < 3) return null;
  const ch = t.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (len < t.length && t.charCodeAt(len) === ch) len++;
  if (len < 3) return null;
  let info = t.slice(len);
  // backtick fences may not contain backticks in the info string
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  info = info.trim();
  // the language is the first word of the info string; backslash
  // escapes are processed in it (foo\+bar -> foo+bar)
  let lang = '';
  if (info.length > 0) {
    const sp = info.search(/[ \t]/);
    lang = sp === -1 ? info : info.slice(0, sp);
    if (lang.indexOf('\\') !== -1) {
      lang = lang.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    }
  }
  return { ch: String.fromCharCode(ch), len, lang, info };
}
// Fenced code closing line: same char, length >= openLen, only spaces after.
function matchFenceClose(s, col, ch, openLen) {
  const ind = indentOf(s, col);
  if (ind >= 4) return false;
  const t = s.slice(ind);
  let len = 0;
  while (len < t.length && t.charCodeAt(len) === ch.charCodeAt(0)) len++;
  if (len < openLen) return false;
  return isBlankStr(t.slice(len));
}

// ATX heading: 1-6 '#' followed by space/EOL. Returns {level, text} or null.
function matchATX(s, col) {
  const ind = indentOf(s, col);
  if (ind >= 4) return null;
  const t = s.slice(ind);
  let level = 0;
  while (level < t.length && level < 6 && t.charCodeAt(level) === 35) level++;
  if (level === 0) return null;
  if (level < t.length && t.charCodeAt(level) !== 32 && t.charCodeAt(level) !== 9) return null;
  let text = t.slice(level).trim();
  // closing sequence of #'s (preceded by a space, and only #'s + spaces)
  if (text.length > 0) {
    const m = text.match(/^(.*?)[ \t]+#+[ \t]*$/);
    if (m) text = m[1].trim();
    else if (/^#+$/.test(text) && t.slice(level).trim().length > 0 && /^[ \t]/.test(t.slice(level))) {
      // the whole thing is a closing sequence (e.g. "## ##")
      text = '';
    }
  }
  return { level, text };
}

// Setext underline: only '=' (level 1) or '-' (level 2) + spaces/tabs.
function matchSetext(s, col) {
  const ind = indentOf(s, col);
  if (ind >= 4) return 0;
  const t = s.slice(ind);
  let i = 0;
  while (i < t.length && (t.charCodeAt(i) === 32 || t.charCodeAt(i) === 9)) i++;
  if (i >= t.length) return 0;
  const c = t.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  // the underline is a run of ONLY '=' or '-' (no spaces mixed in),
  // then only spaces/tabs to end of line
  let j = i;
  while (j < t.length && t.charCodeAt(j) === c) j++;
  while (j < t.length && (t.charCodeAt(j) === 32 || t.charCodeAt(j) === 9)) j++;
  if (j < t.length) return 0;
  return c === 61 ? 1 : 2;
}

// Thematic break: 3+ of -, _, * with only spaces/tabs between.
function matchHR(s, col) {
  const ind = indentOf(s, col);
  if (ind >= 4) return false;
  const t = s.slice(ind);
  let ch = 0, count = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 32 || c === 9) continue;
    if (c === 45 || c === 95 || c === 42) {
      if (ch === 0) ch = c;
      else if (ch !== c) return false;
      count++;
    } else return false;
  }
  return count >= 3;
}

// HTML block start. Returns the type (1-7) or 0. Types 1-6 may interrupt
// a paragraph; type 7 may not.
const HTML_BLOCK_TAGS = new Set(['address','article','aside','base','basefont','blockquote','body','caption','center','col','colgroup','dd','details','dialog','dir','div','dl','dt','fieldset','figcaption','figure','footer','form','frame','frameset','h1','h2','h3','h4','h5','h6','head','header','hr','html','iframe','legend','li','link','main','menu','menuitem','nav','noframes','ol','optgroup','option','p','param','section','source','summary','table','tbody','td','tfoot','th','thead','title','tr','track','ul']);
function matchHtmlBlock(s, col) {
  const ind = indentOf(s, col);
  if (ind >= 4) return 0;
  const t = s.slice(ind);
  if (t.charCodeAt(0) !== 60) return 0; // '<'
  const lower = t.toLowerCase();
  // type 1: pre/script/style/textarea -- the char after the tag name
  // must be whitespace, '>', or end of line
  const type1Tags = ['<pre', '<script', '<style', '<textarea'];
  for (const tag of type1Tags) {
    if (lower.startsWith(tag)) {
      const c = t.charAt(tag.length);
      if (c === '' || c === ' ' || c === '\t' || c === '\n' || c === '>') return 1;
      break;
    }
  }
  if (t.startsWith('<!--')) return 2;
  if (t.startsWith('<?')) return 3;
  if (t.startsWith('<!')) {
    const c = t.charAt(2);
    if (c !== '' && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) return 4;
  }
  if (t.startsWith('<![CDATA[')) return 5;
  // open/close tag of a block-level element
  let j = 1, closing = false;
  if (t.charCodeAt(j) === 47) { closing = true; j++; }
  let name = '';
  while (j < t.length && /[A-Za-z0-9-]/.test(t[j])) { name += t[j]; j++; }
  if (name.length > 0) {
    if (HTML_BLOCK_TAGS.has(name.toLowerCase())) return 6;
    // type 7: a complete open/close tag on its own line -- nothing
    // but whitespace may follow the closing '>'. The char right after
    // the tag name must be whitespace, '/', or '>' (so <http://x> is
    // an autolink, not a tag). The tag itself must be well-formed
    // (validated by tryRawHtml, the same check inline parsing uses).
    const afterName = t.charAt(j);
    if (afterName !== '' && afterName !== ' ' && afterName !== '\t' && afterName !== '/' && afterName !== '>') return 0;
    const raw = tryRawHtml(t, 0, t.length);
    if (raw && t.slice(raw.next).trim() === '') return 7;
  }
  return 0;
}

// Is a list tight? A list is loose when any of its items is separated
// from the next by a blank line, or ends with two blank lines (i.e. any
// item other than the last ends with a blank line, or any item contains
// two block children separated by a blank line).
function computeTight(list) {
  if (list.loose) return false;
  for (let i = 0; i < list.children.length; i++) {
    const item = list.children[i];
    if (item.endsWithBlank && i < list.children.length - 1) return false;
    if (item.hasBlankBetween) return false;
  }
  return true;
}

// Parse one link reference definition starting at text[i] (the '[').
// Returns {label, dest, title, end} or null. The label is normalised.
function parseRefDef(text, i, n) {
  // label: [ ... ] (may span lines; brackets nest, backslash escapes)
  const close = findClosingBracket(text, i, n);
  if (close === -1) return null;
  const rawLabel = text.slice(i + 1, close);
  if (rawLabel.length === 0) return null;
  // a label may not contain an unescaped '['
  if (hasUnescapedBracket(rawLabel)) return null;
  const label = normalizeLabel(rawLabel);
  if (label.length === 0) return null;
  let j = close + 1;
  // ':' then whitespace (incl. newlines, but at most one blank line is
  // not allowed -- a blank line ends the def)
  if (j >= n || text.charCodeAt(j) !== 58) return null;
  j++;
  let k = j;
  // skip spaces/tabs/newlines, but no blank line (two newlines)
  let newlines = 0;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (c === 32 || c === 9) { k++; continue; }
    if (c === 10) { newlines++; if (newlines > 1) return null; k++; continue; }
    break;
  }
  if (k >= n) return null;
  const d = parseDestination(text, k, n);
  if (!d) return null;
  let dest = d.dest, end = d.next;
  // optional title on the same line or the next line
  let title = null;
  let m = end;
  let nl = 0;
  while (m < n) {
    const c = text.charCodeAt(m);
    if (c === 32 || c === 9) { m++; continue; }
    if (c === 10) { nl++; if (nl > 1) break; m++; continue; }
    break;
  }
  // a title must be preceded by whitespace (space/tab/newline)
  if (m > end && m < n && nl <= 1 && (text.charCodeAt(m) === 34 || text.charCodeAt(m) === 39 || text.charCodeAt(m) === 40)) {
    const t = parseTitle(text, m, n);
    if (t) { title = t.title; end = t.next; }
  }
  // after the def, only whitespace then EOL/EOF
  let e = end;
  while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
  if (e < n && text.charCodeAt(e) !== 10) {
    // a malformed title does not kill the def: retry without it
    // (the title line stays as paragraph text)
    if (title !== null) {
      title = null;
      e = d.next;
      while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
      if (e < n && text.charCodeAt(e) !== 10) return null;
      end = e;
    } else {
      return null;
    }
  }
  // the def ends at the newline (or EOF)
  if (e < n) e++;
  return { label, dest, title, end: e };
}

// Extract leading link reference definitions from a paragraph's joined
// text. Adds them to defs (first definition wins). Returns the remaining
// text ('' when the paragraph was only definitions).
function extractRefDefs(text, defs) {
  let i = 0;
  const n = text.length;
  // skip up to 3 spaces of indent before a def
  while (i < n) {
    let j = i, spaces = 0;
    while (j < n && text.charCodeAt(j) === 32) { spaces++; j++; }
    if (spaces > 3) break;
    if (j >= n || text.charCodeAt(j) !== 91) break; // '['
    const def = parseRefDef(text, j, n);
    if (!def) break;
    if (!defs.has(def.label)) defs.set(def.label, { dest: def.dest, title: def.title });
    i = def.end;
  }
  return text.slice(i);
}

// Split a table row line into cells. `|` inside code spans or escaped
// (\|) does not split. Leading/trailing pipes are dropped; cells are
// trimmed.
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const n = line.length;
  // skip a leading pipe
  let start = 0;
  while (start < n && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  if (start < n && line.charCodeAt(start) === 124) start++;
  i = start;
  // Marked's splitCells splits on EVERY unescaped pipe, code spans
  // included (a `|` inside a code span breaks the table, so it is not
  // protected here). A pipe is escaped iff preceded by an odd number
  // of backslashes.
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 124) {
      let bs = 0, p = i - 1;
      while (p >= 0 && line.charCodeAt(p) === 92) { bs++; p--; }
      if (bs % 2 === 1) {
        // escaped pipe: drop one backslash, keep the pipe literally
        cur = cur.slice(0, cur.length - 1) + '|';
        i++;
        continue;
      }
      cells.push(cur.trim()); cur = ''; i++; continue;
    }
    cur += line[i]; i++;
  }
  // trailing cell (drop it when the line ends with a pipe and the last
  // cell is empty because of it)
  const last = cur.trim();
  if (last.length > 0 || cells.length === 0) cells.push(last);
  // if the line ends with a pipe, the final empty segment is dropped
  return cells;
}

// Is `line` a valid table delimiter row? Returns the alignments
// ('left'|'right'|'center'|null per column) or null.
function parseTableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    const left = t.charCodeAt(0) === 58, right = t.charCodeAt(t.length - 1) === 58;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Try to interpret a paragraph (array of lines) as a GFM table. Returns a
// table node or null. The first line is the header, the second must be a
// delimiter row.
function tryTable(paraLines) {
  if (paraLines.length < 2) return null;
  // the delimiter row must be indented less than 4 columns
  if (indentOf(paraLines[1], 0) >= 4) return null;
  const aligns = parseTableDelimiter(paraLines[1]);
  if (!aligns) return null;
  const header = splitTableRow(paraLines[0]);
  if (header.length === 0) return null;
  // the delimiter row must have exactly as many cells as the header
  if (aligns.length !== header.length) return null;
  const ncols = aligns.length;
  const rows = [];
  for (let i = 2; i < paraLines.length; i++) {
    if (isBlankStr(paraLines[i])) {
      // a tab-only line is an empty row (see the main loop); a
      // spaces-only / empty line is skipped
      if (paraLines[i].indexOf('\t') !== -1) {
        rows.push(new Array(ncols).fill(''));
      }
      continue;
    }
    const cells = splitTableRow(paraLines[i]);
    while (cells.length < ncols) cells.push('');
    if (cells.length > ncols) cells.length = ncols;
    rows.push(cells);
  }
  return { type: 'table', header, aligns, rows };
}

// Does the blank line at lines[ln] keep the HTML block's trailing
// newline by ending its container? Only when the block's parent is a
// BLOCKQUOTE: the line must be container-marker only (raw line
// non-empty but strips to empty, e.g. '>' inside a blockquote), it must
// be the ONLY blank line, and the blockquote must end after it (EOF, or
// the next line does not belong to the blockquote). A truly empty line
// never qualifies; two blank lines in a row do not either. (Inside a
// list item the item's content never ends with a newline unless the
// list continues -- handled by listContinuesAfterBlank.)
function singleMarkerBlankEndsContainer(lines, ln, stack) {
  if (stack[stack.length - 1].type !== 'blockquote') return false;
  const raw = lines[ln];
  if (raw.length === 0) return false;
  const stripped = stripContainersForLine(raw, stack);
  if (!stripped || stripped.text.length !== 0) return false;
  const nxt = ln + 1;
  if (nxt >= lines.length) return true;
  const s2 = stripContainersForLine(lines[nxt], stack);
  if (s2 === null) return true; // next line is outside the container
  if (isBlankStr(s2.text)) return false; // a second blank line
  return false; // the container continues with a non-blank line
}

// Does the list containing this HTML block continue after the blank
// line(s) starting at lines[ln]? A blank line after an HTML block keeps
// the block's trailing newline only when the blank line belongs to a
// list item's content -- i.e. another item of the SAME list follows
// after the blank line(s) (marked tokenizes the item's text, and the
// blank line joined into it yields the trailing newline). If the list
// ends at the blank line (or there is no list), the newline is stripped.
function listContinuesAfterBlank(lines, ln, stack) {
  // nearest list in the stack
  let listIdx = -1, list = null;
  for (let si = stack.length - 1; si >= 1; si--) {
    if (stack[si].type === 'list') { listIdx = si; list = stack[si]; break; }
  }
  if (!list) return false;
  // skip the blank lines
  let ln2 = ln;
  while (ln2 < lines.length && isBlankStr(lines[ln2])) ln2++;
  if (ln2 >= lines.length) return false;
  // strip the containers above the list (excluding the item and anything
  // below the list) and check for a marker of the same list
  const stripped = stripContainersForLine(lines[ln2], stack.slice(0, listIdx + 1));
  if (!stripped) return false;
  const ind = indentOf(stripped.text, stripped.col);
  const marker = matchListMarker(stripped.text.slice(ind), stripped.col + ind);
  if (!marker) return false;
  if (marker.ordered !== list.ordered) return false;
  if (marker.ordered) {
    const delim = stripped.text.slice(ind + marker.markerLen - 1, ind + marker.markerLen);
    if (delim !== list.delimiter) return false;
  } else if (marker.bullet !== list.delimiter) return false;
  return true;
}

// Finalise a paragraph node: extract link reference definitions, detect a
// table, and either drop the node, replace it with a table, or set its
// text. Returns the node to keep (paragraph/table) or null.
function finalizeParagraph(node, parent, defs) {
  const text = node.lines.join('\n');
  const rest = extractRefDefs(text, defs);
  if (rest.trim() === '') {
    // only definitions: drop the paragraph
    const idx = parent.children.indexOf(node);
    if (idx !== -1) parent.children.splice(idx, 1);
    return null;
  }
  // table? (needs at least 2 lines in the original paragraph)
  const restLines = rest.split('\n');
  // the table check uses the ORIGINAL lines (defs may have consumed some)
  const table = tryTable(node.lines);
  if (table) {
    const idx = parent.children.indexOf(node);
    if (idx !== -1) parent.children[idx] = table;
    return table;
  }
  node.text = rest;
  delete node.lines;
  return node;
}

// The main block parser. `lines` is an array of raw lines (no trailing
// newline). Returns the document node.
// Does this line start a block that can interrupt a paragraph?
// (Used to decide whether a non-matching line is a lazy continuation.)
function canInterruptPara(content, contentCol) {
  const ind = indentOf(content, contentCol);
  if (ind < 4) {
    // blockquote
    let p = 0;
    while (p < content.length && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
    if (p < content.length && content.charCodeAt(p) === 62) return true;
    // list item
    if (matchListMarker(content.slice(ind), contentCol + ind)) return true;
  }
  if (matchATX(content, contentCol)) return true;
  if (matchFence(content, contentCol)) return true;
  if (matchHR(content, contentCol)) return true;
  if (matchSetext(content, contentCol)) return true;
  const ht = matchHtmlBlock(content, contentCol);
  if (ht > 0 && ht <= 6) return true;
  return false;
}

function parseBlocks(lines, defs, srcEndsWithNL) {
  const doc = { type: 'document', children: [] };
  const stack = [doc];
  let openPara = null;
  let openParaParent = null;
  let openParaDepth = 0; // stack length when the paragraph was created
  let lastLineBlank = false;
  let lastLineLazy = false; // the previous line was appended as a lazy
  // continuation (used for the blockquote setext rule below)
  let lastBlankTop = ''; // type of the innermost container when the last
  // blank line was seen ('item'/'list' = a blank line in list structure;
  // 'blockquote' etc. = contained inside a nested block, does not make
  // an outer list loose)
  let lastBlankHasQuote = false; // the last blank line carried a '>'
  // marker (a blank line OF a blockquote, inside it -- tight) as opposed
  // to a plain blank line (between two blocks in the item -- loose)

  const top = () => stack[stack.length - 1];
  const closePara = () => {
    if (openPara) {
      finalizeParagraph(openPara, openParaParent, defs);
      openPara = null;
      openParaParent = null;
    }
  };
  // Close containers down to `depth` (stack length). Finalises paragraphs.
  const closeTo = (depth) => {
    closePara();
    while (stack.length > depth) stack.pop();
  };
  // A blank line between two blocks inside one list item makes the list
  // loose. Call when a new block starts after a blank line.
  const markLooseIfBlank = () => {
    if (!lastLineBlank) return;
    // only when the item already has a block (a first block after a
    // blank line does not make the list loose)
    const t = top();
    if (t.type === 'item' && t.children.length === 0) return;
    for (let si = stack.length - 1; si >= 1; si--) {
      if (stack[si].type === 'list') {
        // a blank line contained inside a nested block (e.g. a blockquote
        // within the item) does not make the list loose -- but only when
        // the blank line itself is a line OF that block (it carries the
        // block's marker, e.g. '>' for a quote). A plain blank line
        // (no marker) that ends the block is between two blocks in the
        // item and makes the list loose (doc-19).
        if (lastBlankTop !== 'item' && lastBlankTop !== 'list' && lastBlankHasQuote) return;
        stack[si].loose = true; return;
      }
      if (stack[si].type === 'item') continue;
      return;
    }
  };

  for (let ln = 0; ln < lines.length; ln++) {
    const rawLine = lines[ln];
    const prevLineLazy = lastLineLazy;
    lastLineLazy = false;
    // ---------- Phase 1: match open containers ----------
    let pos = 0, col = 0, pad = 0;
    let matched = 1; // stack depth matched (1 = document only)
    const lineIsBlank = isBlankStr(rawLine);
    for (let si = 1; si < stack.length; si++) {
      const cont = stack[si];
      if (cont.type === 'blockquote') {
        // up to 3 spaces, then '>', then 1 optional space
        let p = pos, c = col, sp = 0;
        while (p < rawLine.length && sp < 3 && rawLine.charCodeAt(p) === 32) { p++; c++; sp++; }
        if (p < rawLine.length && rawLine.charCodeAt(p) === 62) {
          // virtual column of '>' in the line at this level (outer
          // markers already stripped: pad spaces precede it)
          const vgt = pad + (p - pos);
          p++; c++;
          // Expand the whitespace after '>' (marked's J): tabs expand to
          // the next tab stop counting from the column after '>' (vgt+1);
          // the first expanded space is the marker's optional space and
          // is dropped. Only a run containing a tab is consumed into
          // pad; a spaces-only run consumes one space (the marker's
          // optional space), the rest staying in the raw slice.
          let q = p, vq = vgt + 1, exp = 0, hasTab = false;
          while (q < rawLine.length) {
            const ch = rawLine.charCodeAt(q);
            if (ch === 32) { exp++; vq++; q++; }
            else if (ch === 9) { hasTab = true; const w = 4 - (vq % 4); exp += w; vq += w; q++; }
            else break;
          }
          if (hasTab) {
            pad = exp > 0 ? exp - 1 : 0;
            c = vq; // the next char is at the expanded column
            p = q;
          } else if (q > p) {
            p++; c++;
            // the pad spaces before '>' belong to the container
            // prefix, not the content -- drop them (a tab-overshoot
            // pad from an outer item would otherwise leak a leading
            // space into the blockquote's content)
            pad = 0;
          } else {
            pad = 0;
          }
          pos = p; col = c;
          matched = si + 1;
          // A line blank after the marker (e.g. a lone '>') is blank
          // for every inner container EXCEPT an inner blockquote: a
          // nested blockquote needs its own '>' marker, so a lone '>'
          // closes it (doc-14: `> > ...` then `>` then `> > ...`
          // starts a NEW inner blockquote). Lists and items stay open
          // (CommonMark: blank lines match any container but a
          // blockquote marker is required for a nested blockquote).
          if (restIsBlank(rawLine, pos)) {
            matched = stack.length;
            for (let sj = si + 1; sj < stack.length; sj++) {
              if (stack[sj].type === 'blockquote') { matched = sj; break; }
            }
            break;
          }
          continue;
        }
        break;
      }
      if (cont.type === 'item') {
        if (lineIsBlank) { matched = si + 1; continue; }
        // an empty item followed by a blank line is closed: later
        // indented lines do not belong to it
        if (cont.children.length === 0 && lastLineBlank) break;
        // the item's content indent is RELATIVE to the container's
        // content start on this line (col - pad): a blockquote prefix
        // is a different width on different lines, so an absolute
        // column would misalign continuation lines (cm-259)
        const target = (col - pad) + cont.relIndent;
        if (target <= col) {
          // pad (virtual spaces from a tab expansion in an outer
          // container) may overlap the item's indent: the first
          // relIndent pad spaces are the item's indent, not content
          if (pad > 0) pad -= Math.min(cont.relIndent, pad);
          matched = si + 1; continue;
        }
        const adv = advanceCols(rawLine, pos, col, target);
        if (!adv) break;
        pos = adv[0]; col = adv[1]; pad = adv[2];
        matched = si + 1;
        continue;
      }
      // 'list': transparent container. It matches only when the line
      // continues its current item (handled by the item entry below) or
      // starts a new item (a list marker here). Otherwise the list is
      // closed and the line belongs to the list's parent.
      {
        const next = stack[si + 1];
        if (next && next.type === 'item') {
          if (lineIsBlank) { matched = si + 2; si++; continue; }
          // a new item marker keeps the list open even after an empty
          // item + blank line (the empty item is closed, a new one
          // starts) -- check this before the empty-item close below.
          // A thematic break is NOT a new item (it closes the list).
          // Only when the line does NOT continue the current item
          // (a continuation line such as a setext underline must not
          // be mistaken for an HR / new item).
          {
            const target0 = (col - pad) + next.relIndent;
            const continues = target0 <= col || advanceCols(rawLine, pos, col, target0);
            if (!continues) {
            const rt = (pad > 0 ? ' '.repeat(pad) : '') + rawLine.slice(pos);
            const rc = col - pad;
            const ri = indentOf(rt, rc);
            if (ri < 4 && matchHR(rt.slice(ri), rc + ri)) break;
            if (ri < 4) {
              const mm = matchListMarker(rt.slice(ri), rc + ri);
              if (mm) {
                const dd = mm.ordered ? rt.slice(ri + mm.markerLen - 1, ri + mm.markerLen) : mm.bullet;
                if (mm.ordered === cont.ordered && dd === cont.delimiter) {
                  matched = si + 1;
                  continue;
                }
              }
            }
            } // !continues
          }
          // an empty item followed by a blank line is closed
          if (next.children.length === 0 && lastLineBlank) break;
          const target = (col - pad) + next.relIndent;
          if (target <= col) {
            // pad (virtual spaces from a tab expansion in an outer
            // container) may overlap the item's indent: the first
            // relIndent pad spaces are the item's indent, not content
            if (pad > 0) pad -= Math.min(next.relIndent, pad);
            matched = si + 2; si++; continue;
          }
          const adv = advanceCols(rawLine, pos, col, target);
          if (adv) {
            pos = adv[0]; col = adv[1]; pad = adv[2];
            matched = si + 2;
            si++; // item already matched; skip it next iteration
            continue;
          }
          // The item doesn't match: a new item marker keeps the list
          // open, but ONLY if it matches this list's type/delimiter.
          // A different marker type closes this list (a new sibling list
          // starts instead). A thematic break also closes the list
          // (it is checked before list items in block-start order).
          const restText = (pad > 0 ? ' '.repeat(pad) : '') + rawLine.slice(pos);
          const restCol = col - pad;
          const restInd = indentOf(restText, restCol);
          if (restInd < 4 && matchHR(restText.slice(restInd), restCol + restInd)) break;
          if (restInd < 4) {
            const m = matchListMarker(restText.slice(restInd), restCol + restInd);
            if (m) {
              const d = m.ordered ? restText.slice(restInd + m.markerLen - 1, restInd + m.markerLen) : m.bullet;
              if (m.ordered === cont.ordered && d === cont.delimiter) {
                matched = si + 1;
                continue;
              }
            }
          }
          break;
        }
        matched = si + 1;
      }
    }

    // content after the matched containers
    let content = (pad > 0 ? ' '.repeat(pad) : '') + rawLine.slice(pos);
    let contentCol = col - pad;
    // (the content string starts at column col-pad: the pad spaces occupy
    //  the columns before the sliced part)
    // Recompute: pad spaces are at columns col-pad .. col-1, and the slice
    // starts at col. So the string's first char is at col-pad.
    contentCol = col - pad;
    // A line is blank when, after container stripping, it is empty, or
    // whitespace-only AND the innermost matched container is not a
    // blockquote: whitespace left after a blockquote marker ('>' + one
    // optional space) is paragraph content, not a blank line (cm-241:
    // '>  ' contributes a single space to the paragraph), while a
    // whitespace-only line after a list-item indent is blank.
    const contentBlank = content === '' || (isBlankStr(content) && !(matched > 1 && stack[matched - 1].type === 'blockquote'));

    // ---------- lazy continuation ----------
    // (only when the line does NOT start a block that interrupts a paragraph)
    if (matched < stack.length && openPara && !contentBlank) {
      // A setext underline that is ONLY a setext underline (an '='
      // line, or a '-' line that is neither a thematic break nor a
      // list marker) cannot be a lazy heading underline: it stays
      // paragraph text. Inside a blockquote, when the previous line was
      // also lazy, it is indented 4 spaces (marked's
      // blockquoteSetextReplace) so it is not mistaken for a heading
      // when the paragraph is parsed; otherwise it is kept as-is. In a
      // list item it is always kept as-is.
      const stLazy = matchSetext(content, contentCol);
      const onlySetext = stLazy === 1 ||
        (stLazy === 2 && !matchHR(content, contentCol) && !matchListMarker(content.slice(indentOf(content, contentCol)), contentCol + indentOf(content, contentCol)));
      if (onlySetext) {
        const firstUnmatched = stack[matched];
        if (firstUnmatched && firstUnmatched.type === 'blockquote' && prevLineLazy) {
          openPara.lines.push('    ' + content.replace(/^[ \t]+/, ''));
        } else {
          openPara.lines.push(content);
        }
        lastLineBlank = false;
        lastLineLazy = true;
        continue;
      }
      if (!canInterruptPara(content, contentCol)) {
        // lazy continuation: the line belongs to the open paragraph even
        // though it does not match the paragraph's containers. The
        // containers stay open (do NOT pop them) so a later line that does
        // match them continues the same block; append this line to it.
        // A lazy line indented 4+ columns loses exactly 4 of them
        // (indented-code indent); fewer are kept as-is.
        let lazyContent = content;
        if (indentOf(content, contentCol) >= 4) {
          lazyContent = stripIndent(content, contentCol, 4);
        }
        openPara.lines.push(lazyContent);
        lastLineBlank = false;
        lastLineLazy = true;
        continue;
      }
    }
    if (matched < stack.length) {
      closeTo(matched);
    }

    // ---------- Phase 2: block start detection ----------
    let isListItemStart = false, listMarker = null;
    let handled = false;
    if (contentBlank) {
      // marked's table regex does not treat a tab-only line as blank
      // (its blank-line exclusion is ` *\n`, spaces only), so a tab
      // line inside a table is an empty row. If the open paragraph is
      // a table (header + delimiter), keep the tab line as one of its
      // lines instead of closing the paragraph.
      if (openPara && content.indexOf('\t') !== -1 && openPara.lines.length >= 2 && parseTableDelimiter(openPara.lines[1])) {
        openPara.lines.push(content);
        lastLineBlank = false;
        continue;
      }
      // blank line: close any open paragraph; it does not start a block
      // (any open blockquote/list stays open for later lines)
      // Rule: a blank line inside a blockquote followed by lines that
      // continue the quote does NOT end the quote. A blank line OUTSIDE
      // the quote (only the quote is open, no inner blocks) DOES end it
      // -- but the quote remains open for lazy continuation lines, so
      // closing happens only when a non-blank line that does not match
      // the quote follows. In marked, after the quote's LAST inner
      // block ends, a blank line means the quote itself is also closed
      // (it is the last open block); here we keep it open, which matches
      // marked when later lines re-open it via the quote marker.
      // A blank line inside a LIST ITEM: remember it, so a later item
      // knows the list is loose (and empty-item rules apply).
      if (openPara) {
        openPara.endsWithBlank = true;
        const t = top();
        if (t.type === 'item') t.endsWithBlank = true;
      }
      closePara();
      lastLineBlank = true;
      lastBlankTop = top().type;
      lastBlankHasQuote = rawLine.indexOf('>') !== -1;
      continue;
    }

    // setext underline for an open paragraph: the WHOLE paragraph
    // (all its lines) becomes the heading; leading whitespace at the
    // start of the text and trailing whitespace at the end are stripped.
    // EXCEPTION: when the open paragraph is a table (header + delimiter
    // already present), a setext underline is a table ROW, not a heading
    // -- marked's table-body regex does not exclude setext underlines
    // (doc-26: '=========' right after a table row is a row).
    if (openPara) {
      const st = matchSetext(content, contentCol);
      if (st > 0) {
        if (tryTable(openPara.lines)) {
          openPara.lines.push(content);
          lastLineBlank = false;
          continue;
        }
        const parent = openParaParent;
        const para = openPara;
        closePara(); // finalises: extracts ref defs, sets para.text
        const idx = parent.children.indexOf(para);
        if (idx !== -1 && para.text !== undefined) {
          parent.children[idx] = { type: 'heading', level: st, text: para.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') };
          lastLineBlank = false;
          continue;
        }
        // the paragraph was dropped (only ref defs) or became a table:
        // the underline is not a heading -- fall through and process
        // it as a fresh block
      }
    }

    // ---- indented code (paragraph has priority when one is open) ----
    if (!openPara) {
      const ind = indentOf(content, contentCol);
      if (ind >= 4) {
        const code = stripIndent(content, contentCol, 4);
        // An indented code block starts. If the previous sibling is a
        // paragraph, the code is a continuation of it (marked: an
        // indented code block cannot interrupt a paragraph). Since
        // openPara is null here, no paragraph is open -- but a paragraph
        // may have been closed by a blank line; only a paragraph that is
        // STILL open blocks. So start the code block.
        const parent = top();
        markLooseIfBlank();
        const node = { type: 'code_block', lang: '', lines: [code] };
        parent.children.push(node);
        // consume following indented/blank lines
        let j = ln + 1;
        while (j < lines.length) {
          const l2 = lines[j];
          const s2 = stripContainersForLine(l2, stack);
          if (!s2) break;
          if (isBlankStr(s2.text)) {
            // a blank line is part of the code only if a later
            // non-blank line still belongs to the block (indented >= 4
            // after the containers); its spaces beyond the 4-column
            // indent are kept (cm-112)
            let k = j + 1, s3 = null;
            while (k < lines.length) {
              const s = stripContainersForLine(lines[k], stack);
              if (!s) break;
              if (!isBlankStr(s.text)) { s3 = s; break; }
              k++;
            }
            if (s3 && indentOf(s3.text, s3.col) >= 4) {
              node.lines.push(stripIndent(s2.text, s2.col, 4) ?? '');
              j++; continue;
            }
            break;
          }
          if (indentOf(s2.text, s2.col) >= 4) {
            node.lines.push(stripIndent(s2.text, s2.col, 4));
            j++;
          } else break;
        }
        // drop trailing blank lines
        while (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') node.lines.pop();
        ln = j - 1;
        lastLineBlank = false;
        continue;
      }
    }

    // ---- fenced code ----
    const fence = matchFence(content, contentCol);
    if (fence) {
      const parent = top();
      markLooseIfBlank();
      const node = { type: 'code_block', lang: fence.lang, fenced: true, fenceCh: fence.ch, fenceLen: fence.len, lines: [] };
      parent.children.push(node);
      closePara();
      let j = ln + 1;
      while (j < lines.length) {
        const l2 = lines[j];
        const fail = {};
        const s2 = stripContainersForLine(l2, stack, fail);
        if (!s2) {
          // the line does not match the containers. A lazy line fails
          // only on a list-item indent: it belongs to the fenced
          // block as-is (marked lexes the fence from the item text,
          // which includes lazy lines). A missing blockquote marker
          // means the line is outside the quote (a code block ends
          // the quote's lazy continuation) -- the fence ends too.
          // A blank line outside the containers ends the block.
          if (isBlankStr(l2)) break;
          if (fail.reason !== 'item') break;
          if (matchFenceClose(l2, 0, fence.ch, fence.len)) { j++; break; }
          // a lazy line is part of the fence only when the previous
          // line is not itself a block start (marked's list-item text
          // building breaks a lazy line after a fence/heading/html/hr
          // line: the item text ends there, so the fence has no
          // content after its opening line -- doc-17's empty toml
          // fence). The previous line is the last content line, or
          // the opening fence line when the block is still empty.
          const prev = node.lines.length > 0 ? node.lines[node.lines.length - 1] : content;
          if (matchFence(prev, 0) || matchATX(prev, 0) || matchHR(prev, 0)) break;
          { const ht = matchHtmlBlock(prev, 0); if (ht > 0 && ht <= 6) break; }
          // A lazy line starts a new block when its content AFTER the
          // containers that did match is a block start. The raw line's
          // indent is misleading: a list marker at raw indent 4
          // ('    + ...') is a new item once the outer item's indent
          // is stripped (doc-12/doc-36).
          const rem = (fail.pad > 0 ? ' '.repeat(fail.pad) : '') + l2.slice(fail.pos);
          const remCol = fail.col - fail.pad;
          const lind = indentOf(rem, remCol);
          let startsBlock = false;
          if (lind < 4) {
            let pp = 0;
            while (pp < rem.length && (rem.charCodeAt(pp) === 32 || rem.charCodeAt(pp) === 9)) pp++;
            if (pp < rem.length && rem.charCodeAt(pp) === 62) startsBlock = true;
            else if (matchListMarker(rem.slice(lind), remCol + lind)) startsBlock = true;
          }
          if (!startsBlock && (matchATX(rem, remCol) || matchHR(rem, remCol))) startsBlock = true;
          if (!startsBlock) { const ht = matchHtmlBlock(rem, remCol); if (ht > 0 && ht <= 6) startsBlock = true; }
          if (startsBlock) break;
          node.lines.push(l2);
          j++;
          continue;
        }
        if (isBlankStr(s2.text)) {
          // a blank line is part of the code only if a later non-blank
          // line still belongs to the block (the block continues
          // after it); otherwise the block ends before it (cm-128: a
          // blank line without a '>' does not belong to a fenced block
          // inside a blockquote). A blank line's spaces (dedented) are
          // kept as code content. A later line belongs to the block
          // when it matches the containers, when it is a closing
          // fence, or when it is a lazy continuation line.
          let k = j + 1, s3 = null;
          while (k < lines.length) {
            const fk = {};
            const s = stripContainersForLine(lines[k], stack, fk);
            if (!s) {
              if (isBlankStr(lines[k])) break;
              if (fk.reason !== 'item') break;
              // lazy line: a closing fence or a content line (whose
              // previous line is not a block start) continues the
              // block; a block-starting line ends it
              if (matchFenceClose(lines[k], 0, fence.ch, fence.len)) { s3 = { text: lines[k], col: 0 }; break; }
              const prevk = node.lines.length > 0 ? node.lines[node.lines.length - 1] : content;
              if (matchFence(prevk, 0) || matchATX(prevk, 0) || matchHR(prevk, 0)) break;
              { const ht = matchHtmlBlock(prevk, 0); if (ht > 0 && ht <= 6) break; }
              // same as the main lazy-line branch: judge the block
              // start on the content after the containers that did
              // match, not on the raw line
              const remk = (fk.pad > 0 ? ' '.repeat(fk.pad) : '') + lines[k].slice(fk.pos);
              const remkCol = fk.col - fk.pad;
              const lindk = indentOf(remk, remkCol);
              let sb = false;
              if (lindk < 4) {
                let pp = 0;
                while (pp < remk.length && (remk.charCodeAt(pp) === 32 || remk.charCodeAt(pp) === 9)) pp++;
                if (pp < remk.length && remk.charCodeAt(pp) === 62) sb = true;
                else if (matchListMarker(remk.slice(lindk), remkCol + lindk)) sb = true;
              }
              if (!sb && (matchATX(remk, remkCol) || matchHR(remk, remkCol))) sb = true;
              if (!sb) { const ht = matchHtmlBlock(remk, remkCol); if (ht > 0 && ht <= 6) sb = true; }
              if (sb) break;
              s3 = { text: lines[k], col: 0 }; break;
            }
            if (!isBlankStr(s.text)) { s3 = s; break; }
            k++;
          }
          if (s3) {
            const indB = indentOf(s2.text, s2.col);
            const fInd = indentOf(content, contentCol);
            // marked's Dt dedents ONLY backtick fences (its regex is
            // /^(\s+)(?:```)/ -- a tilde fence never matches); a tilde
            // fence keeps its content lines as-is
            node.lines.push(indB > 0 && fence.ch === '`' ? stripLeadingWSChars(s2.text, fInd) : s2.text);
            j++; continue;
          }
          break;
        }
        if (matchFenceClose(s2.text, s2.col, fence.ch, fence.len)) { j++; break; }
        // dedent (up to the fence's indent) -- character-based, backtick
        // fences only (see above)
        const ind2 = indentOf(s2.text, s2.col);
        const fInd = indentOf(content, contentCol);
        node.lines.push(ind2 > 0 && fence.ch === '`' ? stripLeadingWSChars(s2.text, fInd) : s2.text);
        j++;
      }
      // trailing newline of a fenced block: the block's content ends with
      // a newline (CommonMark: the text between fences, lines joined)
      ln = j - 1;
      lastLineBlank = false;
      continue;
    }

    // ---- ATX heading ----
    const atx = matchATX(content, contentCol);
    if (atx) {
      const parent = top();
      markLooseIfBlank();
      closePara();
      parent.children.push({ type: 'heading', level: atx.level, text: atx.text });
      lastLineBlank = false;
      continue;
    }

    // ---- thematic break ----
    if (matchHR(content, contentCol)) {
      const parent = top();
      markLooseIfBlank();
      closePara();
      parent.children.push({ type: 'hr' });
      lastLineBlank = false;
      continue;
    }

    // ---- HTML block ----
    const htmlType = matchHtmlBlock(content, contentCol);
    if (htmlType > 0) {
      // type 7 cannot interrupt a paragraph
      if (htmlType === 7 && openPara) {
        // fall through to paragraph continuation below
      } else {
        const parent = top();
        markLooseIfBlank();
        closePara();
        // the block's end: types 1-5 end at their closing marker (a
        // blank line is content, not a terminator); types 6-7 end at a
        // blank line. Type 7 is a complete tag alone on its start line,
        // but the block continues until a blank line like the others.
        const node = { type: 'html_block', htmlType, lines: [content] };
        parent.children.push(node);
        let j = ln + 1;
        const closeMarker = htmlType === 1 ? (content.toLowerCase().includes('<pre') ? '</pre>' : content.toLowerCase().includes('<script') ? '</script>' : content.toLowerCase().includes('<style') ? '</style>' : '</textarea>') :
          htmlType === 2 ? '-->' :
          htmlType === 3 ? '?>' :
          htmlType === 4 ? '>' :
          htmlType === 5 ? ']]>' : null;
        let sawBlank = false;
        // when the start line already contains the closing marker
        // (e.g. '<style>...</style>' or '<!-- foo -->'), the block is
        // just that line -- no further lines are consumed
        if (!(closeMarker && content.toLowerCase().includes(closeMarker))) {
          while (j < lines.length) {
            const l2 = lines[j];
            const s2 = stripContainersForLine(l2, stack);
            if (!s2) break;
            if (closeMarker) {
              // types 1-5: every line is content until the closing marker
              node.lines.push(s2.text);
              if (s2.text.toLowerCase().includes(closeMarker)) { j++; break; }
              j++;
              continue;
            }
            // types 6-7: a blank line ends the block
            if (isBlankStr(s2.text)) {
              sawBlank = true;
              j++; break;
            }
            node.lines.push(s2.text);
            j++;
          }
        }
        // trailing newline (marked's ge() on the raw text): the block's
        // output ends with a newline only when the raw text ends with
        // exactly one. It ends with none when the block is terminated by
        // a blank line, when a blank line follows the closing marker
        // (types 1-5: the regex captures that blank line's newline too,
        // making two trailing newlines, which ge strips entirely), when
        // the block's lines end with blank lines, when a type 6-7 block
        // ends at another block, or when the source has no trailing
        // newline after the block's last line.
        // Only a truly EMPTY next line strips the trailing newline:
        // marked's html regex captures the newlines after the closing
        // marker with `\n*` / `(\n+|$)`, which stops at any whitespace
        // -- so a spaces-only or tab-only line after the block does
        // NOT add a second newline and ge() keeps the one. An empty
        // line does add one, making two, which ge() strips entirely.
        // The next line strips the trailing newline when it is blank
        // AFTER the open containers are stripped: a lone '>' line in
        // a blockquote is a blank line in the quote's text (doc-30),
        // just as an empty raw line is at the top level.
        let nextIsBlank = false;
        if (j < lines.length) {
          if (lines[j].length === 0) nextIsBlank = true;
          else {
            const sn = stripContainersForLine(lines[j], stack);
            if (sn && sn.text === '') nextIsBlank = true;
          }
        }
        const linesEndBlank = node.lines.length > 0 && isBlankStr(node.lines[node.lines.length - 1]);
        // A trailing newline at the end of the DOCUMENT only reaches
        // this block when it is at the top level: inside a list item
        // (or blockquote) the container's text is trimmed, so the
        // document's final newline does not add one (doc-30: an HTML
        // comment inside a tight list item must not gain '\n').
        const endsNL = stack.length === 1 && srcEndsWithNL;
        let trailingNL;
        if (sawBlank || nextIsBlank || linesEndBlank) trailingNL = false;
        else if (htmlType <= 5) trailingNL = (j - 1) < lines.length - 1 || endsNL;
        else trailingNL = j >= lines.length && endsNL;
        node.trailingNL = trailingNL;
        ln = j - 1;
        lastLineBlank = sawBlank;
        if (sawBlank) lastBlankTop = top().type;
        continue;
      }
    }

    // ---- blockquote ----
    {
      let p = 0;
      while (p < content.length && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
      if (p < content.length && content.charCodeAt(p) === 62 && p - 0 < 4) {
        const parent = top();
        markLooseIfBlank();
        closePara();
        const node = { type: 'blockquote', children: [] };
        parent.children.push(node);
        stack.push(node);
        // the marker is stripped by the next iteration's container
        // matching (the same line is re-processed at the new depth)
        ln--;
        lastLineBlank = false;
        continue;
      }
    }

    // ---- list item ----
    {
      const ind = indentOf(content, contentCol);
      if (ind < 4) {
        const m = matchListMarker(content.slice(ind), contentCol + ind);
        if (m) {
          // a list item can interrupt a paragraph ONLY when it is not
          // empty and the marker is '-', '+', '*' (bullet) or an ordered
          // marker starting at 1 (an empty item never interrupts).
          // EXCEPTION: inside a list item, marked lexes the content
          // with state.top=false, so its paragraphs are single-line
          // "text" tokens and ANY list marker (any ordered start)
          // interrupts them. Inside a blockquote (state.top=true) or
          // at top level the start-1 rule stands.
          let inItem = false;
          if (openPara) {
            for (let si = openParaDepth - 1; si >= 1; si--) {
              const tt = stack[si].type;
              if (tt === 'item') { inItem = true; break; }
              if (tt === 'blockquote') break;
            }
          }
          const canInterrupt = !openPara || (!m.empty && (!m.ordered || m.start === 1 || inItem));
          if (canInterrupt) {
            const parent = top();
            markLooseIfBlank();
            closePara();
            // find or create the list. When the line matched an existing
            // list in Phase 1, top() IS that list (already on the stack)
            // and the new item belongs to it -- do not push it again.
            // Otherwise the list is the parent's last child when it
            // matches, else a new list under the parent.
            const delim = m.ordered ? content.slice(ind + m.markerLen - 1, ind + m.markerLen) : m.bullet;
            let list = null;
            let listOnStack = false;
            if (parent.type === 'list' && parent.ordered === m.ordered && parent.delimiter === delim) {
              list = parent;
              listOnStack = true;
            } else {
              const last = parent.children[parent.children.length - 1];
              if (last && last.type === 'list' && last.ordered === m.ordered && last.delimiter === delim) {
                list = last;
              } else {
                list = { type: 'list', ordered: m.ordered, delimiter: delim, start: m.ordered ? m.start : undefined, loose: false, children: [] };
                parent.children.push(list);
              }
            }
            const item = { type: 'item', children: [], endsWithBlank: false, hasBlankBetween: false };
            // content indent relative to the line's content start
            // (contentCol), so a blockquote prefix does not shift it
            item.relIndent = m.contentIndent - contentCol;
            list.children.push(item);
            if (!listOnStack) stack.push(list);
            stack.push(item);
            // An empty item (nothing after the marker) is consumed as-is:
            // the item stays open for later indented lines, and the line
            // must NOT count as a blank line after the item (an indented
            // line following it is still the item's content).
            if (m.empty) {
              lastLineBlank = false;
              continue;
            }
            // Re-process this line at the new depth: the item's content
            // (after the marker) becomes the line's content. Replace the
            // marker span with spaces so the next pass's container
            // matching strips exactly the item's content indent: the
            // remainder starts at column m.contentIndent, and the
            // replacement puts it at column col + S where S =
            // m.contentIndent - col (col = column of the content's
            // first char in the raw line; S >= 1 for a non-empty item
            // because the content's indent covers the pad spaces).
            // When the container prefix ends with a blockquote '>'
            // that consumed no following space in this pass (e.g.
            // '>+ At'), the re-processed line's blockquote WILL eat
            // one of the replacement spaces as its optional space, so
            // add one extra to keep the item indent aligned.
            const remainder = sliceCols(content, contentCol, m.contentIndent - contentCol) ?? '';
            const bqEatsSpace = pos > 0 && rawLine.charCodeAt(pos - 1) === 62 ? 1 : 0;
            lines[ln] = rawLine.slice(0, pos) + ' '.repeat(m.contentIndent - col + bqEatsSpace) + remainder;
            ln--;
            lastLineBlank = false;
            continue;
          }
        }
      }
    }

    // ---- paragraph continuation / new paragraph ----
    {
      const parent = top();
      if (openPara) {
        // continuation line. Inside a list item, a line indented 4+
        // columns (after the item indent) loses 4 of them (the
        // indented-code indent is stripped during the list's outdent);
        // at top level and in blockquotes the indent is kept as-is.
        let cont = content;
        if (parent.type === 'item' && indentOf(cont, contentCol) >= 4) {
          cont = stripIndent(cont, contentCol, 4);
        }
        openPara.lines.push(cont);
      } else {
        markLooseIfBlank();
        const node = { type: 'paragraph', lines: [content] };
        parent.children.push(node);
        openPara = node;
        openParaParent = parent;
        openParaDepth = stack.length;
      }
      lastLineBlank = false;
      continue;
    }
  }
  closePara();
  return doc;
}

// Strip the open containers (stack entries after the document) from a
// line, for the multi-line consumption in code/HTML blocks. Returns
// {text, col} or null when the line does not match the containers
// (a line that does not match is not part of the block). Blank lines
// match any container (CommonMark). The containers are re-matched
// independently of the main loop (so `stack` must be the same stack).
// When `fail` is given, it is set to {reason:'blockquote'|'item'}
// on a null return, saying which container the line failed to match
// (a lazy line fails only on a list-item indent; a missing blockquote
// marker means the line is outside the quote).
function stripContainersForLine(rawLine, stack, fail) {
  let pos = 0, col = 0, pad = 0;
  for (let si = 1; si < stack.length; si++) {
    const cont = stack[si];
    if (cont.type === 'blockquote') {
      let p = pos, c = col, sp = 0;
      while (p < rawLine.length && sp < 3 && rawLine.charCodeAt(p) === 32) { p++; c++; sp++; }
      if (p < rawLine.length && rawLine.charCodeAt(p) === 62) {
        p++; c++;
        let q = p, vq = c, exp = 0, hasTab = false;
        const vgt = pad + (p - pos) - 1;
        vq = vgt + 1;
        while (q < rawLine.length) {
          const ch = rawLine.charCodeAt(q);
          if (ch === 32) { exp++; vq++; q++; }
          else if (ch === 9) { hasTab = true; const w = 4 - (vq % 4); exp += w; vq += w; q++; }
          else break;
        }
        if (hasTab) { pad = exp > 0 ? exp - 1 : 0; c = vq; p = q; }
        else if (q > p) { p++; c++; }
        pos = p; col = c;
        continue;
      }
      if (isBlankStr(rawLine)) continue;
      if (fail) { fail.reason = 'blockquote'; fail.pos = pos; fail.col = col; fail.pad = pad; }
      return null;
    }
    if (cont.type === 'item') {
      // a line that is blank after the outer containers were stripped
      // (e.g. a lone '>' inside a blockquote) matches the item
      if (isBlankStr(rawLine.slice(pos))) continue;
      const target = (col - pad) + cont.relIndent;
      if (target <= col) {
        if (pad > 0) pad -= Math.min(cont.relIndent, pad);
        continue;
      }
      const adv = advanceCols(rawLine, pos, col, target);
      if (!adv) { if (fail) { fail.reason = 'item'; fail.pos = pos; fail.col = col; fail.pad = pad; } return null; }
      pos = adv[0]; col = adv[1]; pad = adv[2];
      continue;
    }
    // list: transparent; handled by the item entry below
    const next = stack[si + 1];
    if (next && next.type === 'item') {
      if (isBlankStr(rawLine.slice(pos))) { si++; continue; }
      const target = (col - pad) + next.relIndent;
      if (target <= col) {
        if (pad > 0) pad -= Math.min(next.relIndent, pad);
        si++; continue;
      }
      const adv = advanceCols(rawLine, pos, col, target);
      if (!adv) { if (fail) { fail.reason = 'item'; fail.pos = pos; fail.col = col; fail.pad = pad; } return null; }
      pos = adv[0]; col = adv[1]; pad = adv[2];
      si++; continue;
    }
  }
  // Expand the remainder's leading whitespace to spaces (marked's J):
  // inside a list item / blockquote, a leading tab in the content
  // advances to the next multiple of 4 from its column. At top level
  // (no containers) tabs are kept as-is.
  let rem = rawLine.slice(pos);
  if (stack.length > 1) {
    let exp = '', cc = col, ii = 0;
    while (ii < rem.length) {
      const ch = rem.charCodeAt(ii);
      if (ch === 32) { exp += ' '; cc++; ii++; }
      else if (ch === 9) { const nx = cc + (4 - (cc % 4)); exp += ' '.repeat(nx - cc); cc = nx; ii++; }
      else break;
    }
    if (ii > 0) rem = exp + rem.slice(ii);
  }
  const text = (pad > 0 ? ' '.repeat(pad) : '') + rem;
  return { text, col: col - pad };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderBlock(node, defs, out) {
  switch (node.type) {
    case 'document': {
      for (const child of node.children) renderBlock(child, defs, out);
      return;
    }
    case 'paragraph': {
      out.push('<p>');
      if (node.task === 0) out.push('<input disabled="" type="checkbox"> ');
      else if (node.task === 1) out.push('<input checked="" disabled="" type="checkbox"> ');
      parseInline(node.text, defs, out, false, null);
      out.push('</p>\n');
      return;
    }
    case 'heading': {
      out.push('<h' + node.level + '>');
      parseInline(node.text, defs, out, false, null);
      out.push('</h' + node.level + '>\n');
      return;
    }
    case 'hr': {
      out.push('<hr>\n');
      return;
    }
    case 'code_block': {
      out.push('<pre><code');
      if (node.lang) {
        out.push(' class="language-');
        escapeAttr(node.lang, out);
        out.push('"');
      }
      out.push('>');
      // escape the code text directly (no entities in code blocks).
      // The content is the lines joined by '\n'; the output ends with
      // exactly one trailing '\n' when the block is non-empty (a fenced
      // block's trailing blank lines contribute only up to that one
      // newline; an empty block has none).
      const txt = node.lines.join('\n');
      escapeText(txt.length > 0 ? (txt.endsWith('\n') ? txt : txt + '\n') : txt, out);
      out.push('</code></pre>\n');
      return;
    }
    case 'html_block': {
      // an HTML block's lines are output verbatim; trailing blank lines
      // (and the blank line that ends the block) do not contribute.
      // A block terminated by a blank line has no trailing newline;
      // one terminated by EOF, another block, or its closing tag does.
      let txt = node.lines.join('\n');
      // strip trailing blank lines (spaces-only lines at the end)
      txt = txt.replace(/[ \t]*(\n[ \t]*)+$/, '');
      if (txt.length > 0) out.push(txt);
      if (node.trailingNL !== false) out.push('\n');
      return;
    }
    case 'blockquote': {
      out.push('<blockquote>\n');
      for (const child of node.children) renderBlock(child, defs, out);
      out.push('</blockquote>\n');
      return;
    }
    case 'list': {
      const tight = computeTight(node);
      const tag = node.ordered ? 'ol' : 'ul';
      out.push('<' + tag);
      if (node.ordered && node.start !== undefined && node.start !== 1) {
        out.push(' start="' + node.start + '"');
      }
      out.push('>\n');
      for (const item of node.children) renderItem(item, defs, out, tight);
      out.push('</' + tag + '>\n');
      return;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < node.header.length; i++) {
        const a = node.aligns[i];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>');
        parseInline(node.header[i], defs, out, false, null);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      // a table with no body rows has no <tbody> at all (gfm-205)
      if (node.rows.length === 0) { out.push('</table>\n'); return; }
      out.push('<tbody>');
      for (const row of node.rows) {
        out.push('<tr>\n');
        for (let i = 0; i < node.header.length; i++) {
          const a = node.aligns[i];
          out.push('<td' + (a ? ' align="' + a + '"' : '') + '>');
          parseInline(row[i], defs, out, false, null);
          out.push('</td>\n');
        }
        out.push('</tr>\n');
      }
      out.push('</tbody></table>\n');
      return;
    }
  }
}

// Render a list item. In a tight list, a paragraph child is rendered
// without the <p> wrapper (its inline content only); in a loose list it
// keeps the <p> wrapper. A tight list item containing a single paragraph
// renders the paragraph inline; the <li> tags wrap the content.
function renderItem(item, defs, out, tight) {
  out.push('<li>');
  const children = item.children;
  // GFM task list: if the item's first child is a paragraph whose text
  // starts with '[ ] ' / '[x] ' / '[X] ', it renders a checkbox input
  // at the start of that paragraph and the marker is dropped.
  if (children.length > 0 && children[0].type === 'paragraph') {
    const t = children[0].text;
    if (t.length >= 4 && t[0] === '[' && t[2] === ']' && t[3] === ' ') {
      const c = t[1];
      if (c === ' ') { children[0].task = 0; children[0].text = t.slice(4); }
      else if (c === 'x' || c === 'X') { children[0].task = 1; children[0].text = t.slice(4); }
    }
  }
  // render each child; in a tight list, paragraph children render inline
  // (no <p> wrapper, no trailing newline), and no extra newline is ever
  // added between children -- blocks carry their own trailing newline
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'paragraph' && tight) {
      if (child.task === 0) out.push('<input disabled="" type="checkbox"> ');
      else if (child.task === 1) out.push('<input checked="" disabled="" type="checkbox"> ');
      parseInline(child.text, defs, out, false, null);
    } else {
      renderBlock(child, defs, out);
    }
  }
  out.push('</li>\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// parse(src): render Markdown to HTML, byte-identical to marked 18.1.3
// (with headerIds off, mangle off, GFM on) on the test cases.
function parse(src) {
  // normalise line endings and NULs
  src = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
  const lines = src.split('\n');
  // a trailing newline produces a final empty line that is not a real line
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // fresh per-document inline state (inLink is set by raw <a> tags and
  // must not leak from a previous document)
  inLink = false;
  const defs = new Map();
  const doc = parseBlocks(lines, defs, src.endsWith('\n'));
  const out = [];
  renderBlock(doc, defs, out);
  return out.join('');
}

export default parse;
export { parse };
