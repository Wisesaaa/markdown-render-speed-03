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

function processEmphasis(delimiters, html, text, phantomSpans, suppressedRegions) {
  // Rule A: a closer whose effective position lies inside a phantom
  // code span (trigger link present) is suppressed.
  // Rule B: a match whose opener AND closer both lie inside the same
  // unformed-link region and whose content wraps an unclean 2+ code
  // span is suppressed.
  // The effective position of a delimiter is the position of the
  // delimiter that THIS match would consume: for a closer the leftmost
  // remaining delimiter, for an opener the rightmost remaining one.
  const insidePhantom = (pos) => {
    if (!phantomSpans) return false;
    for (let idx = 0; idx < phantomSpans.length; idx++) {
      if (pos >= phantomSpans[idx][0] && pos < phantomSpans[idx][1]) return true;
    }
    return false;
  };
  const isSuppressed = (openDelim, closeDelim) => {
    const closePos = closeDelim.pos + (closeDelim.origLen - closeDelim.len);
    if (insidePhantom(closePos)) return true;
    if (suppressedRegions && suppressedRegions.length > 0 && text !== undefined) {
      const openPos = openDelim.pos + openDelim.len - 1;
      for (let idx = 0; idx < suppressedRegions.length; idx++) {
        const region = suppressedRegions[idx];
        if (openPos >= region[0] && openPos < region[1] && closePos >= region[0] && closePos < region[1]) {
          if (hasUncleanCodeSpan(text, openPos + 1, closePos)) return true;
        }
      }
    }
    return false;
  };
  // floor per delimiter char: index into delimiters (exclusive bound).
  const floor = { '*': -1, '_': -1, '~': -1 };
  // Pre-pass (marked's emStrong m-balance): for each '*'/'_' opener with
  // len >= 2, determine whether it closes as strong. A lone close-only
  // '*' must NOT match such an opener with take=1 when the opener is
  // going to close as strong at a later '**' (e.g. `**a *b*other* c**`
  // is <strong>, while `**a *b* c* d**` is <em>). The pre-pass only
  // ADDS this one skip rule; all matching stays closer-first.
  markStrongOpeners(delimiters);
  let closeIdx = 0;
  while (closeIdx < delimiters.length) {
    const closeDelim = delimiters[closeIdx];
    if (!closeDelim || !closeDelim.close) { closeIdx++; continue; }
    const delimChar = closeDelim.ch;
    // find the nearest opener before this closer
    let openIdx = closeIdx - 1, openDelim = null, sawCandidate = false;
    while (openIdx > floor[delimChar]) {
      const cand = delimiters[openIdx];
      if (cand && cand.ch === delimChar && cand.open) {
        sawCandidate = true;
        // '~' (strikethrough): the regex backreferences the opener's
        // length, so the two runs must have the SAME length, and it must
        // be 1 or 2 (a longer run leaves a '~' adjacent to the delimiter,
        // failing the lookahead). Otherwise this opener cannot match.
        if (delimChar === '~' && (cand.len !== closeDelim.len || cand.len > 2)) { openIdx--; continue; }
        const oddMatch = (cand.open && cand.close) || (closeDelim.open && closeDelim.close);
        if (!oddMatch || (cand.len + closeDelim.len) % 3 !== 0 || (cand.len % 3 === 0 && closeDelim.len % 3 === 0)) {
          // A lone close-only run must not steal one delimiter from a
          // '**' opener that the m-balance says closes as strong.
          if (cand.len === 2 && closeDelim.len === 1 && !closeDelim.open && !cand.close && cand.expectsStrong) {
            openIdx--; continue;
          }
          // The m-balance says this opener never closes (no k in
          // 1..len reaches m <= 0), so it must stay literal.
          if (cand.closes === false) { openIdx--; continue; }
          // Rule A / Rule B: this match is suppressed by a phantom
          // code span or an unformed-link region -- keep searching
          // backwards for another opener for this closer.
          if (isSuppressed(cand, closeDelim)) { openIdx--; continue; }
          openDelim = cand; break;
        }
      }
      openIdx--;
    }
    if (!openDelim) {
      // cmark #383: only advance the floor when NO potential opener
      // was seen. An opener rejected by the odd-match rule may still match
      // a later closer (different length), so it must not be skipped.
      // Advance to closeIdx-1 (not closeIdx): the delimiter at closeIdx itself may be an
      // opener for a later closer, so it must stay searchable.
      if (!sawCandidate) floor[delimChar] = closeIdx - 1;
      closeIdx++;
      continue;
    }
    // use 2 delimiters when both runs have >= 2 (strong/del), else 1 (em).
    // '~' uses the run length (1 or 2; opener and closer lengths match).
    let take = (openDelim.len >= 2 && closeDelim.len >= 2) ? 2 : 1;
    if (delimChar === '~') take = openDelim.len;
    const tagName = delimChar === '~' ? 'del' : (take === 2 ? 'strong' : 'em');
    // Chunk layout: an opener's leftover delimiters sit on the LEFT
    // (outer side), its tags after them; a closer's leftover delimiters
    // sit on the RIGHT, its tags before them. A new match consumes the
    // delimiters adjacent to the content, so the new tag goes right
    // after the opener's leftovers / right before the closer's leftovers.
    const openChunk = html[openDelim.idx];
    const openOldLeft = openDelim.len;
    const openLeft = openOldLeft - take;
    const openTail = openChunk.slice(openOldLeft);
    html[openDelim.idx] = (openLeft > 0 ? delimChar.repeat(openLeft) : '') + '<' + tagName + '>' + openTail;
    openDelim.len = openLeft;
    const closeChunk = html[closeDelim.idx];
    const closeOldLeft = closeDelim.len;
    const closeLeft = closeOldLeft - take;
    const closeHead = closeChunk.slice(0, closeChunk.length - closeOldLeft);
    // When an inner both-flanking closer was skipped by the rule of 3
    // (marked's f), the adjusted closer length b exceeds `take`, so the
    // leftover delimiters stay INSIDE the tag (M.slice(2,-2) keeps the
    // first b-take of them as content). Otherwise they go outside.
    if (openDelim.hasInnerSkip && closeLeft > 0) {
      html[closeDelim.idx] = closeHead + delimChar.repeat(closeLeft) + '</' + tagName + '>';
    } else {
      html[closeDelim.idx] = closeHead + '</' + tagName + '>' + (closeLeft > 0 ? delimChar.repeat(closeLeft) : '');
    }
    closeDelim.len = closeLeft;
    // Record a rule-of-3 skip for the nearest enclosing opener: if
    // this closer was both-flanking and (outer.len + closer.len) % 3
    // is 0 while outer.len % 3 is not, marked skips it (f) and the
    // outer match's closer leftover goes inside.
    if (delimGroup(closeDelim.prev || '', closeDelim.next || '') === 'both') {
      for (let scanIdx = openIdx - 1; scanIdx > floor[delimChar]; scanIdx--) {
        const outer = delimiters[scanIdx];
        if (outer && outer.ch === delimChar && outer.open) {
          if (outer.len % 3 !== 0 && (outer.len + closeOldLeft) % 3 === 0) outer.hasInnerSkip = true;
          break;
        }
      }
    }
    // Trapping rule: delimiters strictly between the opener and closer
    // are now inside the formed emphasis and can no longer match a
    // closer outside it -- remove them from the stack.
    const trapped = closeIdx - openIdx - 1;
    if (trapped > 0) {
      delimiters.splice(openIdx + 1, trapped);
      closeIdx -= trapped;
      // Splicing shifts indices, so the floor index bounds
      // (set for the old array) now point at the wrong delimiters
      // and would block valid later matches (e.g. `**is**` after an
      // inner `*3*` inside `_..._`). Reset them: re-scanning is
      // correct, just slightly more work.
      floor['*'] = -1; floor['_'] = -1; floor['~'] = -1;
    }
    // remove exhausted delimiters from the stack
    let removed = false;
    if (openDelim.len === 0) {
      const openSlot = delimiters.indexOf(openDelim);
      if (openSlot !== -1) delimiters.splice(openSlot, 1);
      if (openSlot < closeIdx) closeIdx--;
      if (openSlot !== -1) removed = true;
    } else if (delimChar === '~' && openDelim.len < 2) {
      // a leftover single '~' can never form a strikethrough; drop it
      const openSlot = delimiters.indexOf(openDelim);
      if (openSlot !== -1) delimiters.splice(openSlot, 1);
      if (openSlot < closeIdx) closeIdx--;
      if (openSlot !== -1) removed = true;
    }
    if (closeDelim.len === 0) {
      delimiters.splice(closeIdx, 1);
      removed = true;
      // do not advance closeIdx: the next delimiter slid into this slot
    } else if (delimChar === '~' && closeDelim.len < 2) {
      // a leftover single '~' can never form a strikethrough; skip it
      closeIdx++;
    }
    if (removed) { floor['*'] = -1; floor['_'] = -1; floor['~'] = -1; }
    // if the closer still has delimiters, keep it as current (closeIdx unchanged)
    // so it can match another opener.
  }
}

