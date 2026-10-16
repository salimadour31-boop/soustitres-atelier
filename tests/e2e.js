// End-to-end tests (Playwright + Chromium), run against index.html opened from file://.
// Usage:  npm i playwright && npx playwright install chromium   (outside the repo is fine)
//         node tests/e2e.js            [SHOTS=1 to also write the screenshots]
'use strict';
let pw;
try { pw = require('playwright'); } catch (e) { pw = require('playwright-core'); }
const { chromium } = pw;
const fs = require('fs'), path = require('path');
const S = require('../subs.js');
const ROOT = path.resolve(__dirname, '..');
const URL0 = process.env.ST_URL || 'file://' + path.join(ROOT, 'index.html');
const SHOTS = !!process.env.SHOTS;

let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

const SAMPLE_SRT = [
  '1', '00:00:01,250 --> 00:00:03,900', 'Première ligne', 'deuxième ligne', '',
  '2', '00:00:04,000 --> 00:00:06,500', '<i>Azul fellawen !</i>', '',
  '3', '00:01:02,003 --> 00:01:05,010', 'Fin & « guillemets »', ''
].join('\r\n');

async function readDownload(page, clickSel) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(clickSel)]);
  const p = await dl.path();
  return { name: dl.suggestedFilename(), text: fs.readFileSync(p, 'utf8') };
}

// Small 4 s test video (only if ffmpeg exists); never committed.
let videoPath = null;
try {
  const vp = path.join(require('os').tmpdir(), 'st-test.webm');
  require('child_process').execSync(`ffmpeg -y -loglevel error -f lavfi -i testsrc=size=320x180:rate=25 -f lavfi -i sine=frequency=440 -t 4 -c:v libvpx -b:v 200k -c:a libopus -shortest ${vp}`);
  videoPath = vp;
} catch (e) { console.log('SKIP video test (ffmpeg not available)'); }

