// Unit tests for subs.js (no dependency). Run: node tests/unit.js
'use strict';
const assert = require('assert');
const S = require('../subs.js');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

test('formatTime SRT / VTT', () => {
  assert.strictEqual(S.formatTime(0), '00:00:00,000');
  assert.strictEqual(S.formatTime(3723456), '01:02:03,456');
  assert.strictEqual(S.formatTime(3723456, '.'), '01:02:03.456');
  assert.strictEqual(S.formatTime(59999.6), '00:01:00,000');
  assert.strictEqual(S.formatTime(-50), '00:00:00,000');
  assert.strictEqual(S.formatTime(100 * 3600000), '100:00:00,000');
});

test('parseTime variants', () => {
  assert.strictEqual(S.parseTime('01:02:03,456'), 3723456);
  assert.strictEqual(S.parseTime('01:02:03.456'), 3723456);
  assert.strictEqual(S.parseTime('02:03.5'), 123500);
  assert.strictEqual(S.parseTime('63.25'), 63250);
  assert.strictEqual(S.parseTime('63'), 63000);
  assert.strictEqual(S.parseTime(' 00:00:01,05 '), 1050);
  assert.ok(isNaN(S.parseTime('abc')));
  assert.ok(isNaN(S.parseTime('')));
  assert.ok(isNaN(S.parseTime('1:2:3:4')));
  assert.ok(isNaN(S.parseTime('-1')));
});

test('format/parse round trip on many values', () => {
  for (let ms = 0; ms < 4 * 3600000; ms += 7919) {
    assert.strictEqual(S.parseTime(S.formatTime(ms)), ms);
    assert.strictEqual(S.parseTime(S.formatTime(ms, '.')), ms);
  }
});

const SRT = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\nBonjour à tous !\r\nAzul fellawen.\r\n\r\n' +
  '2\r\n00:00:04,000 --> 00:00:06,250\r\n<i>Musique douce</i>\r\n\r\n' +
  '3\r\n00:01:00,000 --> 00:01:02,000\r\nLigne avec 42 → flèche & « guillemets »\r\n';

test('parseSRT basic, CRLF, BOM, multi-line, tags', () => {
  const c = S.parseSRT(SRT);
  assert.strictEqual(c.length, 3);
  assert.deepStrictEqual(c[0], { start: 1000, end: 3500, text: 'Bonjour à tous !\nAzul fellawen.' });
  assert.strictEqual(c[1].text, '<i>Musique douce</i>');
  assert.strictEqual(c[2].start, 60000);
});

test('SRT import -> export -> import round trip', () => {
  const a = S.parseSRT(SRT);
  const out = S.toSRT(a);
  assert.ok(out.startsWith('1\n00:00:01,000 --> 00:00:03,500\nBonjour à tous !\nAzul fellawen.\n\n2\n'));
  assert.deepStrictEqual(S.parseSRT(out), a);
  // Export is stable (idempotent)
  assert.strictEqual(S.toSRT(S.parseSRT(out)), out);
});

test('SRT tolerant: missing blank lines, dot separator, trailing spaces', () => {
  const t = '1\n00:00:01.000 --> 00:00:02.000  \nA  \n2\n00:00:03,000 --> 00:00:04,000\nB\n00:00:05,000 --> 00:00:06,000\nC';
  const c = S.parseSRT(t);
  assert.deepStrictEqual(c.map(x => x.text), ['A', 'B', 'C']);
  assert.deepStrictEqual(c.map(x => x.start), [1000, 3000, 5000]);
});

const VTT = 'WEBVTT - demo\n\nNOTE ceci est une note\nsur deux lignes\n\nSTYLE\n::cue { color: yellow }\n\n' +
  'intro\n00:01.000 --> 00:03.000 align:center line:90%\nTom &amp; Jerry &lt;3\n\n' +
  '00:00:04.500 --> 00:00:06.000\n<v Lina>Azul !</v>\nDeuxième ligne\n';

test('parseVTT: header, NOTE, STYLE, ids, settings, entities, short timestamps', () => {
  const c = S.parseVTT(VTT);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c[0], { start: 1000, end: 3000, text: 'Tom & Jerry <3' });
  assert.deepStrictEqual(c[1], { start: 4500, end: 6000, text: '<v Lina>Azul !</v>\nDeuxième ligne' });
});

