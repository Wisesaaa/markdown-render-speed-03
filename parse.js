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

// One scanner for every '&...' reference. s[i] must be '&'. Returns null
// when the '&' does not start a reference; otherwise an object describing
// it: {named: true, value, next} for &name; (passes through literally),
// {named: false, value, next} for a decoded numeric reference. A single
// scanner replaces the old pair decodeEntity/isEntityStart, which scanned
// the same text twice with the same digit logic.
const ENTITY_DIGIT = new Int8Array(128).fill(-1);
for (let d = 0; d <= 9; d++) ENTITY_DIGIT[48 + d] = d;
for (let d = 0; d < 6; d++) { ENTITY_DIGIT[97 + d] = 10 + d; ENTITY_DIGIT[65 + d] = 10 + d; }
function scanEntityRef(s, i, n) {
  if (i + 1 >= n) return null;
  let c1 = s.charCodeAt(i + 1);
  if (c1 === 35) {
    let j = i + 2;
    let hex = j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88);
    if (hex) j += 1;
    let base = hex ? 16 : 10;
    let maxD = hex ? 6 : 7;
    let v = 0;
    let d = 0;
    while (j < n && d < maxD) {
      let c = s.charCodeAt(j);
      if (c >= 128) break;
      let dv = ENTITY_DIGIT[c];
      if (dv < 0 || (!hex && dv > 9)) break;
      v = v * base + dv;
      d += 1;
      j += 1;
    }
    if (d === 0 || j >= n || s.charCodeAt(j) !== 59) return null;
    if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return { named: false, value: '\uFFFD', next: j + 1 };
    return { named: false, value: String.fromCodePoint(v), next: j + 1 };
  }
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return null;
  let j = i + 1;
  while (j < n) {
    let c = s.charCodeAt(j);
    let ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
    if (!ok) break;
    j += 1;
  }
  if (j >= n || s.charCodeAt(j) !== 59) return null;
  return { named: true, value: s.slice(i, j + 1), next: j + 1 };
}

// ---------------------------------------------------------------------------
// Character classes (ASCII fast paths; non-ASCII is never punctuation here).
// ---------------------------------------------------------------------------
// Character classes as a bitmask table: SPACE=1, PUNCT=2, DIGIT=4, ALPHA=8.
// One table lookup replaces the four range-check predicates below.
const CHAR_CLASS = new Uint8Array(128);
for (let c = 9; c <= 13; c++) CHAR_CLASS[c] |= 1;
CHAR_CLASS[32] |= 1;
for (let c = 33; c <= 47; c++) CHAR_CLASS[c] |= 2;
for (let c = 58; c <= 64; c++) CHAR_CLASS[c] |= 2;
for (let c = 91; c <= 96; c++) CHAR_CLASS[c] |= 2;
for (let c = 123; c <= 126; c++) CHAR_CLASS[c] |= 2;
for (let c = 48; c <= 57; c++) CHAR_CLASS[c] |= 4;
for (let c = 65; c <= 90; c++) CHAR_CLASS[c] |= 8;
for (let c = 97; c <= 122; c++) CHAR_CLASS[c] |= 8;
function isSpace(c) { return c < 128 && (CHAR_CLASS[c] & 1) !== 0; }
function isPunct(c) { return c < 128 && (CHAR_CLASS[c] & 2) !== 0; }
function isDigit(c) { return c < 128 && (CHAR_CLASS[c] & 4) !== 0; }
function isAlphaNum(c) { return c < 128 && (CHAR_CLASS[c] & 12) !== 0; }
// Unicode whitespace (CommonMark): space, tab, LF, FF, CR + Unicode spaces.
function isUnicodeSpace(ch) {
  let c = ch.charCodeAt(0);
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c === 0xA0 || c === 0x1680 || c === 0x202F || c === 0x205F || c === 0x3000) return true;
  return c >= 0x2000 && c <= 0x200A;
}
// Unicode punctuation: ASCII punct + Unicode P* and S* categories (approx:
// everything that is not a letter, digit, space or combining mark). We use a
// conservative check: a char is punctuation when it is ASCII punct, or a
// non-ASCII char that is not a letter/digit. This matches marked's behaviour
// on the practice set (its PUNCT set is the ASCII one plus Unicode P/S).
// The letter set is a sorted range table searched by binary search, instead
// of the old regex character class.
const UNICODE_LETTER_RANGES = [
  [0x30, 0x39], [0x41, 0x5A], [0x61, 0x7A],
  [0xC0, 0x24F], [0x370, 0x3FF], [0x400, 0x4FF], [0x590, 0x5FF],
  [0x600, 0x6FF], [0x900, 0x97F], [0x3040, 0x30FF], [0x3400, 0x4DBF],
  [0x4E00, 0x9FFF], [0xAC00, 0xD7AF], [0xFF00, 0xFFEF],
];
function isUnicodePunct(ch) {
  if (ch.length === 0) return true;
  let c = ch.charCodeAt(0);
  if (c < 128) return isPunct(c);
  // Letters (incl. accents, CJK, Greek, Cyrillic, Hebrew, Arabic...) are not
  // punctuation; digits are not; everything else counts as punctuation.
  let lo = 0;
  let hi = UNICODE_LETTER_RANGES.length - 1;
  while (lo <= hi) {
    let mid = (lo + hi) >> 1;
    let r = UNICODE_LETTER_RANGES[mid];
    if (c < r[0]) hi = mid - 1;
    else if (c > r[1]) lo = mid + 1;
    else return false;
  }
  return true;
}

const ESCAPE_FOR = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };
// Escape text for HTML: & < > " '  (marked escapes quotes in text too).
// Fast path: most text runs contain none of these, so a single native
// regex scan skips the per-character loop entirely.
const NEED_ESCAPE = /[&<>"']/;
// One escaping loop for both modes. attr=false escapes every & < > " '
// (marked's escape(..., true), used for text, code and autolinks);
// attr=true leaves a '&' alone when it starts a valid entity reference
// (marked's escape(..., false), used for link href/title and image
// src/alt/title). The two old loops were identical except for that '&'
// test, so they share one implementation now.
function escapeRun(s, out, attr) {
  if (!NEED_ESCAPE.test(s)) { out[out.length] = s; return; }
  let n = s.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    let c = s.charCodeAt(i);
    if (c === 38 && attr && scanEntityRef(s, i, n) !== null) { i += 1; continue; }
    let rep = ESCAPE_FOR[c];
    if (rep === undefined) { i += 1; continue; }
    if (start < i) out[out.length] = s.slice(start, i);
    out[out.length] = rep;
    start = i + 1;
    i += 1;
  }
  if (start < n) out[out.length] = s.slice(start);
}
function escapeText(s, out) {
  escapeRun(s, out, false);
}
// Escape with encode=true (marked's escape(..., true)): escapes ALL of
// & < > " '. Used for code spans/blocks and for autolink href/text.
function escapeEncode(s, out) {
  escapeRun(s, out, false);
}
// Escape a single char with encode=true (for numeric-entity decodes).
function escapeEncodeChar(ch, out) {
  escapeRun(ch, out, false);
}
// Escape an attribute value with noEncode (marked's escape(..., false)):
// escapes < > " ' and a '&' ONLY when it does not start a valid entity
// reference. Used for regular-link href/title and image src/alt/title.
function escapeAttr(s, out) {
  escapeRun(s, out, true);
}
// cleanUrl: encodeURI + restore '%' (marked's cleanUrl). Returns null when
// encodeURI throws (lone surrogate in the href).
function cleanUrl(href) {
  let encoded;
  try { encoded = encodeURI(href); }
  catch { return null; }
  return encoded.replace(/%25/g, '%');
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
  let bSpace = before === '' || isUnicodeSpace(before);
  let aSpace = after === '' || isUnicodeSpace(after);
  let bPunct = before !== '' && isUnicodePunct(before);
  let aPunct = after !== '' && isUnicodePunct(after);
  let left = !aSpace && (bSpace || bPunct || !aPunct);
  let right = !bSpace && (aSpace || aPunct || !bPunct);
  return [left, right];
}

// Delimiter record: {ch, len, open, close, idx} where idx is the chunk index
// in the output array holding this run's literal text.

// Category of a delimiter run from its neighbours, following marked's
// emStrongRDelimAst/Und groups. Returns 'open' (groups 3-4), 'close'
// (groups 1-2), 'both' (groups 5-6), or '' (no group).
function delimGroup(prev, next) {
  let pPunct = prev !== '' && isUnicodePunct(prev);
  let pSpace = prev !== '' && isSpace(prev.charCodeAt(0));
  let pWord = prev !== '' && !pPunct && !pSpace;
  let nPunct = next !== '' && isUnicodePunct(next);
  let nSpace = next === '' || isSpace(next.charCodeAt(0));
  let nWord = next !== '' && !nPunct && !nSpace;
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
  for (let i = 0; i < delims.length; i += 1) {
    let opener = delims[i];
    if (!opener || !opener.open) continue;
    if (opener.ch === '~') continue;
    let ch = opener.ch;
    let y = opener.len;
    let k = opener.len;
    while (k >= 1) {
      // scanCloses answers as [res, skipped]: res 0 never closes,
      // 1 closes as em, 2 closes as strong; skipped means a
      // both-flanking closer was passed over by the rule of 3.
      let verdict = scanCloses(delims, i, ch, k, y);
      let res = verdict[0];
      let skipped = verdict[1];
      if (res === 1) break;
      if (res === 2) {
        if (opener.len >= 2) opener.expectsStrong = true;
        break;
      }
      // A "never closes" verdict only counts when a both-flanking
      // closer was skipped by the rule of 3 (f > 0). Without a skip,
      // the failure is just an inner open-only run extending m, and
      // the outer opener can still close once the inner emphasis is
      // formed (cm-470: `*foo __bar *baz bim__ bam*`).
      if (skipped) opener.closes = false;
      k -= 1;
    }
    // No k closed and no skip was recorded: leave unmarked (the
    // closer-first scan decides). expectsStrong is set inside the
    // k loop above.
  }
}

