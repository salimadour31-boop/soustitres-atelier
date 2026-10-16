/*!
 * Sous-titres Atelier — subs.js
 * Pure, DOM-free helpers: timestamp parsing/formatting, SRT / WebVTT / JSON
 * import, SRT / WebVTT / TXT / JSON export, time shift, framerate conversion,
 * sorting and quality checks (overlap, reading speed, line length…).
 *
 * Works in the browser (global `Subs`) and in Node (`require('./subs.js')`),
 * so the same code is covered by the unit tests in tests/unit.js.
 * All times are integers in milliseconds.
 * MIT License — © 2026 salimadour31-boop
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Subs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Timestamps                                                          */
  /* ------------------------------------------------------------------ */

  function pad(n, w) { return String(n).padStart(w, '0'); }

  /**
   * Format milliseconds as HH:MM:SS<sep>mmm.
   * sep = ',' for SRT (default), '.' for WebVTT.
   */
  function formatTime(ms, sep) {
    if (sep === undefined) sep = ',';
    ms = Math.max(0, Math.round(Number(ms) || 0));
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var f = ms % 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sep + pad(f, 3);
  }

  /**
   * Parse a timestamp into milliseconds. Lenient on purpose so it can also
   * read what people type in the editor:
   *   "01:02:03,456"  "01:02:03.456"  "02:03.5"  "63.25"  "63"
   * Returns NaN when the string is not a valid timestamp.
   */
  function parseTime(str) {
    if (typeof str === 'number') return isFinite(str) && str >= 0 ? Math.round(str) : NaN;
    str = String(str == null ? '' : str).trim().replace(',', '.');
    if (!str) return NaN;
    var parts = str.split(':');
    if (parts.length > 3) return NaN;
    var secPart = parts.pop();
    if (!/^\d+(\.\d+)?$/.test(secPart)) return NaN;
    for (var i = 0; i < parts.length; i++) if (!/^\d+$/.test(parts[i])) return NaN;
    var dot = secPart.indexOf('.');
    var whole = dot < 0 ? secPart : secPart.slice(0, dot);
    var frac = dot < 0 ? '' : secPart.slice(dot + 1);
    // "5" -> 500 ms, "05" -> 50 ms, "5000" -> 500 ms (rounded)
    var fracMs = frac ? Math.round(Number('0.' + frac) * 1000) : 0;
    var total = Number(whole) * 1000 + fracMs;
    var mult = 60000;
    for (var j = parts.length - 1; j >= 0; j--) { total += Number(parts[j]) * mult; mult *= 60; }
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* Text helpers                                                        */
  /* ------------------------------------------------------------------ */

  function normalizeNewlines(t) {
    return String(t == null ? '' : t).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  }

  /** Remove formatting tags (<i>, <b>, <font …>, <v Name>, {\an8}…) for display and counting. */
  function stripTags(t) {
    return String(t || '').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '');
  }

  /** Lines of a cue text with blank lines removed (blank lines would break SRT/VTT blocks). */
  function cleanLines(t) {
    return normalizeNewlines(t).split('\n').map(function (l) { return l.replace(/\s+$/, ''); })
      .filter(function (l) { return l.trim() !== ''; });
  }

  var ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': '\u00A0', '&lrm;': '\u200E', '&rlm;': '\u200F' };
  function decodeVttEntities(t) {
    return t.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, function (m) { return ENTITIES[m]; });
  }
  /** Escape cue text for WebVTT while keeping simple formatting tags intact. */
  function encodeVttText(t) {
    return t.replace(/&/g, '&amp;')
      .replace(/<(?!\/?(?:i|b|u|c|v|lang|ruby|rt)(?:[\s.>]|$))/g, '&lt;')
      .replace(/-->/g, '--&gt;');
  }

  /* ------------------------------------------------------------------ */
  /* Import                                                              */
  /* ------------------------------------------------------------------ */

  var TIMING = /^\s*(\S+)\s*-->\s*(\S+)(.*)$/;

  /**
   * Shared block scanner for SRT and WebVTT. It looks for timing lines
   * ("start --> end [settings]") and takes the following non-blank lines as
   * the cue text. Index numbers, cue identifiers, the WEBVTT header and
   * NOTE / STYLE / REGION blocks (which never contain "-->") are skipped.
   */
  function scan(text, isVtt) {
    var lines = normalizeNewlines(text).split('\n');
    var cues = [];
    var i = 0;
    while (i < lines.length) {
      var m = TIMING.exec(lines[i]);
      if (!m) { i++; continue; }
      var start = parseTime(m[1]);
      var end = parseTime(m[2]);
      i++;
      var txt = [];
      while (i < lines.length && lines[i].trim() !== '') {
        if (TIMING.test(lines[i])) break; // missing blank line before next cue
        // "12" directly followed by a timing line = next SRT index without blank line
        if (/^\d+$/.test(lines[i].trim()) && i + 1 < lines.length && TIMING.test(lines[i + 1])) break;
        txt.push(lines[i].replace(/\s+$/, ''));
        i++;
      }
      if (!isNaN(start) && !isNaN(end)) {
        var body = txt.join('\n');
        cues.push({ start: start, end: end, text: isVtt ? decodeVttEntities(body) : body });
      }
    }
    return cues;
  }

  function parseSRT(text) { return scan(text, false); }
  function parseVTT(text) { return scan(text, true); }

  /** Read a JSON project (as exported) or a bare array of {start,end,text}. */
  function parseJSON(text) {
    var data = JSON.parse(text);
    var list = Array.isArray(data) ? data : (data && Array.isArray(data.cues) ? data.cues : null);
    if (!list) throw new Error('No "cues" array');
    return list.map(function (c) {
      var s = typeof c.start === 'number' ? Math.round(c.start) : parseTime(c.start);
      var e = typeof c.end === 'number' ? Math.round(c.end) : parseTime(c.end);
      return { start: s, end: e, text: String(c.text == null ? '' : c.text) };
    }).filter(function (c) { return !isNaN(c.start) && !isNaN(c.end); });
  }

  function detectFormat(text) {
    var t = normalizeNewlines(text).trim();
    if (/^WEBVTT/.test(t)) return 'vtt';
    if (t[0] === '{' || t[0] === '[') return 'json';
    return 'srt';
  }

  /** Auto-detecting import. Returns { format, cues }. */
  function parseAny(text) {
    var format = detectFormat(text);
    var cues = format === 'vtt' ? parseVTT(text) : format === 'json' ? parseJSON(text) : parseSRT(text);
    return { format: format, cues: cues };
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                              */
  /* ------------------------------------------------------------------ */

  function toSRT(cues) {
    return cues.map(function (c, i) {
      return (i + 1) + '\n' + formatTime(c.start, ',') + ' --> ' + formatTime(c.end, ',') + '\n' +
        cleanLines(c.text).join('\n') + '\n';
    }).join('\n');
  }

  function toVTT(cues) {
    var body = cues.map(function (c) {
      return formatTime(c.start, '.') + ' --> ' + formatTime(c.end, '.') + '\n' +
        cleanLines(c.text).map(encodeVttText).join('\n') + '\n';
    }).join('\n');
    return 'WEBVTT\n\n' + body;
  }

  /** Plain transcript: one cue per line, tags removed, line breaks joined with a space. */
  function toTXT(cues) {
    return cues.map(function (c) { return cleanLines(stripTags(c.text)).join(' '); })
      .filter(function (l) { return l !== ''; }).join('\n') + '\n';
  }

  function toJSON(cues, extra) {
    var out = { app: 'soustitres-atelier', version: 1 };
    if (extra) for (var k in extra) out[k] = extra[k];
    out.cues = cues.map(function (c) {
      return { start: c.start, end: c.end, startTC: formatTime(c.start), endTC: formatTime(c.end), text: c.text };
    });
    return JSON.stringify(out, null, 2) + '\n';
  }

  /* ------------------------------------------------------------------ */
  /* Timing tools (return new arrays, never mutate the input)            */
  /* ------------------------------------------------------------------ */

  function copy(c) { var o = {}; for (var k in c) o[k] = c[k]; return o; }

  /** Shift cues by `ms` (may be negative). `pick(cue, index)` limits which cues move. Times are clamped at 0. */
  function shift(cues, ms, pick) {
    return cues.map(function (c, i) {
      if (pick && !pick(c, i)) return c;
      var o = copy(c);
      o.start = Math.max(0, Math.round(c.start + ms));
      o.end = Math.max(0, Math.round(c.end + ms));
      return o;
    });
  }

  /** Multiply every time by `factor`. */
  function stretch(cues, factor) {
    return cues.map(function (c) {
      var o = copy(c);
      o.start = Math.round(c.start * factor);
      o.end = Math.round(c.end * factor);
      return o;
    });
  }

  /**
   * Framerate conversion, e.g. subtitles timed on a 23.976 fps master that is
   * now played at 25 fps (PAL speed-up): every time is multiplied by from / to.
   */
  function convertFps(cues, fromFps, toFps) {
    return stretch(cues, fromFps / toFps);
  }

  /** Stable sort by start, then end. */
  function sortCues(cues) {
    return cues.map(function (c, i) { return [c, i]; }).sort(function (a, b) {
      return (a[0].start - b[0].start) || (a[0].end - b[0].end) || (a[1] - b[1]);
    }).map(function (p) { return p[0]; });
  }

  /** Trim each cue that overlaps the next one so it ends where the next starts. */
  function fixOverlaps(cues) {
    var out = cues.map(copy);
    for (var i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start && out[i + 1].start > out[i].start) out[i].end = out[i + 1].start;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Quality checks                                                      */
  /* ------------------------------------------------------------------ */

  /** Visible characters (tags and line breaks excluded). */
  function charCount(text) { return stripTags(text).replace(/\n/g, '').length; }

  /** Characters per second. */
  function cps(cue) {
    var d = (cue.end - cue.start) / 1000;
    if (d <= 0) return Infinity;
    return charCount(cue.text) / d;
  }

  /**
   * List the problems of `cue` given the previous cue in the list.
   * opts: { maxCps, maxLine, minDur, maxLines }
   * Returns codes: invalid, overlap, cps, line, lines, short, empty.
   */
  function checkCue(cue, prev, opts) {
    opts = opts || {};
    var maxCps = opts.maxCps || 17, maxLine = opts.maxLine || 42, minDur = opts.minDur || 700, maxLines = opts.maxLines || 2;
    var w = [];
    if (cue.end <= cue.start) w.push('invalid');
    if (prev && cue.start < prev.end) w.push('overlap');
    var plain = stripTags(cue.text);
    if (plain.trim() === '') w.push('empty');
    else {
      if (cue.end > cue.start && cps(cue) > maxCps) w.push('cps');
      var lines = cleanLines(plain);
      if (lines.some(function (l) { return l.length > maxLine; })) w.push('line');
      if (lines.length > maxLines) w.push('lines');
    }
    if (cue.end > cue.start && cue.end - cue.start < minDur) w.push('short');
    return w;
  }

  /* ------------------------------------------------------------------ */
  /* Editing helpers                                                     */
  /* ------------------------------------------------------------------ */

  /** Split a cue text in two halves: by lines when there are several, else at the middle word. */
  function splitText(text) {
    var lines = cleanLines(text);
    if (lines.length >= 2) {
      var h = Math.ceil(lines.length / 2);
      return [lines.slice(0, h).join('\n'), lines.slice(h).join('\n')];
    }
    var words = (lines[0] || '').split(/\s+/).filter(Boolean);
    if (words.length < 2) return [lines[0] || '', ''];
    // choose the space closest to the middle of the line
    var total = words.join(' ').length, prefix = -1, cut = 1, best = Infinity;
    for (var i = 0; i < words.length - 1; i++) {
      prefix += words[i].length + 1; // length of "w0 … wi"
      var d = Math.abs(prefix - total / 2);
      if (d < best) { best = d; cut = i + 1; }
    }
    return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
  }

  return {
    formatTime: formatTime, parseTime: parseTime,
    stripTags: stripTags, cleanLines: cleanLines,
    parseSRT: parseSRT, parseVTT: parseVTT, parseJSON: parseJSON, parseAny: parseAny, detectFormat: detectFormat,
    toSRT: toSRT, toVTT: toVTT, toTXT: toTXT, toJSON: toJSON,
    shift: shift, stretch: stretch, convertFps: convertFps, sortCues: sortCues, fixOverlaps: fixOverlaps,
    charCount: charCount, cps: cps, checkCue: checkCue, splitText: splitText
  };
});