test('VTT export escapes and round-trips', () => {
  const c = S.parseVTT(VTT);
  const out = S.toVTT(c);
  assert.ok(out.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nTom &amp; Jerry &lt;3\n'));
  assert.ok(out.includes('<v Lina>Azul !</v>'));
  assert.deepStrictEqual(S.parseVTT(out), c);
});

test('SRT -> VTT -> SRT keeps cues', () => {
  const a = S.parseSRT(SRT);
  assert.deepStrictEqual(S.parseVTT(S.toVTT(a)), a);
});

test('blank lines inside text are removed on export (would break blocks)', () => {
  const out = S.toSRT([{ start: 0, end: 1000, text: 'A\n\nB' }]);
  assert.strictEqual(out, '1\n00:00:00,000 --> 00:00:01,000\nA\nB\n');
});

test('parseAny detection + JSON round trip', () => {
  assert.strictEqual(S.parseAny(VTT).format, 'vtt');
  assert.strictEqual(S.parseAny(SRT).format, 'srt');
  const a = S.parseSRT(SRT);
  const j = S.toJSON(a, { lang: 'fr' });
  const r = S.parseAny(j);
  assert.strictEqual(r.format, 'json');
  assert.deepStrictEqual(r.cues, a);
  assert.deepStrictEqual(S.parseJSON('[{"start":"00:00:01,000","end":2000,"text":"x"}]'), [{ start: 1000, end: 2000, text: 'x' }]);
});

test('toTXT transcript', () => {
  assert.strictEqual(S.toTXT(S.parseSRT(SRT)), 'Bonjour à tous ! Azul fellawen.\nMusique douce\nLigne avec 42 → flèche & « guillemets »\n');
});

test('shift (all, subset, clamp at zero)', () => {
  const a = S.parseSRT(SRT);
  const b = S.shift(a, 1500);
  assert.deepStrictEqual(b.map(c => [c.start, c.end]), [[2500, 5000], [5500, 7750], [61500, 63500]]);
  const n = S.shift(a, -2000);
  assert.deepStrictEqual(n[0], { start: 0, end: 1500, text: a[0].text });
  const p = S.shift(a, 100, (c, i) => i >= 1);
  assert.strictEqual(p[0].start, 1000); assert.strictEqual(p[1].start, 4100);
  assert.strictEqual(a[0].start, 1000, 'input not mutated');
});

test('convertFps 23.976 -> 25 and back', () => {
  const a = [{ start: 25000, end: 50000, text: 'x' }];
  const b = S.convertFps(a, 23.976, 25);
  assert.deepStrictEqual([b[0].start, b[0].end], [23976, 47952]);
  const back = S.convertFps(b, 25, 23.976);
  assert.ok(Math.abs(back[0].start - 25000) <= 1 && Math.abs(back[0].end - 50000) <= 1);
});

test('sortCues stable + fixOverlaps', () => {
  const a = [{ start: 3000, end: 4000, text: 'b' }, { start: 1000, end: 3500, text: 'a' }, { start: 3000, end: 4000, text: 'c' }];
  assert.deepStrictEqual(S.sortCues(a).map(c => c.text), ['a', 'b', 'c']);
  const f = S.fixOverlaps(S.sortCues(a));
  assert.strictEqual(f[0].end, 3000);
});

test('checkCue warnings', () => {
  const o = { maxCps: 17, maxLine: 42, minDur: 700 };
  assert.deepStrictEqual(S.checkCue({ start: 0, end: 2000, text: 'Bonjour' }, null, o), []);
  assert.ok(S.checkCue({ start: 2000, end: 2000, text: 'x' }, null, o).includes('invalid'));
  assert.ok(S.checkCue({ start: 1000, end: 3000, text: 'x' }, { start: 0, end: 1500 }, o).includes('overlap'));
  assert.ok(S.checkCue({ start: 0, end: 1000, text: 'Ceci est beaucoup trop long pour une seconde' }, null, o).includes('cps'));
  assert.ok(S.checkCue({ start: 0, end: 9000, text: 'x'.repeat(43) }, null, o).includes('line'));
  assert.ok(S.checkCue({ start: 0, end: 9000, text: 'a\nb\nc' }, null, o).includes('lines'));
  assert.ok(S.checkCue({ start: 0, end: 500, text: 'a' }, null, o).includes('short'));
  assert.ok(S.checkCue({ start: 0, end: 2000, text: '<i> </i>' }, null, o).includes('empty'));
  assert.strictEqual(S.charCount('<i>ab</i>\ncd'), 4);
  assert.strictEqual(S.cps({ start: 0, end: 2000, text: 'abcd' }), 2);
});

test('splitText', () => {
  assert.deepStrictEqual(S.splitText('un deux trois quatre'), ['un deux', 'trois quatre']);
  assert.deepStrictEqual(S.splitText('ligne 1\nligne 2'), ['ligne 1', 'ligne 2']);
  assert.deepStrictEqual(S.splitText('seul'), ['seul', '']);
  assert.deepStrictEqual(S.splitText(''), ['', '']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