(async () => {
  const browser = await chromium.launch();
  for (const vp of [{ name: 'desktop', width: 1280, height: 800, dpr: 1 }, { name: 'mobile', width: 375, height: 812, dpr: 2 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, acceptDownloads: true, hasTouch: vp.name === 'mobile' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(URL0);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(300);
    const P = vp.name + ': ';
    const cues = () => page.evaluate(() => SousTitres.state.cues.map(c => ({ start: c.start, end: c.end, text: c.text })));

    // ---- first load: example cues, French
    ok((await page.getAttribute('html', 'lang')) === 'fr', P + 'default language is French');
    ok((await cues()).length === 6, P + 'example cues loaded on first visit');
    ok((await page.locator('#cueList .cue').count()) === 6, P + '6 rows rendered');
    ok((await page.locator('#track .tl-cue').count()) === 6, P + '6 timeline blocks rendered');

    // ---- languages
    for (const [lang, demo, cuesTitle] of [['en', 'Demo mode', 'Subtitles'], ['kab', 'Askar n uskan', 'Iduzwilen'], ['fr', 'Mode démo', 'Sous-titres']]) {
      await page.selectOption('#lang', lang);
      const a = await page.textContent('#btnDemo'), b = await page.textContent('#cuesTitle');
      ok(a === demo && b === cuesTitle && (await page.getAttribute('html', 'lang')) === lang, P + `language ${lang}: "${a}" / "${b}"`);
    }
    const missing = await page.evaluate(() => {
      const fr = Object.keys(I18N.fr);
      const keys = [...document.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-ph],[data-i18n-aria]')]
        .map(e => e.dataset.i18n || e.dataset.i18nTitle || e.dataset.i18nPh || e.dataset.i18nAria);
      return { html: keys.filter(k => !(k in I18N.fr)), en: fr.filter(k => !(k in I18N.en)), kab: fr.filter(k => !(k in I18N.kab)) };
    });
    ok(!missing.html.length && !missing.en.length && !missing.kab.length, P + 'no missing translation keys ' + JSON.stringify(missing));
    await page.selectOption('#lang', 'en');
    await page.reload(); await page.waitForTimeout(200);
    ok((await page.getAttribute('html', 'lang')) === 'en' && (await page.textContent('#btnDemo')) === 'Demo mode', P + 'language remembered after reload');
    await page.selectOption('#lang', 'fr');

    // ---- demo mode: create cues with I / O and hold H
    await page.click('#btnDemo');
    await page.click('#btnClear');
    ok((await cues()).length === 0, P + 'clear all (confirm accepted)');
    await page.click('body', { position: { x: 5, y: 5 } }).catch(() => {});
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => !SousTitres.player.paused), P + 'Space starts the demo clock');
    await page.keyboard.press('i');
    ok(await page.isVisible('#recBadge'), P + 'IN badge visible while marking');
    await page.waitForTimeout(1000);
    await page.keyboard.press('o');
    let c = await cues();
    ok(c.length === 1 && c[0].end - c[0].start >= 900 && c[0].end - c[0].start <= 1300, P + `I/O creates a cue (${c[0] && c[0].end - c[0].start} ms)`);
    await page.waitForTimeout(200);
    await page.keyboard.down('h'); await page.waitForTimeout(700); await page.keyboard.up('h');
    c = await cues();
    ok(c.length === 2 && c[1].start >= c[0].end && c[1].end - c[1].start >= 600, P + 'hold H creates a second cue');
    // on-screen buttons
    await page.click('#btnIn'); await page.waitForTimeout(500); await page.click('#btnOut');
    c = await cues();
    ok(c.length === 3, P + 'IN / OUT buttons create a cue');
    await page.keyboard.press('Space');
    ok(await page.evaluate(() => SousTitres.player.paused), P + 'Space pauses');

    // ---- editing text updates overlay
    await page.locator('#cueList .cue').nth(0).locator('textarea').fill('Bonjour\ntout le monde');
    await page.evaluate(() => { const c = SousTitres.state.cues[0]; SousTitres.player.seek(c.start + 100); });
    await page.waitForTimeout(150);
    ok((await page.textContent('#overlay')).includes('tout le monde'), P + 'overlay shows the active cue text');
    ok((await page.textContent('#track .tl-cue')).includes('Bonjour'), P + 'timeline block label updated');
    // undo text edit
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Control+z');
    ok((await cues())[0].text === '', P + 'Ctrl+Z undoes the text edit');
    await page.keyboard.press('Control+y');
    ok((await cues())[0].text === 'Bonjour\ntout le monde', P + 'Ctrl+Y redoes it');

    // ---- split / merge / delete
    await page.locator('#cueList .cue').nth(0).locator('[data-act=split]').click();
    c = await cues();
    ok(c.length === 4 && c[0].text === 'Bonjour' && c[1].text === 'tout le monde' && c[0].end === c[1].start, P + 'split cue');
    await page.locator('#cueList .cue').nth(0).locator('[data-act=merge]').click();
    c = await cues();
    ok(c.length === 3 && c[0].text === 'Bonjour\ntout le monde', P + 'merge cue');
    await page.locator('#cueList .cue').nth(2).locator('[data-act=delete]').click();
    ok((await cues()).length === 2, P + 'delete cue');

    // ---- time edit field
    const startInput = page.locator('#cueList .cue').nth(1).locator('.t-start');
    await startInput.fill('0:20.5'); await startInput.press('Enter');
    c = await cues();
    ok(c[1].start === 20500 || c[0].start === 20500, P + 'typed start time "0:20.5" parsed to 20500 ms');
    await startInput.fill('nimporte');
    await startInput.press('Enter');
    ok((await cues()).some(x => x.start === 20500), P + 'invalid typed time is rejected');

    // ---- SRT import (paste) -> export round trip
    await page.fill('#pasteBox', SAMPLE_SRT);
    await page.click('#btnPaste');
    c = await cues();
    ok(c.length === 3 && c[0].start === 1250 && c[2].end === 65010 && c[0].text === 'Première ligne\ndeuxième ligne', P + 'SRT paste import');
    let dl = await readDownload(page, '#exSrt');
    const expectedSrt = S.toSRT(S.parseSRT(SAMPLE_SRT));
    ok(dl.name === 'soustitres.srt' && dl.text === expectedSrt, P + 'SRT export identical to normalized input');
    ok(dl.text === SAMPLE_SRT.replace(/\r\n/g, '\n') + '\n' || dl.text.split('\n\n').length === 3, P + 'SRT export structure (3 blocks)');
    ok(JSON.stringify(S.parseSRT(dl.text)) === JSON.stringify(S.parseSRT(SAMPLE_SRT)), P + 'SRT import→export→import round trip');

    // ---- time shift
    await page.fill('#shiftMs', '500');
    await page.click('#btnShiftPlus');
    c = await cues();
    ok(c[0].start === 1750 && c[0].end === 4400 && c[2].start === 62503, P + 'shift +500 ms on all cues');
    await page.click('#btnShiftMinus'); await page.click('#btnShiftMinus');
    c = await cues();
    ok(c[0].start === 750 && c[2].end === 64510, P + 'shift −500 ms twice');
    // scope: selected only
    await page.locator('#cueList .cue').nth(1).locator('.cue-num').click();
    await page.selectOption('#shiftScope', 'sel');
    await page.fill('#shiftMs', '1000'); await page.click('#btnShiftPlus');
    c = await cues();
    ok(c[0].start === 750 && c[1].start === 4500 && c[2].start === 61503, P + 'shift scope "selected only"');
    await page.selectOption('#shiftScope', 'all');

    // ---- fps conversion and back
    await page.selectOption('#fpsFrom', '23.976'); await page.selectOption('#fpsTo', '25');
    const before = await cues();
    await page.click('#btnFps');
    c = await cues();
    ok(c[2].start === Math.round(before[2].start * 23.976 / 25), P + 'fps conversion 23.976 → 25');
    await page.selectOption('#fpsFrom', '25'); await page.selectOption('#fpsTo', '23.976'); await page.click('#btnFps');
    c = await cues();
    ok(c.every((x, i) => Math.abs(x.start - before[i].start) <= 1), P + 'fps conversion back 25 → 23.976 (±1 ms)');

    // ---- warnings: overlap + reading speed + line length, sort
    await page.fill('#pasteBox', '1\n00:00:05,000 --> 00:00:06,000\nCeci est une phrase beaucoup trop longue pour une seconde\n\n2\n00:00:01,000 --> 00:00:05,500\nB\n');
    await page.click('#btnPaste');
    const badges = await page.locator('#cueList .badge').allTextContents();
    ok(badges.includes('trop rapide') && badges.includes('ligne trop longue'), P + 'CPS and line length warnings ' + JSON.stringify(badges));
    await page.click('#btnSort');
    const b2 = await page.locator('#cueList .badge').allTextContents();
    ok(b2.includes('chevauchement'), P + 'overlap warning after sort');
    await page.click('#btnFixOverlaps');
    ok(!(await page.locator('#cueList .badge').allTextContents()).includes('chevauchement'), P + 'fix overlaps');

    // ---- VTT export / JSON / TXT
    dl = await readDownload(page, '#exVtt');
    ok(dl.text.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nB\n'), P + 'WebVTT export');
    ok(JSON.stringify(S.parseVTT(dl.text)) === JSON.stringify(await cues()), P + 'WebVTT export re-imports identically');
    dl = await readDownload(page, '#exJson');
    ok(JSON.stringify(S.parseJSON(dl.text)) === JSON.stringify(await cues()), P + 'JSON export');
    dl = await readDownload(page, '#exTxt');
    ok(dl.text === 'B\nCeci est une phrase beaucoup trop longue pour une seconde\n', P + 'TXT transcript export');

    // ---- VTT import from a file
    const vttPath = path.join(require('os').tmpdir(), 'st-test.vtt');
    fs.writeFileSync(vttPath, 'WEBVTT\n\nNOTE test\n\n00:02.000 --> 00:04.000 line:90%\nTom &amp; Jerry\n');
    await page.setInputFiles('#subFile', vttPath);
    await page.waitForTimeout(200);
    c = await cues();
    ok(c.length === 1 && c[0].text === 'Tom & Jerry' && c[0].start === 2000, P + 'WebVTT file import');

    // ---- timeline click seeks
    await page.locator('#timeline').scrollIntoViewIfNeeded();
    const box = await page.locator('#timeline').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + 10);
    const tNow = await page.evaluate(() => SousTitres.player.t);
    ok(tNow > 1000, P + `timeline click seeks (${Math.round(tNow)} ms)`);

    // ---- autosave
    await page.waitForTimeout(400);
    await page.reload(); await page.waitForTimeout(300);
    c = await cues();
    ok(c.length === 1 && c[0].text === 'Tom & Jerry', P + 'project restored from localStorage');

    // ---- layout: no horizontal overflow
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, P + `no horizontal page overflow (${overflow}px)`);

    // ---- real local video file (generated with ffmpeg when available)
    if (videoPath) {
      await page.setInputFiles('#mediaFile', videoPath);
      await page.waitForFunction(() => SousTitres.player.mode === 'video' && SousTitres.player.dur > 0, null, { timeout: 5000 }).catch(() => {});
      const info = await page.evaluate(() => ({ mode: SousTitres.player.mode, dur: SousTitres.player.dur, src: document.querySelector('#video').src }));
      ok(info.mode === 'video' && Math.abs(info.dur - 4000) < 300 && info.src.startsWith('blob:'), P + 'local video loaded via object URL ' + JSON.stringify({ mode: info.mode, dur: info.dur }));
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      const n0 = (await cues()).length;
      await page.evaluate(() => { document.querySelector('#video').muted = true; });
      await page.keyboard.press('Space');
      await page.waitForTimeout(300);
      await page.keyboard.press('i'); await page.waitForTimeout(800); await page.keyboard.press('o');
      c = await cues();
      const nc = c.find(x => x.text === '' );
      ok(c.length === n0 + 1 && nc && nc.end - nc.start > 500, P + 'I/O on a playing video creates a cue');
      await page.keyboard.press('Space');
      await page.click('#btnDemo');
      ok(await page.evaluate(() => SousTitres.player.mode === 'demo'), P + 'back to demo mode');
    }

    // ---- screenshots with real cues
    if (SHOTS) {
      await page.click('#btnExample');
      await page.locator('#cueList .cue').nth(1).locator('.cue-num').click();
      await page.evaluate(() => {
        SousTitres.player.seek(6200);
        document.activeElement && document.activeElement.blur();
        window.scrollTo(0, 0);
        document.querySelector('#cueList').scrollTop = 0;
        document.querySelector('#toast').classList.remove('show');
      });
      await page.waitForTimeout(400);
      const file = vp.name === 'desktop' ? 'screenshot.png' : 'screenshot-mobile.png';
      if (vp.name === 'desktop') await page.screenshot({ path: path.join(ROOT, file) });
      else await page.screenshot({ path: path.join(ROOT, file), clip: { x: 0, y: 0, width: 375, height: 1100 }, fullPage: true });
      console.log('wrote ' + file);
    }

    ok(errors.length === 0, P + 'no console errors/warnings ' + JSON.stringify(errors));
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