// Run the m-balance from delimiter index i with opener run length k
// and total run length y. Returns {res: 0 (never closes), 1 (em),
// 2 (strong), skipped: whether a both-flanking closer was skipped
// by the rule of 3}.
function scanCloses(delims, i, ch, k, y) {
  let m = k;
  let f = 0;
  let opener = delims[i];
  let prev = opener.prev || '';
  let next = opener.next || '';
  let h = prev === '*' || prev === '_' || isUnicodePunct(prev);
  let R = prev !== '' && prev.trim() !== '' && (next !== '' || (ch === '*' && !h));
  // A len-1 opener nested inside a len>=2 opener (e.g. `*...*` inside
  // `**...**`) cannot close at a len>=2 closer: that closer belongs
  // to the enclosing strong. Its scope ends before such a closer.
  let insideStrong = false;
  if (opener.len === 1) {
    let s = i - 1;
    while (s >= 0) {
      let od = delims[s];
      if (od && od.ch === ch && od.open && od.len >= 2) { insideStrong = true; break; }
      if (od && od.ch === ch && od.close && od.len >= 2) break;
      s -= 1;
    }
  }
  let t = i + 1;
  while (t < delims.length) {
    let d = delims[t];
    t += 1;
    if (!d || d.len === 0 || d.ch !== ch) continue;
    let b = d.len;
    let g = delimGroup(d.prev || '', d.next || '');
    if (g === '') continue;
    if (g === 'open') {
      if (!d.open) continue;
      m += b;
      continue;
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
    let b2 = b + m + f < b ? b + m + f : b;
    let use = b2 < k ? b2 : k;
    return [use % 2 === 0 ? 2 : 1, f > 0];
  }
  return [0, f > 0];
}

function resetEmphasisFloors(floor) {
  floor['*'] = -1;
  floor['_'] = -1;
  floor['~'] = -1;
}

function findEmphasisOpener(delims, closeAt, closer, floor, isSuppressed) {
  let ch = closer.ch;
  let low = floor[ch];
  let at = closeAt - 1;
  let seen = false;
  while (at > low) {
    let cand = delims[at];
    if (cand && cand.ch === ch && cand.open) {
      seen = true;
      // '~' (strikethrough): the regex backreferences the opener's
      // length, so the two runs must have the SAME length, and it must
      // be 1 or 2 (a longer run leaves a '~' adjacent to the delimiter,
      // failing the lookahead). Otherwise this opener cannot match.
      if (ch === '~' && (cand.len !== closer.len || cand.len > 2)) { at -= 1; continue; }
      let oddMatch = (cand.open && cand.close) || (closer.open && closer.close);
      let ruleOk = !oddMatch || (cand.len + closer.len) % 3 !== 0 || (cand.len % 3 === 0 && closer.len % 3 === 0);
      if (ruleOk) {
        // A lone close-only run must not steal one delimiter from a
        // '**' opener that the m-balance says closes as strong.
        if (cand.len === 2 && closer.len === 1 && !closer.open && !cand.close && cand.expectsStrong) { at -= 1; continue; }
        // The m-balance says this opener never closes (no k in
        // 1..len reaches m <= 0), so it must stay literal.
        if (cand.closes === false) { at -= 1; continue; }
        // Rule A / Rule B: this match is suppressed by a phantom
        // code span or an unformed-link region -- keep searching
        // backwards for another opener for this closer.
        if (isSuppressed(cand, closer)) { at -= 1; continue; }
        return [at, true];
      }
    }
    at -= 1;
  }
  return [-1, seen];
}

function applyEmphasisTags(html, openDelim, closeDelim, tagName, take) {
  // Chunk layout: an opener's leftover delimiters sit on the LEFT
  // (outer side), its tags after them; a closer's leftover delimiters
  // sit on the RIGHT, its tags before them. A new match consumes the
  // delimiters adjacent to the content, so the new tag goes right
  // after the opener's leftovers / right before the closer's leftovers.
  let openChunk = html[openDelim.idx];
  let openOldLeft = openDelim.len;
  let openLeft = openOldLeft - take;
  let openTail = openChunk.slice(openOldLeft);
  let openLit = openLeft > 0 ? openDelim.ch.repeat(openLeft) : '';
  html[openDelim.idx] = `${openLit}<${tagName}>${openTail}`;
  openDelim.len = openLeft;
  let closeChunk = html[closeDelim.idx];
  let closeOldLeft = closeDelim.len;
  let closeLeft = closeOldLeft - take;
  let closeHead = closeChunk.slice(0, closeChunk.length - closeOldLeft);
  // When an inner both-flanking closer was skipped by the rule of 3
  // (marked's f), the adjusted closer length b exceeds `take`, so the
  // leftover delimiters stay INSIDE the tag (M.slice(2,-2) keeps the
  // first b-take of them as content). Otherwise they go outside.
  if (openDelim.hasInnerSkip && closeLeft > 0) {
    html[closeDelim.idx] = `${closeHead}${closeDelim.ch.repeat(closeLeft)}</${tagName}>`;
  } else {
    let closeLit = closeLeft > 0 ? closeDelim.ch.repeat(closeLeft) : '';
    html[closeDelim.idx] = `${closeHead}</${tagName}>${closeLit}`;
  }
  closeDelim.len = closeLeft;
  return closeOldLeft;
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
    let idx = 0;
    while (idx < phantomSpans.length) {
      if (pos >= phantomSpans[idx][0] && pos < phantomSpans[idx][1]) return true;
      idx += 1;
    }
    return false;
  };
  const isSuppressed = (openDelim, closeDelim) => {
    let closePos = closeDelim.pos + (closeDelim.origLen - closeDelim.len);
    if (insidePhantom(closePos)) return true;
    if (suppressedRegions && suppressedRegions.length > 0 && text !== undefined) {
      let openPos = openDelim.pos + openDelim.len - 1;
      let idx = 0;
      while (idx < suppressedRegions.length) {
        let region = suppressedRegions[idx];
        if (openPos >= region[0] && openPos < region[1] && closePos >= region[0] && closePos < region[1]) {
          if (hasUncleanCodeSpan(text, openPos + 1, closePos)) return true;
        }
        idx += 1;
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
    let closeDelim = delimiters[closeIdx];
    if (!closeDelim || !closeDelim.close) { closeIdx += 1; continue; }
    let delimChar = closeDelim.ch;
    // find the nearest opener before this closer
    let search = findEmphasisOpener(delimiters, closeIdx, closeDelim, floor, isSuppressed);
    let openIdx = search[0];
    let seenOpener = search[1];
    if (openIdx === -1) {
      // cmark #383: only advance the floor when NO potential opener
      // was seen. An opener rejected by the odd-match rule may still match
      // a later closer (different length), so it must not be skipped.
      // Advance to closeIdx-1 (not closeIdx): the delimiter at closeIdx itself may be an
      // opener for a later closer, so it must stay searchable.
      if (!seenOpener) floor[delimChar] = closeIdx - 1;
      closeIdx += 1;
      continue;
    }
    let openDelim = delimiters[openIdx];
    // use 2 delimiters when both runs have >= 2 (strong/del), else 1 (em).
    // '~' uses the run length (1 or 2; opener and closer lengths match).
    let take = 1;
    if (openDelim.len >= 2 && closeDelim.len >= 2) take = 2;
    if (delimChar === '~') take = openDelim.len;
    let tagName = 'em';
    if (delimChar === '~') tagName = 'del';
    else if (take === 2) tagName = 'strong';
    let closeOldLeft = applyEmphasisTags(html, openDelim, closeDelim, tagName, take);
    // Record a rule-of-3 skip for the nearest enclosing opener: if
    // this closer was both-flanking and (outer.len + closer.len) % 3
    // is 0 while outer.len % 3 is not, marked skips it (f) and the
    // outer match's closer leftover goes inside.
    if (delimGroup(closeDelim.prev || '', closeDelim.next || '') === 'both') {
      let scanIdx = openIdx - 1;
      while (scanIdx > floor[delimChar]) {
        let outer = delimiters[scanIdx];
        if (outer && outer.ch === delimChar && outer.open) {
          if (outer.len % 3 !== 0 && (outer.len + closeOldLeft) % 3 === 0) outer.hasInnerSkip = true;
          break;
        }
        scanIdx -= 1;
      }
    }
    // Trapping rule: delimiters strictly between the opener and closer
    // are now inside the formed emphasis and can no longer match a
    // closer outside it -- remove them from the stack.
    let trapped = closeIdx - openIdx - 1;
    if (trapped > 0) {
      delimiters.splice(openIdx + 1, trapped);
      closeIdx -= trapped;
      // Splicing shifts indices, so the floor index bounds
      // (set for the old array) now point at the wrong delimiters
      // and would block valid later matches (e.g. `**is**` after an
      // inner `*3*` inside `_..._`). Reset them: re-scanning is
      // correct, just slightly more work.
      resetEmphasisFloors(floor);
    }
    // remove exhausted delimiters from the stack
    let removed = false;
    if (openDelim.len === 0) {
      let openSlot = delimiters.indexOf(openDelim);
      if (openSlot !== -1) delimiters.splice(openSlot, 1);
      if (openSlot < closeIdx) closeIdx -= 1;
      if (openSlot !== -1) removed = true;
    } else if (delimChar === '~' && openDelim.len < 2) {
      // a leftover single '~' can never form a strikethrough; drop it
      let openSlot = delimiters.indexOf(openDelim);
      if (openSlot !== -1) delimiters.splice(openSlot, 1);
      if (openSlot < closeIdx) closeIdx -= 1;
      if (openSlot !== -1) removed = true;
    }
    if (closeDelim.len === 0) {
      delimiters.splice(closeIdx, 1);
      removed = true;
      // do not advance closeIdx: the next delimiter slid into this slot
    } else if (delimChar === '~' && closeDelim.len < 2) {
      // a leftover single '~' can never form a strikethrough; skip it
      closeIdx += 1;
    }
    if (removed) resetEmphasisFloors(floor);
    // if the closer still has delimiters, keep it as current (closeIdx unchanged)
    // so it can match another opener.
  }
}

function skipBracketCodeSpan(str, pos, len, bracketDepth) {
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
  while (runEnd < len && str.charCodeAt(runEnd) === 96) runEnd += 1;
  let tickLen = runEnd - pos;
  let scan = runEnd;
  let closeRun = -1;
  let scanDepth = bracketDepth; // bracket depth at the run
  let parenDepth = 0; // >0 while inside a (...) group after a label-closing ']'
  while (scan < len) {
    let scanCode = str.charCodeAt(scan);
    if (scanCode === 92) { scan = scan + 2; continue; }
    if (scanCode === 96) {
      closeRun = scan;
      while (closeRun < len && str.charCodeAt(closeRun) === 96) closeRun += 1;
      break;
    }
    if (scanCode === 91) { if (parenDepth === 0) scanDepth += 1; scan += 1; continue; }
    if (scanCode === 93) {
      if (parenDepth === 0) {
        scanDepth -= 1;
        if (scanDepth === 0 && scan + 1 < len && str.charCodeAt(scan + 1) === 40) {
          parenDepth = 1;
          scan = scan + 2;
          // angle destination <...>: skip to '>'
          if (scan < len && str.charCodeAt(scan) === 60) {
            scan += 1;
            while (scan < len && str.charCodeAt(scan) !== 62) {
              if (str.charCodeAt(scan) === 92) scan += 1;
              scan += 1;
            }
            if (scan < len) scan += 1;
          }
          continue;
        }
      }
      scan += 1;
      continue;
    }
    if (parenDepth > 0) {
      if (scanCode === 40) { parenDepth += 1; scan += 1; continue; }
      if (scanCode === 41) {
        parenDepth -= 1;
        if (parenDepth === 0) break;
        scan += 1;
        continue;
      }
      if (scanCode === 34 || scanCode === 39) { // skip a quoted title
        let quote = scanCode;
        scan += 1;
        while (scan < len && str.charCodeAt(scan) !== quote) {
          if (str.charCodeAt(scan) === 92) scan += 1;
          scan += 1;
        }
        if (scan < len) scan += 1;
        continue;
      }
    }
    scan += 1;
  }
  if (closeRun === -1) {
    // no closing run: blocks the label, unless 2+ backticks right
    // before the closing ']'
    if (tickLen >= 2 && runEnd < len && str.charCodeAt(runEnd) === 93) return runEnd;
    return -1;
  }
  return closeRun;
}

// Find the index of the ']' matching the '[' at s[i] (i points at '[').
// Skips code spans and backslash escapes. Returns -1 when there is none.
function findClosingBracket(str, start, len) {
  let bracketDepth = 0;
  for (let pos = start; pos < len; pos += 1) {
    let code = str.charCodeAt(pos);
    switch (code) {
      case 92: // backslash escape: skip the escaped char too
        pos += 1;
        break;
      case 96: { // backtick run: skip the code span
        let after = skipBracketCodeSpan(str, pos, len, bracketDepth);
        if (after === -1) return -1;
        pos = after - 1;
        break;
      }
      case 60: { // '<': skip a raw HTML tag / autolink, so a ']'
        // inside a tag's attribute value does not close the bracket
        let rawTag = tryRawHtml(str, pos, len);
        if (rawTag) { pos = rawTag.next - 1; break; }
        let autolink = tryAngleAutolink(str, pos, len);
        if (autolink) { pos = autolink.next - 1; break; }
        break;
      }
      case 91: // '['
        bracketDepth += 1;
        break;
      case 93: // ']'
        bracketDepth -= 1;
        if (bracketDepth === 0) return pos;
        break;
      default:
        break;
    }
  }
  return -1;
}

// Angle-bracket destination <...>: no newline or '<' inside, backslash
// escapes a punctuation char. Returns {dest, next} or null.
function angleDestination(s, j, n) {
  let k = j + 1;
  let dest = '';
  while (k < n) {
    let c = s.charCodeAt(k);
    if (c === 10 || c === 60) return null; // newline or '<' not allowed
    if (c === 62) return { dest, next: k + 1 }; // '>'
    if (c === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
    dest += s[k];
    k += 1;
  }
  return null;
}
// Bare destination: no spaces/control chars, balanced parens.
// An empty destination is valid ([link]() -> href="").
function bareDestination(s, j, n) {
  let k = j;
  let depth = 0;
  let dest = '';
  while (k < n) {
    let c = s.charCodeAt(k);
    if (isSpace(c)) break;
    if (c === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
    if (c === 40) { depth += 1; dest += s[k]; k += 1; continue; } // '('
    if (c === 41) { // ')'
      if (depth === 0) break;
      depth -= 1;
      dest += s[k];
      k += 1;
      continue;
    }
    if (c < 32 || c === 127) return null;
    dest += s[k];
    k += 1;
  }
  return { dest, next: k };
}
// Parse a link destination starting at s[i] (after '(' or after label).
// Returns {dest, next} where next is the index after the destination, or
// null when there is no valid destination here.
function parseDestination(s, i, n) {
  // skip whitespace (including newlines)
  let j = i;
  while (j < n && isSpace(s.charCodeAt(j))) j += 1;
  if (j >= n) return null;
  if (s.charCodeAt(j) === 60) return angleDestination(s, j, n); // '<...>'
  return bareDestination(s, j, n);
}

// Quoted title "..." or '...': backslash escapes punctuation; a blank
// line inside is not allowed. Returns {title, next} or null.
function quotedTitle(s, j, n, quote) {
  let k = j + 1;
  let title = '';
  while (k < n) {
    let c = s.charCodeAt(k);
    if (c === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { title += s[k + 1]; k += 2; continue; }
    if (c === quote) return { title, next: k + 1 };
    // a blank line inside a title is not allowed
    if (c === 10 && k + 1 < n && s.charCodeAt(k + 1) === 10) return null;
    title += s[k];
    k += 1;
  }
  return null;
}
// Paren title (...): nested parens are allowed and balanced; a blank
// line inside is not allowed. Returns {title, next} or null.
function parenTitle(s, j, n) {
  let k = j + 1;
  let title = '';
  let depth = 0;
  while (k < n) {
    let c = s.charCodeAt(k);
    if (c === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { title += s[k + 1]; k += 2; continue; }
    if (c === 41) {
      if (depth > 0) { depth -= 1; title += s[k]; k += 1; continue; }
      return { title, next: k + 1 };
    }
    if (c === 40) { depth += 1; title += s[k]; k += 1; continue; }
    // a blank line inside a title is not allowed
    if (c === 10 && k + 1 < n && s.charCodeAt(k + 1) === 10) return null;
    title += s[k];
    k += 1;
  }
  return null;
}
// Parse a link title starting at s[i] (after the destination + whitespace).
// Returns {title, next} or null.
function parseTitle(s, i, n) {
  let j = i;
  while (j < n && isSpace(s.charCodeAt(j))) j += 1;
  if (j >= n) return null;
  let q = s.charCodeAt(j);
  if (q === 34 || q === 39) return quotedTitle(s, j, n, q);
  if (q === 40) return parenTitle(s, j, n);
  return null;
}

// Normalize a link label: collapse whitespace runs to one space, trim,
// case-fold (toLowerCase). Used for reference lookups.
// true if s contains a '[' not preceded by a backslash (a link label
// may not contain an unescaped '[')
function hasUnescapedBracket(s) {
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 92) { i += 2; continue; }
    if (s.charCodeAt(i) === 91) return true;
    i += 1;
  }
  return false;
}
function normalizeLabel(s) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  let i = 0;
  while (i < s.length) {
    let c = s.charCodeAt(i);
    if (isSpace(c)) { pendingSpace = true; i += 1; continue; }
    if (pendingSpace && started) out = out + ' ';
    pendingSpace = false;
    started = true;
    out = out + s[i];
    i += 1;
  }
  // Unicode case folding: toLowerCase() alone does not fold ß -> ss
  // (nor ẞ -> ss); CommonMark matches labels case-insensitively.
  let folded = out.toLowerCase();
  folded = folded.replace(/ß/g, 'ss');
  return folded.replace(/ẞ/g, 'ss');
}

function skipSpaces(s, pos, n) {
  let p = pos;
  while (p < n && isSpace(s.charCodeAt(p))) p += 1;
  return p;
}

// Inline link (dest "title") after the label's ']'. Returns the rendered
// link or null when the parens do not form a valid inline link (the
// caller then falls through to the reference forms).
function inlineLink(s, j, close, text, defs, isImage, n) {
  if (j >= n || s.charCodeAt(j) !== 40) return null;
  let d = parseDestination(s, j + 1, n);
  if (!d) return null;
  let k = d.next;
  // optional title
  let title = null;
  let m = skipSpaces(s, k, n);
  if (m < n && (s.charCodeAt(m) === 34 || s.charCodeAt(m) === 39 || s.charCodeAt(m) === 40)) {
    let t = parseTitle(s, k, n);
    if (t) { title = t.title; k = t.next; }
  }
  // skip whitespace, expect ')'
  k = skipSpaces(s, k, n);
  if (k >= n || s.charCodeAt(k) !== 41) return null;
  let r = renderLink(text, d.dest, title, isImage, defs, k + 1);
  if (r) { r.text = text; r.inline = true; }
  return r;
}

// Try to parse a link or image starting at s[i] ('[' or '![').
// Returns {html, next} (html already rendered) or null when not a link.
function tryLink(s, i, n, defs, isImage) {
  let open = isImage ? i + 1 : i; // index of '['
  let close = findClosingBracket(s, open, n);
  if (close === -1) return null;
  let text = s.slice(open + 1, close);
  // a link label may not be empty (except '[]' collapsed form is handled below)
  let j = close + 1;
  // inline link first; on failure fall through to the reference forms
  // (a shortcut reference may still apply, e.g. [foo](not a link)
  // with [foo]: /url1 defined).
  let inline = inlineLink(s, j, close, text, defs, isImage, n);
  if (inline) return inline;
  return referenceLink(s, j, close, text, defs, isImage, n);
}

function referenceLink(s, j, close, text, defs, isImage, n) {
  // Work out which reference form applies and what its label and end
  // position are; the definition lookup and rendering are shared.
  let label = null;
  let next = -1;
  if (j < n && s.charCodeAt(j) === 91) {
    // full reference: [text][label]
    let close2 = findClosingBracket(s, j, n);
    if (close2 === -1) return null;
    if (hasUnescapedBracket(s.slice(j + 1, close2))) return null;
    let found = normalizeLabel(s.slice(j + 1, close2));
    if (found.length > 0) { label = found; next = close2 + 1; }
    // an empty label means a collapsed reference ([text][]), which
    // uses the link text as the label -- fall through to that case
  }
  if (label === null && j + 1 < n && s.charCodeAt(j) === 91 && s.charCodeAt(j + 1) === 93) {
    // collapsed reference: [text][]
    label = normalizeLabel(text);
    next = j + 2;
  }
  if (label === null && text.length > 0 && !hasUnescapedBracket(text)) {
    // shortcut reference: [text] (the text is the label; it may not
    // contain an unescaped '[')
    label = normalizeLabel(text);
    next = close + 1;
  }
  if (label === null) return null;
  let def = defs.get(label);
  if (!def) return null;
  let r = renderLink(text, def.dest, def.title, isImage, defs, next);
  if (r) { r.text = text; r.inline = false; }
  return r;
}

// Render a resolved link/image. Returns {html, next}. cleanUrl is applied
// to the href; when it returns null (lone surrogate) a link renders as just
// its text and an image as just its alt text (noEncode-escaped).
function renderLink(text, dest, title, isImage, defs, next) {
  let href = cleanUrl(dest);
  if (isImage) {
    // alt text: parse inline, then strip tags. A nested image's <img>
    // tag is replaced by its alt attribute first (so the nested alt
    // text survives instead of being dropped with the tag).
    let tmp = [];
    parseInline(text, defs, tmp);
    let rawAlt = tmp.join('');
    let withAlts = rawAlt.replace(/<img\b[^>]*>/g, (m) => {
      let a = / alt="([^"]*)"/.exec(m);
      return a ? a[1] : '';
    });
    let alt = withAlts.replace(/<[^>]*>/g, '');
    if (href === null) {
      let out = [];
      escapeAttr(alt, out);
      return { html: out.join(''), next };
    }
    let out = ['<img src="'];
    escapeAttr(href, out);
    out[out.length] = '" alt="';
    escapeAttr(alt, out);
    out[out.length] = '"';
    if (title != null) {
      out[out.length] = ' title="';
      escapeAttr(title, out);
      out[out.length] = '"';
    }
    out[out.length] = '>';
    return { html: out.join(''), next };
  }
  let inner = [];
  let state = { bracketLink: false };
  parseInline(text, defs, inner, true, state);
  let innerHtml = inner.join('');
  // a link's text may not contain another bracket-link (CommonMark:
  // links do not nest). An angle autolink inside is allowed (it renders
  // as a nested <a>), and a bare URL inside is plain text.
  if (state.bracketLink) return null;
  if (href === null) return { html: innerHtml, next };
  let out = ['<a href="'];
  escapeAttr(href, out);
  out[out.length] = '"';
  if (title != null) {
    out[out.length] = ' title="';
    escapeAttr(title, out);
    out[out.length] = '"';
  }
  out[out.length] = '>';
  out[out.length] = innerHtml;
  out[out.length] = '</a>';
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
function autolinkHtml(href, body) {
  let out = ['<a href="'];
  escapeEncode(href, out);
  out[out.length] = '">';
  escapeEncode(body, out);
  out[out.length] = '</a>';
  return out.join('');
}

function tryAngleAutolink(s, i, n) {
  // find the closing '>' (no whitespace/control, '<' or '>' inside)
  let j = i + 1;
  while (j < n) {
    let c = s.charCodeAt(j);
    if (c === 62) break; // '>'
    if (c <= 32 || c === 60) return null;
    j += 1;
  }
  if (j >= n) return null;
  let inner = s.slice(i + 1, j);
  let colon = inner.indexOf(':');
  if (colon >= 2 && colon <= 32) {
    let scheme = inner.slice(0, colon);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) {
      let href = cleanUrl(inner);
      if (href === null) {
        let out = [];
        escapeEncode(inner, out);
        return { html: out.join(''), next: j + 1 };
      }
      return { html: autolinkHtml(href, inner), next: j + 1 };
    }
  }
  if (ANGLE_EMAIL.test(inner)) {
    let href = cleanUrl('mailto:' + inner);
    if (href === null) {
      let out = [];
      escapeEncode(inner, out);
      return { html: out.join(''), next: j + 1 };
    }
    return { html: autolinkHtml(href, inner), next: j + 1 };
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
  let prev = '';
  while (url !== prev) {
    prev = url;
    let m = BACKPEDAL.exec(url);
    url = m ? m[0] : '';
  }
  return url;
}
// Validate a candidate extended-autolink URL starting at s[i] (the 'w' of
// www. or the scheme start). Returns the end index of the final URL, or -1.
// `wwwOnly` restricts to the www. form (used by the look-back helper).
function matchUrlAt(s, i, n) {
  let m = URL_BROAD.exec(s.slice(i, n));
  if (!m) return -1;
  // the domain part must be present (the regex guarantees at least one
  // [a-zA-Z0-9-]+ group after the scheme/www.)
  let end = i + backpedalUrl(m[0]).length;
  if (end <= i) return -1;
  return end;
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
  let i = 0;
  while (i < upto) {
    if (s.charCodeAt(i) === 95) {
      let before = i > 0 ? s[i - 1] : '';
      let after = i + 1 < s.length ? s[i + 1] : '';
      let flank = flanking(before, after);
      if (flank[0] && (!flank[1] || isUnicodePunct(before))) return true;
    }
    i += 1;
  }
  return false;
}

// Validate an email autolink whose '@' is at s[at]. The local part is
// scanned back over [A-Za-z0-9._+-] (clamped to `minStart`). Returns
// {start, end} or null.
function matchEmailAt(s, at, n, minStart) {
  let ls = at;
  while (ls > minStart) {
    let c = s.charCodeAt(ls - 1);
    let local = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 45 || c === 95 || c === 43;
    if (!local) break;
    ls -= 1;
  }
  if (ls >= at) return null;
  let m = EMAIL_GFM.exec(s.slice(ls, n));
  if (!m) {
    // No match with the lookahead: it may have failed on a trailing '_'
    // that is an emphasis closer (marked resolves emphasis first, so its
    // email regex never sees the closer). Try without the lookahead;
    // accept the longer match only if a '_' opener exists before the
    // email -- otherwise marked's regex fails entirely (e.g.
    // `foo@bar.com__` with no opener renders as plain text).
    let m2 = EMAIL_GFM_NOLOOK.exec(s.slice(ls, n));
    if (!m2) return null;
    let end2 = ls + m2[0].length;
    if (end2 >= n) return { start: ls, end: end2 };
    if (s.charCodeAt(end2) === 95 && hasUnderscoreOpener(s, ls)) {
      return { start: ls, end: end2 };
    }
    return null;
  }
  let end = ls + m[0].length;
  // The lookahead may have shortened the match (backtracked past a
  // trailing '_' that is an emphasis closer): the shortened match then
  // ends right before a '.' (the dropped group's dot). Re-match without
  // the lookahead and take the longer match when it ends before a '_'
  // with a '_' opener before the email.
  if (end < n && s.charCodeAt(end) === 46) {
    let m2 = EMAIL_GFM_NOLOOK.exec(s.slice(ls, n));
    if (m2) {
      let end2 = ls + m2[0].length;
      if (end2 > end && end2 < n && s.charCodeAt(end2) === 95 && hasUnderscoreOpener(s, ls)) {
        return { start: ls, end: end2 };
      }
    }
  }
  return { start: ls, end };
}
function hasUrlScheme(s, i) {
  if (s.startsWith('http://', i) || s.startsWith('https://', i) || s.startsWith('ftp://', i)) return true;
  if (s.startsWith('HTTP://', i) || s.startsWith('HTTPS://', i) || s.startsWith('FTP://', i)) return true;
  // case-insensitive scheme check (the broad regex handles the rest)
  let head = s.slice(i, i + 8).toLowerCase();
  if (head.startsWith('http://') || head.startsWith('https://') || head.startsWith('ftp://')) return true;
  return false;
}
// mailto: / xmpp: + email (GFM emailProtocol branch; the whole
// "mailto:foo@bar.baz" is the link, href and text alike). xmpp: may
// carry one /path segment of [A-Za-z0-9@.]+.
function tryMailtoAutolink(s, i, n) {
  let isMailto = s.charCodeAt(i) === 109; // 'm'
  let eStart = i + (isMailto ? 7 : 5);
  let eEnd = matchEmailAt(s, eStart, n);
  if (eEnd !== -1) {
    let end = eEnd;
    if (!isMailto && end < n && s.charCodeAt(end) === 47) { // '/'
      let j = end + 1;
      while (j < n && /[A-Za-z0-9@.]/.test(s[j])) j += 1;
      if (j > end + 1) end = j;
    }
    let body = s.slice(i, end);
    let href = cleanUrl(body);
    if (href === null) return null;
    return { html: autolinkHtml(href, body), next: end };
  }
  return null;
}
// GFM extended autolink starting at s[i]. `prev` is the char before i.
// Returns {html, next} or null. The caller (text-run processing) decides
// when to call this; for www. the preceding-char rule applies here.
function tryExtendedAutolink(s, i, n, prev) {
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) return tryMailtoAutolink(s, i, n);
  let isWww = s.startsWith('www.', i);
  if (isWww) {
    if (prev !== '' && !isUnicodeSpace(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') return null;
  } else if (!hasUrlScheme(s, i)) {
    return null;
  }
  let end = matchUrlAt(s, i, n);
  if (end === -1) return null;
  let body = s.slice(i, end);
  if (isWww) {
    // the host (before any /, ?, #) must contain a dot
    let hostEnd = body.search(/[/?#]/);
    let host = hostEnd === -1 ? body.slice(4) : body.slice(4, hostEnd);
    if (host.indexOf('.') === -1) return null;
  }
  let hrefRaw = isWww ? 'http://' + body : body;
  let href = cleanUrl(hrefRaw);
  if (href === null) return null; // renders as plain text
  return { html: autolinkHtml(href, body), next: end };
}

function skipTagWs(str, pos, len) {
  let p = pos;
  while (p < len) {
    let c = str.charCodeAt(p);
    if (c !== 32 && c !== 9 && c !== 10) break;
    p += 1;
  }
  return p;
}

// Scan a quoted attribute value starting at str[pos] (the quote char).
// Returns the index just past the closing quote, or -1 when unterminated.
function scanQuotedValue(str, pos, len, quote) {
  let p = pos + 1;
  while (p < len && str.charCodeAt(p) !== quote) p += 1;
  if (p >= len) return -1;
  return p + 1;
}
// Scan an unquoted attribute value starting at str[pos]. Returns the
// index just past the value, or -1 when the value starts with a
// forbidden char, contains one, or runs off the end.
function scanUnquotedValue(str, pos, len) {
  let first = str.charCodeAt(pos);
  if (first === 34 || first === 39 || first === 61 || first === 60 || first === 62 || first === 96) return -1;
  let p = pos;
  while (p < len) {
    let code = str.charCodeAt(p);
    if (code === 32 || code === 9 || code === 10 || code === 62 || code === 47) break;
    if (code === 34 || code === 39 || code === 61 || code === 60 || code === 96) return -1;
    p += 1;
  }
  if (p >= len) return -1;
  return p;
}

// Scan tag attributes starting at cursor (after the tag name). Returns the
// index just past the closing '>' or '/>', or -1 when invalid.
function scanTagAttrs(str, cursor, len) {
  let pos = cursor;
  while (pos < len) {
    let code = str.charCodeAt(pos);
    if (code === 62) return pos + 1; // '>'
    if (code === 47 && pos + 1 < len && str.charCodeAt(pos + 1) === 62) return pos + 2; // '/>'
    if (code === 32 || code === 9 || code === 10) { pos += 1; continue; }
    // attribute name (must start with a letter, '_' or ':')
    if (!/[A-Za-z_:]/.test(str[pos])) return -1;
    while (pos < len && /[A-Za-z0-9_.:-]/.test(str[pos])) pos += 1;
    // optional whitespace
    pos = skipTagWs(str, pos, len);
    if (pos < len && str.charCodeAt(pos) === 61) { // '='
      pos += 1;
      pos = skipTagWs(str, pos, len);
      if (pos >= len) return -1;
      let quote = str.charCodeAt(pos);
      if (quote === 34 || quote === 39) { // quoted value
        let after = scanQuotedValue(str, pos, len, quote);
        if (after === -1) return -1;
        pos = after;
        // after a quoted value, whitespace, '/' or '>' must follow
        if (pos < len) {
          let nextCode = str.charCodeAt(pos);
          if (nextCode !== 32 && nextCode !== 9 && nextCode !== 10 && nextCode !== 62 && nextCode !== 47) return -1;
        }
      } else { // unquoted value
        let after = scanUnquotedValue(str, pos, len);
        if (after === -1) return -1;
        pos = after;
      }
    }
  }
  return -1;
}

// Raw HTML tag starting at s[i] === '<'. Returns {html, next} or null.
// Scan a special HTML form from `start` to its terminator `end`
// (e.g. '?>'), skipping the first `from` chars. Returns {html, next}
// or null when the terminator is missing.
function scanSpecialForm(str, start, from, end) {
  let endIdx = str.indexOf(end, start + from);
  if (endIdx === -1) return null;
  return { html: str.slice(start, endIdx + end.length), next: endIdx + end.length };
}
// Scan a declaration <!A ...> from `start` (the '<'). The char after
// '!' must be a letter. Returns {html, next} or null.
function scanDeclaration(str, start, len) {
  let cursor = start + 2;
  if (cursor < len && /[A-Za-z]/.test(str[cursor])) {
    while (cursor < len && str.charCodeAt(cursor) !== 62) cursor += 1;
    if (cursor < len) return { html: str.slice(start, cursor + 1), next: cursor + 1 };
  }
  return null;
}
// Raw HTML tag starting at s[i] === '<'. Returns {html, next} or null.
function tryRawHtml(str, start, len) {
  // comment <!-- ... --> (<!--> and <!---> are empty comments)
  if (str.startsWith('<!--', start)) {
    if (str.charCodeAt(start + 4) === 62) return { html: str.slice(start, start + 5), next: start + 5 }; // <!-->
    if (str.startsWith('->', start + 4)) return { html: str.slice(start, start + 7), next: start + 7 }; // <!--->
    // unterminated comment: marked treats it as literal text
    return scanSpecialForm(str, start, 4, '-->');
  }
  // processing instruction <? ... ?>
  if (str.startsWith('<?', start)) return scanSpecialForm(str, start, 2, '?>');
  // declaration <!A ...>  (not <!-- and not <![CDATA[)
  if (str.startsWith('<!', start) && !str.startsWith('<![CDATA[', start)) return scanDeclaration(str, start, len);
  // CDATA <![CDATA[ ... ]]>
  if (str.startsWith('<![CDATA[', start)) return scanSpecialForm(str, start, 9, ']]>');
  // open or close tag
  let cursor = start + 1;
  let isClosing = false;
  if (cursor < len && str.charCodeAt(cursor) === 47) { isClosing = true; cursor += 1; } // '/'
  if (cursor >= len || !/[A-Za-z]/.test(str[cursor])) return null;
  while (cursor < len && /[A-Za-z0-9-]/.test(str[cursor])) cursor += 1;
  if (isClosing) {
    // optional whitespace, then '>'
    let scan = skipTagWs(str, cursor, len);
    if (scan < len && str.charCodeAt(scan) === 62) return { html: str.slice(start, scan + 1), next: scan + 1 };
    return null;
  }
  // open tag: attributes then '>' or '/>'. The first character after
  // the tag name must be whitespace, '/' or '>' (an attribute must be
  // preceded by whitespace); e.g. <m:abc> is not a tag.
  let afterName = str.charCodeAt(cursor);
  if (afterName !== 32 && afterName !== 9 && afterName !== 10 && afterName !== 62 && afterName !== 47) return null;
  let tagEnd = scanTagAttrs(str, cursor, len);
  if (tagEnd === -1) return null;
  return { html: str.slice(start, tagEnd), next: tagEnd };
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

function isEmailChar(c, withAt) {
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) return true;
  if (c === 46 || c === 45 || c === 95 || c === 43) return true;
  if (withAt && c === 64) return true;
  return false;
}

// Is the '_' at s[i] part of an email local part? Scan forward over
// local-part chars to an '@', then validate the whole email.
function underscoreInEmail(s, i, n) {
  let j = i;
  while (j < n) {
    if (!isEmailChar(s.charCodeAt(j), false)) break;
    j += 1;
  }
  if (j >= n || s.charCodeAt(j) !== 64) return false;
  let em = matchEmailAt(s, j, n, 0);
  if (em === null) return false;
  return em.start <= i && i < em.end;
}

// Is the '_' at s[i] part of an email DOMAIN (foo@bar.com_baz)? Scan
// back over email chars (including '@') to find an '@', then validate
// the whole email.
function underscoreInEmailDomain(s, i, n) {
  let j = i;
  while (j > 0) {
    if (!isEmailChar(s.charCodeAt(j - 1), true)) break;
    j -= 1;
  }
  let at = s.indexOf('@', j);
  if (at === -1 || at >= i) return false;
  let em = matchEmailAt(s, at, n, 0);
  if (em === null) return false;
  return em.start <= i && i < em.end;
}

// URL schemes recognised before '://', longest first.
const URL_SCHEMES = ['https', 'http', 'ftp'];
// Find the start of a URL (www. or scheme://) at or after `from`,
// searching only before index `limit`. Returns the start index or -1,
// and advances `state.pos` past a rejected candidate.
function findUrlStart(s, from, limit, state) {
  let w = s.indexOf('www.', from);
  let c = s.indexOf('://', from);
  if (w !== -1 && w < limit && (c === -1 || w <= c)) return w;
  if (c === -1 || c >= limit) return -1;
  for (let scheme of URL_SCHEMES) {
    if (s.slice(c - scheme.length, c).toLowerCase() === scheme) return c - scheme.length;
  }
  state.pos = c + 3;
  return -2;
}

// Is the char before a 'www.' start a valid URL boundary? (A 'www.'
// preceded by a non-space char that is not a delimiter or '(' is part
// of a larger token, not a URL start.)
function wwwPrevOk(s, us) {
  let prev = us > 0 ? s[us - 1] : '';
  return prev === '' || isUnicodeSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(';
}

// A URL that is a link destination [text](url) ends at the paren
// matching the '(' before it: a delimiter after that ')' (e.g. an
// emphasis closer) is outside the URL, even when the broad match
// runs on into later text whose balanced parens make the backpedal
// keep the whole run (e.g. [i](https://e.com)*](https://x.org)).
// Returns the index of the matching ')' or -1.
function linkDestCloseParen(s, us, n) {
  if (us < 2 || s.charCodeAt(us - 1) !== 40 || s.charCodeAt(us - 2) !== 93) return -1;
  let depth = 0;
  let k = us - 1;
  while (k < n) {
    let ck = s.charCodeAt(k);
    if (ck === 40) depth += 1;
    else if (ck === 41) {
      depth -= 1;
      if (depth === 0) return k;
    }
    k += 1;
  }
  return -1;
}

// Is the delimiter at s[i] inside a bare extended-autolink URL? Scan back
// over the current token (no whitespace/'<'), find a www. or :// start in
// it, validate the URL (broad match + backpedal) and check i is inside.
function delimInUrl(s, i, n) {
  // fast path: at a token boundary (preceded by space/'<'/start) a
  // delimiter cannot sit inside a URL
  if (i === 0) return false;
  let pc = s.charCodeAt(i - 1);
  if (pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 60) return false;
  let t = i;
  while (t > 0) {
    let c = s.charCodeAt(t - 1);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
    t -= 1;
  }
  let state = { pos: t };
  let p = t;
  while (p < i) {
    let us = findUrlStart(s, p, i, state);
    if (us === -2) { p = state.pos; continue; }
    if (us === -1) break;
    if (s.startsWith('www.', us) && !wwwPrevOk(s, us)) {
      p = us + 4;
      continue;
    }
    let end0 = matchUrlAt(s, us, n);
    if (end0 !== -1) {
      let end = end0;
      let closeAt = linkDestCloseParen(s, us, n);
      if (closeAt !== -1 && closeAt < end) end = closeAt;
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
  let amp = src.indexOf('&', start);
  if (amp === -1 || amp >= end) {
    escapeText(src.slice(start, end), out);
    return;
  }
  let s = start;
  let k = start;
  while (k < end) {
    if (src.charCodeAt(k) !== 38) { k += 1; continue; }
    let ref = scanEntityRef(src, k, end);
    if (!ref) { k += 1; continue; }
    if (k > s) escapeText(src.slice(s, k), out);
    if (ref.named) out.push(ref.value);
    else escapeEncodeChar(ref.value, out);
    k = ref.next;
    s = k;
  }
  if (end > s) escapeText(src.slice(s, end), out);
}

// The scheme start for a '://' at index c, or -1 when the chars before
// it are not http/https/ftp.
function schemeStartAt(src, c) {
  let before = src.slice(c - 5, c).toLowerCase();
  if (before === 'https') return c - 5;
  before = src.slice(c - 4, c).toLowerCase();
  if (before === 'http') return c - 4;
  before = src.slice(c - 3, c).toLowerCase();
  if (before === 'ftp') return c - 3;
  return -1;
}

function emitAutolinkAnchor(urlText, linkHref, html) {
  html.push('<a href="');
  escapeEncode(linkHref, html);
  html.push('">');
  escapeEncode(urlText, html);
  html.push('</a>');
}

// Try a www. autolink at wwwAt. Returns {pos, segStart}: on success the
// link is emitted and both advance past it; on rejection pos skips past
// the 'www.' and segStart is unchanged.
function emitWwwLink(text, wwwAt, to, from, prev, segStart, html) {
  let before = wwwAt > from ? text[wwwAt - 1] : prev;
  if (before !== '' && !isUnicodeSpace(before) && before !== '*' && before !== '_' && before !== '~' && before !== '(') {
    return { pos: wwwAt + 4, segStart };
  }
  let urlEnd = matchUrlAt(text, wwwAt, text.length);
  if (urlEnd === -1 || urlEnd > to) return { pos: wwwAt + 4, segStart };
  let urlText = text.slice(wwwAt, urlEnd);
  let hostCut = urlText.search(/[/?#]/);
  let hostPart = hostCut === -1 ? urlText.slice(4) : urlText.slice(4, hostCut);
  if (hostPart.indexOf('.') === -1) return { pos: wwwAt + 4, segStart };
  let linkHref = cleanUrl('http://' + urlText);
  if (linkHref === null) return { pos: wwwAt + 4, segStart };
  if (wwwAt > segStart) pushText(text, segStart, wwwAt, html);
  emitAutolinkAnchor(urlText, linkHref, html);
  return { pos: urlEnd, segStart: urlEnd };
}

// Try a scheme:// autolink at schemeAt (the '://'). Returns {pos, segStart}.
function emitSchemeLink(text, schemeAt, to, from, segStart, html) {
  let schemeStart = schemeStartAt(text, schemeAt);
  if (schemeStart === -1 || schemeStart < from) return { pos: schemeAt + 3, segStart };
  let urlEnd = matchUrlAt(text, schemeStart, text.length);
  if (urlEnd === -1 || urlEnd > to) return { pos: schemeAt + 3, segStart };
  let urlText = text.slice(schemeStart, urlEnd);
  let linkHref = cleanUrl(urlText);
  if (linkHref === null) return { pos: schemeAt + 3, segStart };
  if (schemeStart > segStart) pushText(text, segStart, schemeStart, html);
  emitAutolinkAnchor(urlText, linkHref, html);
  return { pos: urlEnd, segStart: urlEnd };
}

// Try an email autolink at atAt (the '@'). Returns {pos, segStart}.
function emitEmailLink(text, atAt, to, from, segStart, html) {
  let email = matchEmailAt(text, atAt, text.length, from);
  if (!email || email.end > to) return { pos: atAt + 1, segStart };
  let startPos = email.start;
  let endPos = email.end;
  let schemePrefix = '';
  if (email.start >= 7 && text.slice(email.start - 7, email.start) === 'mailto:') {
    startPos = email.start - 7;
    schemePrefix = 'mailto:';
  } else if (email.start >= 5 && text.slice(email.start - 5, email.start) === 'xmpp:') {
    startPos = email.start - 5;
    schemePrefix = 'xmpp:';
    // one /path segment of [A-Za-z0-9@.]+
    if (endPos < to && text.charCodeAt(endPos) === 47) {
      let pathEnd = endPos + 1;
      while (pathEnd < to && /[A-Za-z0-9@.]/.test(text[pathEnd])) pathEnd += 1;
      if (pathEnd > endPos + 1) endPos = pathEnd;
    }
  }
  let address = text.slice(startPos, endPos);
  let linkHref = cleanUrl(schemePrefix ? address : 'mailto:' + address);
  if (linkHref === null) return { pos: atAt + 1, segStart };
  if (startPos > segStart) pushText(text, segStart, startPos, html);
  emitAutolinkAnchor(address, linkHref, html);
  return { pos: endPos, segStart: endPos };
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
    let nearest = Math.min(wwwAt, schemeAt, atAt);
    if (nearest === Infinity) break;
    let step;
    if (nearest === wwwAt) step = emitWwwLink(text, wwwAt, to, from, prev, segStart, html);
    else if (nearest === schemeAt) step = emitSchemeLink(text, schemeAt, to, from, segStart, html);
    else step = emitEmailLink(text, atAt, to, from, segStart, html);
    pos = step.pos;
    segStart = step.segStart;
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
  let c = src.indexOf('://', textStart);
  if (c !== -1 && c < i) us = schemeStartAt(src, c);
  if (us === -1) {
    let w = src.indexOf('www.', textStart);
    if (w !== -1 && w < i) us = w;
  }
  if (us === -1) return false;
  let e = matchUrlAt(src, us, n);
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
// Find a backtick run of exactly `len` backticks at or after `from`
// (before `to`). Returns the index just past the run, or -1.
function findEqualRun(src, from, to, len) {
  let m = from;
  while (m < to) {
    if (src.charCodeAt(m) !== 96) { m += 1; continue; }
    let e = m;
    while (e < to && src.charCodeAt(e) === 96) e += 1;
    if (e - m === len) return e;
    m = e;
  }
  return -1;
}

// Equal-length code-span pairing over src: each backtick run opens a
// span closing at the next run of the SAME length; unpaired runs are
// literal. Raw HTML tags / autolinks are skipped (backticks inside a
// tag are not code spans). Returns a list of [start, end) regions.
function codeSpanRegions(src) {
  let n = src.length;
  let regions = [];
  let i = 0;
  while (i < n) {
    let c = src.charCodeAt(i);
    if (c === 96) {
      let k = i;
      while (k < n && src.charCodeAt(k) === 96) k += 1;
      let len = k - i;
      let close = findEqualRun(src, k, n, len);
      if (close !== -1) { regions.push([i, close]); i = close; }
      else i = k;
      continue;
    }
    if (c === 60) {
      let raw = tryRawHtml(src, i, n);
      if (raw) { i = raw.next; continue; }
      let auto = tryAngleAutolink(src, i, n);
      if (auto) { i = auto.next; continue; }
      i += 1;
      continue;
    }
    i += 1;
  }
  return regions;
}

// Does a formed inline link/image's text trigger Rule A? Tokenize the
// text for code spans (equal-length pairing); true iff the text yields
// BOTH a literal single-backtick run AND (a literal 2+ run OR a 2+
// code span whose content contains a backtick).
function linkTextTrigger(text) {
  let n = text.length;
  let lit1 = false, lit2 = false, unclean2 = false;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) !== 96) { i += 1; continue; }
    let k = i;
    while (k < n && text.charCodeAt(k) === 96) k += 1;
    let len = k - i;
    let end = findEqualRun(text, k, n, len);
    if (end !== -1) {
      if (len >= 2) {
        // does the span content contain a backtick?
        let p = k;
        while (p < end - len) {
          if (text.charCodeAt(p) === 96) { unclean2 = true; break; }
          p += 1;
        }
      }
      i = end;
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
    let c = s.charCodeAt(j);
    if (c === 92) { j = j + 2; continue; }
    if (c === 96) {
      let k = j;
      while (k < n && s.charCodeAt(k) === 96) k += 1;
      let len = k - j;
      let close = findEqualRun(s, k, n, len);
      if (close !== -1) { j = close; continue; }
      j = k;
      continue;
    }
    if (c === 60) {
      let raw = tryRawHtml(s, j, n);
      if (raw) { j = raw.next; continue; }
      let auto = tryAngleAutolink(s, j, n);
      if (auto) { j = auto.next; continue; }
      j += 1;
      continue;
    }
    if (c === 91) { depth += 1; j += 1; continue; }
    if (c === 93) { depth -= 1; if (depth === 0) return j; j += 1; continue; }
    j += 1;
  }
  return -1;
}

// Skip from just past an opening quote/'<' to just past its closer,
// honouring backslash escapes. Returns n when unterminated.
function skipToChar(str, j, n, endCode) {
  let p = j;
  while (p < n && str.charCodeAt(p) !== endCode) {
    if (str.charCodeAt(p) === 92) p += 1;
    p += 1;
  }
  if (p < n) p += 1;
  return p;
}

// Find the ')' matching the '(' at s[i] (paren depth counting, skipping
// backslash escapes, quoted strings and <...> angle groups). -1 if none.
function findParenClose(s, i, n) {
  let depth = 0;
  let j = i;
  while (j < n) {
    let c = s.charCodeAt(j);
    if (c === 92) { j = j + 2; continue; }
    if (c === 40) { depth += 1; j += 1; continue; }
    if (c === 41) { depth -= 1; if (depth === 0) return j; j += 1; continue; }
    if (c === 34 || c === 39) { j = skipToChar(s, j + 1, n, c); continue; }
    if (c === 60) { j = skipToChar(s, j + 1, n, 62); continue; }
    j += 1;
  }
  return -1;
}

// Is there a 2+-backtick code span whose content contains a backtick
// inside src[from, to)? Equal-length pairing; spans are consumed.
function hasUncleanCodeSpan(src, from, to) {
  let i = from;
  while (i < to) {
    if (src.charCodeAt(i) !== 96) { i += 1; continue; }
    let k = i;
    while (k < to && src.charCodeAt(k) === 96) k += 1;
    let len = k - i;
    if (len < 2) { i = k; continue; }
    let end = findEqualRun(src, k, to, len);
    if (end !== -1) {
      let p = k;
      while (p < end - len) {
        if (src.charCodeAt(p) === 96) return true;
        p += 1;
      }
      i = end;
    } else i = k;
  }
  return false;
}
// Update marked's inLink lexer state from a raw HTML tag.
function updateInLink(tag) {
  if (tag.length < 2 || tag.charCodeAt(0) !== 60) return;
  if (tag.charCodeAt(1) === 97 || tag.charCodeAt(1) === 65) {
    // marked's startATag is /^<a(?:\s[^>]*?)?>/ : after <a must
    // come '>' or whitespace. <a/> (no space) is NOT an <a> tag
    // and does NOT set inLink (doc-04 regression).
    let thirdChar = tag.length > 2 ? tag.charCodeAt(2) : 0;
    if (thirdChar === 62 || thirdChar === 32 || thirdChar === 9 || thirdChar === 10) inLink = true;
  } else if (tag.charCodeAt(1) === 47 && tag.length >= 3 && (tag.charCodeAt(2) === 97 || tag.charCodeAt(2) === 65)) {
    let fourthChar = tag.length > 3 ? tag.charCodeAt(3) : 0;
    if (fourthChar === 62 || fourthChar === 32 || fourthChar === 9 || fourthChar === 10) inLink = false;
  }
}

// ---------------------------------------------------------------------------
// The inline scan: one pass over the text, emitting HTML chunks.
// Delimiter runs (* _ ~) are recorded; emphasis is resolved afterwards.
// The scan is a single loop with a switch on the char code; the branch
// handlers of the previous pass are inlined here and share the scan's
// local variables (no state object is passed around).
// ---------------------------------------------------------------------------
function parseInline(text, linkDefs, html, skipAutolink, inlineState) {
  let textLen = text.length;
  let delimiters = [];
  // Rule A: phantom code spans over the whole paragraph (computed once
  // when a trigger link/image is found). Rule B: regions [start, end)
  // of unformed inline-link brackets followed by a closed paren group.
  let phantomSpans = null;
  let suppressedRegions = [];
  let runStart = 0; // start of the current un-emitted text run
  function flushRun(stop) {
    if (stop > runStart) {
      let prev = runStart > 0 ? text[runStart - 1] : '';
      emitTextRun(text, runStart, stop, prev, linkDefs, html, skipAutolink);
    }
  }
  let pos = 0;
  while (pos < textLen) {
    let code = text.charCodeAt(pos);
    if (code < 128 && !SPECIAL[code]) { pos += 1; continue; }
    switch (code) {
      case 96: { // backtick: code span
        flushRun(pos);
        let runEnd = pos;
        while (runEnd < textLen && text.charCodeAt(runEnd) === 96) runEnd += 1;
        let runLen = runEnd - pos;
        // find a matching run of exactly runLen backticks
        let scan = runEnd;
        let matchAt = -1;
        while (scan < textLen) {
          if (text.charCodeAt(scan) === 96) {
            let closeEnd = scan;
            while (closeEnd < textLen && text.charCodeAt(closeEnd) === 96) closeEnd += 1;
            if (closeEnd - scan === runLen) { matchAt = scan; break; }
            scan = closeEnd;
          } else scan += 1;
        }
        if (matchAt === -1) {
          // literal backticks
          html.push(text.slice(pos, runEnd));
          runStart = runEnd;
          pos = runEnd;
        } else {
          let codeText = text.slice(runEnd, matchAt);
          // line endings become spaces; strip one leading/trailing space
          if (codeText.indexOf('\n') !== -1) codeText = codeText.replace(/\n/g, ' ');
          if (codeText.length >= 2 && codeText.charCodeAt(0) === 32 && codeText.charCodeAt(codeText.length - 1) === 32 && codeText.trim() !== '') {
            codeText = codeText.slice(1, -1);
          }
          html.push('<code>');
          escapeEncode(codeText, html);
          html.push('</code>');
          runStart = matchAt + runLen;
          pos = matchAt + runLen;
        }
        break;
      }
      case 42: case 95: case 126: { // * _ ~ : delimiter run
        // a '_' inside an email local part, or any of these inside a bare
        // URL, is plain text, not a delimiter
        if (code === 95 && (underscoreInEmail(text, pos, textLen) || underscoreInEmailDomain(text, pos, textLen))) { pos += 1; break; }
        if (delimInUrl(text, pos, textLen)) { pos += 1; break; }
        flushRun(pos);
        let runEnd = pos;
        while (runEnd < textLen && text.charCodeAt(runEnd) === code) runEnd += 1;
        let runLen = runEnd - pos;
        let prevCh = pos > 0 ? text[pos - 1] : '';
        let nextCh = runEnd < textLen ? text[runEnd] : '';
        let flanks = flanking(prevCh, nextCh);
        let flankLeft = flanks[0];
        let flankRight = flanks[1];
        let delimChar = String.fromCharCode(code);
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
        runStart = runEnd;
        pos = runEnd;
        break;
      }
      case 91: case 33: { // '[' or '!['
        if (code === 33 && !(pos + 1 < textLen && text.charCodeAt(pos + 1) === 91)) { pos += 1; break; }
        let image = code === 33;
        // NOTE: marked's inLink does NOT block bracket-links -- its link
        // tokenizer has no inLink check (De only uses inLink to detect a
        // nested link inside the link's own text). Only the bare-URL
        // autolink (url tokenizer) is gated on !inLink (doc-33).
        let link = tryLink(text, pos, textLen, linkDefs, image);
        if (link) {
          if (inlineState && !image) inlineState.bracketLink = true;
          // Rule A: a formed INLINE link/image whose text is a trigger
          // computes the phantom code spans for this paragraph once.
          if (link.inline && link.text !== undefined && phantomSpans === null && linkTextTrigger(link.text)) {
            phantomSpans = codeSpanRegions(text);
          }
          flushRun(pos);
          html.push(link.html);
          runStart = link.next;
          pos = link.next;
        } else {
          // Rule B: an unformed link whose brackets are immediately
          // followed by a closed paren group -- record the region so
          // emphasis inside it can be suppressed (only the emphasis that
          // wraps an unclean 2+ code span is actually suppressed).
          let bracketOpen = image ? pos + 1 : pos;
          let bracketClose = findBracketCloseLenient(text, bracketOpen, textLen);
          if (bracketClose !== -1 && bracketClose + 1 < textLen && text.charCodeAt(bracketClose + 1) === 40) {
            let parenClose = findParenClose(text, bracketClose + 1, textLen);
            if (parenClose !== -1) suppressedRegions.push([bracketOpen, parenClose + 1]);
          }
          // not a link: the '[' (or '!') is literal text
          pos += 1;
        }
        break;
      }
      case 60: { // '<': autolink or raw HTML
        let autolink = tryAngleAutolink(text, pos, textLen);
        if (autolink) {
          flushRun(pos);
          html.push(autolink.html);
          runStart = autolink.next;
          pos = autolink.next;
        } else {
          let rawTag = tryRawHtml(text, pos, textLen);
          if (rawTag) {
            // Flush the text run BEFORE the tag first: the tag's inLink
            // effect only applies to text AFTER it (a URL before an <a>
            // tag still autolinks; doc-13 regression).
            flushRun(pos);
            // <a ...> (incl. self-closing <a />) opens the link scope;
            // </a> closes it (marked's tag tokenizer state.inLink)
            updateInLink(rawTag.html);
            html.push(rawTag.html);
            runStart = rawTag.next;
            pos = rawTag.next;
          } else {
            pos += 1; // literal '<', escaped by flushRun
          }
        }
        break;
      }
      case 38: // '&': handled inside flushRun (entity or &amp;)
        pos += 1;
        break;
      case 92: { // backslash
        if (pos + 1 < textLen) {
          let nextCode = text.charCodeAt(pos + 1);
          // a backslash that is the trailing char of a bare URL is part
          // of the URL, not a hard break / escape -- leave it in the text
          // run so emitTextRun links the whole URL (with %5C)
          if (!backslashInUrl(text, runStart, pos, textLen)) {
            if (nextCode === 10) { // backslash + newline = hard break
              flushRun(pos);
              html.push('<br>');
              let p = pos + 2;
              while (p < textLen && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p += 1;
              runStart = p;
              pos = p;
              break;
            }
            if (nextCode < 128 && isPunct(nextCode)) {
              flushRun(pos);
              // the escaped char is literal text (still HTML-escaped)
              escapeText(text[pos + 1], html);
              runStart = pos + 2;
              pos = pos + 2;
              break;
            }
          }
        }
        pos += 1; // literal backslash
        break;
      }
      case 10: { // newline: soft break, or hard break (2+ spaces before)
        // count trailing spaces in the pending text run
        let trailingSpaces = 0;
        let back = pos - 1;
        while (back >= runStart && text.charCodeAt(back) === 32) { trailingSpaces += 1; back -= 1; }
        if (trailingSpaces >= 2) {
          flushRun(pos - trailingSpaces);
          html.push('<br>');
          let p = pos + 1;
          // after a hard break the next line's leading whitespace is stripped
          while (p < textLen && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p += 1;
          runStart = p;
          pos = p;
        } else {
          flushRun(pos);
          html.push('\n');
          runStart = pos + 1;
          pos = pos + 1;
        }
        break;
      }
      default: // any other char (incl. non-ASCII): part of the text run
        pos += 1;
        break;
    }
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
// Advance idx/column over leading whitespace, consuming up to maxCols
// columns. Returns {idx, column, leftover}: leftover is the spaces a
// tab straddling the limit leaves (0 otherwise).
// Advance (idx, column) over characters up to maxCols columns. When
// wsOnly, only whitespace is consumed (a tab jumps to the next multiple
// of 4); otherwise any character advances one column (a tab still jumps).
// Returns {idx, column, leftover}: leftover is the spaces a tab
// straddling the limit leaves (0 otherwise).
function advanceCursor(str, idx, column, maxCols, wsOnly) {
  let leftover = 0;
  let len = str.length;
  while (column < maxCols && idx < len) {
    let code = str.charCodeAt(idx);
    if (code === 9) {
      let nextCol = column + (4 - (column % 4));
      if (nextCol > maxCols) { leftover = nextCol - maxCols; idx += 1; column = nextCol; break; }
      column = nextCol; idx += 1;
    } else if (!wsOnly || code === 32) {
      column += 1; idx += 1;
    } else break;
  }
  return { idx, column, leftover };
}

// Indent (columns of leading whitespace) of string s whose first char is
// at visual column startCol.
function indentOf(str, baseCol) {
  let column = baseCol;
  for (let idx = 0; idx < str.length; idx += 1) {
    let code = str.charCodeAt(idx);
    if (code === 32) column += 1;
    else if (code === 9) column += 4 - (column % 4);
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

// String str (first char at column baseCol) after removing cols columns.
// A straddling tab leaves spaces. anyChar=false removes only whitespace
// (stripIndent); anyChar=true removes any characters (sliceCols).
// allowShort=false returns null when str has less than cols columns of
// indentation; allowShort=true just removes what is there (stripUpTo).
function stripColumns(str, baseCol, cols, anyChar, allowShort) {
  let r = advanceCursor(str, 0, baseCol, baseCol + cols, !anyChar);
  if (r.leftover > 0) return ' '.repeat(r.leftover) + str.slice(r.idx);
  if (!allowShort && r.column - baseCol < cols) return null;
  return str.slice(r.idx);
}
// Strip up to cols columns of leading whitespace (never null: a line with
// less indent just loses what it has). Used for fenced code lines.
function stripUpTo(str, baseCol, cols) {
  return stripColumns(str, baseCol, cols, false, true);
}
// Remove the first cols columns of string str (first char at column
// baseCol), whatever they are (whitespace or marker characters). A
// straddling tab leaves spaces. Returns null when str is shorter than cols
// columns. Unlike stripIndent, this does not stop at non-whitespace.
function sliceCols(str, baseCol, cols) {
  return stripColumns(str, baseCol, cols, true, false);
}

function stripIndent(str, baseCol, cols) {
  return stripColumns(str, baseCol, cols, false, false);
}

// Is the string (from `from`) blank? spacesOnly=true means only spaces
// count (no tabs) -- marked's notion of a "blank" line for its
// space/newline regex /^(?: *(?:\n|$))+/ -- a tab-only line is NOT
// blank there. spacesOnly=false allows spaces and tabs.
function isBlankRun(str, from, spacesOnly) {
  let idx = from;
  while (idx < str.length) {
    let code = str.charCodeAt(idx);
    if (code === 32) { idx += 1; continue; }
    if (!spacesOnly && code === 9) { idx += 1; continue; }
    return false;
  }
  return true;
}

// Is the rest of the line (from from) blank (only spaces/tabs)?
function restIsBlank(text, from) {
  return isBlankRun(text, from, false);
}

// Is the string blank (only spaces/tabs)?
function isSpacesOnly(str) {
  return isBlankRun(str, 0, true);
}

function isBlankStr(str) {
  return isBlankRun(str, 0, false);
}

// Advance (start, startCol) over the line's whitespace up to goalCol. Returns
// [cursor, column, padding] (padding = spaces from a straddling tab) or null when a
// non-space is hit or the line ends before goalCol.
function advanceCols(text, start, startCol, goalCol) {
  let cursor = start;
  let column = startCol;
  let padding = 0;
  while (column < goalCol && cursor < text.length) {
    let code = text.charCodeAt(cursor);
    if (code === 32) { cursor += 1; column += 1; }
    else if (code === 9) {
      let nextCol = column + (4 - (column % 4));
      if (nextCol > goalCol) { padding = nextCol - goalCol; cursor += 1; column = nextCol; break; }
      cursor += 1; column = nextCol;
    } else return null;
  }
  if (column < goalCol) return null;
  // a tab exactly at the target column is entirely beyond the stripped
  // indent: expand it to spaces (it is leading whitespace of the content).
  // Only when no straddling tab already set a padding.
  if (padding === 0 && cursor < text.length && text.charCodeAt(cursor) === 9) {
    let nextCol = column + (4 - (column % 4));
    padding = nextCol - column;
    cursor += 1; column = nextCol;
  }
  return [cursor, column, padding];
}

// Strip the leading indent (must be < 4 columns); returns the rest of
// the string, or null when the indent is 4+.
function dedentLine(str, startCol) {
  let indent = indentOf(str, startCol);
  if (indent >= 4) return null;
  return str.slice(indent);
}

// Match a list marker in string str (str starts at the marker; startCol is the
// visual column of str[0]). CommonMark 5.2: N = total whitespace columns
// after the marker. N==0 -> not a list item. N>=5 -> content indent is
// W+1 (rule #2, indented-code content). 1<=N<=4 -> content indent W+N.
// An item with no content after the marker is empty (indent W+1).
// Parse a bullet marker (*, +, -) at str[0]. Returns the marker length (1) or 0.
function bulletMarkerLen(str) {
  let firstCode = str.charCodeAt(0);
  if (firstCode === 42 || firstCode === 43 || firstCode === 45) return 1;
  return 0;
}
// Parse an ordered marker (1-9 digits + '.' or ')') at str[0].
// Returns {len, start} or null.
function orderedMarker(str) {
  let idx = 0;
  while (idx < str.length && idx < 9 && str.charCodeAt(idx) >= 48 && str.charCodeAt(idx) <= 57) idx += 1;
  if (idx === 0 || idx >= str.length) return null;
  let delimCode = str.charCodeAt(idx);
  if (delimCode !== 46 && delimCode !== 41) return null;
  let value = parseInt(str.slice(0, idx), 10);
  if (value > 999999999) return null;
  return { len: idx + 1, start: value };
}
// Whitespace columns after the marker (tabs to next multiple of 4).
// Returns {cols, idx} where idx is the first non-whitespace index.
function markerWs(str, from, startCol) {
  let column = startCol;
  let idx = from;
  let wsCols = 0;
  while (idx < str.length) {
    let code = str.charCodeAt(idx);
    if (code === 32) { wsCols += 1; column += 1; idx += 1; }
    else if (code === 9) { let nextCol = column + (4 - (column % 4)); wsCols += nextCol - column; column = nextCol; idx += 1; }
    else break;
  }
  return { cols: wsCols, idx };
}
function matchListMarker(str, startCol) {
  if (str.length === 0) return null;
  let isOrdered = false;
  let startNum = 0;
  let markerLength = 0;
  let bulletLen = bulletMarkerLen(str);
  if (bulletLen > 0) {
    markerLength = bulletLen;
  } else if (str.charCodeAt(0) >= 48 && str.charCodeAt(0) <= 57) {
    let ordered = orderedMarker(str);
    if (!ordered) return null;
    isOrdered = true; startNum = ordered.start; markerLength = ordered.len;
  } else return null;
  let ws = markerWs(str, markerLength, startCol + markerLength);
  // a marker with no whitespace after it is not a list item -- unless
  // it is at the end of the line (an empty item)
  if (ws.cols === 0 && ws.idx < str.length) return null;
  let isEmpty = ws.idx >= str.length;
  let contentIndent;
  if (isEmpty) contentIndent = startCol + markerLength + 1;
  else if (ws.cols >= 5) contentIndent = startCol + markerLength + 1;
  else contentIndent = startCol + markerLength + ws.cols;
  return { ordered: isOrdered, bullet: str[0], start: startNum, markerLen: markerLength, contentIndent, empty: isEmpty };
}

// Length of the run of `code` starting at str[from] (0 when the char
// there differs). Shared by the fence, setext and heading matchers.
function countRun(str, code, from) {
  let start = from || 0;
  let len = 0;
  while (start + len < str.length && str.charCodeAt(start + len) === code) len += 1;
  return len;
}

// Fenced code start. Returns {ch, len, lang} or null. The fence must be at
// indent < 4 (the caller passes the content after container stripping, and
// its column). `infoStr` is the info string (trimmed).
function matchFence(str, startCol) {
  let rest = dedentLine(str, startCol);
  if (rest === null) return null;
  if (rest.length < 3) return null;
  let fenceCode = rest.charCodeAt(0);
  if (fenceCode !== 96 && fenceCode !== 126) return null;
  let fenceLen = countRun(rest, fenceCode, 0);
  if (fenceLen < 3) return null;
  let infoStr = rest.slice(fenceLen);
  // backtick fences may not contain backticks in the info string
  if (fenceCode === 96 && infoStr.indexOf('`') !== -1) return null;
  infoStr = infoStr.trim();
  // the language is the first word of the info string; backslash
  // escapes are processed in it (foo\+bar -> foo+bar)
  let language = '';
  if (infoStr.length > 0) {
    let splitAt = infoStr.search(/[ \t]/);
    language = splitAt === -1 ? infoStr : infoStr.slice(0, splitAt);
    if (language.indexOf('\\') !== -1) {
      language = language.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    }
  }
  return { ch: String.fromCharCode(fenceCode), len: fenceLen, lang: language, info: infoStr };
}
// Fenced code closing line: same char, length >= minLen, only spaces after.
function matchFenceClose(str, startCol, fenceCh, minLen) {
  let rest = dedentLine(str, startCol);
  if (rest === null) return false;
  let closeLen = countRun(rest, fenceCh.charCodeAt(0), 0);
  if (closeLen < minLen) return false;
  return isBlankStr(rest.slice(closeLen));
}

// ATX heading: 1-6 '#' followed by space/EOL. Returns {level, text} or null.
function matchATX(str, startCol) {
  let rest = dedentLine(str, startCol);
  if (rest === null) return null;
  let depth = countRun(rest, 35, 0);
  if (depth === 0 || depth > 6) return null;
  if (depth < rest.length && rest.charCodeAt(depth) !== 32 && rest.charCodeAt(depth) !== 9) return null;
  let headingText = rest.slice(depth).trim();
  // closing sequence of #'s (preceded by a space, and only #'s + spaces)
  if (headingText.length > 0) {
    let closing = headingText.match(/^(.*?)[ \t]+#+[ \t]*$/);
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
  let rest = dedentLine(str, startCol);
  if (rest === null) return 0;
  let idx = 0;
  while (idx < rest.length && (rest.charCodeAt(idx) === 32 || rest.charCodeAt(idx) === 9)) idx += 1;
  if (idx >= rest.length) return 0;
  let code = rest.charCodeAt(idx);
  if (code !== 61 && code !== 45) return 0;
  // the underline is a run of ONLY '=' or '-' (no spaces mixed in),
  // then only spaces/tabs to end of line
  let run = countRun(rest, code, idx);
  let tail = rest.slice(idx + run);
  if (!isBlankRun(tail, 0, false)) return 0;
  return code === 61 ? 1 : 2;
}

// Thematic break: 3+ of -, _, * with only spaces/tabs between.
function matchHR(str, startCol) {
  let rest = dedentLine(str, startCol);
  if (rest === null) return false;
  let markerCode = 0;
  let marks = 0;
  for (let idx = 0; idx < rest.length; idx += 1) {
    let code = rest.charCodeAt(idx);
    if (code === 32 || code === 9) continue;
    if (code === 45 || code === 95 || code === 42) {
      if (markerCode === 0) markerCode = code;
      else if (markerCode !== code) return false;
      marks += 1;
    } else return false;
  }
  return marks >= 3;
}

// HTML block start. Returns the type (1-7) or 0. Types 1-6 may interrupt
// a paragraph; type 7 may not.
const HTML_BLOCK_TAGS = new Set(['address','article','aside','base','basefont','blockquote','body','caption','center','col','colgroup','dd','details','dialog','dir','div','dl','dt','fieldset','figcaption','figure','footer','form','frame','frameset','h1','h2','h3','h4','h5','h6','head','header','hr','html','iframe','legend','li','link','main','menu','menuitem','nav','noframes','ol','optgroup','option','p','param','section','source','summary','table','tbody','td','tfoot','th','thead','title','tr','track','ul']);
// The tag name starting at rest[idx] (after '<' or '</'). Returns {name, end}.
function htmlTagName(rest, idx) {
  let tagName = '';
  let p = idx;
  while (p < rest.length && /[A-Za-z0-9-]/.test(rest[p])) { tagName += rest[p]; p += 1; }
  return { name: tagName, end: p };
}
function matchHtmlBlock(str, startCol) {
  let rest = dedentLine(str, startCol);
  if (rest === null) return 0;
  if (rest.charCodeAt(0) !== 60) return 0; // '<'
  let lowerRest = rest.toLowerCase();
  // type 1: pre/script/style/textarea -- the char after the tag name
  // must be whitespace, '>', or end of line
  for (let prefix of ['<pre', '<script', '<style', '<textarea']) {
    if (lowerRest.startsWith(prefix)) {
      let nextCh = rest.charAt(prefix.length);
      if (nextCh === '' || nextCh === ' ' || nextCh === '\t' || nextCh === '\n' || nextCh === '>') return 1;
      break;
    }
  }
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<!')) {
    let nextCh = rest.charAt(2);
    if (nextCh !== '' && ((nextCh >= 'A' && nextCh <= 'Z') || (nextCh >= 'a' && nextCh <= 'z'))) return 4;
  }
  if (rest.startsWith('<![CDATA[')) return 5;
  // open/close tag of a block-level element
  let idx = 1;
  if (rest.charCodeAt(idx) === 47) idx += 1;
  let tag = htmlTagName(rest, idx);
  if (tag.name.length === 0) return 0;
  if (HTML_BLOCK_TAGS.has(tag.name.toLowerCase())) return 6;
  // type 7: a complete open/close tag on its own line -- nothing
  // but whitespace may follow the closing '>'. The char right after
  // the tag name must be whitespace, '/', or '>' (so <http://x> is
  // an autolink, not a tag). The tag itself must be well-formed
  // (validated by tryRawHtml, the same check inline parsing uses).
  let afterTag = rest.charAt(tag.end);
  if (afterTag !== '' && afterTag !== ' ' && afterTag !== '\t' && afterTag !== '/' && afterTag !== '>') return 0;
  let tagMatch = tryRawHtml(rest, 0, rest.length);
  if (tagMatch && rest.slice(tagMatch.next).trim() === '') return 7;
  return 0;
}

// Is a list tight? A list is loose when any of its items is separated
// from the next by a blank line, or ends with two blank lines (i.e. any
// item other than the last ends with a blank line, or any item contains
// two block children separated by a blank line).
// A list is tight when it is not loose and no item (except the last)
// ends with a blank line and no item has a blank line between its
// blocks.
function computeTight(listNode) {
  if (listNode.loose) return false;
  for (let idx = 0; idx < listNode.children.length; idx += 1) {
    let itemNode = listNode.children[idx];
    if (itemNode.endsWithBlank && idx < listNode.children.length - 1) return false;
    if (itemNode.hasBlankBetween) return false;
  }
  return true;
}

// Skip spaces/tabs/newlines from `scan`. Returns {pos, nlCount}.
function skipWsNewlines(doc, scan, len) {
  let nlCount = 0;
  let p = scan;
  while (p < len) {
    let code = doc.charCodeAt(p);
    if (code === 32 || code === 9) { p += 1; continue; }
    if (code === 10) { nlCount += 1; p += 1; continue; }
    break;
  }
  return { pos: p, nlCount };
}

// Optional title after a ref def's destination. Returns {title, end} or null.
function refDefTitle(doc, endPos, len) {
  let titleSkipped = skipWsNewlines(doc, endPos, len);
  let titleScan = titleSkipped.pos;
  let nlSeen = titleSkipped.nlCount;
  // a title must be preceded by whitespace (space/tab/newline)
  if (titleScan > endPos && titleScan < len && nlSeen <= 1 && (doc.charCodeAt(titleScan) === 34 || doc.charCodeAt(titleScan) === 39 || doc.charCodeAt(titleScan) === 40)) {
    let titleInfo = parseTitle(doc, titleScan, len);
    if (titleInfo) return { title: titleInfo.title, end: titleInfo.next };
  }
  return null;
}
// After the def, only whitespace then EOL/EOF. Returns the end position
// (just past the newline) or -1 when there is trailing junk.
function refDefTailEnd(doc, endPos, len) {
  let tail = endPos;
  while (tail < len && (doc.charCodeAt(tail) === 32 || doc.charCodeAt(tail) === 9)) tail += 1;
  if (tail < len && doc.charCodeAt(tail) !== 10) return -1;
  if (tail < len) tail += 1;
  return tail;
}

// Parse one link reference definition starting at doc[start] (the '[').
// Returns {label, dest, title, end} or null. The label is normalised.
function parseRefDef(doc, start, len) {
  // label: [ ... ] (may span lines; brackets nest, backslash escapes)
  let closeBracket = findClosingBracket(doc, start, len);
  if (closeBracket === -1) return null;
  let labelText = doc.slice(start + 1, closeBracket);
  if (labelText.length === 0) return null;
  // a label may not contain an unescaped '['
  if (hasUnescapedBracket(labelText)) return null;
  let normLabel = normalizeLabel(labelText);
  if (normLabel.length === 0) return null;
  let cursor = closeBracket + 1;
  // ':' then whitespace (incl. newlines, but at most one blank line is
  // not allowed -- a blank line ends the def)
  if (cursor >= len || doc.charCodeAt(cursor) !== 58) return null;
  cursor += 1;
  let skipped = skipWsNewlines(doc, cursor, len);
  if (skipped.nlCount > 1) return null;
  let scan = skipped.pos;
  if (scan >= len) return null;
  let destInfo = parseDestination(doc, scan, len);
  if (!destInfo) return null;
  let target = destInfo.dest;
  let endPos = destInfo.next;
  // optional title on the same line or the next line
  let titleText = null;
  let titleInfo = refDefTitle(doc, endPos, len);
  if (titleInfo) { titleText = titleInfo.title; endPos = titleInfo.end; }
  let tailEnd = refDefTailEnd(doc, endPos, len);
  if (tailEnd !== -1) return { label: normLabel, dest: target, title: titleText, end: tailEnd };
  // a malformed title does not kill the def: retry without it
  // (the title line stays as paragraph text)
  if (titleText !== null) {
    let retryEnd = refDefTailEnd(doc, destInfo.next, len);
    if (retryEnd === -1) return null;
    return { label: normLabel, dest: target, title: null, end: retryEnd };
  }
  return null;
}

// Extract leading link reference definitions from a paragraph's joined
// text. Adds them to linkDefs (first definition wins). Returns the remaining
// text ('' when the paragraph was only definitions).
function extractRefDefs(doc, linkDefs) {
  let pos = 0;
  let len = doc.length;
  // skip up to 3 spaces of indent before a def
  while (pos < len) {
    let scan = pos;
    let indent = 0;
    while (scan < len && doc.charCodeAt(scan) === 32) { indent += 1; scan += 1; }
    if (indent > 3) break;
    if (scan >= len || doc.charCodeAt(scan) !== 91) break; // '['
    let refDef = parseRefDef(doc, scan, len);
    if (!refDef) break;
    if (!linkDefs.has(refDef.label)) linkDefs.set(refDef.label, { dest: refDef.dest, title: refDef.title });
    pos = refDef.end;
  }
  return doc.slice(pos);
}

// Count the backslashes immediately before row[idx].
function countBackslashesBefore(row, idx) {
  let slashes = 0;
  let back = idx - 1;
  while (back >= 0 && row.charCodeAt(back) === 92) { slashes += 1; back -= 1; }
  return slashes;
}

// Split a table row line into cells. `|` inside code spans or escaped
// (\|) does not split. Leading/trailing pipes are dropped; cells are
// trimmed.
function splitTableRow(row) {
  let parts = [];
  let current = '';
  let len = row.length;
  // skip a leading pipe
  let first = 0;
  while (first < len && (row.charCodeAt(first) === 32 || row.charCodeAt(first) === 9)) first += 1;
  if (first < len && row.charCodeAt(first) === 124) first += 1;
  // Marked's splitCells splits on EVERY unescaped pipe, code spans
  // included (a `|` inside a code span breaks the table, so it is not
  // protected here). A pipe is escaped iff preceded by an odd number
  // of backslashes.
  for (let idx = first; idx < len; idx += 1) {
    if (row.charCodeAt(idx) !== 124) { current += row[idx]; continue; }
    if (countBackslashesBefore(row, idx) % 2 === 1) {
      // escaped pipe: drop one backslash, keep the pipe literally
      current = current.slice(0, current.length - 1) + '|';
      continue;
    }
    parts.push(current.trim());
    current = '';
  }
  // trailing cell (drop it when the line ends with a pipe and the last
  // cell is empty because of it)
  let tail = current.trim();
  if (tail.length > 0 || parts.length === 0) parts.push(tail);
  // if the line ends with a pipe, the final empty segment is dropped
  return parts;
}

// Is `row` a valid table delimiter row? Returns the alignments
// ('left'|'right'|'center'|null per column) or null.
function parseTableDelimiter(row) {
  let parts = splitTableRow(row);
  if (parts.length === 0) return null;
  let columns = [];
  for (let pIdx = 0; pIdx < parts.length; pIdx += 1) {
    let trimmed = parts[pIdx].trim();
    if (!/^:?-+:?$/.test(trimmed)) return null;
    let leftAlign = trimmed.charCodeAt(0) === 58;
    let rightAlign = trimmed.charCodeAt(trimmed.length - 1) === 58;
    if (leftAlign && rightAlign) columns.push('center');
    else if (leftAlign) columns.push('left');
    else if (rightAlign) columns.push('right');
    else columns.push(null);
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
  let columns = parseTableDelimiter(lines[1]);
  if (!columns) return null;
  let head = splitTableRow(lines[0]);
  if (head.length === 0) return null;
  // the delimiter row must have exactly as many cells as the header
  if (columns.length !== head.length) return null;
  let colCount = columns.length;
  let bodyRows = [];
  for (let rowIdx = 2; rowIdx < lines.length; rowIdx += 1) {
    if (isBlankStr(lines[rowIdx])) {
      // a tab-only line is an empty row (see the main loop); a
      // spaces-only / empty line is skipped
      if (lines[rowIdx].indexOf('\t') !== -1) {
        bodyRows.push(new Array(colCount).fill(''));
      }
      continue;
    }
    let parts = splitTableRow(lines[rowIdx]);
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
  let rawLine = sourceLines[lineNo];
  if (rawLine.length === 0) return false;
  let strippedLine = stripContainersForLine(rawLine, openStack);
  if (!strippedLine || strippedLine.text.length !== 0) return false;
  let nextNo = lineNo + 1;
  if (nextNo >= sourceLines.length) return true;
  let nextStripped = stripContainersForLine(sourceLines[nextNo], openStack);
  if (nextStripped === null) return true; // next line is outside the container
  if (isBlankStr(nextStripped.text)) return false; // a second blank line
  return false; // the container continues with a non-blank line
}

// Find the nearest list in the open stack, or null.
function nearestListInStack(openStack) {
  let stackIdx = openStack.length - 1;
  while (stackIdx >= 1) {
    if (openStack[stackIdx].type === 'list') return { pos: stackIdx, node: openStack[stackIdx] };
    stackIdx -= 1;
  }
  return null;
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
  let found = nearestListInStack(openStack);
  if (!found) return false;
  let listPos = found.pos;
  let listNode = found.node;
  // skip the blank lines
  let scanNo = lineNo;
  while (scanNo < sourceLines.length && isBlankStr(sourceLines[scanNo])) scanNo += 1;
  if (scanNo >= sourceLines.length) return false;
  // strip the containers above the list (excluding the item and anything
  // below the list) and check for a marker of the same list
  let strippedLine = stripContainersForLine(sourceLines[scanNo], openStack.slice(0, listPos + 1));
  if (!strippedLine) return false;
  let indent = indentOf(strippedLine.text, strippedLine.col);
  let listMarker = matchListMarker(strippedLine.text.slice(indent), strippedLine.col + indent);
  if (!listMarker) return false;
  if (listMarker.ordered !== listNode.ordered) return false;
  if (listMarker.ordered) {
    let delimiter = strippedLine.text.slice(indent + listMarker.markerLen - 1, indent + listMarker.markerLen);
    if (delimiter !== listNode.delimiter) return false;
  } else if (listMarker.bullet !== listNode.delimiter) return false;
  return true;
}

// Replace oldNode with newNode in parentNode's children (or remove it
// when newNode is null). Returns true when oldNode was found.
function replaceChild(parentNode, oldNode, newNode) {
  let childIdx = parentNode.children.indexOf(oldNode);
  if (childIdx === -1) return false;
  if (newNode === null) parentNode.children.splice(childIdx, 1);
  else parentNode.children[childIdx] = newNode;
  return true;
}

// Finalise a paragraph node: extract link reference definitions, detect a
// table, and either drop the node, replace it with a table, or set its
// text. Returns the node to keep (paragraph/table) or null.
function finalizeParagraph(para, parentNode, linkDefs) {
  let joined = para.lines.join('\n');
  let remaining = extractRefDefs(joined, linkDefs);
  if (remaining.trim() === '') {
    // only definitions: drop the paragraph
    replaceChild(parentNode, para, null);
    return null;
  }
  // table? (needs at least 2 lines in the original paragraph)
  // the table check uses the ORIGINAL lines (defs may have consumed some)
  let table = tryTable(para.lines);
  if (table) {
    replaceChild(parentNode, para, table);
    return table;
  }
  para.text = remaining;
  delete para.lines;
  return para;
}

// Does a line start with a blockquote marker '>' (after spaces/tabs)?
function startsWithBlockquoteMarker(lineText) {
  let scanPos = 0;
  while (scanPos < lineText.length && (lineText.charCodeAt(scanPos) === 32 || lineText.charCodeAt(scanPos) === 9)) scanPos += 1;
  return scanPos < lineText.length && lineText.charCodeAt(scanPos) === 62;
}

// Block matchers that can interrupt a paragraph, in order. Each takes
// (lineText, textCol) and returns a truthy value when the line starts
// that block. HTML blocks only interrupt when their type is 1-6.
const PARA_INTERRUPTERS = [
  (lineText, textCol) => matchATX(lineText, textCol),
  (lineText, textCol) => matchFence(lineText, textCol),
  (lineText, textCol) => matchHR(lineText, textCol),
  (lineText, textCol) => matchSetext(lineText, textCol),
];
// Does this line start a block that can interrupt a paragraph?
// (Used to decide whether a non-matching line is a lazy continuation.)
function canInterruptPara(lineText, textCol) {
  let indent = indentOf(lineText, textCol);
  if (indent < 4) {
    // blockquote
    if (startsWithBlockquoteMarker(lineText)) return true;
    // list item
    if (matchListMarker(lineText.slice(indent), textCol + indent)) return true;
  }
  for (let check of PARA_INTERRUPTERS) {
    if (check(lineText, textCol)) return true;
  }
  let htmlKind = matchHtmlBlock(lineText, textCol);
  if (htmlKind > 0 && htmlKind <= 6) return true;
  return false;
}

// Match one blockquote container against the current line. Returns
// {matched, cursor, column, padding, matchedDepth, stop}: matched is
// false when the line has no '>' marker (the container loop breaks);
// stop is true when the line is blank after the marker and the loop
// must also break (a nested blockquote closes).
function matchBlockquote(raw, cursor, column, padding, openStack, stackIdx) {
  // up to 3 spaces, then '>', then 1 optional space
  let scan = cursor;
  let scanCol = column;
  let spaces = 0;
  while (scan < raw.length && spaces < 3 && raw.charCodeAt(scan) === 32) { scan += 1; scanCol += 1; spaces += 1; }
  if (scan >= raw.length || raw.charCodeAt(scan) !== 62) return { matched: false, cursor, column, padding, matchedDepth: 0, stop: true };
  // virtual column of '>' in the line at this level (outer
  // markers already stripped: padding spaces precede it)
  let markerCol = padding + (scan - cursor);
  scan += 1; scanCol += 1;
  // Expand the whitespace after '>' (marked's J): tabs expand to
  // the next tab stop counting from the column after '>' (markerCol+1);
  // the first expanded space is the marker's optional space and
  // is dropped. Only a run containing a tab is consumed into
  // padding; a spaces-only run consumes one space (the marker's
  // optional space), the rest staying in the raw slice.
  let expanded = expandMarkerWs(raw, scan, markerCol + 1);
  if (expanded.hasTab) {
    padding = expanded.exp > 0 ? expanded.exp - 1 : 0;
    scanCol = expanded.vq; // the next char is at the expanded column
    scan = expanded.q;
  } else if (expanded.q > scan) {
    scan += 1; scanCol += 1;
    // the padding spaces before '>' belong to the container
    // prefix, not the content -- drop them (a tab-overshoot
    // padding from an outer item would otherwise leak a leading
    // space into the blockquote's content)
    padding = 0;
  } else {
    padding = 0;
  }
  cursor = scan;
  column = scanCol;
  let matchedDepth = stackIdx + 1;
  // A line blank after the marker (e.g. a lone '>') is blank
  // for every inner container EXCEPT an inner blockquote: a
  // nested blockquote needs its own '>' marker, so a lone '>'
  // closes it (doc-14: `> > ...` then `>` then `> > ...`
  // starts a NEW inner blockquote). Lists and items stay open
  // (CommonMark: blank lines match any container but a
  // blockquote marker is required for a nested blockquote).
  if (restIsBlank(raw, cursor)) {
    matchedDepth = openStack.length;
    for (let innerIdx = stackIdx + 1; innerIdx < openStack.length; innerIdx += 1) {
      if (openStack[innerIdx].type === 'blockquote') { matchedDepth = innerIdx; break; }
    }
    return { matched: true, cursor, column, padding, matchedDepth, stop: true };
  }
  return { matched: true, cursor, column, padding, matchedDepth, stop: false };
}

// Does an indented code block continue past a blank line at `scanLine`?
// A blank line is part of the code only when a later non-blank line
// still belongs to the block (indented >= 4 after the containers).
// Returns the later line's stripped form, or null.
function indentedCodeContinues(sourceLines, scanLine, openStack) {
  let lookahead = scanLine + 1;
  while (lookahead < sourceLines.length) {
    let later = stripContainersForLine(sourceLines[lookahead], openStack);
    if (!later) return null;
    if (!isBlankStr(later.text)) {
      if (indentOf(later.text, later.col) >= 4) return later;
      return null;
    }
    lookahead += 1;
  }
  return null;
}

// Consume the lines following an indented code block's first line.
// Returns the scan line just past the block (trailing blank lines are
// dropped from the block's lines).
function consumeIndentedCode(sourceLines, fromLine, openStack, blockNode) {
  let scanLine = fromLine;
  while (scanLine < sourceLines.length) {
    let nextRaw = sourceLines[scanLine];
    let stripped = stripContainersForLine(nextRaw, openStack);
    if (!stripped) break;
    if (isBlankStr(stripped.text)) {
      // a blank line is part of the code only if a later
      // non-blank line still belongs to the block (indented >= 4
      // after the containers); its spaces beyond the 4-column
      // indent are kept (cm-112)
      let laterMatch = indentedCodeContinues(sourceLines, scanLine, openStack);
      if (laterMatch) {
        blockNode.lines.push(stripIndent(stripped.text, stripped.col, 4) ?? '');
        scanLine += 1;
        continue;
      }
      break;
    }
    if (indentOf(stripped.text, stripped.col) >= 4) {
      blockNode.lines.push(stripIndent(stripped.text, stripped.col, 4));
      scanLine += 1;
    } else break;
  }
  // drop trailing blank lines
  while (blockNode.lines.length > 0 && blockNode.lines[blockNode.lines.length - 1] === '') blockNode.lines.pop();
  return scanLine;
}

// Does the text after the matched containers start a block (a '>'
// marker, a list marker, an ATX heading, a thematic break, or an
// HTML block type 1-6)? Used to decide whether a lazy line inside a
// fenced code block ends the block. (A fence line itself is NOT a
// block start here -- the closing fence is handled separately.)
function isFenceBlockStart(restAfter, restCol) {
  let restIndent = indentOf(restAfter, restCol);
  if (restIndent < 4) {
    if (startsWithBlockquoteMarker(restAfter)) return true;
    if (matchListMarker(restAfter.slice(restIndent), restCol + restIndent)) return true;
  }
  if (matchATX(restAfter, restCol) || matchHR(restAfter, restCol)) return true;
  let htmlTag = matchHtmlBlock(restAfter, restCol);
  return htmlTag > 0 && htmlTag <= 6;
}

// The closing marker an HTML block of this kind ends at, or null for
// types 6-7 (which end at a blank line). Type 1's marker depends on
// which tag opened the block, so it is computed from the line.
const HTML_END_MARKERS = {
  2: '-->',
  3: '?>',
  4: '>',
  5: ']]>',
};
function htmlEndMarker(htmlKind, lineText) {
  if (htmlKind === 1) {
    let lower = lineText.toLowerCase();
    if (lower.includes('<pre')) return '</pre>';
    if (lower.includes('<script')) return '</script>';
    if (lower.includes('<style')) return '</style>';
    return '</textarea>';
  }
  return HTML_END_MARKERS[htmlKind] ?? null;
}

// Find the list a new item belongs to: the parent itself when it is a
// matching list on the open stack, else the parent's last child when
// it matches, else a new list under the parent. Returns
// {list, onStack}.
function findListForItem(parentNode, marker, delimiter) {
  if (parentNode.type === 'list' && parentNode.ordered === marker.ordered && parentNode.delimiter === delimiter) {
    return { list: parentNode, onStack: true };
  }
  let lastChild = parentNode.children[parentNode.children.length - 1];
  if (lastChild && lastChild.type === 'list' && lastChild.ordered === marker.ordered && lastChild.delimiter === delimiter) {
    return { list: lastChild, onStack: false };
  }
  let listNode = { type: 'list', ordered: marker.ordered, delimiter: delimiter, start: marker.ordered ? marker.start : undefined, loose: false, children: [] };
  parentNode.children.push(listNode);
  return { list: listNode, onStack: false };
}

// Open a new list item for `marker` under parentNode, finding or
// creating the list it belongs to. Returns the new item node.
function openListItem(parentNode, openStack, marker, delimiter, textCol) {
  // When the line matched an existing list in Phase 1, topNode() IS
  // that list (already on the stack) and the new item belongs to it
  // -- do not push it again. Otherwise the list is the parent's
  // last child when it matches, else a new list under the parent.
  let found = findListForItem(parentNode, marker, delimiter);
  let listNode = found.list;
  let itemNode = { type: 'item', children: [], endsWithBlank: false, hasBlankBetween: false };
  // content indent relative to the line's content start
  // (textCol), so a blockquote prefix does not shift it
  itemNode.relIndent = marker.contentIndent - textCol;
  listNode.children.push(itemNode);
  if (!found.onStack) openStack.push(listNode);
  openStack.push(itemNode);
  return itemNode;
}

// The absolute column an item's content indent sits at on this line.
// The indent is RELATIVE to the container's content start on this
// line (column - padding): a blockquote prefix is a different width
// on different lines, so an absolute column would misalign
// continuation lines (cm-259).
function itemIndentTarget(column, padding, relIndent) {
  return (column - padding) + relIndent;
}

// Advance past a list item's content indent. Returns {cursor, column,
// padding} when the line continues the item, or null when it does not.
function matchItemIndent(raw, cursor, column, padding, relIndent) {
  let indentTarget = itemIndentTarget(column, padding, relIndent);
  if (indentTarget <= column) {
    // padding (virtual spaces from a tab expansion in an outer
    // container) may overlap the item's indent: the first
    // relIndent padding spaces are the item's indent, not content
    if (padding > 0) padding -= Math.min(relIndent, padding);
    return { cursor, column, padding };
  }
  let advanced = advanceCols(raw, cursor, column, indentTarget);
  if (!advanced) return null;
  return { cursor: advanced[0], column: advanced[1], padding: advanced[2] };
}

// The delimiter char of a matched list marker ('.', ')' for ordered,
// the bullet char otherwise).
function markerDelimiter(marker, text, indent) {
  if (marker.ordered) return text.slice(indent + marker.markerLen - 1, indent + marker.markerLen);
  return marker.bullet;
}

// Does the text (after the containers) start a new item of this list?
// Returns 'hr' for a thematic break, 'marker' for a list marker
// matching the list's type/delimiter, or null otherwise. (A thematic
// break is NOT a new item.)
function listMarkerKeepsList(text, col, container) {
  let indent = indentOf(text, col);
  if (indent >= 4) return null;
  if (matchHR(text.slice(indent), col + indent)) return 'hr';
  let marker = matchListMarker(text.slice(indent), col + indent);
  if (!marker) return null;
  let delim = markerDelimiter(marker, text, indent);
  if (marker.ordered === container.ordered && delim === container.delimiter) return 'marker';
  return null;
}

// Pure probe: does the line continue a list item (without consuming
// anything)? True when the item's content indent is already reached,
// or when advanceCols can reach it.
function itemContinues(raw, cursor, column, padding, relIndent) {
  let indentTarget = itemIndentTarget(column, padding, relIndent);
  if (indentTarget <= column) return true;
  return !!advanceCols(raw, cursor, column, indentTarget);
}

// Is the text (at column col) the start of a block that can end a
// fenced code block's lazy continuation? (fence, ATX, HR, or an HTML
// block type 1-6.)
function isBlockStartLine(text, col) {
  if (matchFence(text, col) || matchATX(text, col) || matchHR(text, col)) return true;
  let htmlTag = matchHtmlBlock(text, col);
  return htmlTag > 0 && htmlTag <= 6;
}

// Is the previous content line of a fenced block (or its opening line
// when empty) itself a block start? A lazy line after one does not
// belong to the fence.
function fencePrevIsBlockStart(blockNode, lineText) {
  let prevText = blockNode.lines.length > 0 ? blockNode.lines[blockNode.lines.length - 1] : lineText;
  return isBlockStartLine(prevText, 0);
}

// Dedent one fenced-code content line (backtick fences only, up to the
// fence's indent, character-based). A tilde fence keeps lines as-is.
function fenceDedentLine(text, col, fenceInfo, fenceIndent) {
  let lineIndent = indentOf(text, col);
  if (lineIndent > 0 && fenceInfo.ch === '`') return stripLeadingWSChars(text, fenceIndent);
  return text;
}

// Consume the lines of a fenced code block starting after its opening
// line. Returns the scan line just past the block.
function consumeFencedCode(sourceLines, fromLine, openStack, fenceInfo, lineText, textCol, blockNode) {
  let scanLine = fromLine;
  let fenceIndent = indentOf(lineText, textCol);
  while (scanLine < sourceLines.length) {
    let nextRaw = sourceLines[scanLine];
    let stripFail = {};
    let stripped = stripContainersForLine(nextRaw, openStack, stripFail);
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
      if (matchFenceClose(nextRaw, 0, fenceInfo.ch, fenceInfo.len)) { scanLine += 1; break; }
      // a lazy line is part of the fence only when the previous
      // line is not itself a block start (marked's list-item text
      // building breaks a lazy line after a fence/heading/html/hr
      // line: the item text ends there, so the fence has no
      // content after its opening line -- doc-17's empty toml
      // fence). The previous line is the last content line, or
      // the opening fence line when the block is still empty.
      if (fencePrevIsBlockStart(blockNode, lineText)) break;
      // A lazy line starts a new block when its content AFTER the
      // containers that did match is a block start. The raw line's
      // indent is misleading: a list marker at raw indent 4
      // ('    + ...') is a new item once the outer item's indent
      // is stripped (doc-12/doc-36).
      let restAfter = (stripFail.pad > 0 ? ' '.repeat(stripFail.pad) : '') + nextRaw.slice(stripFail.pos);
      let restCol = stripFail.col - stripFail.pad;
      if (isFenceBlockStart(restAfter, restCol)) break;
      blockNode.lines.push(nextRaw);
      scanLine += 1;
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
      let lookahead = scanLine + 1;
      let laterMatch = null;
      while (lookahead < sourceLines.length) {
        let lookFail = {};
        let later = stripContainersForLine(sourceLines[lookahead], openStack, lookFail);
        if (!later) {
          if (isBlankStr(sourceLines[lookahead])) break;
          if (lookFail.reason !== 'item') break;
          // lazy line: a closing fence or a content line (whose
          // previous line is not a block start) continues the
          // block; a block-starting line ends it
          if (matchFenceClose(sourceLines[lookahead], 0, fenceInfo.ch, fenceInfo.len)) { laterMatch = { text: sourceLines[lookahead], col: 0 }; break; }
          if (fencePrevIsBlockStart(blockNode, lineText)) break;
          // same as the main lazy-line branch: judge the block
          // start on the content after the containers that did
          // match, not on the raw line
          let restAfterK = (lookFail.pad > 0 ? ' '.repeat(lookFail.pad) : '') + sourceLines[lookahead].slice(lookFail.pos);
          let restColK = lookFail.col - lookFail.pad;
          if (isFenceBlockStart(restAfterK, restColK)) break;
          laterMatch = { text: sourceLines[lookahead], col: 0 }; break;
        }
        if (!isBlankStr(later.text)) { laterMatch = later; break; }
        lookahead += 1;
      }
      if (laterMatch) {
        // marked's Dt dedents ONLY backtick fences (its regex is
        // /^(\s+)(?:```)/ -- a tilde fence never matches); a tilde
        // fence keeps its content lines as-is
        blockNode.lines.push(fenceDedentLine(stripped.text, stripped.col, fenceInfo, fenceIndent));
        scanLine += 1;
        continue;
      }
      break;
    }
    if (matchFenceClose(stripped.text, stripped.col, fenceInfo.ch, fenceInfo.len)) { scanLine += 1; break; }
    // dedent (up to the fence's indent) -- character-based, backtick
    // fences only (see above)
    blockNode.lines.push(fenceDedentLine(stripped.text, stripped.col, fenceInfo, fenceIndent));
    scanLine += 1;
  }
  return scanLine;
}

// Consume the lines of an HTML block after its opening line. Returns
// {scanLine, seenBlank}: seenBlank is true when a blank line ended a
// type 6-7 block.
// For HTML block types 1-5: every line is content until the closing
// marker. Returns true when this line contains the marker (the block
// ends after it).
function htmlBlockLineEnds(stripped, endMarker) {
  return stripped.text.toLowerCase().includes(endMarker);
}

// Consume the lines of an HTML block after its opening line. Returns
// {scanLine, seenBlank}: seenBlank is true when a blank line ended a
// type 6-7 block.
function consumeHtmlBlockLines(sourceLines, fromLine, openStack, endMarker, blockNode) {
  let scanLine = fromLine;
  let seenBlank = false;
  while (scanLine < sourceLines.length) {
    let nextRaw = sourceLines[scanLine];
    let stripped = stripContainersForLine(nextRaw, openStack);
    if (!stripped) break;
    if (endMarker) {
      // types 1-5: every line is content until the closing marker
      blockNode.lines.push(stripped.text);
      scanLine += 1;
      if (htmlBlockLineEnds(stripped, endMarker)) break;
      continue;
    }
    // types 6-7: a blank line ends the block
    if (isBlankStr(stripped.text)) {
      seenBlank = true;
      scanLine += 1;
      break;
    }
    blockNode.lines.push(stripped.text);
    scanLine += 1;
  }
  return { scanLine, seenBlank };
}

// Is the line after an HTML block a blank line (stripping containers)?
// Only a truly EMPTY raw line, or a line that strips to empty, counts.
// (A lone '>' line in a blockquote is a blank line in the quote's text,
// doc-30, just as an empty raw line is at the top level.)
function nextLineIsBlank(sourceLines, scanLine, openStack) {
  if (scanLine >= sourceLines.length) return false;
  if (sourceLines[scanLine].length === 0) return true;
  let strippedNext = stripContainersForLine(sourceLines[scanLine], openStack);
  return !!strippedNext && strippedNext.text === '';
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
        let bq = matchBlockquote(raw, cursor, column, padding, openStack, stackIdx);
        if (!bq.matched) break;
        cursor = bq.cursor; column = bq.column; padding = bq.padding;
        matchedDepth = bq.matchedDepth;
        if (bq.stop) break;
        continue;
      }
      if (container.type === 'item') {
        if (blankLine) { matchedDepth = stackIdx + 1; continue; }
        // an empty item followed by a blank line is closed: later
        // indented lines do not belong to it
        if (container.children.length === 0 && prevBlank) break;
        let adv = matchItemIndent(raw, cursor, column, padding, container.relIndent);
        if (!adv) break;
        cursor = adv.cursor; column = adv.column; padding = adv.padding;
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
          if (!itemContinues(raw, cursor, column, padding, nextItem.relIndent)) {
            const restSlice = (padding > 0 ? ' '.repeat(padding) : '') + raw.slice(cursor);
            const restBaseCol = column - padding;
            let keep = listMarkerKeepsList(restSlice, restBaseCol, container);
            if (keep === 'hr') break;
            if (keep === 'marker') { matchedDepth = stackIdx + 1; continue; }
          }
          // an empty item followed by a blank line is closed
          if (nextItem.children.length === 0 && prevBlank) break;
          let adv = matchItemIndent(raw, cursor, column, padding, nextItem.relIndent);
          if (adv) {
            cursor = adv.cursor; column = adv.column; padding = adv.padding;
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
          let keepTail = listMarkerKeepsList(tailText, tailCol, container);
          if (keepTail === 'hr') break;
          if (keepTail === 'marker') { matchedDepth = stackIdx + 1; continue; }
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
        lineNo = consumeIndentedCode(sourceLines, lineNo + 1, openStack, blockNode) - 1;
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
      // trailing newline of a fenced block: the block's content ends with
      // a newline (CommonMark: the text between fences, lines joined)
      lineNo = consumeFencedCode(sourceLines, lineNo + 1, openStack, fenceInfo, lineText, textCol, blockNode) - 1;
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
        const endMarker = htmlEndMarker(htmlKind, lineText);
        let seenBlank = false;
        // when the start line already contains the closing marker
        // (e.g. '<style>...</style>' or '<!-- foo -->'), the block is
        // just that line -- no further lines are consumed
        if (!(endMarker && lineText.toLowerCase().includes(endMarker))) {
          let consumed = consumeHtmlBlockLines(sourceLines, scanLine, openStack, endMarker, blockNode);
          scanLine = consumed.scanLine;
          seenBlank = consumed.seenBlank;
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
        let nextBlank = nextLineIsBlank(sourceLines, scanLine, openStack);
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
            openListItem(parentNode, openStack, marker, delimiter, textCol);
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

// Expand the whitespace run after a blockquote '>' marker, starting at
// index q with visual column vq. Returns {exp, hasTab, vq, q}.
function expandMarkerWs(rawLine, q, vq) {
  let exp = 0;
  let hasTab = false;
  let p = q;
  let col = vq;
  while (p < rawLine.length) {
    let ch = rawLine.charCodeAt(p);
    if (ch === 32) { exp += 1; col += 1; p += 1; }
    else if (ch === 9) {
      hasTab = true;
      let w = 4 - (col % 4);
      exp += w; col += w; p += 1;
    }
    else break;
  }
  return { exp, hasTab, vq: col, q: p };
}

// Expand the leading whitespace of a content remainder to spaces
// (marked's J): a leading tab advances to the next multiple of 4 from
// its column. Returns the remainder unchanged when it has no leading
// whitespace.
function expandLeadingTabs(rem, col) {
  let exp = '';
  let cc = col;
  let ii = 0;
  while (ii < rem.length) {
    let ch = rem.charCodeAt(ii);
    if (ch === 32) { exp += ' '; cc += 1; ii += 1; }
    else if (ch === 9) { let nx = cc + (4 - (cc % 4)); exp += ' '.repeat(nx - cc); cc = nx; ii += 1; }
    else break;
  }
  if (ii === 0) return rem;
  return exp + rem.slice(ii);
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
  let pos = 0;
  let col = 0;
  let pad = 0;
  let si = 1;
  while (si < stack.length) {
    let cont = stack[si];
    if (cont.type === 'blockquote') {
      let p = pos;
      let c = col;
      let sp = 0;
      while (p < rawLine.length && sp < 3 && rawLine.charCodeAt(p) === 32) { p += 1; c += 1; sp += 1; }
      if (p < rawLine.length && rawLine.charCodeAt(p) === 62) {
        p += 1; c += 1;
        let vgt = pad + (p - pos) - 1;
        let expanded = expandMarkerWs(rawLine, p, vgt + 1);
        if (expanded.hasTab) { pad = expanded.exp > 0 ? expanded.exp - 1 : 0; c = expanded.vq; p = expanded.q; }
        else if (expanded.q > p) { p += 1; c += 1; }
        pos = p; col = c;
        si += 1;
        continue;
      }
      if (isBlankStr(rawLine)) { si += 1; continue; }
      if (fail) { fail.reason = 'blockquote'; fail.pos = pos; fail.col = col; fail.pad = pad; }
      return null;
    }
    if (cont.type === 'item') {
      // a line that is blank after the outer containers were stripped
      // (e.g. a lone '>' inside a blockquote) matches the item
      if (isBlankStr(rawLine.slice(pos))) { si += 1; continue; }
      let adv = matchItemIndent(rawLine, pos, col, pad, cont.relIndent);
      if (!adv) { if (fail) { fail.reason = 'item'; fail.pos = pos; fail.col = col; fail.pad = pad; } return null; }
      pos = adv.cursor; col = adv.column; pad = adv.padding;
      si += 1;
      continue;
    }
    // list: transparent; handled by the item entry below
    let next = stack[si + 1];
    if (next && next.type === 'item') {
      if (isBlankStr(rawLine.slice(pos))) { si += 2; continue; }
      let adv = matchItemIndent(rawLine, pos, col, pad, next.relIndent);
      if (!adv) { if (fail) { fail.reason = 'item'; fail.pos = pos; fail.col = col; fail.pad = pad; } return null; }
      pos = adv.cursor; col = adv.column; pad = adv.padding;
      si += 2;
      continue;
    }
    si += 1;
  }
  // Expand the remainder's leading whitespace to spaces (marked's J):
  // inside a list item / blockquote, a leading tab in the content
  // advances to the next multiple of 4 from its column. At top level
  // (no containers) tabs are kept as-is.
  let rem = rawLine.slice(pos);
  if (stack.length > 1) rem = expandLeadingTabs(rem, col);
  let text = (pad > 0 ? ' '.repeat(pad) : '') + rem;
  return { text, col: col - pad };
}

// Emit a GFM task-list checkbox for a paragraph node that carries one.
function pushTaskCheckbox(block, html) {
  if (block.task === 0) html.push('<input disabled="" type="checkbox"> ');
  else if (block.task === 1) html.push('<input checked="" disabled="" type="checkbox"> ');
}

// The text of a code block: lines joined by '\n', ending with exactly
// one trailing '\n' when non-empty (a fenced block's trailing blank
// lines contribute only up to that one newline; an empty block has none).
function codeBlockText(lines) {
  let codeText = lines.join('\n');
  if (codeText.length === 0) return codeText;
  if (codeText.endsWith('\n')) return codeText;
  return codeText + '\n';
}

function renderCodeBlock(block, html) {
  html.push('<pre><code');
  if (block.lang) {
    html.push(' class="language-');
    escapeAttr(block.lang, html);
    html.push('"');
  }
  html.push('>');
  // escape the code text directly (no entities in code blocks)
  escapeText(codeBlockText(block.lines), html);
  html.push('</code></pre>\n');
}

// An HTML block's lines output verbatim; trailing blank lines
// (spaces-only lines at the end) do not contribute.
function htmlBlockText(block) {
  let htmlText = block.lines.join('\n');
  // strip trailing blank lines (spaces-only lines at the end)
  htmlText = htmlText.replace(/[ \t]*(\n[ \t]*)+$/, '');
  return htmlText;
}

function renderHtmlBlock(block, html) {
  // A block terminated by a blank line has no trailing newline;
  // one terminated by EOF, another block, or its closing tag does.
  let htmlText = htmlBlockText(block);
  if (htmlText.length > 0) html.push(htmlText);
  if (block.trailingNL !== false) html.push('\n');
}

// Render one table cell (<th> or <td>) with its alignment attribute.
function renderTableCell(tag, content, align, linkDefs, html) {
  html.push('<' + tag + (align ? ' align="' + align + '"' : '') + '>');
  parseInline(content, linkDefs, html, false, null);
  html.push('</' + tag + '>\n');
}

function renderTable(block, linkDefs, html) {
  html.push('<table>\n<thead>\n<tr>\n');
  for (let idx = 0; idx < block.header.length; idx += 1) {
    renderTableCell('th', block.header[idx], block.aligns[idx], linkDefs, html);
  }
  html.push('</tr>\n</thead>\n');
  // a table with no body rows has no <tbody> at all (gfm-205)
  if (block.rows.length === 0) { html.push('</table>\n'); return; }
  html.push('<tbody>');
  for (let rowIdx = 0; rowIdx < block.rows.length; rowIdx += 1) {
    let row = block.rows[rowIdx];
    html.push('<tr>\n');
    for (let cellIdx = 0; cellIdx < block.header.length; cellIdx += 1) {
      renderTableCell('td', row[cellIdx], block.aligns[cellIdx], linkDefs, html);
    }
    html.push('</tr>\n');
  }
  html.push('</tbody></table>\n');
}

// The opening tag of a list ('<ul>', '<ol>', or '<ol start="N">').
function listOpenTag(block) {
  let tagName = block.ordered ? 'ol' : 'ul';
  if (block.ordered && block.start !== undefined && block.start !== 1) {
    return '<' + tagName + ' start="' + block.start + '">';
  }
  return '<' + tagName + '>';
}

function renderList(block, linkDefs, html) {
  let tight = computeTight(block);
  let tagName = block.ordered ? 'ol' : 'ul';
  html.push(listOpenTag(block));
  html.push('\n');
  for (let idx = 0; idx < block.children.length; idx += 1) {
    renderItem(block.children[idx], linkDefs, html, tight);
  }
  html.push('</' + tagName + '>\n');
}

// ---------------------------------------------------------------------------
// Render the block tree to HTML
// ---------------------------------------------------------------------------
// Render a list of child blocks in order.
function renderChildren(children, linkDefs, html) {
  for (let idx = 0; idx < children.length; idx += 1) {
    renderBlock(children[idx], linkDefs, html);
  }
}
// Block renderers, keyed by block type. Each takes (block, linkDefs, html).
const BLOCK_RENDERERS = {
  document(block, linkDefs, html) {
    renderChildren(block.children, linkDefs, html);
  },
  paragraph(block, linkDefs, html) {
    html.push('<p>');
    pushTaskCheckbox(block, html);
    parseInline(block.text, linkDefs, html, false, null);
    html.push('</p>\n');
  },
  heading(block, linkDefs, html) {
    html.push('<h' + block.level + '>');
    parseInline(block.text, linkDefs, html, false, null);
    html.push('</h' + block.level + '>\n');
  },
  hr(block, linkDefs, html) {
    html.push('<hr>\n');
  },
  code_block(block, linkDefs, html) {
    renderCodeBlock(block, html);
  },
  html_block(block, linkDefs, html) {
    renderHtmlBlock(block, html);
  },
  blockquote(block, linkDefs, html) {
    html.push('<blockquote>\n');
    renderChildren(block.children, linkDefs, html);
    html.push('</blockquote>\n');
  },
  list(block, linkDefs, html) {
    renderList(block, linkDefs, html);
  },
  table(block, linkDefs, html) {
    renderTable(block, linkDefs, html);
  },
};
function renderBlock(block, linkDefs, html) {
  let render = BLOCK_RENDERERS[block.type];
  if (render) render(block, linkDefs, html);
}

// Detect a GFM task-list marker at the start of a list item's first
// paragraph ('[ ] ' / '[x] ' / '[X] '); converts it into a checkbox
// (task 0/1) and drops the marker from the text.
function applyTaskMarker(listItem) {
  let children = listItem.children;
  if (children.length === 0 || children[0].type !== 'paragraph') return;
  let firstText = children[0].text;
  if (firstText.length < 4 || firstText[0] !== '[' || firstText[2] !== ']' || firstText[3] !== ' ') return;
  let marker = firstText[1];
  if (marker === ' ') { children[0].task = 0; children[0].text = firstText.slice(4); }
  else if (marker === 'x' || marker === 'X') { children[0].task = 1; children[0].text = firstText.slice(4); }
}

// Render one child of a list item. In a tight list, a paragraph child
// renders inline (no <p> wrapper, no trailing newline).
function renderItemChild(child, linkDefs, html, isTight) {
  if (child.type === 'paragraph' && isTight) {
    pushTaskCheckbox(child, html);
    parseInline(child.text, linkDefs, html, false, null);
  } else {
    renderBlock(child, linkDefs, html);
  }
}

// Render a list item. In a tight list, a paragraph child is rendered
// without the <p> wrapper (its inline content only); in a loose list it
// keeps the <p> wrapper. A tight list item containing a single paragraph
// renders the paragraph inline; the <li> tags wrap the content.
function renderItem(listItem, linkDefs, html, isTight) {
  html.push('<li>');
  let children = listItem.children;
  // GFM task list: if the item's first child is a paragraph whose text
  // starts with '[ ] ' / '[x] ' / '[X] ', it renders a checkbox input
  // at the start of that paragraph and the marker is dropped.
  applyTaskMarker(listItem);
  // render each child; in a tight list, paragraph children render inline
  // (no <p> wrapper, no trailing newline), and no extra newline is ever
  // added between children -- blocks carry their own trailing newline
  for (let idx = 0; idx < children.length; idx += 1) {
    renderItemChild(children[idx], linkDefs, html, isTight);
  }
  html.push('</li>\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// Normalise line endings (CRLF/CR -> LF) and NULs (replacement char),
// then split into lines, dropping the final empty line a trailing
// newline produces (it is not a real line). Returns {lines, endsNL}.
function splitInput(input) {
  input = input.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
  let sourceLines = input.split('\n');
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop();
  return { lines: sourceLines, endsNL: input.endsWith('\n') };
}

// parse(input): render Markdown to HTML, byte-identical to marked 18.1.3
// (with headerIds off, mangle off, GFM on) on the test cases.
function parse(input) {
  let split = splitInput(input);
  // fresh per-document inline state (inLink is set by raw <a> tags and
  // must not leak from a previous document)
  inLink = false;
  let linkDefs = new Map();
  let rootDoc = parseBlocks(split.lines, linkDefs, split.endsNL);
  let html = [];
  renderBlock(rootDoc, linkDefs, html);
  return html.join('');
}

export default parse;
export { parse };