// Find the index of the ']' matching the '[' at s[i] (i points at '[').
// Skips code spans and backslash escapes. Returns -1 when there is none.
function findClosingBracket(str, start, len) {
  let bracketDepth = 0;
  let pos = start;
  while (pos < len) {
    const code = str.charCodeAt(pos);
    if (code === 92) { pos += 2; continue; } // backslash escape
    if (code === 96) { // backtick run: skip the code span
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
      let runEnd = pos;
      while (runEnd < len && str.charCodeAt(runEnd) === 96) runEnd++;
      const tickLen = runEnd - pos;
      let scan = runEnd;
      let closeRun = -1;
      let scanDepth = bracketDepth; // bracket depth at the run
      let parenDepth = 0; // >0 while inside a (...) group after a label-closing ']'
      while (scan < len) {
        const scanCode = str.charCodeAt(scan);
        if (scanCode === 92) { scan += 2; continue; }
        if (scanCode === 96) { closeRun = scan; while (closeRun < len && str.charCodeAt(closeRun) === 96) closeRun++; break; }
        if (scanCode === 91) { if (parenDepth === 0) scanDepth++; scan++; continue; }
        if (scanCode === 93) {
          if (parenDepth === 0) {
            scanDepth--;
            if (scanDepth === 0 && scan + 1 < len && str.charCodeAt(scan + 1) === 40) {
              parenDepth = 1; scan += 2;
              // angle destination <...>: skip to '>'
              if (scan < len && str.charCodeAt(scan) === 60) {
                scan++;
                while (scan < len && str.charCodeAt(scan) !== 62) { if (str.charCodeAt(scan) === 92) scan++; scan++; }
                if (scan < len) scan++;
              }
              continue;
            }
          }
          scan++; continue;
        }
        if (parenDepth > 0) {
          if (scanCode === 40) { parenDepth++; scan++; continue; }
          if (scanCode === 41) { parenDepth--; if (parenDepth === 0) break; scan++; continue; }
          if (scanCode === 34 || scanCode === 39) { // skip a quoted title
            const quote = scanCode; scan++;
            while (scan < len && str.charCodeAt(scan) !== quote) { if (str.charCodeAt(scan) === 92) scan++; scan++; }
            if (scan < len) scan++;
            continue;
          }
        }
        scan++;
      }
      if (closeRun === -1) {
        // no closing run: blocks the label, unless 2+ backticks right
        // before the closing ']'
        if (tickLen >= 2 && runEnd < len && str.charCodeAt(runEnd) === 93) { pos = runEnd; continue; }
        return -1;
      }
      pos = closeRun;
      continue;
    }
    if (code === 60) { // '<': skip a raw HTML tag / autolink, so a ']'
      // inside a tag's attribute value does not close the bracket
      const rawTag = tryRawHtml(str, pos, len);
      if (rawTag) { pos = rawTag.next; continue; }
      const autolink = tryAngleAutolink(str, pos, len);
      if (autolink) { pos = autolink.next; continue; }
      pos++;
      continue;
    }
    if (code === 91) { bracketDepth++; pos++; continue; } // '['
    if (code === 93) { // ']'
      bracketDepth--;
      if (bracketDepth === 0) return pos;
      pos++;
      continue;
    }
    pos++;
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
function tryRawHtml(str, start, len) {
  // comment <!-- ... --> (<!--> and <!---> are empty comments)
  if (str.startsWith('<!--', start)) {
    if (str.charCodeAt(start + 4) === 62) return { html: str.slice(start, start + 5), next: start + 5 }; // <!-->
    if (str.startsWith('->', start + 4)) return { html: str.slice(start, start + 7), next: start + 7 }; // <!--->
    const endIdx = str.indexOf('-->', start + 4);
    if (endIdx !== -1) return { html: str.slice(start, endIdx + 3), next: endIdx + 3 };
    // unterminated comment: everything to the end is the comment? No --
    // marked treats an unterminated comment as literal text. Fall through.
    return null;
  }
  // processing instruction <? ... ?>
  if (str.startsWith('<?', start)) {
    const endIdx = str.indexOf('?>', start + 2);
    if (endIdx !== -1) return { html: str.slice(start, endIdx + 2), next: endIdx + 2 };
    return null;
  }
  // declaration <!A ...>  (not <!-- and not <![CDATA[)
  if (str.startsWith('<!', start) && !str.startsWith('<![CDATA[', start)) {
    let cursor = start + 2;
    if (cursor < len && /[A-Za-z]/.test(str[cursor])) {
      while (cursor < len && str.charCodeAt(cursor) !== 62) cursor++;
      if (cursor < len) return { html: str.slice(start, cursor + 1), next: cursor + 1 };
    }
    return null;
  }
  // CDATA <![CDATA[ ... ]]>
  if (str.startsWith('<![CDATA[', start)) {
    const endIdx = str.indexOf(']]>', start + 9);
    if (endIdx !== -1) return { html: str.slice(start, endIdx + 3), next: endIdx + 3 };
    return null;
  }
  // open or close tag
  let cursor = start + 1;
  let isClosing = false;
  if (cursor < len && str.charCodeAt(cursor) === 47) { isClosing = true; cursor++; } // '/'
  if (cursor >= len || !/[A-Za-z]/.test(str[cursor])) return null;
  while (cursor < len && /[A-Za-z0-9-]/.test(str[cursor])) cursor++;
  if (isClosing) {
    // optional whitespace, then '>'
    let scan = cursor;
    while (scan < len && (str.charCodeAt(scan) === 32 || str.charCodeAt(scan) === 9 || str.charCodeAt(scan) === 10)) scan++;
    if (scan < len && str.charCodeAt(scan) === 62) return { html: str.slice(start, scan + 1), next: scan + 1 };
    return null;
  }
  // open tag: attributes then '>' or '/>'. The first character after
  // the tag name must be whitespace, '/' or '>' (an attribute must be
  // preceded by whitespace); e.g. <m:abc> is not a tag.
  {
    const afterName = str.charCodeAt(cursor);
    if (afterName !== 32 && afterName !== 9 && afterName !== 10 && afterName !== 62 && afterName !== 47) return null;
  }
  while (cursor < len) {
    const code = str.charCodeAt(cursor);
    if (code === 62) return { html: str.slice(start, cursor + 1), next: cursor + 1 }; // '>'
    if (code === 47 && cursor + 1 < len && str.charCodeAt(cursor + 1) === 62) return { html: str.slice(start, cursor + 2), next: cursor + 2 }; // '/>'
    if (code === 32 || code === 9 || code === 10) { cursor++; continue; }
    // attribute name (must start with a letter, '_' or ':')
    if (!/[A-Za-z_:]/.test(str[cursor])) return null;
    while (cursor < len && /[A-Za-z0-9_.:-]/.test(str[cursor])) cursor++;
    // optional whitespace
    while (cursor < len && (str.charCodeAt(cursor) === 32 || str.charCodeAt(cursor) === 9 || str.charCodeAt(cursor) === 10)) cursor++;
    if (cursor < len && str.charCodeAt(cursor) === 61) { // '='
      cursor++;
      while (cursor < len && (str.charCodeAt(cursor) === 32 || str.charCodeAt(cursor) === 9 || str.charCodeAt(cursor) === 10)) cursor++;
      if (cursor >= len) return null;
      const quote = str.charCodeAt(cursor);
      if (quote === 34 || quote === 39) { // quoted value
        cursor++;
        while (cursor < len && str.charCodeAt(cursor) !== quote) cursor++;
        if (cursor >= len) return null;
        cursor++;
        // after a quoted value, whitespace, '/' or '>' must follow
        if (cursor < len) {
          const nextCode = str.charCodeAt(cursor);
          if (nextCode !== 32 && nextCode !== 9 && nextCode !== 10 && nextCode !== 62 && nextCode !== 47) return null;
        }
      } else { // unquoted value
        if (str.charCodeAt(cursor) === 34 || str.charCodeAt(cursor) === 39 || str.charCodeAt(cursor) === 61 || str.charCodeAt(cursor) === 60 || str.charCodeAt(cursor) === 62 || str.charCodeAt(cursor) === 96) return null;
        while (cursor < len) {
          const code2 = str.charCodeAt(cursor);
          if (code2 === 32 || code2 === 9 || code2 === 10 || code2 === 62 || code2 === 47) break;
          if (code2 === 34 || code2 === 39 || code2 === 61 || code2 === 60 || code2 === 96) return null;
          cursor++;
        }
        if (cursor >= len) return null;
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
function emitTextRun(text, from, to, prev, linkDefs, html, skipAutolink) {
  // inside a link's text, autolinks are plain text (the outer link still
  // forms); only bracket-links inside can cancel it
  if (skipAutolink || inLink) { pushText(text, from, to, html); return; }
  let pos = from;
  let segStart = from; // start of the pending plain-text segment
  while (pos < to) {
    let wwwAt = text.indexOf('www.', pos);
    if (wwwAt === -1 || wwwAt >= to) wwwAt = Infinity;
    let schemeAt = text.indexOf('://', pos);
    if (schemeAt === -1 || schemeAt >= to) schemeAt = Infinity;
    let atAt = text.indexOf('@', pos);
    if (atAt === -1 || atAt >= to) atAt = Infinity;
    const nearest = Math.min(wwwAt, schemeAt, atAt);
    if (nearest === Infinity) break;
    if (nearest === wwwAt) {
      // www. candidate
      const before = wwwAt > from ? text[wwwAt - 1] : prev;
      if (before !== '' && !isUnicodeSpace(before) && before !== '*' && before !== '_' && before !== '~' && before !== '(') {
        pos = wwwAt + 4; continue;
      }
      const urlEnd = matchUrlAt(text, wwwAt, text.length);
      if (urlEnd === -1 || urlEnd > to) { pos = wwwAt + 4; continue; }
      const urlText = text.slice(wwwAt, urlEnd);
      const hostCut = urlText.search(/[/?#]/);
      const hostPart = hostCut === -1 ? urlText.slice(4) : urlText.slice(4, hostCut);
      if (hostPart.indexOf('.') === -1) { pos = wwwAt + 4; continue; }
      const linkHref = cleanUrl('http://' + urlText);
      if (linkHref === null) { pos = wwwAt + 4; continue; }
      if (wwwAt > segStart) pushText(text, segStart, wwwAt, html);
      html.push('<a href="');
      escapeEncode(linkHref, html);
      html.push('">');
      escapeEncode(urlText, html);
      html.push('</a>');
      pos = urlEnd; segStart = urlEnd;
      continue;
    }
    if (nearest === schemeAt) {
      // :// candidate: scheme is the 3-5 chars before it
      let schemeStart = -1;
      if (text.slice(schemeAt - 5, schemeAt).toLowerCase() === 'https') schemeStart = schemeAt - 5;
      else if (text.slice(schemeAt - 4, schemeAt).toLowerCase() === 'http') schemeStart = schemeAt - 4;
      else if (text.slice(schemeAt - 3, schemeAt).toLowerCase() === 'ftp') schemeStart = schemeAt - 3;
      if (schemeStart === -1 || schemeStart < from) { pos = schemeAt + 3; continue; }
      const urlEnd = matchUrlAt(text, schemeStart, text.length);
      if (urlEnd === -1 || urlEnd > to) { pos = schemeAt + 3; continue; }
      const urlText = text.slice(schemeStart, urlEnd);
      const linkHref = cleanUrl(urlText);
      if (linkHref === null) { pos = schemeAt + 3; continue; }
      if (schemeStart > segStart) pushText(text, segStart, schemeStart, html);
      html.push('<a href="');
      escapeEncode(linkHref, html);
      html.push('">');
      escapeEncode(urlText, html);
      html.push('</a>');
      pos = urlEnd; segStart = urlEnd;
      continue;
    }
    // '@' candidate: email -- but a mailto:/xmpp: scheme directly before
    // the address extends the link to include the scheme
    const email = matchEmailAt(text, atAt, text.length, from);
    if (!email || email.end > to) { pos = atAt + 1; continue; }
    let startPos = email.start, endPos = email.end, schemePrefix = '';
    if (email.start >= 7 && text.slice(email.start - 7, email.start) === 'mailto:') {
      startPos = email.start - 7; schemePrefix = 'mailto:';
    } else if (email.start >= 5 && text.slice(email.start - 5, email.start) === 'xmpp:') {
      startPos = email.start - 5; schemePrefix = 'xmpp:';
      // one /path segment of [A-Za-z0-9@.]+
      if (endPos < to && text.charCodeAt(endPos) === 47) {
        let pathEnd = endPos + 1;
        while (pathEnd < to && /[A-Za-z0-9@.]/.test(text[pathEnd])) pathEnd++;
        if (pathEnd > endPos + 1) endPos = pathEnd;
      }
    }
    const address = text.slice(startPos, endPos);
    const linkHref = cleanUrl(schemePrefix ? address : 'mailto:' + address);
    if (linkHref === null) { pos = atAt + 1; continue; }
    if (startPos > segStart) pushText(text, segStart, startPos, html);
    html.push('<a href="');
    escapeEncode(linkHref, html);
    html.push('">');
    escapeEncode(address, html);
    html.push('</a>');
    pos = endPos; segStart = endPos;
  }
  if (to > segStart) pushText(text, segStart, to, html);
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
function parseInline(text, linkDefs, html, skipAutolink, inlineState) {
  const textLen = text.length;
  const delimiters = [];
  // Rule A: phantom code spans over the whole paragraph (computed once
  // when a trigger link/image is found). Rule B: regions [start, end)
  // of unformed inline-link brackets followed by a closed paren group.
  let phantomSpans = null;
  const suppressedRegions = [];
  let pos = 0;
  let runStart = 0; // start of the current un-emitted text run
  const flushRun = (stop) => {
    if (stop > runStart) {
      const prev = runStart > 0 ? text[runStart - 1] : '';
      emitTextRun(text, runStart, stop, prev, linkDefs, html, skipAutolink);
    }
  };

  while (pos < textLen) {
    const code = text.charCodeAt(pos);
    if (code < 128 && !SPECIAL[code]) { pos++; continue; }
    if (code === 96) { // backtick: code span
      flushRun(pos);
      let runEnd = pos;
      while (runEnd < textLen && text.charCodeAt(runEnd) === 96) runEnd++;
      const runLen = runEnd - pos;
      // find a matching run of exactly runLen backticks
      let scan = runEnd, matchAt = -1;
      while (scan < textLen) {
        if (text.charCodeAt(scan) === 96) {
          let closeEnd = scan;
          while (closeEnd < textLen && text.charCodeAt(closeEnd) === 96) closeEnd++;
          if (closeEnd - scan === runLen) { matchAt = scan; break; }
          scan = closeEnd;
        } else scan++;
      }
      if (matchAt === -1) {
        // literal backticks
        html.push(text.slice(pos, runEnd));
        pos = runEnd; runStart = pos;
        continue;
      }
      let codeText = text.slice(runEnd, matchAt);
      // line endings become spaces; strip one leading/trailing space
      if (codeText.indexOf('\n') !== -1) codeText = codeText.replace(/\n/g, ' ');
      if (codeText.length >= 2 && codeText.charCodeAt(0) === 32 && codeText.charCodeAt(codeText.length - 1) === 32 && codeText.trim() !== '') {
        codeText = codeText.slice(1, -1);
      }
      html.push('<code>');
      escapeEncode(codeText, html);
      html.push('</code>');
      pos = matchAt + runLen; runStart = pos;
      continue;
    }
    if (code === 42 || code === 95 || code === 126) { // * _ ~ : delimiter run
      // a '_' inside an email local part, or any of these inside a bare
      // URL, is plain text, not a delimiter
      if (code === 95 && (underscoreInEmail(text, pos, textLen) || underscoreInEmailDomain(text, pos, textLen))) { pos++; continue; }
      if (delimInUrl(text, pos, textLen)) { pos++; continue; }
      flushRun(pos);
      let runEnd = pos;
      while (runEnd < textLen && text.charCodeAt(runEnd) === code) runEnd++;
      const runLen = runEnd - pos;
      const prevCh = pos > 0 ? text[pos - 1] : '';
      const nextCh = runEnd < textLen ? text[runEnd] : '';
      const [flankLeft, flankRight] = flanking(prevCh, nextCh);
      const delimChar = String.fromCharCode(code);
      let mayOpen, mayClose;
      if (delimChar === '*') { mayOpen = flankLeft; mayClose = flankRight; }
      else if (delimChar === '_') {
        mayOpen = flankLeft && (!flankRight || isUnicodePunct(prevCh));
        mayClose = flankRight && (!flankLeft || isUnicodePunct(nextCh));
      } else { // '~'
        mayOpen = flankLeft; mayClose = flankRight;
      }
      html.push(text.slice(pos, runEnd));
      // A run that can neither open nor close can never form emphasis
      // (e.g. '_' inside snake_case) -- do not record it at all. This
      // skips most delimiter allocations in README prose.
      if (mayOpen || mayClose) {
        delimiters.push({ ch: delimChar, len: runLen, origLen: runLen, open: mayOpen, close: mayClose, idx: html.length - 1, prev: prevCh, next: nextCh, pos });
      }
      pos = runEnd; runStart = pos;
      continue;
    }
    if (code === 91 || (code === 33 && pos + 1 < textLen && text.charCodeAt(pos + 1) === 91)) { // '[' or '!['
      const image = code === 33;
      // NOTE: marked's inLink does NOT block bracket-links -- its link
      // tokenizer has no inLink check (De only uses inLink to detect a
      // nested link inside the link's own text). Only the bare-URL
      // autolink (url tokenizer) is gated on !inLink (doc-33).
      const link = tryLink(text, pos, textLen, linkDefs, image);
      if (link) {
        if (inlineState && !image) inlineState.bracketLink = true;
        // Rule A: a formed INLINE link/image whose text is a trigger
        // computes the phantom code spans for this paragraph once.
        if (link.inline && link.text !== undefined && phantomSpans === null && linkTextTrigger(link.text)) {
          phantomSpans = codeSpanRegions(text);
        }
        flushRun(pos);
        html.push(link.html);
        pos = link.next; runStart = pos;
        continue;
      }
      // Rule B: an unformed link whose brackets are immediately
      // followed by a closed paren group -- record the region so
      // emphasis inside it can be suppressed (only the emphasis that
      // wraps an unclean 2+ code span is actually suppressed).
      {
        const bracketOpen = image ? pos + 1 : pos;
        const bracketClose = findBracketCloseLenient(text, bracketOpen, textLen);
        if (bracketClose !== -1 && bracketClose + 1 < textLen && text.charCodeAt(bracketClose + 1) === 40) {
          const parenClose = findParenClose(text, bracketClose + 1, textLen);
          if (parenClose !== -1) suppressedRegions.push([bracketOpen, parenClose + 1]);
        }
      }
      // not a link: the '[' (or '!') is literal text
      pos += 1;
      continue;
    }
    if (code === 60) { // '<': autolink or raw HTML
      const autolink = tryAngleAutolink(text, pos, textLen);
      if (autolink) {
        flushRun(pos);
        html.push(autolink.html);
        pos = autolink.next; runStart = pos;
        continue;
      }
      const rawTag = tryRawHtml(text, pos, textLen);
      if (rawTag) {
        // Flush the text run BEFORE the tag first: the tag's inLink
        // effect only applies to text AFTER it (a URL before an <a>
        // tag still autolinks; doc-13 regression).
        flushRun(pos);
        // <a ...> (incl. self-closing <a />) opens the link scope;
        // </a> closes it (marked's tag tokenizer state.inLink)
        const tag = rawTag.html;
        if (tag.length >= 2 && tag.charCodeAt(0) === 60) {
          if (tag.charCodeAt(1) === 97 || tag.charCodeAt(1) === 65) {
            // marked's startATag is /^<a(?:\s[^>]*?)?>/ : after <a must
            // come '>' or whitespace. <a/> (no space) is NOT an <a> tag
            // and does NOT set inLink (doc-04 regression).
            const thirdChar = tag.length > 2 ? tag.charCodeAt(2) : 0;
            if (thirdChar === 62 || thirdChar === 32 || thirdChar === 9 || thirdChar === 10) inLink = true;
          } else if (tag.charCodeAt(1) === 47 && tag.length >= 3 && (tag.charCodeAt(2) === 97 || tag.charCodeAt(2) === 65)) {
            const fourthChar = tag.length > 3 ? tag.charCodeAt(3) : 0;
            if (fourthChar === 62 || fourthChar === 32 || fourthChar === 9 || fourthChar === 10) inLink = false;
          }
        }
        html.push(rawTag.html);
        pos = rawTag.next; runStart = pos;
        continue;
      }
      pos++; // literal '<', escaped by flushRun
      continue;
    }
    if (code === 38) { // '&': handled inside flushRun (entity or &amp;)
      pos++;
      continue;
    }
    if (code === 92) { // backslash
      if (pos + 1 < textLen) {
        const nextCode = text.charCodeAt(pos + 1);
        // a backslash that is the trailing char of a bare URL is part
        // of the URL, not a hard break / escape -- leave it in the text
        // run so emitTextRun links the whole URL (with %5C)
        if (!backslashInUrl(text, runStart, pos, textLen)) {
          if (nextCode === 10) { // backslash + newline = hard break
            flushRun(pos);
            html.push('<br>');
            pos += 2;
            while (pos < textLen && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) pos++;
            runStart = pos;
            continue;
          }
          if (nextCode < 128 && isPunct(nextCode)) {
            flushRun(pos);
            // the escaped char is literal text (still HTML-escaped)
            escapeText(text[pos + 1], html);
            pos += 2; runStart = pos;
            continue;
          }
        }
      }
      pos++; // literal backslash
      continue;
    }
    if (code === 10) { // newline: soft break, or hard break (2+ spaces before)
      // count trailing spaces in the pending text run
      let trailingSpaces = 0, back = pos - 1;
      while (back >= runStart && text.charCodeAt(back) === 32) { trailingSpaces++; back--; }
      if (trailingSpaces >= 2) {
        flushRun(pos - trailingSpaces);
        html.push('<br>');
        pos++;
        // after a hard break the next line's leading whitespace is stripped
        while (pos < textLen && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) pos++;
      } else {
        flushRun(pos);
        html.push('\n');
        pos++;
      }
      runStart = pos;
      continue;
    }
    // any other char (incl. non-ASCII): part of the text run
    pos++;
  }
  flushRun(textLen);
  if (delimiters.length > 0) processEmphasis(delimiters, html, text, phantomSpans, suppressedRegions);
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
function indentOf(str, baseCol) {
  let column = baseCol, idx = 0;
  const len = str.length;
  while (idx < len) {
    const code = str.charCodeAt(idx);
    if (code === 32) { column++; idx++; }
    else if (code === 9) { column += 4 - (column % 4); idx++; }
    else break;
  }
  return column - baseCol;
}

// Count leading whitespace characters (space/tab, each 1 char) in str.
function countLeadingWS(str) {
  let idx = 0;
  while (idx < str.length && (str.charCodeAt(idx) === 32 || str.charCodeAt(idx) === 9)) idx += 1;
  return idx;
}

// Remove up to limit leading whitespace characters. Marked's fenced-code
// dedent (Dt) is character-based: a tab counts as ONE character, not an
// expanded tab stop -- so a tab at the fence indent is removed whole,
// not left as remainder spaces.
function stripLeadingWSChars(str, limit) {
  let idx = 0;
  while (idx < str.length && idx < limit && (str.charCodeAt(idx) === 32 || str.charCodeAt(idx) === 9)) idx += 1;
  return str.slice(idx);
}

// String str (first char at column baseCol) after removing cols columns of
// indentation. A straddling tab leaves spaces. Returns null when str has
// less than cols columns of indentation.
// Strip up to cols columns of leading whitespace (never null: a line with
// less indent just loses what it has). Used for fenced code lines.
function stripUpTo(str, baseCol, cols) {
  let column = baseCol, idx = 0;
  const len = str.length;
  while (column - baseCol < cols && idx < len) {
    const code = str.charCodeAt(idx);
    if (code === 32) { column++; idx++; }
    else if (code === 9) {
      const nextCol = column + (4 - (column % 4));
      if (nextCol - baseCol > cols) return ' '.repeat(nextCol - (baseCol + cols)) + str.slice(idx + 1);
      column = nextCol; idx++;
    } else break;
  }
  return str.slice(idx);
}
// Remove the first cols columns of string str (first char at column
// baseCol), whatever they are (whitespace or marker characters). A
// straddling tab leaves spaces. Returns null when str is shorter than cols
// columns. Unlike stripIndent, this does not stop at non-whitespace.
function sliceCols(str, baseCol, cols) {
  let column = baseCol, idx = 0;
  const len = str.length;
  while (column - baseCol < cols && idx < len) {
    const code = str.charCodeAt(idx);
    if (code === 9) {
      const nextCol = column + (4 - (column % 4));
      if (nextCol - baseCol > cols) return ' '.repeat(nextCol - (baseCol + cols)) + str.slice(idx + 1);
      column = nextCol; idx++;
    } else { column++; idx++; }
  }
  if (column - baseCol < cols) return null;
  return str.slice(idx);
}

function stripIndent(str, baseCol, cols) {
  let column = baseCol, idx = 0;
  const len = str.length;
  while (column - baseCol < cols && idx < len) {
    const code = str.charCodeAt(idx);
    if (code === 32) { column++; idx++; }
    else if (code === 9) {
      const nextCol = column + (4 - (column % 4));
      if (nextCol - baseCol > cols) return ' '.repeat(nextCol - (baseCol + cols)) + str.slice(idx + 1);
      column = nextCol; idx++;
    } else break;
  }
  if (column - baseCol < cols) return null;
  return str.slice(idx);
}

// Is the rest of the line (from from) blank (only spaces/tabs)?
function restIsBlank(text, from) {
  for (let idx = from; idx < text.length; idx += 1) {
    const code = text.charCodeAt(idx);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

// Is the string blank (only spaces/tabs)?
// True when str is empty or consists only of spaces (no tabs). This is
// marked's notion of a "blank" line for its space/newline regex
// /^(?: *(?:\n|$))+/ -- a tab-only line is NOT blank there.
function isSpacesOnly(str) {
  for (let idx = 0; idx < str.length; idx += 1) {
    if (str.charCodeAt(idx) !== 32) return false;
  }
  return true;
}

function isBlankStr(str) {
  for (let idx = 0; idx < str.length; idx += 1) {
    const code = str.charCodeAt(idx);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

// Advance (start, startCol) over the line's whitespace up to goalCol. Returns
// [cursor, column, padding] (padding = spaces from a straddling tab) or null when a
// non-space is hit or the line ends before goalCol.
function advanceCols(text, start, startCol, goalCol) {
  let cursor = start, column = startCol, padding = 0;
  while (column < goalCol && cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === 32) { cursor++; column++; }
    else if (code === 9) {
      const nextCol = column + (4 - (column % 4));
      if (nextCol > goalCol) { padding = nextCol - goalCol; cursor++; column = nextCol; break; }
      cursor++; column = nextCol;
    } else return null;
  }
  if (column < goalCol) return null;
  // a tab exactly at the target column is entirely beyond the stripped
  // indent: expand it to spaces (it is leading whitespace of the content).
  // Only when no straddling tab already set a padding.
  if (padding === 0 && cursor < text.length && text.charCodeAt(cursor) === 9) {
    const nextCol = column + (4 - (column % 4));
    padding = nextCol - column;
    cursor++; column = nextCol;
  }
  return [cursor, column, padding];
}

// Match a list marker in string str (str starts at the marker; startCol is the
// visual column of str[0]). CommonMark 5.2: N = total whitespace columns
// after the marker. N==0 -> not a list item. N>=5 -> content indent is
// W+1 (rule #2, indented-code content). 1<=N<=4 -> content indent W+N.
// An item with no content after the marker is empty (indent W+1).
function matchListMarker(str, startCol) {
  if (str.length === 0) return null;
  const firstCode = str.charCodeAt(0);
  let isOrdered = false, startNum = 0, markerLength = 0;
  if (firstCode === 42 || firstCode === 43 || firstCode === 45) {
    markerLength = 1;
  } else if (firstCode >= 48 && firstCode <= 57) {
    let idx = 0;
    while (idx < str.length && idx < 9 && str.charCodeAt(idx) >= 48 && str.charCodeAt(idx) <= 57) idx += 1;
    if (idx === 0 || idx >= str.length) return null;
    const delimCode = str.charCodeAt(idx);
    if (delimCode !== 46 && delimCode !== 41) return null;
    const value = parseInt(str.slice(0, idx), 10);
    if (value > 999999999) return null;
    isOrdered = true; startNum = value; markerLength = idx + 1;
  } else return null;
  // whitespace after the marker (columns, tabs to next multiple of 4)
  let column = startCol + markerLength, idx = markerLength, wsCols = 0;
  while (idx < str.length) {
    const code = str.charCodeAt(idx);
    if (code === 32) { wsCols++; column++; idx++; }
    else if (code === 9) { const nextCol = column + (4 - (column % 4)); wsCols += nextCol - column; column = nextCol; idx++; }
    else break;
  }
  // a marker with no whitespace after it is not a list item -- unless
  // it is at the end of the line (an empty item)
  if (wsCols === 0 && idx < str.length) return null;
  const isEmpty = idx >= str.length;
  if (isEmpty) return { ordered: isOrdered, bullet: str[0], start: startNum, markerLen: markerLength, contentIndent: startCol + markerLength + 1, empty: true };
  if (wsCols >= 5) return { ordered: isOrdered, bullet: str[0], start: startNum, markerLen: markerLength, contentIndent: startCol + markerLength + 1, empty: false };
  return { ordered: isOrdered, bullet: str[0], start: startNum, markerLen: markerLength, contentIndent: startCol + markerLength + wsCols, empty: false };
}

// Fenced code start. Returns {ch, len, lang} or null. The fence must be at
// indent < 4 (the caller passes the content after container stripping, and
// its column). `infoStr` is the info string (trimmed).
function matchFence(str, startCol) {
  const indent = indentOf(str, startCol);
  if (indent >= 4) return null;
  const rest = str.slice(indent);
  if (rest.length < 3) return null;
  const fenceCode = rest.charCodeAt(0);
  if (fenceCode !== 96 && fenceCode !== 126) return null;
  let fenceLen = 0;
  while (fenceLen < rest.length && rest.charCodeAt(fenceLen) === fenceCode) fenceLen += 1;
  if (fenceLen < 3) return null;
  let infoStr = rest.slice(fenceLen);
  // backtick fences may not contain backticks in the info string
  if (fenceCode === 96 && infoStr.indexOf('`') !== -1) return null;
  infoStr = infoStr.trim();
  // the language is the first word of the info string; backslash
  // escapes are processed in it (foo\+bar -> foo+bar)
  let language = '';
  if (infoStr.length > 0) {
    const splitAt = infoStr.search(/[ \t]/);
    language = splitAt === -1 ? infoStr : infoStr.slice(0, splitAt);
    if (language.indexOf('\\') !== -1) {
      language = language.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    }
  }
  return { ch: String.fromCharCode(fenceCode), len: fenceLen, lang: language, info: infoStr };
}
// Fenced code closing line: same char, length >= minLen, only spaces after.
function matchFenceClose(str, startCol, fenceCh, minLen) {
  const indent = indentOf(str, startCol);
  if (indent >= 4) return false;
  const rest = str.slice(indent);
  let closeLen = 0;
  while (closeLen < rest.length && rest.charCodeAt(closeLen) === fenceCh.charCodeAt(0)) closeLen += 1;
  if (closeLen < minLen) return false;
  return isBlankStr(rest.slice(closeLen));
}

// ATX heading: 1-6 '#' followed by space/EOL. Returns {level, text} or null.
function matchATX(str, startCol) {
  const indent = indentOf(str, startCol);
  if (indent >= 4) return null;
  const rest = str.slice(indent);
  let depth = 0;
  while (depth < rest.length && depth < 6 && rest.charCodeAt(depth) === 35) depth += 1;
  if (depth === 0) return null;
  if (depth < rest.length && rest.charCodeAt(depth) !== 32 && rest.charCodeAt(depth) !== 9) return null;
  let headingText = rest.slice(depth).trim();
  // closing sequence of #'s (preceded by a space, and only #'s + spaces)
  if (headingText.length > 0) {
    const closing = headingText.match(/^(.*?)[ \t]+#+[ \t]*$/);
    if (closing) headingText = closing[1].trim();
    else if (/^#+$/.test(headingText) && rest.slice(depth).trim().length > 0 && /^[ \t]/.test(rest.slice(depth))) {
      // the whole thing is a closing sequence (e.g. "## ##")
      headingText = '';
    }
  }
  return { level: depth, text: headingText };
}

// Setext underline: only '=' (level 1) or '-' (level 2) + spaces/tabs.
function matchSetext(str, startCol) {
  const indent = indentOf(str, startCol);
  if (indent >= 4) return 0;
  const rest = str.slice(indent);
  let idx = 0;
  while (idx < rest.length && (rest.charCodeAt(idx) === 32 || rest.charCodeAt(idx) === 9)) idx += 1;
  if (idx >= rest.length) return 0;
  const code = rest.charCodeAt(idx);
  if (code !== 61 && code !== 45) return 0;
  // the underline is a run of ONLY '=' or '-' (no spaces mixed in),
  // then only spaces/tabs to end of line
  let scan = idx;
  while (scan < rest.length && rest.charCodeAt(scan) === code) scan += 1;
  while (scan < rest.length && (rest.charCodeAt(scan) === 32 || rest.charCodeAt(scan) === 9)) scan += 1;
  if (scan < rest.length) return 0;
  return code === 61 ? 1 : 2;
}

// Thematic break: 3+ of -, _, * with only spaces/tabs between.
function matchHR(str, startCol) {
  const indent = indentOf(str, startCol);
  if (indent >= 4) return false;
  const rest = str.slice(indent);
  let markerCode = 0, marks = 0;
  for (let idx = 0; idx < rest.length; idx += 1) {
    const code = rest.charCodeAt(idx);
    if (code === 32 || code === 9) continue;
    if (code === 45 || code === 95 || code === 42) {
      if (markerCode === 0) markerCode = code;
      else if (markerCode !== code) return false;
      marks++;
    } else return false;
  }
  return marks >= 3;
}

// HTML block start. Returns the type (1-7) or 0. Types 1-6 may interrupt
// a paragraph; type 7 may not.
const HTML_BLOCK_TAGS = new Set(['address','article','aside','base','basefont','blockquote','body','caption','center','col','colgroup','dd','details','dialog','dir','div','dl','dt','fieldset','figcaption','figure','footer','form','frame','frameset','h1','h2','h3','h4','h5','h6','head','header','hr','html','iframe','legend','li','link','main','menu','menuitem','nav','noframes','ol','optgroup','option','p','param','section','source','summary','table','tbody','td','tfoot','th','thead','title','tr','track','ul']);
function matchHtmlBlock(str, startCol) {
  const indent = indentOf(str, startCol);
  if (indent >= 4) return 0;
  const rest = str.slice(indent);
  if (rest.charCodeAt(0) !== 60) return 0; // '<'
  const lowerRest = rest.toLowerCase();
  // type 1: pre/script/style/textarea -- the char after the tag name
  // must be whitespace, '>', or end of line
  const type1Prefixes = ['<pre', '<script', '<style', '<textarea'];
  for (const prefix of type1Prefixes) {
    if (lowerRest.startsWith(prefix)) {
      const nextCh = rest.charAt(prefix.length);
      if (nextCh === '' || nextCh === ' ' || nextCh === '\t' || nextCh === '\n' || nextCh === '>') return 1;
      break;
    }
  }
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<!')) {
    const nextCh = rest.charAt(2);
    if (nextCh !== '' && ((nextCh >= 'A' && nextCh <= 'Z') || (nextCh >= 'a' && nextCh <= 'z'))) return 4;
  }
  if (rest.startsWith('<![CDATA[')) return 5;
  // open/close tag of a block-level element
  let idx = 1, isClosing = false;
  if (rest.charCodeAt(idx) === 47) { isClosing = true; idx++; }
  let tagName = '';
  while (idx < rest.length && /[A-Za-z0-9-]/.test(rest[idx])) { tagName += rest[idx]; idx++; }
  if (tagName.length > 0) {
    if (HTML_BLOCK_TAGS.has(tagName.toLowerCase())) return 6;
    // type 7: a complete open/close tag on its own line -- nothing
    // but whitespace may follow the closing '>'. The char right after
    // the tag name must be whitespace, '/', or '>' (so <http://x> is
    // an autolink, not a tag). The tag itself must be well-formed
    // (validated by tryRawHtml, the same check inline parsing uses).
    const afterTag = rest.charAt(idx);
    if (afterTag !== '' && afterTag !== ' ' && afterTag !== '\t' && afterTag !== '/' && afterTag !== '>') return 0;
    const tagMatch = tryRawHtml(rest, 0, rest.length);
    if (tagMatch && rest.slice(tagMatch.next).trim() === '') return 7;
  }
  return 0;
}

// Is a list tight? A list is loose when any of its items is separated
// from the next by a blank line, or ends with two blank lines (i.e. any
// item other than the last ends with a blank line, or any item contains
// two block children separated by a blank line).
function computeTight(listNode) {
  if (listNode.loose) return false;
  for (let idx = 0; idx < listNode.children.length; idx += 1) {
    const itemNode = listNode.children[idx];
    if (itemNode.endsWithBlank && idx < listNode.children.length - 1) return false;
    if (itemNode.hasBlankBetween) return false;
  }
  return true;
}

// Parse one link reference definition starting at doc[start] (the '[').
// Returns {label, dest, title, end} or null. The label is normalised.
function parseRefDef(doc, start, len) {
  // label: [ ... ] (may span lines; brackets nest, backslash escapes)
  const closeBracket = findClosingBracket(doc, start, len);
  if (closeBracket === -1) return null;
  const labelText = doc.slice(start + 1, closeBracket);
  if (labelText.length === 0) return null;
  // a label may not contain an unescaped '['
  if (hasUnescapedBracket(labelText)) return null;
  const normLabel = normalizeLabel(labelText);
  if (normLabel.length === 0) return null;
  let cursor = closeBracket + 1;
  // ':' then whitespace (incl. newlines, but at most one blank line is
  // not allowed -- a blank line ends the def)
  if (cursor >= len || doc.charCodeAt(cursor) !== 58) return null;
  cursor++;
  let scan = cursor;
  // skip spaces/tabs/newlines, but no blank line (two newlines)
  let nlCount = 0;
  while (scan < len) {
    const code = doc.charCodeAt(scan);
    if (code === 32 || code === 9) { scan++; continue; }
    if (code === 10) { nlCount++; if (nlCount > 1) return null; scan++; continue; }
    break;
  }
  if (scan >= len) return null;
  const destInfo = parseDestination(doc, scan, len);
  if (!destInfo) return null;
  let target = destInfo.dest, endPos = destInfo.next;
  // optional title on the same line or the next line
  let titleText = null;
  let titleScan = endPos;
  let nlSeen = 0;
  while (titleScan < len) {
    const code = doc.charCodeAt(titleScan);
    if (code === 32 || code === 9) { titleScan++; continue; }
    if (code === 10) { nlSeen++; if (nlSeen > 1) break; titleScan++; continue; }
    break;
  }
  // a title must be preceded by whitespace (space/tab/newline)
  if (titleScan > endPos && titleScan < len && nlSeen <= 1 && (doc.charCodeAt(titleScan) === 34 || doc.charCodeAt(titleScan) === 39 || doc.charCodeAt(titleScan) === 40)) {
    const titleInfo = parseTitle(doc, titleScan, len);
    if (titleInfo) { titleText = titleInfo.title; endPos = titleInfo.next; }
  }
  // after the def, only whitespace then EOL/EOF
  let tail = endPos;
  while (tail < len && (doc.charCodeAt(tail) === 32 || doc.charCodeAt(tail) === 9)) tail++;
  if (tail < len && doc.charCodeAt(tail) !== 10) {
    // a malformed title does not kill the def: retry without it
    // (the title line stays as paragraph text)
    if (titleText !== null) {
      titleText = null;
      tail = destInfo.next;
      while (tail < len && (doc.charCodeAt(tail) === 32 || doc.charCodeAt(tail) === 9)) tail++;
      if (tail < len && doc.charCodeAt(tail) !== 10) return null;
      endPos = tail;
    } else {
      return null;
    }
  }
  // the def ends at the newline (or EOF)
  if (tail < len) tail++;
  return { label: normLabel, dest: target, title: titleText, end: tail };
}

// Extract leading link reference definitions from a paragraph's joined
// text. Adds them to linkDefs (first definition wins). Returns the remaining
// text ('' when the paragraph was only definitions).
function extractRefDefs(doc, linkDefs) {
  let pos = 0;
  const len = doc.length;
  // skip up to 3 spaces of indent before a def
  while (pos < len) {
    let scan = pos, indent = 0;
    while (scan < len && doc.charCodeAt(scan) === 32) { indent++; scan++; }
    if (indent > 3) break;
    if (scan >= len || doc.charCodeAt(scan) !== 91) break; // '['
    const refDef = parseRefDef(doc, scan, len);
    if (!refDef) break;
    if (!linkDefs.has(refDef.label)) linkDefs.set(refDef.label, { dest: refDef.dest, title: refDef.title });
    pos = refDef.end;
  }
  return doc.slice(pos);
}

// Split a table row line into cells. `|` inside code spans or escaped
// (\|) does not split. Leading/trailing pipes are dropped; cells are
// trimmed.
function splitTableRow(row) {
  const parts = [];
  let current = '', idx = 0;
  const len = row.length;
  // skip a leading pipe
  let first = 0;
  while (first < len && (row.charCodeAt(first) === 32 || row.charCodeAt(first) === 9)) first += 1;
  if (first < len && row.charCodeAt(first) === 124) first += 1;
  idx = first;
  // Marked's splitCells splits on EVERY unescaped pipe, code spans
  // included (a `|` inside a code span breaks the table, so it is not
  // protected here). A pipe is escaped iff preceded by an odd number
  // of backslashes.
  while (idx < len) {
    const code = row.charCodeAt(idx);
    if (code === 124) {
      let slashes = 0, back = idx - 1;
      while (back >= 0 && row.charCodeAt(back) === 92) { slashes++; back--; }
      if (slashes % 2 === 1) {
        // escaped pipe: drop one backslash, keep the pipe literally
        current = current.slice(0, current.length - 1) + '|';
        idx++;
        continue;
      }
      parts.push(current.trim()); current = ''; idx++; continue;
    }
    current += row[idx]; idx++;
  }
  // trailing cell (drop it when the line ends with a pipe and the last
  // cell is empty because of it)
  const tail = current.trim();
  if (tail.length > 0 || parts.length === 0) parts.push(tail);
  // if the line ends with a pipe, the final empty segment is dropped
  return parts;
}

// Is `row` a valid table delimiter row? Returns the alignments
// ('left'|'right'|'center'|null per column) or null.
function parseTableDelimiter(row) {
  const parts = splitTableRow(row);
  if (parts.length === 0) return null;
  const columns = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^:?-+:?$/.test(trimmed)) return null;
    const leftAlign = trimmed.charCodeAt(0) === 58, rightAlign = trimmed.charCodeAt(trimmed.length - 1) === 58;
    columns.push(leftAlign && rightAlign ? 'center' : leftAlign ? 'left' : rightAlign ? 'right' : null);
  }
  return columns;
}

// Try to interpret a paragraph (array of lines) as a GFM table. Returns a
// table node or null. The first line is the header, the second must be a
// delimiter row.
function tryTable(lines) {
  if (lines.length < 2) return null;
  // the delimiter row must be indented less than 4 columns
  if (indentOf(lines[1], 0) >= 4) return null;
  const columns = parseTableDelimiter(lines[1]);
  if (!columns) return null;
  const head = splitTableRow(lines[0]);
  if (head.length === 0) return null;
  // the delimiter row must have exactly as many cells as the header
  if (columns.length !== head.length) return null;
  const colCount = columns.length;
  const bodyRows = [];
  for (let rowIdx = 2; rowIdx < lines.length; rowIdx += 1) {
    if (isBlankStr(lines[rowIdx])) {
      // a tab-only line is an empty row (see the main loop); a
      // spaces-only / empty line is skipped
      if (lines[rowIdx].indexOf('\t') !== -1) {
        bodyRows.push(new Array(colCount).fill(''));
      }
      continue;
    }
    const parts = splitTableRow(lines[rowIdx]);
    while (parts.length < colCount) parts.push('');
    if (parts.length > colCount) parts.length = colCount;
    bodyRows.push(parts);
  }
  return { type: 'table', header: head, aligns: columns, rows: bodyRows };
}

// Does the blank line at sourceLines[lineNo] keep the HTML block's trailing
// newline by ending its container? Only when the block's parent is a
// BLOCKQUOTE: the line must be container-marker only (raw line
// non-empty but strips to empty, e.g. '>' inside a blockquote), it must
// be the ONLY blank line, and the blockquote must end after it (EOF, or
// the next line does not belong to the blockquote). A truly empty line
// never qualifies; two blank lines in a row do not either. (Inside a
// list item the item's content never ends with a newline unless the
// list continues -- handled by listContinuesAfterBlank.)
function singleMarkerBlankEndsContainer(sourceLines, lineNo, openStack) {
  if (openStack[openStack.length - 1].type !== 'blockquote') return false;
  const rawLine = sourceLines[lineNo];
  if (rawLine.length === 0) return false;
  const strippedLine = stripContainersForLine(rawLine, openStack);
  if (!strippedLine || strippedLine.text.length !== 0) return false;
  const nextNo = lineNo + 1;
  if (nextNo >= sourceLines.length) return true;
  const nextStripped = stripContainersForLine(sourceLines[nextNo], openStack);
  if (nextStripped === null) return true; // next line is outside the container
  if (isBlankStr(nextStripped.text)) return false; // a second blank line
  return false; // the container continues with a non-blank line
}

// Does the list containing this HTML block continue after the blank
// line(s) starting at sourceLines[lineNo]? A blank line after an HTML block keeps
// the block's trailing newline only when the blank line belongs to a
// list item's content -- i.e. another item of the SAME list follows
// after the blank line(s) (marked tokenizes the item's text, and the
// blank line joined into it yields the trailing newline). If the list
// ends at the blank line (or there is no list), the newline is stripped.
function listContinuesAfterBlank(sourceLines, lineNo, openStack) {
  // nearest list in the stack
  let listPos = -1, listNode = null;
  for (let stackIdx = openStack.length - 1; stackIdx >= 1; stackIdx--) {
    if (openStack[stackIdx].type === 'list') { listPos = stackIdx; listNode = openStack[stackIdx]; break; }
  }
  if (!listNode) return false;
  // skip the blank lines
  let scanNo = lineNo;
  while (scanNo < sourceLines.length && isBlankStr(sourceLines[scanNo])) scanNo += 1;
  if (scanNo >= sourceLines.length) return false;
  // strip the containers above the list (excluding the item and anything
  // below the list) and check for a marker of the same list
  const strippedLine = stripContainersForLine(sourceLines[scanNo], openStack.slice(0, listPos + 1));
  if (!strippedLine) return false;
  const indent = indentOf(strippedLine.text, strippedLine.col);
  const listMarker = matchListMarker(strippedLine.text.slice(indent), strippedLine.col + indent);
  if (!listMarker) return false;
  if (listMarker.ordered !== listNode.ordered) return false;
  if (listMarker.ordered) {
    const delimiter = strippedLine.text.slice(indent + listMarker.markerLen - 1, indent + listMarker.markerLen);
    if (delimiter !== listNode.delimiter) return false;
  } else if (listMarker.bullet !== listNode.delimiter) return false;
  return true;
}

// Finalise a paragraph node: extract link reference definitions, detect a
// table, and either drop the node, replace it with a table, or set its
// text. Returns the node to keep (paragraph/table) or null.
function finalizeParagraph(para, parentNode, linkDefs) {
  const joined = para.lines.join('\n');
  const remaining = extractRefDefs(joined, linkDefs);
  if (remaining.trim() === '') {
    // only definitions: drop the paragraph
    const childIdx = parentNode.children.indexOf(para);
    if (childIdx !== -1) parentNode.children.splice(childIdx, 1);
    return null;
  }
  // table? (needs at least 2 lines in the original paragraph)
  const restRows = remaining.split('\n');
  // the table check uses the ORIGINAL lines (defs may have consumed some)
  const table = tryTable(para.lines);
  if (table) {
    const childIdx = parentNode.children.indexOf(para);
    if (childIdx !== -1) parentNode.children[childIdx] = table;
    return table;
  }
  para.text = remaining;
  delete para.lines;
  return para;
}

// Does this line start a block that can interrupt a paragraph?
// (Used to decide whether a non-matching line is a lazy continuation.)
function canInterruptPara(lineText, textCol) {
  const indent = indentOf(lineText, textCol);
  if (indent < 4) {
    // blockquote
    let scanPos = 0;
    while (scanPos < lineText.length && (lineText.charCodeAt(scanPos) === 32 || lineText.charCodeAt(scanPos) === 9)) scanPos += 1;
    if (scanPos < lineText.length && lineText.charCodeAt(scanPos) === 62) return true;
    // list item
    if (matchListMarker(lineText.slice(indent), textCol + indent)) return true;
  }
  if (matchATX(lineText, textCol)) return true;
  if (matchFence(lineText, textCol)) return true;
  if (matchHR(lineText, textCol)) return true;
  if (matchSetext(lineText, textCol)) return true;
  const htmlKind = matchHtmlBlock(lineText, textCol);
  if (htmlKind > 0 && htmlKind <= 6) return true;
  return false;
}

function parseBlocks(sourceLines, linkDefs, endsWithNewline) {
  const rootDoc = { type: 'document', children: [] };
  const openStack = [rootDoc];
  let activePara = null;
  let activeParaParent = null;
  let activeParaDepth = 0; // open-stack length when the paragraph was created
  let prevBlank = false;
  let prevLazy = false; // the previous line was appended as a lazy
  // continuation (used for the blockquote setext rule below)
  let prevBlankTop = ''; // type of the innermost container when the last
  // blank line was seen ('item'/'list' = a blank line in list structure;
  // 'blockquote' etc. = contained inside a nested block, does not make
  // an outer list loose)
  let prevBlankQuoted = false; // the last blank line carried a '>'
  // marker (a blank line OF a blockquote, inside it -- tight) as opposed
  // to a plain blank line (between two blocks in the item -- loose)

  const topNode = () => openStack[openStack.length - 1];
  const closeParagraph = () => {
    if (activePara) {
      finalizeParagraph(activePara, activeParaParent, linkDefs);
      activePara = null;
      activeParaParent = null;
    }
  };
  // Close containers down to `depth` (open-stack length). Finalises paragraphs.
  const closeToDepth = (depth) => {
    closeParagraph();
    while (openStack.length > depth) openStack.pop();
  };
  // A blank line between two blocks inside one list item makes the list
  // loose. Call when a new block starts after a blank line.
  const markLooseAfterBlank = () => {
    if (!prevBlank) return;
    // only when the item already has a block (a first block after a
    // blank line does not make the list loose)
    const topBlock = topNode();
    if (topBlock.type === 'item' && topBlock.children.length === 0) return;
    for (let stackIdx = openStack.length - 1; stackIdx >= 1; stackIdx--) {
      if (openStack[stackIdx].type === 'list') {
        // a blank line contained inside a nested block (e.g. a blockquote
        // within the item) does not make the list loose -- but only when
        // the blank line itself is a line OF that block (it carries the
        // block's marker, e.g. '>' for a quote). A plain blank line
        // (no marker) that ends the block is between two blocks in the
        // item and makes the list loose (doc-19).
        if (prevBlankTop !== 'item' && prevBlankTop !== 'list' && prevBlankQuoted) return;
        openStack[stackIdx].loose = true; return;
      }
      if (openStack[stackIdx].type === 'item') continue;
      return;
    }
  };

  for (let lineNo = 0; lineNo < sourceLines.length; lineNo++) {
    const raw = sourceLines[lineNo];
    const prevWasLazy = prevLazy;
    prevLazy = false;
    // ---------- Phase 1: match open containers ----------
    let cursor = 0, column = 0, padding = 0;
    let matchedDepth = 1; // open-stack depth matched (1 = document only)
    const blankLine = isBlankStr(raw);
    for (let stackIdx = 1; stackIdx < openStack.length; stackIdx++) {
      const container = openStack[stackIdx];
      if (container.type === 'blockquote') {
        // up to 3 spaces, then '>', then 1 optional space
        let scan = cursor, scanCol = column, spaces = 0;
        while (scan < raw.length && spaces < 3 && raw.charCodeAt(scan) === 32) { scan++; scanCol++; spaces++; }
        if (scan < raw.length && raw.charCodeAt(scan) === 62) {
          // virtual column of '>' in the line at this level (outer
          // markers already stripped: padding spaces precede it)
          const markerCol = padding + (scan - cursor);
          scan++; scanCol++;
          // Expand the whitespace after '>' (marked's J): tabs expand to
          // the next tab stop counting from the column after '>' (markerCol+1);
          // the first expanded space is the marker's optional space and
          // is dropped. Only a run containing a tab is consumed into
          // padding; a spaces-only run consumes one space (the marker's
          // optional space), the rest staying in the raw slice.
          let scanEnd = scan, scanEndCol = markerCol + 1, expanded = 0, sawTab = false;
          while (scanEnd < raw.length) {
            const code = raw.charCodeAt(scanEnd);
            if (code === 32) { expanded++; scanEndCol++; scanEnd++; }
            else if (code === 9) { sawTab = true; const tabWidth = 4 - (scanEndCol % 4); expanded += tabWidth; scanEndCol += tabWidth; scanEnd++; }
            else break;
          }
          if (sawTab) {
            padding = expanded > 0 ? expanded - 1 : 0;
            scanCol = scanEndCol; // the next char is at the expanded column
            scan = scanEnd;
          } else if (scanEnd > scan) {
            scan++; scanCol++;
            // the padding spaces before '>' belong to the container
            // prefix, not the content -- drop them (a tab-overshoot
            // padding from an outer item would otherwise leak a leading
            // space into the blockquote's content)
            padding = 0;
          } else {
            padding = 0;
          }
          cursor = scan; column = scanCol;
          matchedDepth = stackIdx + 1;
          // A line blank after the marker (e.g. a lone '>') is blank
          // for every inner container EXCEPT an inner blockquote: a
          // nested blockquote needs its own '>' marker, so a lone '>'
          // closes it (doc-14: `> > ...` then `>` then `> > ...`
          // starts a NEW inner blockquote). Lists and items stay open
          // (CommonMark: blank lines match any container but a
          // blockquote marker is required for a nested blockquote).
          if (restIsBlank(raw, cursor)) {
            matchedDepth = openStack.length;
            for (let innerIdx = stackIdx + 1; innerIdx < openStack.length; innerIdx++) {
              if (openStack[innerIdx].type === 'blockquote') { matchedDepth = innerIdx; break; }
            }
            break;
          }
          continue;
        }
        break;
      }
      if (container.type === 'item') {
        if (blankLine) { matchedDepth = stackIdx + 1; continue; }
        // an empty item followed by a blank line is closed: later
        // indented lines do not belong to it
        if (container.children.length === 0 && prevBlank) break;
        // the item's content indent is RELATIVE to the container's
        // content start on this line (column - padding): a blockquote prefix
        // is a different width on different lines, so an absolute
        // column would misalign continuation lines (cm-259)
        const indentTarget = (column - padding) + container.relIndent;
        if (indentTarget <= column) {
          // padding (virtual spaces from a tab expansion in an outer
          // container) may overlap the item's indent: the first
          // relIndent padding spaces are the item's indent, not content
          if (padding > 0) padding -= Math.min(container.relIndent, padding);
          matchedDepth = stackIdx + 1; continue;
        }
        const advanced = advanceCols(raw, cursor, column, indentTarget);
        if (!advanced) break;
        cursor = advanced[0]; column = advanced[1]; padding = advanced[2];
        matchedDepth = stackIdx + 1;
        continue;
      }
      // 'list': transparent container. It matches only when the line
      // continues its current item (handled by the item entry below) or
      // starts a new item (a list marker here). Otherwise the list is
      // closed and the line belongs to the list's parent.
      {
        const nextItem = openStack[stackIdx + 1];
        if (nextItem && nextItem.type === 'item') {
          if (blankLine) { matchedDepth = stackIdx + 2; stackIdx++; continue; }
          // a new item marker keeps the list open even after an empty
          // item + blank line (the empty item is closed, a new one
          // starts) -- check this before the empty-item close below.
          // A thematic break is NOT a new item (it closes the list).
          // Only when the line does NOT continue the current item
          // (a continuation line such as a setext underline must not
          // be mistaken for an HR / new item).
          {
            const firstTarget = (column - padding) + nextItem.relIndent;
            const continuesItem = firstTarget <= column || advanceCols(raw, cursor, column, firstTarget);
            if (!continuesItem) {
            const restSlice = (padding > 0 ? ' '.repeat(padding) : '') + raw.slice(cursor);
            const restBaseCol = column - padding;
            const restIndent = indentOf(restSlice, restBaseCol);
            if (restIndent < 4 && matchHR(restSlice.slice(restIndent), restBaseCol + restIndent)) break;
            if (restIndent < 4) {
              const markerMatch = matchListMarker(restSlice.slice(restIndent), restBaseCol + restIndent);
              if (markerMatch) {
                const delimChar = markerMatch.ordered ? restSlice.slice(restIndent + markerMatch.markerLen - 1, restIndent + markerMatch.markerLen) : markerMatch.bullet;
                if (markerMatch.ordered === container.ordered && delimChar === container.delimiter) {
                  matchedDepth = stackIdx + 1;
                  continue;
                }
              }
            }
            } // !continuesItem
          }
          // an empty item followed by a blank line is closed
          if (nextItem.children.length === 0 && prevBlank) break;
          const indentTarget = (column - padding) + nextItem.relIndent;
          if (indentTarget <= column) {
            // padding (virtual spaces from a tab expansion in an outer
            // container) may overlap the item's indent: the first
            // relIndent padding spaces are the item's indent, not content
            if (padding > 0) padding -= Math.min(nextItem.relIndent, padding);
            matchedDepth = stackIdx + 2; stackIdx++; continue;
          }
          const advanced = advanceCols(raw, cursor, column, indentTarget);
          if (advanced) {
            cursor = advanced[0]; column = advanced[1]; padding = advanced[2];
            matchedDepth = stackIdx + 2;
            stackIdx++; // item already matched; skip it next iteration
            continue;
          }
          // The item doesn't match: a new item marker keeps the list
          // open, but ONLY if it matches this list's type/delimiter.
          // A different marker type closes this list (a new sibling list
          // starts instead). A thematic break also closes the list
          // (it is checked before list items in block-start order).
          const tailText = (padding > 0 ? ' '.repeat(padding) : '') + raw.slice(cursor);
          const tailCol = column - padding;
          const tailIndent = indentOf(tailText, tailCol);
          if (tailIndent < 4 && matchHR(tailText.slice(tailIndent), tailCol + tailIndent)) break;
          if (tailIndent < 4) {
            const marker = matchListMarker(tailText.slice(tailIndent), tailCol + tailIndent);
            if (marker) {
              const delim = marker.ordered ? tailText.slice(tailIndent + marker.markerLen - 1, tailIndent + marker.markerLen) : marker.bullet;
              if (marker.ordered === container.ordered && delim === container.delimiter) {
                matchedDepth = stackIdx + 1;
                continue;
              }
            }
          }
          break;
        }
        matchedDepth = stackIdx + 1;
      }
    }

    // content after the matched containers
    let lineText = (padding > 0 ? ' '.repeat(padding) : '') + raw.slice(cursor);
    let textCol = column - padding;
    // (the content string starts at column column-padding: the padding spaces occupy
    //  the columns before the sliced part)
    // Recompute: padding spaces are at columns column-padding .. column-1, and the slice
    // starts at column. So the string's first char is at column-padding.
    textCol = column - padding;
    // A line is blank when, after container stripping, it is empty, or
    // whitespace-only AND the innermost matched container is not a
    // blockquote: whitespace left after a blockquote marker ('>' + one
    // optional space) is paragraph content, not a blank line (cm-241:
    // '>  ' contributes a single space to the paragraph), while a
    // whitespace-only line after a list-item indent is blank.
    const blankText = lineText === '' || (isBlankStr(lineText) && !(matchedDepth > 1 && openStack[matchedDepth - 1].type === 'blockquote'));

    // ---------- lazy continuation ----------
    // (only when the line does NOT start a block that interrupts a paragraph)
    if (matchedDepth < openStack.length && activePara && !blankText) {
      // A setext underline that is ONLY a setext underline (an '='
      // line, or a '-' line that is neither a thematic break nor a
      // list marker) cannot be a lazy heading underline: it stays
      // paragraph text. Inside a blockquote, when the previous line was
      // also lazy, it is indented 4 spaces (marked's
      // blockquoteSetextReplace) so it is not mistaken for a heading
      // when the paragraph is parsed; otherwise it is kept as-is. In a
      // list item it is always kept as-is.
      const setextLazy = matchSetext(lineText, textCol);
      const pureSetext = setextLazy === 1 ||
        (setextLazy === 2 && !matchHR(lineText, textCol) && !matchListMarker(lineText.slice(indentOf(lineText, textCol)), textCol + indentOf(lineText, textCol)));
      if (pureSetext) {
        const firstOpen = openStack[matchedDepth];
        if (firstOpen && firstOpen.type === 'blockquote' && prevWasLazy) {
          activePara.lines.push('    ' + lineText.replace(/^[ \t]+/, ''));
        } else {
          activePara.lines.push(lineText);
        }
        prevBlank = false;
        prevLazy = true;
        continue;
      }
      if (!canInterruptPara(lineText, textCol)) {
        // lazy continuation: the line belongs to the open paragraph even
        // though it does not match the paragraph's containers. The
        // containers stay open (do NOT pop them) so a later line that does
        // match them continues the same block; append this line to it.
        // A lazy line indented 4+ columns loses exactly 4 of them
        // (indented-code indent); fewer are kept as-is.
        let lazyText = lineText;
        if (indentOf(lineText, textCol) >= 4) {
          lazyText = stripIndent(lineText, textCol, 4);
        }
        activePara.lines.push(lazyText);
        prevBlank = false;
        prevLazy = true;
        continue;
      }
    }
    if (matchedDepth < openStack.length) {
      closeToDepth(matchedDepth);
    }

    // ---------- Phase 2: block start detection ----------
    let itemStart = false, itemMarker = null;
    let done = false;
    if (blankText) {
      // marked's table regex does not treat a tab-only line as blank
      // (its blank-line exclusion is ` *\n`, spaces only), so a tab
      // line inside a table is an empty row. If the open paragraph is
      // a table (header + delimiter), keep the tab line as one of its
      // lines instead of closing the paragraph.
      if (activePara && lineText.indexOf('\t') !== -1 && activePara.lines.length >= 2 && parseTableDelimiter(activePara.lines[1])) {
        activePara.lines.push(lineText);
        prevBlank = false;
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
      if (activePara) {
        activePara.endsWithBlank = true;
        const topBlock = topNode();
        if (topBlock.type === 'item') topBlock.endsWithBlank = true;
      }
      closeParagraph();
      prevBlank = true;
      prevBlankTop = topNode().type;
      prevBlankQuoted = raw.indexOf('>') !== -1;
      continue;
    }

    // setext underline for an open paragraph: the WHOLE paragraph
    // (all its lines) becomes the heading; leading whitespace at the
    // start of the text and trailing whitespace at the end are stripped.
    // EXCEPTION: when the open paragraph is a table (header + delimiter
    // already present), a setext underline is a table ROW, not a heading
    // -- marked's table-body regex does not exclude setext underlines
    // (doc-26: '=========' right after a table row is a row).
    if (activePara) {
      const setextLevel = matchSetext(lineText, textCol);
      if (setextLevel > 0) {
        if (tryTable(activePara.lines)) {
          activePara.lines.push(lineText);
          prevBlank = false;
          continue;
        }
        const paraParent = activeParaParent;
        const paraNode = activePara;
        closeParagraph(); // finalises: extracts ref defs, sets para.text
        const childIdx = paraParent.children.indexOf(paraNode);
        if (childIdx !== -1 && paraNode.text !== undefined) {
          paraParent.children[childIdx] = { type: 'heading', level: setextLevel, text: paraNode.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') };
          prevBlank = false;
          continue;
        }
        // the paragraph was dropped (only ref defs) or became a table:
        // the underline is not a heading -- fall through and process
        // it as a fresh block
      }
    }

    // ---- indented code (paragraph has priority when one is open) ----
    if (!activePara) {
      const indent = indentOf(lineText, textCol);
      if (indent >= 4) {
        const codeText = stripIndent(lineText, textCol, 4);
        // An indented code block starts. If the previous sibling is a
        // paragraph, the code is a continuation of it (marked: an
        // indented code block cannot interrupt a paragraph). Since
        // activePara is null here, no paragraph is open -- but a paragraph
        // may have been closed by a blank line; only a paragraph that is
        // STILL open blocks. So start the code block.
        const parentNode = topNode();
        markLooseAfterBlank();
        const blockNode = { type: 'code_block', lang: '', lines: [codeText] };
        parentNode.children.push(blockNode);
        // consume following indented/blank lines
        let scanLine = lineNo + 1;
        while (scanLine < sourceLines.length) {
          const nextRaw = sourceLines[scanLine];
          const stripped = stripContainersForLine(nextRaw, openStack);
          if (!stripped) break;
          if (isBlankStr(stripped.text)) {
            // a blank line is part of the code only if a later
            // non-blank line still belongs to the block (indented >= 4
            // after the containers); its spaces beyond the 4-column
            // indent are kept (cm-112)
            let lookahead = scanLine + 1, laterMatch = null;
            while (lookahead < sourceLines.length) {
              const later = stripContainersForLine(sourceLines[lookahead], openStack);
              if (!later) break;
              if (!isBlankStr(later.text)) { laterMatch = later; break; }
              lookahead++;
            }
            if (laterMatch && indentOf(laterMatch.text, laterMatch.col) >= 4) {
              blockNode.lines.push(stripIndent(stripped.text, stripped.col, 4) ?? '');
              scanLine++; continue;
            }
            break;
          }
          if (indentOf(stripped.text, stripped.col) >= 4) {
            blockNode.lines.push(stripIndent(stripped.text, stripped.col, 4));
            scanLine++;
          } else break;
        }
        // drop trailing blank lines
        while (blockNode.lines.length > 0 && blockNode.lines[blockNode.lines.length - 1] === '') blockNode.lines.pop();
        lineNo = scanLine - 1;
        prevBlank = false;
        continue;
      }
    }

    // ---- fenced code ----
    const fenceInfo = matchFence(lineText, textCol);
    if (fenceInfo) {
      const parentNode = topNode();
      markLooseAfterBlank();
      const blockNode = { type: 'code_block', lang: fenceInfo.lang, fenced: true, fenceCh: fenceInfo.ch, fenceLen: fenceInfo.len, lines: [] };
      parentNode.children.push(blockNode);
      closeParagraph();
      let scanLine = lineNo + 1;
      while (scanLine < sourceLines.length) {
        const nextRaw = sourceLines[scanLine];
        const stripFail = {};
        const stripped = stripContainersForLine(nextRaw, openStack, stripFail);
        if (!stripped) {
          // the line does not match the containers. A lazy line fails
          // only on a list-item indent: it belongs to the fenced
          // block as-is (marked lexes the fence from the item text,
          // which includes lazy lines). A missing blockquote marker
          // means the line is outside the quote (a code block ends
          // the quote's lazy continuation) -- the fence ends too.
          // A blank line outside the containers ends the block.
          if (isBlankStr(nextRaw)) break;
          if (stripFail.reason !== 'item') break;
          if (matchFenceClose(nextRaw, 0, fenceInfo.ch, fenceInfo.len)) { scanLine++; break; }
          // a lazy line is part of the fence only when the previous
          // line is not itself a block start (marked's list-item text
          // building breaks a lazy line after a fence/heading/html/hr
          // line: the item text ends there, so the fence has no
          // content after its opening line -- doc-17's empty toml
          // fence). The previous line is the last content line, or
          // the opening fence line when the block is still empty.
          const prevText = blockNode.lines.length > 0 ? blockNode.lines[blockNode.lines.length - 1] : lineText;
          if (matchFence(prevText, 0) || matchATX(prevText, 0) || matchHR(prevText, 0)) break;
          { const htmlTag = matchHtmlBlock(prevText, 0); if (htmlTag > 0 && htmlTag <= 6) break; }
          // A lazy line starts a new block when its content AFTER the
          // containers that did match is a block start. The raw line's
          // indent is misleading: a list marker at raw indent 4
          // ('    + ...') is a new item once the outer item's indent
          // is stripped (doc-12/doc-36).
          const restAfter = (stripFail.pad > 0 ? ' '.repeat(stripFail.pad) : '') + nextRaw.slice(stripFail.pos);
          const restCol = stripFail.col - stripFail.pad;
          const restIndent = indentOf(restAfter, restCol);
          let isBlockStart = false;
          if (restIndent < 4) {
            let wsPos = 0;
            while (wsPos < restAfter.length && (restAfter.charCodeAt(wsPos) === 32 || restAfter.charCodeAt(wsPos) === 9)) wsPos++;
            if (wsPos < restAfter.length && restAfter.charCodeAt(wsPos) === 62) isBlockStart = true;
            else if (matchListMarker(restAfter.slice(restIndent), restCol + restIndent)) isBlockStart = true;
          }
          if (!isBlockStart && (matchATX(restAfter, restCol) || matchHR(restAfter, restCol))) isBlockStart = true;
          if (!isBlockStart) { const htmlTag = matchHtmlBlock(restAfter, restCol); if (htmlTag > 0 && htmlTag <= 6) isBlockStart = true; }
          if (isBlockStart) break;
          blockNode.lines.push(nextRaw);
          scanLine++;
          continue;
        }
        if (isBlankStr(stripped.text)) {
          // a blank line is part of the code only if a later non-blank
          // line still belongs to the block (the block continues
          // after it); otherwise the block ends before it (cm-128: a
          // blank line without a '>' does not belong to a fenced block
          // inside a blockquote). A blank line's spaces (dedented) are
          // kept as code content. A later line belongs to the block
          // when it matches the containers, when it is a closing
          // fence, or when it is a lazy continuation line.
          let lookahead = scanLine + 1, laterMatch = null;
          while (lookahead < sourceLines.length) {
            const lookFail = {};
            const later = stripContainersForLine(sourceLines[lookahead], openStack, lookFail);
            if (!later) {
              if (isBlankStr(sourceLines[lookahead])) break;
              if (lookFail.reason !== 'item') break;
              // lazy line: a closing fence or a content line (whose
              // previous line is not a block start) continues the
              // block; a block-starting line ends it
              if (matchFenceClose(sourceLines[lookahead], 0, fenceInfo.ch, fenceInfo.len)) { laterMatch = { text: sourceLines[lookahead], col: 0 }; break; }
              const prevTextK = blockNode.lines.length > 0 ? blockNode.lines[blockNode.lines.length - 1] : lineText;
              if (matchFence(prevTextK, 0) || matchATX(prevTextK, 0) || matchHR(prevTextK, 0)) break;
              { const htmlTag = matchHtmlBlock(prevTextK, 0); if (htmlTag > 0 && htmlTag <= 6) break; }
              // same as the main lazy-line branch: judge the block
              // start on the content after the containers that did
              // match, not on the raw line
              const restAfterK = (lookFail.pad > 0 ? ' '.repeat(lookFail.pad) : '') + sourceLines[lookahead].slice(lookFail.pos);
              const restColK = lookFail.col - lookFail.pad;
              const restIndentK = indentOf(restAfterK, restColK);
              let isBlockK = false;
              if (restIndentK < 4) {
                let wsPos = 0;
                while (wsPos < restAfterK.length && (restAfterK.charCodeAt(wsPos) === 32 || restAfterK.charCodeAt(wsPos) === 9)) wsPos++;
                if (wsPos < restAfterK.length && restAfterK.charCodeAt(wsPos) === 62) isBlockK = true;
                else if (matchListMarker(restAfterK.slice(restIndentK), restColK + restIndentK)) isBlockK = true;
              }
              if (!isBlockK && (matchATX(restAfterK, restColK) || matchHR(restAfterK, restColK))) isBlockK = true;
              if (!isBlockK) { const htmlTag = matchHtmlBlock(restAfterK, restColK); if (htmlTag > 0 && htmlTag <= 6) isBlockK = true; }
              if (isBlockK) break;
              laterMatch = { text: sourceLines[lookahead], col: 0 }; break;
            }
            if (!isBlankStr(later.text)) { laterMatch = later; break; }
            lookahead++;
          }
          if (laterMatch) {
            const blankIndent = indentOf(stripped.text, stripped.col);
            const fenceIndent = indentOf(lineText, textCol);
            // marked's Dt dedents ONLY backtick fences (its regex is
            // /^(\s+)(?:```)/ -- a tilde fence never matches); a tilde
            // fence keeps its content lines as-is
            blockNode.lines.push(blankIndent > 0 && fenceInfo.ch === '`' ? stripLeadingWSChars(stripped.text, fenceIndent) : stripped.text);
            scanLine++; continue;
          }
          break;
        }
        if (matchFenceClose(stripped.text, stripped.col, fenceInfo.ch, fenceInfo.len)) { scanLine++; break; }
        // dedent (up to the fence's indent) -- character-based, backtick
        // fences only (see above)
        const lineIndent = indentOf(stripped.text, stripped.col);
        const fenceIndent = indentOf(lineText, textCol);
        blockNode.lines.push(lineIndent > 0 && fenceInfo.ch === '`' ? stripLeadingWSChars(stripped.text, fenceIndent) : stripped.text);
        scanLine++;
      }
      // trailing newline of a fenced block: the block's content ends with
      // a newline (CommonMark: the text between fences, lines joined)
      lineNo = scanLine - 1;
      prevBlank = false;
      continue;
    }

    // ---- ATX heading ----
    const atxHead = matchATX(lineText, textCol);
    if (atxHead) {
      const parentNode = topNode();
      markLooseAfterBlank();
      closeParagraph();
      parentNode.children.push({ type: 'heading', level: atxHead.level, text: atxHead.text });
      prevBlank = false;
      continue;
    }

    // ---- thematic break ----
    if (matchHR(lineText, textCol)) {
      const parentNode = topNode();
      markLooseAfterBlank();
      closeParagraph();
      parentNode.children.push({ type: 'hr' });
      prevBlank = false;
      continue;
    }

    // ---- HTML block ----
    const htmlKind = matchHtmlBlock(lineText, textCol);
    if (htmlKind > 0) {
      // type 7 cannot interrupt a paragraph
      if (htmlKind === 7 && activePara) {
        // fall through to paragraph continuation below
      } else {
        const parentNode = topNode();
        markLooseAfterBlank();
        closeParagraph();
        // the block's end: types 1-5 end at their closing marker (a
        // blank line is content, not a terminator); types 6-7 end at a
        // blank line. Type 7 is a complete tag alone on its start line,
        // but the block continues until a blank line like the others.
        const blockNode = { type: 'html_block', htmlType: htmlKind, lines: [lineText] };
        parentNode.children.push(blockNode);
        let scanLine = lineNo + 1;
        const endMarker = htmlKind === 1 ? (lineText.toLowerCase().includes('<pre') ? '</pre>' : lineText.toLowerCase().includes('<script') ? '</script>' : lineText.toLowerCase().includes('<style') ? '</style>' : '</textarea>') :
          htmlKind === 2 ? '-->' :
          htmlKind === 3 ? '?>' :
          htmlKind === 4 ? '>' :
          htmlKind === 5 ? ']]>' : null;
        let seenBlank = false;
        // when the start line already contains the closing marker
        // (e.g. '<style>...</style>' or '<!-- foo -->'), the block is
        // just that line -- no further lines are consumed
        if (!(endMarker && lineText.toLowerCase().includes(endMarker))) {
          while (scanLine < sourceLines.length) {
            const nextRaw = sourceLines[scanLine];
            const stripped = stripContainersForLine(nextRaw, openStack);
            if (!stripped) break;
            if (endMarker) {
              // types 1-5: every line is content until the closing marker
              blockNode.lines.push(stripped.text);
              if (stripped.text.toLowerCase().includes(endMarker)) { scanLine++; break; }
              scanLine++;
              continue;
            }
            // types 6-7: a blank line ends the block
            if (isBlankStr(stripped.text)) {
              seenBlank = true;
              scanLine++; break;
            }
            blockNode.lines.push(stripped.text);
            scanLine++;
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
        let nextBlank = false;
        if (scanLine < sourceLines.length) {
          if (sourceLines[scanLine].length === 0) nextBlank = true;
          else {
            const strippedNext = stripContainersForLine(sourceLines[scanLine], openStack);
            if (strippedNext && strippedNext.text === '') nextBlank = true;
          }
        }
        const endsBlank = blockNode.lines.length > 0 && isBlankStr(blockNode.lines[blockNode.lines.length - 1]);
        // A trailing newline at the end of the DOCUMENT only reaches
        // this block when it is at the top level: inside a list item
        // (or blockquote) the container's text is trimmed, so the
        // document's final newline does not add one (doc-30: an HTML
        // comment inside a tight list item must not gain '\n').
        const endsNewline = openStack.length === 1 && endsWithNewline;
        let trailingNewline;
        if (seenBlank || nextBlank || endsBlank) trailingNewline = false;
        else if (htmlKind <= 5) trailingNewline = (scanLine - 1) < sourceLines.length - 1 || endsNewline;
        else trailingNewline = scanLine >= sourceLines.length && endsNewline;
        blockNode.trailingNL = trailingNewline;
        lineNo = scanLine - 1;
        prevBlank = seenBlank;
        if (seenBlank) prevBlankTop = topNode().type;
        continue;
      }
    }

    // ---- blockquote ----
    {
      let scanPos = 0;
      while (scanPos < lineText.length && (lineText.charCodeAt(scanPos) === 32 || lineText.charCodeAt(scanPos) === 9)) scanPos++;
      if (scanPos < lineText.length && lineText.charCodeAt(scanPos) === 62 && scanPos - 0 < 4) {
        const parentNode = topNode();
        markLooseAfterBlank();
        closeParagraph();
        const blockNode = { type: 'blockquote', children: [] };
        parentNode.children.push(blockNode);
        openStack.push(blockNode);
        // the marker is stripped by the next iteration's container
        // matching (the same line is re-processed at the new depth)
        lineNo--;
        prevBlank = false;
        continue;
      }
    }

    // ---- list item ----
    {
      const indent = indentOf(lineText, textCol);
      if (indent < 4) {
        const marker = matchListMarker(lineText.slice(indent), textCol + indent);
        if (marker) {
          // a list item can interrupt a paragraph ONLY when it is not
          // empty and the marker is '-', '+', '*' (bullet) or an ordered
          // marker starting at 1 (an empty item never interrupts).
          // EXCEPTION: inside a list item, marked lexes the content
          // with state.top=false, so its paragraphs are single-line
          // "text" tokens and ANY list marker (any ordered start)
          // interrupts them. Inside a blockquote (state.top=true) or
          // at top level the start-1 rule stands.
          let insideItem = false;
          if (activePara) {
            for (let stackIdx = activeParaDepth - 1; stackIdx >= 1; stackIdx--) {
              const nodeType = openStack[stackIdx].type;
              if (nodeType === 'item') { insideItem = true; break; }
              if (nodeType === 'blockquote') break;
            }
          }
          const mayInterrupt = !activePara || (!marker.empty && (!marker.ordered || marker.start === 1 || insideItem));
          if (mayInterrupt) {
            const parentNode = topNode();
            markLooseAfterBlank();
            closeParagraph();
            // find or create the list. When the line matched an existing
            // list in Phase 1, topNode() IS that list (already on the stack)
            // and the new item belongs to it -- do not push it again.
            // Otherwise the list is the parent's last child when it
            // matches, else a new list under the parent.
            const delimiter = marker.ordered ? lineText.slice(indent + marker.markerLen - 1, indent + marker.markerLen) : marker.bullet;
            let listNode = null;
            let listOnOpenStack = false;
            if (parentNode.type === 'list' && parentNode.ordered === marker.ordered && parentNode.delimiter === delimiter) {
              listNode = parentNode;
              listOnOpenStack = true;
            } else {
              const lastChild = parentNode.children[parentNode.children.length - 1];
              if (lastChild && lastChild.type === 'list' && lastChild.ordered === marker.ordered && lastChild.delimiter === delimiter) {
                listNode = lastChild;
              } else {
                listNode = { type: 'list', ordered: marker.ordered, delimiter: delimiter, start: marker.ordered ? marker.start : undefined, loose: false, children: [] };
                parentNode.children.push(listNode);
              }
            }
            const itemNode = { type: 'item', children: [], endsWithBlank: false, hasBlankBetween: false };
            // content indent relative to the line's content start
            // (textCol), so a blockquote prefix does not shift it
            itemNode.relIndent = marker.contentIndent - textCol;
            listNode.children.push(itemNode);
            if (!listOnOpenStack) openStack.push(listNode);
            openStack.push(itemNode);
            // An empty item (nothing after the marker) is consumed as-is:
            // the item stays open for later indented lines, and the line
            // must NOT count as a blank line after the item (an indented
            // line following it is still the item's content).
            if (marker.empty) {
              prevBlank = false;
              continue;
            }
            // Re-process this line at the new depth: the item's content
            // (after the marker) becomes the line's content. Replace the
            // marker span with spaces so the next pass's container
            // matching strips exactly the item's content indent: the
            // remainder starts at column marker.contentIndent, and the
            // replacement puts it at column column + S where S =
            // marker.contentIndent - column (column = column of the content's
            // first char in the raw line; S >= 1 for a non-empty item
            // because the content's indent covers the padding spaces).
            // When the container prefix ends with a blockquote '>'
            // that consumed no following space in this pass (e.g.
            // '>+ At'), the re-processed line's blockquote WILL eat
            // one of the replacement spaces as its optional space, so
            // add one extra to keep the item indent aligned.
            const restText = sliceCols(lineText, textCol, marker.contentIndent - textCol) ?? '';
            const quoteEatsSpace = cursor > 0 && raw.charCodeAt(cursor - 1) === 62 ? 1 : 0;
            sourceLines[lineNo] = raw.slice(0, cursor) + ' '.repeat(marker.contentIndent - column + quoteEatsSpace) + restText;
            lineNo--;
            prevBlank = false;
            continue;
          }
        }
      }
    }

    // ---- paragraph continuation / new paragraph ----
    {
      const parentNode = topNode();
      if (activePara) {
        // continuation line. Inside a list item, a line indented 4+
        // columns (after the item indent) loses 4 of them (the
        // indented-code indent is stripped during the list's outdent);
        // at top level and in blockquotes the indent is kept as-is.
        let contText = lineText;
        if (parentNode.type === 'item' && indentOf(contText, textCol) >= 4) {
          contText = stripIndent(contText, textCol, 4);
        }
        activePara.lines.push(contText);
      } else {
        markLooseAfterBlank();
        const blockNode = { type: 'paragraph', lines: [lineText] };
        parentNode.children.push(blockNode);
        activePara = blockNode;
        activeParaParent = parentNode;
        activeParaDepth = openStack.length;
      }
      prevBlank = false;
      continue;
    }
  }
  closeParagraph();
  return rootDoc;
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
// Render the block tree to HTML
// ---------------------------------------------------------------------------
function renderBlock(block, linkDefs, html) {
  switch (block.type) {
    case 'document': {
      for (const child of block.children) renderBlock(child, linkDefs, html);
      return;
    }
    case 'paragraph': {
      html.push('<p>');
      if (block.task === 0) html.push('<input disabled="" type="checkbox"> ');
      else if (block.task === 1) html.push('<input checked="" disabled="" type="checkbox"> ');
      parseInline(block.text, linkDefs, html, false, null);
      html.push('</p>\n');
      return;
    }
    case 'heading': {
      html.push('<h' + block.level + '>');
      parseInline(block.text, linkDefs, html, false, null);
      html.push('</h' + block.level + '>\n');
      return;
    }
    case 'hr': {
      html.push('<hr>\n');
      return;
    }
    case 'code_block': {
      html.push('<pre><code');
      if (block.lang) {
        html.push(' class="language-');
        escapeAttr(block.lang, html);
        html.push('"');
      }
      html.push('>');
      // escape the code text directly (no entities in code blocks).
      // The content is the lines joined by '\n'; the output ends with
      // exactly one trailing '\n' when the block is non-empty (a fenced
      // block's trailing blank lines contribute only up to that one
      // newline; an empty block has none).
      const codeText = block.lines.join('\n');
      escapeText(codeText.length > 0 ? (codeText.endsWith('\n') ? codeText : codeText + '\n') : codeText, html);
      html.push('</code></pre>\n');
      return;
    }
    case 'html_block': {
      // an HTML block's lines are output verbatim; trailing blank lines
      // (and the blank line that ends the block) do not contribute.
      // A block terminated by a blank line has no trailing newline;
      // one terminated by EOF, another block, or its closing tag does.
      let htmlText = block.lines.join('\n');
      // strip trailing blank lines (spaces-only lines at the end)
      htmlText = htmlText.replace(/[ \t]*(\n[ \t]*)+$/, '');
      if (htmlText.length > 0) html.push(htmlText);
      if (block.trailingNL !== false) html.push('\n');
      return;
    }
    case 'blockquote': {
      html.push('<blockquote>\n');
      for (const child of block.children) renderBlock(child, linkDefs, html);
      html.push('</blockquote>\n');
      return;
    }
    case 'list': {
      const tight = computeTight(block);
      const tagName = block.ordered ? 'ol' : 'ul';
      html.push('<' + tagName);
      if (block.ordered && block.start !== undefined && block.start !== 1) {
        html.push(' start="' + block.start + '"');
      }
      html.push('>\n');
      for (const item of block.children) renderItem(item, linkDefs, html, tight);
      html.push('</' + tagName + '>\n');
      return;
    }
    case 'table': {
      html.push('<table>\n<thead>\n<tr>\n');
      for (let idx = 0; idx < block.header.length; idx += 1) {
        const align = block.aligns[idx];
        html.push('<th' + (align ? ' align="' + align + '"' : '') + '>');
        parseInline(block.header[idx], linkDefs, html, false, null);
        html.push('</th>\n');
      }
      html.push('</tr>\n</thead>\n');
      // a table with no body rows has no <tbody> at all (gfm-205)
      if (block.rows.length === 0) { html.push('</table>\n'); return; }
      html.push('<tbody>');
      for (const row of block.rows) {
        html.push('<tr>\n');
        for (let idx = 0; idx < block.header.length; idx += 1) {
          const align = block.aligns[idx];
          html.push('<td' + (align ? ' align="' + align + '"' : '') + '>');
          parseInline(row[idx], linkDefs, html, false, null);
          html.push('</td>\n');
        }
        html.push('</tr>\n');
      }
      html.push('</tbody></table>\n');
      return;
    }
  }
}

// Render a list item. In a tight list, a paragraph child is rendered
// without the <p> wrapper (its inline content only); in a loose list it
// keeps the <p> wrapper. A tight list item containing a single paragraph
// renders the paragraph inline; the <li> tags wrap the content.
function renderItem(listItem, linkDefs, html, isTight) {
  html.push('<li>');
  const children = listItem.children;
  // GFM task list: if the item's first child is a paragraph whose text
  // starts with '[ ] ' / '[x] ' / '[X] ', it renders a checkbox input
  // at the start of that paragraph and the marker is dropped.
  if (children.length > 0 && children[0].type === 'paragraph') {
    const firstText = children[0].text;
    if (firstText.length >= 4 && firstText[0] === '[' && firstText[2] === ']' && firstText[3] === ' ') {
      const marker = firstText[1];
      if (marker === ' ') { children[0].task = 0; children[0].text = firstText.slice(4); }
      else if (marker === 'x' || marker === 'X') { children[0].task = 1; children[0].text = firstText.slice(4); }
    }
  }
  // render each child; in a tight list, paragraph children render inline
  // (no <p> wrapper, no trailing newline), and no extra newline is ever
  // added between children -- blocks carry their own trailing newline
  for (let idx = 0; idx < children.length; idx += 1) {
    const child = children[idx];
    if (child.type === 'paragraph' && isTight) {
      if (child.task === 0) html.push('<input disabled="" type="checkbox"> ');
      else if (child.task === 1) html.push('<input checked="" disabled="" type="checkbox"> ');
      parseInline(child.text, linkDefs, html, false, null);
    } else {
      renderBlock(child, linkDefs, html);
    }
  }
  html.push('</li>\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// parse(input): render Markdown to HTML, byte-identical to marked 18.1.3
// (with headerIds off, mangle off, GFM on) on the test cases.
function parse(input) {
  // normalise line endings and NULs
  input = input.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
  const sourceLines = input.split('\n');
  // a trailing newline produces a final empty line that is not a real line
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop();
  // fresh per-document inline state (inLink is set by raw <a> tags and
  // must not leak from a previous document)
  inLink = false;
  const linkDefs = new Map();
  const rootDoc = parseBlocks(sourceLines, linkDefs, input.endsWith('\n'));
  const html = [];
  renderBlock(rootDoc, linkDefs, html);
  return html.join('');
}

export default parse;
export { parse };
