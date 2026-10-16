/*!
 * Sous-titres Atelier — app.js
 * User interface: player (local media or demo clock), IN/OUT marking, cue
 * list editing, live overlay, timeline, timing tools, import/export,
 * undo/redo, autosave and language switching.
 * Depends on subs.js (global Subs) and i18n.js (global I18N). No libraries.
 * MIT License — © 2026 salimadour31-boop
 */
(function () {
  'use strict';

  /* ================================================================== */
  /* Helpers                                                             */
  /* ================================================================== */

  var $ = function (sel) { return document.querySelector(sel); };
  var STORE_KEY = 'soustitres-atelier:project';
  var LANG_KEY = 'soustitres-atelier:lang';
  var DEMO_DUR = 60000;          // minimum length of the demo clock (ms)
  var FPS_LIST = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmt(ms) { return Subs.formatTime(ms, ','); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode / quota: ignore */ } }

  /* ================================================================== */
  /* State                                                               */
  /* ================================================================== */

  var state = {
    lang: 'fr',
    cues: [],            // [{ id, start, end, text }] — times in ms
    selected: null,      // id of the selected cue
    pendingIn: null,     // time of an IN mark waiting for its OUT
    mediaName: '',
    script: '',
    style: { size: 30, color: '#ffffff', box: true, boxColor: '#0b0d12', boxOpacity: 0.72, position: 'bottom', outline: false, bold: false },
    opts: { maxCps: 17, maxLine: 42, minDur: 700, defDur: 2000, chain: false, hold: true },
    zoom: 1
  };
  var nextId = 1;
  var warnings = {};     // id -> [codes]
  var undoStack = [], redoStack = [];

  /* ---------- i18n ---------- */
  function t(key, vars) {
    var dict = I18N[state.lang] || I18N.fr;
    var s = key in dict ? dict[key] : (key in I18N.fr ? I18N.fr[key] : key);
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? vars[k] : m; });
    return s;
  }
  function num(x, digits) {
    return new Intl.NumberFormat(state.lang === 'en' ? 'en-US' : 'fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
  }

  /* ---------- DOM refs ---------- */
  var video = $('#video'), canvas = $('#demoCanvas'), ctx = canvas.getContext('2d');
  var stage = $('#stage'), overlay = $('#overlay'), list = $('#cueList');
  var timelineScroll = $('#timelineScroll'), timeline = $('#timeline'), track = $('#track'), ruler = $('#ruler');
  var playhead = $('#playhead'), pendingZone = $('#pendingZone');
  var rowEls = {}, blockEls = {};

  /* ================================================================== */
  /* Player: a tiny abstraction over <video> and the demo clock          */
  /* ================================================================== */

  var objectUrl = null;
  var player = {
    mode: 'demo',          // 'demo' | 'video' | 'audio'
    demoT: 0, demoPlaying: false, demoLast: 0, rate: 1,
    get t() { return this.mode === 'demo' ? this.demoT : video.currentTime * 1000; },
    get dur() {
      if (this.mode === 'demo') return Math.max(DEMO_DUR, lastEnd() + 10000);
      return isFinite(video.duration) ? video.duration * 1000 : 0;
    },
    get paused() { return this.mode === 'demo' ? !this.demoPlaying : video.paused; },
    play: function () {
      if (this.mode === 'demo') {
        if (this.demoT >= this.dur) this.demoT = 0;
        this.demoPlaying = true; this.demoLast = performance.now();
      } else {
        var p = video.play(); if (p && p.catch) p.catch(function () {});
      }
      updatePlayButton();
    },
    pause: function () {
      if (this.mode === 'demo') this.demoPlaying = false; else video.pause();
      updatePlayButton();
    },
    toggle: function () { if (this.paused) this.play(); else this.pause(); },
    seek: function (ms) {
      var d = this.dur;
      ms = Math.max(0, d > 0 ? Math.min(ms, d) : ms);
      if (this.mode === 'demo') this.demoT = ms; else video.currentTime = ms / 1000;
    },
    setRate: function (r) { this.rate = r; video.playbackRate = r; },
    /** Advance the demo clock; called once per animation frame. */
    tick: function (now) {
      if (this.mode !== 'demo' || !this.demoPlaying) return;
      this.demoT += (now - this.demoLast) * this.rate;
      this.demoLast = now;
      if (this.demoT >= this.dur) { this.demoT = this.dur; this.demoPlaying = false; updatePlayButton(); }
    }
  };

  function updatePlayButton() {
    var b = $('#btnPlay');
    b.textContent = player.paused ? '▶' : '❚❚';
    b.classList.toggle('on', !player.paused);
  }

  function setMode(mode) {
    player.mode = mode;
    stage.classList.toggle('has-video', mode === 'video');
    updateBadge();
    renderTimeline();
    lastDrawT = -1;
  }

  function updateBadge() {
    var b = $('#stageBadge');
    if (player.mode === 'demo') b.textContent = t('badgeDemo');
    else if (player.mode === 'audio') b.textContent = t('badgeAudio') + ' · ' + state.mediaName;
    else b.textContent = state.mediaName;
  }

  /* ================================================================== */
  /* Cue helpers                                                         */
  /* ================================================================== */

  function lastEnd() { return state.cues.reduce(function (m, c) { return Math.max(m, c.end); }, 0); }
  function byId(id) { for (var i = 0; i < state.cues.length; i++) if (state.cues[i].id === id) return state.cues[i]; return null; }
  function indexOf(id) { for (var i = 0; i < state.cues.length; i++) if (state.cues[i].id === id) return i; return -1; }
  function withIds(arr) { return arr.map(function (c) { return { id: nextId++, start: c.start, end: c.end, text: c.text }; }); }
  /** Cues visible at time ms. */
  function activeAt(ms) { return state.cues.filter(function (c) { return c.start <= ms && ms < c.end; }); }

  /** Insert keeping start order (after cues with the same start). */
  function insertCue(c) {
    var i = 0;
    while (i < state.cues.length && state.cues[i].start <= c.start) i++;
    state.cues.splice(i, 0, c);
  }

  function exampleCues() {
    var times = [[1000, 4200], [5000, 8500], [8800, 11000], [12000, 14800], [16000, 21500], [22000, 25500]];
    return withIds(t('demoCues').map(function (txt, i) { return { start: times[i][0], end: times[i][1], text: txt }; }));
  }

  function computeWarnings() {
    warnings = {};
    for (var i = 0; i < state.cues.length; i++) {
      warnings[state.cues[i].id] = Subs.checkCue(state.cues[i], i ? state.cues[i - 1] : null, state.opts);
    }
  }

  /* ================================================================== */
  /* Undo / redo (snapshots of the cue array)                            */
  /* ================================================================== */

  function snapshot() { return JSON.stringify(state.cues); }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }
  function restore(from, to, msg) {
    if (!from.length) return;
    to.push(snapshot());
    state.cues = JSON.parse(from.pop());
    if (state.selected != null && !byId(state.selected)) state.selected = null;
    afterChange();
    toast(t(msg));
  }
  function undo() { restore(undoStack, redoStack, 'tUndo'); }
  function redo() { restore(redoStack, undoStack, 'tRedo'); }
  function updateUndoButtons() {
    $('#btnUndo').disabled = !undoStack.length;
    $('#btnRedo').disabled = !redoStack.length;
  }

  /* ================================================================== */
  /* Persistence                                                         */
  /* ================================================================== */

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }
  function saveNow() {
    storageSet(STORE_KEY, JSON.stringify({
      v: 1, cues: state.cues, style: state.style, opts: state.opts, script: state.script,
      zoom: state.zoom, mediaName: state.mediaName
    }));
  }
  function load() {
    var raw = storageGet(STORE_KEY);
    if (!raw) return false;
    try {
      var p = JSON.parse(raw);
      if (!p || !Array.isArray(p.cues)) return false;
      state.cues = withIds(p.cues.filter(function (c) { return typeof c.start === 'number' && typeof c.end === 'number'; })
        .map(function (c) { return { start: c.start, end: c.end, text: String(c.text || '') }; }));
      if (p.style) for (var k in state.style) if (k in p.style) state.style[k] = p.style[k];
      if (p.opts) for (var o in state.opts) if (o in p.opts) state.opts[o] = p.opts[o];
      state.script = typeof p.script === 'string' ? p.script : '';
      state.zoom = clamp(Number(p.zoom) || 1, 1, 30);
      return true;
    } catch (e) { return false; }
  }

  /* ================================================================== */
  /* Rendering: cue list                                                 */
  /* ================================================================== */

  /** Called after any structural change to the cues. */
  function afterChange() {
    computeWarnings();
    renderList();
    renderTimeline();
    updateSummary();
    updateUndoButtons();
    lastOverlayKey = null;
    save();
  }

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function renderList() {
    list.textContent = '';
    rowEls = {};
    var frag = document.createDocumentFragment();
    state.cues.forEach(function (c, i) {
      var li = el('li', 'cue', { 'data-id': c.id });
      if (c.id === state.selected) li.classList.add('sel');

      var head = el('div', 'cue-head');
      var n = el('span', 'cue-num'); n.textContent = i + 1;
      var s = el('input', 't-start', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': t('startLbl') + ' ' + (i + 1), title: t('startLbl') });
      s.value = fmt(c.start);
      var arrow = el('span', 'arrow'); arrow.textContent = '→';
      var e = el('input', 't-end', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': t('endLbl') + ' ' + (i + 1), title: t('endLbl') });
      e.value = fmt(c.end);
      var meta = el('span', 'cue-meta');
      var actions = el('span', 'cue-actions');
      [['seek', '▶', 'aSeek'], ['split', '✂', 'aSplit'], ['merge', '⇣', 'aMerge'], ['delete', '✕', 'aDelete']].forEach(function (a) {
        var b = el('button', 'btn tiny' + (a[0] === 'delete' ? ' danger' : ''), { type: 'button', 'data-act': a[0], title: t(a[2]), 'aria-label': t(a[2]) });
        b.textContent = a[1];
        actions.appendChild(b);
      });
      head.append(n, s, arrow, e, meta, actions);

      var ta = el('textarea', 'cue-text', { rows: '2', placeholder: t('cuePh'), 'aria-label': t('cuePh') + ' ' + (i + 1) });
      ta.value = c.text;
      var warn = el('div', 'cue-warn');
      li.append(head, ta, warn);
      frag.appendChild(li);
      rowEls[c.id] = li;
      fillMeta(li, c);
    });
    list.appendChild(frag);
    $('#emptyHint').hidden = state.cues.length > 0;
    lastActiveKey = null;
  }

  /** Duration, reading speed and warning badges of one row. */
  function fillMeta(li, c) {
    var d = (c.end - c.start) / 1000;
    var cps = Subs.cps(c);
    var w = warnings[c.id] || [];
    li.querySelector('.cue-meta').textContent = num(Math.max(0, d), 2) + ' ' + t('sec') + ' · ' +
      (isFinite(cps) ? num(cps, 1) : '—') + ' ' + t('cpsUnit');
    var box = li.querySelector('.cue-warn');
    box.textContent = '';
    w.forEach(function (code) {
      var b = el('span', 'badge w-' + code); b.textContent = t('w_' + code);
      box.appendChild(b);
    });
    li.classList.toggle('has-warn', w.length > 0);
  }

  function updateSummary() {
    var n = state.cues.length, w = 0;
    for (var id in warnings) if (warnings[id].length) w++;
    $('#summary').textContent = w ? t('summary', { n: n, w: w }) : t('summaryOk', { n: n });
    $('#summary').classList.toggle('warn', w > 0);
  }

  function select(id, opts) {
    opts = opts || {};
    state.selected = id;
    Object.keys(rowEls).forEach(function (k) { rowEls[k].classList.toggle('sel', Number(k) === id); });
    Object.keys(blockEls).forEach(function (k) { blockEls[k].classList.toggle('sel', Number(k) === id); });
    if (id != null && opts.scroll !== false) scrollRowIntoView(id);
  }

  /** Scroll inside the list only (never the whole page). */
  function scrollRowIntoView(id) {
    var li = rowEls[id];
    if (!li) return;
    var top = li.offsetTop, bottom = top + li.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 6;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 6;
  }

  /* ================================================================== */
  /* Rendering: timeline                                                 */
  /* ================================================================== */

  function timelineDur() { return Math.max(player.dur || 0, lastEnd() + 2000, 10000); }
  function pxPerMs() { return (timelineScroll.clientWidth * state.zoom) / timelineDur(); }

  function renderTimeline() {
    var dur = timelineDur();
    var width = timelineScroll.clientWidth * state.zoom;
    timeline.style.width = width + 'px';
    timeline.setAttribute('aria-valuemax', Math.round(dur));
    var k = width / dur;

    // Ruler: choose a tick step giving at least ~70 px between labels
    ruler.textContent = '';
    var steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (steps[i] * 1000 * k >= 70) { step = steps[i]; break; }
    for (var s = 0; s * 1000 <= dur; s += step) {
      var tick = el('span', 'tick');
      tick.style.left = (s * 1000 * k) + 'px';
      var mm = Math.floor(s / 60), ss = s % 60;
      tick.textContent = mm + ':' + String(ss).padStart(2, '0');
      ruler.appendChild(tick);
    }

    // Cue blocks
    track.textContent = '';
    blockEls = {};
    state.cues.forEach(function (c, idx) {
      var b = el('div', 'tl-cue', { 'data-id': c.id });
      b.style.left = (c.start * k) + 'px';
      b.style.width = Math.max(3, (c.end - c.start) * k) + 'px';
      b.title = (idx + 1) + ' · ' + fmt(c.start) + ' → ' + fmt(c.end) + '\n' + Subs.stripTags(c.text);
      var lbl = el('span'); lbl.textContent = Subs.stripTags(c.text).replace(/\n/g, ' ') || '…';
      b.appendChild(lbl);
      if ((warnings[c.id] || []).length) b.classList.add('warn');
      if (c.id === state.selected) b.classList.add('sel');
      track.appendChild(b);
      blockEls[c.id] = b;
    });
    lastActiveKey = null;
  }

  /* ================================================================== */
  /* Overlay + demo canvas                                               */
  /* ================================================================== */

  var lastOverlayKey = null;

  /** Render the cue text: only <i>, <b>, <u> are kept, everything else is escaped or removed. */
  function cueHtml(text) {
    var safe = escapeHtml(text).replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>');
    return safe.replace(/&lt;\/?[a-z][^&]*?&gt;/gi, '').replace(/\{\\[^}]*\}/g, '');
  }

  function updateOverlay(ms) {
    var act = activeAt(ms);
    var key = act.map(function (c) { return c.id + ':' + c.text; }).join('|');
    if (key === lastOverlayKey) return;
    lastOverlayKey = key;
    overlay.innerHTML = act.filter(function (c) { return c.text.trim(); }).map(function (c) {
      return '<div class="sub"><span>' + cueHtml(Subs.cleanLines(c.text).join('\n')) + '</span></div>';
    }).join('');
  }

  function applyStyle() {
    var st = state.style;
    var hex = st.boxColor.replace('#', '');
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    overlay.style.setProperty('--sub-color', st.color);
    overlay.style.setProperty('--sub-bg', st.box ? 'rgba(' + r + ',' + g + ',' + b + ',' + st.boxOpacity + ')' : 'transparent');
    overlay.style.setProperty('--sub-weight', st.bold ? '700' : '500');
    overlay.classList.toggle('pos-top', st.position === 'top');
    overlay.classList.toggle('pos-bottom', st.position !== 'top');
    overlay.classList.toggle('outline', !!st.outline);
    scaleOverlay();
    $('#stSizeOut').textContent = st.size + ' px';
    $('#stBoxOpacityOut').textContent = Math.round(st.boxOpacity * 100) + ' %';
  }
  /** Font size is defined for a 720 px tall frame and scaled to the actual stage height. */
  function scaleOverlay() {
    var h = stage.clientHeight || 720;
    overlay.style.setProperty('--sub-size', (state.style.size * h / 720).toFixed(1) + 'px');
  }

  var lastDrawT = -1;
  /** Animated "clock" picture used in demo mode and for audio files. */
  function drawCanvas(ms) {
    if (Math.abs(ms - lastDrawT) < 1 && lastDrawT >= 0) return;
    lastDrawT = ms;
    var W = canvas.width, H = canvas.height;
    var bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#10131c'); bg.addColorStop(1, '#1b1428');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // soft drifting light blobs
    var s = ms / 1000;
    var hues = [174, 36, 352, 262, 200];
    for (var i = 0; i < hues.length; i++) {
      var a = s * (0.15 + i * 0.04) + i * 1.7;
      var cx = W / 2 + Math.cos(a) * W * 0.33, cy = H / 2 + Math.sin(a * 1.3) * H * 0.28;
      var rad = 260 + 60 * Math.sin(s * 0.5 + i);
      var gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      gr.addColorStop(0, 'hsla(' + hues[i] + ',70%,55%,0.22)');
      gr.addColorStop(1, 'hsla(' + hues[i] + ',70%,55%,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }

    // faint frame guides (title-safe area)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 2;
    ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);

    // second ring
    var frac = (ms % 1000) / 1000;
    ctx.beginPath(); ctx.strokeStyle = 'rgba(61,214,196,0.18)'; ctx.lineWidth = 10;
    ctx.arc(W / 2, H * 0.36, 150, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = '#3dd6c4';
    ctx.arc(W / 2, H * 0.36, 150, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();

    // big timecode
    ctx.fillStyle = '#e8ecf3'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 64px ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
    ctx.fillText(fmt(ms), W / 2, H * 0.36);
    ctx.font = '500 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(232,236,243,0.6)';
    ctx.fillText(player.mode === 'audio' ? t('canvasAudio') + ' — ' + state.mediaName : t('canvasDemo'), W / 2, H * 0.36 + 200);

    // progress bar
    var d = player.dur || 1;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(W * 0.05, H - 24, W * 0.9, 6);
    ctx.fillStyle = '#ffb547'; ctx.fillRect(W * 0.05, H - 24, W * 0.9 * clamp(ms / d, 0, 1), 6);
  }

  /* ================================================================== */
  /* Main animation loop                                                 */
  /* ================================================================== */

  var lastActiveKey = null, lastTc = '';
  function frame(now) {
    player.tick(now);
    var ms = player.t;
    var tc = fmt(ms);
    if (tc !== lastTc) {
      lastTc = tc;
      $('#tcNow').textContent = tc;
      $('#tcDur').textContent = fmt(player.dur);
      timeline.setAttribute('aria-valuenow', Math.round(ms));
    }
    if (player.mode !== 'video') drawCanvas(ms);
    updateOverlay(ms);

    // playhead + auto-follow while playing
    var x = ms * pxPerMs();
    playhead.style.transform = 'translateX(' + x + 'px)';
    if (!player.paused && !scrubbing) {
      var vis = timelineScroll.scrollLeft, w = timelineScroll.clientWidth;
      if (x < vis || x > vis + w - 30) timelineScroll.scrollLeft = Math.max(0, x - 40);
    }

    // pending IN zone + REC badge
    if (state.pendingIn != null) {
      pendingZone.hidden = false;
      var a = Math.min(state.pendingIn, ms), b = Math.max(state.pendingIn, ms);
      pendingZone.style.left = (a * pxPerMs()) + 'px';
      pendingZone.style.width = Math.max(2, (b - a) * pxPerMs()) + 'px';
    } else pendingZone.hidden = true;

    // highlight cues under the playhead
    var act = activeAt(ms).map(function (c) { return c.id; });
    var key = act.join(',');
    if (key !== lastActiveKey) {
      lastActiveKey = key;
      Object.keys(rowEls).forEach(function (k) { rowEls[k].classList.toggle('live', act.indexOf(Number(k)) >= 0); });
      Object.keys(blockEls).forEach(function (k) { blockEls[k].classList.toggle('live', act.indexOf(Number(k)) >= 0); });
      var editing = document.activeElement && list.contains(document.activeElement);
      if (act.length && !player.paused && !editing) scrollRowIntoView(act[0]);
    }
    requestAnimationFrame(frame);
  }

  /* ================================================================== */
  /* Editing actions                                                     */
  /* ================================================================== */

  /** Take the next line of the "text to time" queue ("|" = line break). */
  function takeScriptLine() {
    var lines = state.script.split('\n');
    var i = lines.findIndex(function (l) { return l.trim() !== ''; });
    if (i < 0) return '';
    var line = lines[i].trim();
    lines.splice(0, i + 1);
    state.script = lines.join('\n');
    $('#script').value = state.script;
    updateScriptCount();
    return line.replace(/\s*\|\s*/g, '\n');
  }
  function updateScriptCount() {
    var n = state.script.split('\n').filter(function (l) { return l.trim(); }).length;
    $('#scriptCount').textContent = t('scriptCount', { n: n });
  }

  function setRec() {
    var r = $('#recBadge');
    if (state.pendingIn != null) { r.hidden = false; r.textContent = '● ' + t('recIn', { t: fmt(state.pendingIn) }); }
    else r.hidden = true;
    $('#btnIn').classList.toggle('armed', state.pendingIn != null);
  }

  function markIn() {
    state.pendingIn = Math.round(player.t);
    setRec();
  }

  function markOut() {
    var now = Math.round(player.t);
    if (state.pendingIn != null) {
      if (now <= state.pendingIn + 40) { toast(t('tOutBeforeIn')); return; }
      pushUndo();
      var c = { id: nextId++, start: state.pendingIn, end: now, text: takeScriptLine() };
      insertCue(c);
      state.pendingIn = state.opts.chain ? now : null;
      setRec();
      state.selected = c.id;
      afterChange();
      select(c.id);
      return;
    }
    // No pending IN: close the selected cue if the playhead is after its start
    var sel = byId(state.selected);
    if (sel && now > sel.start) {
      pushUndo();
      sel.end = now;
      afterChange();
      return;
    }
    toast(t('tInFirst'));
  }

  function addCueAtPlayhead(focus) {
    pushUndo();
    var start = Math.round(player.t);
    var c = { id: nextId++, start: start, end: start + state.opts.defDur, text: takeScriptLine() };
    insertCue(c);
    state.selected = c.id;
    afterChange();
    select(c.id);
    if (focus && rowEls[c.id]) rowEls[c.id].querySelector('textarea').focus({ preventScroll: true });
    toast(t('tCueAdded'));
  }

  function deleteCue(id) {
    var i = indexOf(id);
    if (i < 0) return;
    pushUndo();
    state.cues.splice(i, 1);
    var nb = state.cues[i] || state.cues[i - 1];
    state.selected = nb ? nb.id : null;
    afterChange();
    toast(t('tDeleted'));
  }

  /** Split at the playhead when it is inside the cue, otherwise in the middle. */
  function splitCue(id) {
    var c = byId(id);
    if (!c) { toast(t('tNoSel')); return; }
    var now = player.t;
    var at = (now > c.start + 100 && now < c.end - 100) ? Math.round(now) : Math.round((c.start + c.end) / 2);
    if (at <= c.start || at >= c.end) return;
    pushUndo();
    var parts = Subs.splitText(c.text);
    var c2 = { id: nextId++, start: at, end: c.end, text: parts[1] };
    c.end = at; c.text = parts[0];
    state.cues.splice(indexOf(c.id) + 1, 0, c2);
    afterChange();
    select(c.id);
    toast(t('tSplit'));
  }

  function mergeWithNext(id) {
    var i = indexOf(id);
    if (i < 0) { toast(t('tNoSel')); return; }
    if (i >= state.cues.length - 1) { toast(t('tNoNext')); return; }
    pushUndo();
    var a = state.cues[i], b = state.cues[i + 1];
    a.end = Math.max(a.end, b.end);
    a.text = [a.text, b.text].filter(function (x) { return x.trim(); }).join('\n');
    state.cues.splice(i + 1, 1);
    afterChange();
    select(a.id);
    toast(t('tMerged'));
  }

  function setEdge(which) {
    var c = byId(state.selected);
    if (!c) { toast(t('tNoSel')); return; }
    pushUndo();
    c[which] = Math.round(player.t);
    state.cues = Subs.sortCues(state.cues);
    afterChange();
  }

  function selectRelative(dir) {
    if (!state.cues.length) return;
    var i = indexOf(state.selected);
    if (i < 0) {
      // nothing selected: pick relative to the playhead
      var now = player.t;
      i = dir > 0 ? state.cues.findIndex(function (c) { return c.start > now; }) : -1;
      if (dir < 0) for (var k = state.cues.length - 1; k >= 0; k--) if (state.cues[k].start < now) { i = k; break; }
      if (i < 0) i = dir > 0 ? 0 : state.cues.length - 1;
    } else i = clamp(i + dir, 0, state.cues.length - 1);
    select(state.cues[i].id);
    player.seek(state.cues[i].start);
  }

  function nextWarning() {
    var n = state.cues.length;
    if (!n) return;
    var start = indexOf(state.selected);
    for (var k = 1; k <= n; k++) {
      var c = state.cues[(start + k + n) % n];
      if ((warnings[c.id] || []).length) { select(c.id); player.seek(c.start); return; }
    }
    toast(t('tNoWarn'));
  }

  /* ---------- timing tools ---------- */
  function applyShift(sign) {
    var ms = Math.round(Number($('#shiftMs').value) || 0) * sign;
    if (!ms || !state.cues.length) return;
    var scope = $('#shiftScope').value;
    var si = indexOf(state.selected);
    if (scope !== 'all' && si < 0) { toast(t('tNoSel')); return; }
    pushUndo();
    var pick = scope === 'all' ? null : scope === 'from' ? function (c, i) { return i >= si; } : function (c, i) { return i === si; };
    state.cues = Subs.shift(state.cues, ms, pick);
    afterChange();
    toast(t('tShifted', { ms: (ms > 0 ? '+' : '') + ms }));
  }

  function applyFps() {
    var a = Number($('#fpsFrom').value), b = Number($('#fpsTo').value);
    if (!state.cues.length || !a || !b || a === b) return;
    pushUndo();
    state.cues = Subs.convertFps(state.cues, a, b);
    afterChange();
    toast(t('tConverted', { a: a, b: b }));
  }

  function applyStretch() {
    var f = Number($('#stretchFactor').value);
    if (!isFinite(f) || f < 0.5 || f > 2) { toast(t('tBadFactor')); return; }
    if (!state.cues.length || f === 1) return;
    pushUndo();
    state.cues = Subs.stretch(state.cues, f);
    afterChange();
    toast(t('tStretched', { f: f }));
  }

  /* ---------- import / export ---------- */
  function doImport(text, label) {
    var res;
    try { res = Subs.parseAny(text); } catch (e) { res = { cues: [] }; }
    if (!res.cues.length) { toast(t('tImportFail')); return false; }
    pushUndo();
    var incoming = withIds(res.cues);
    state.cues = $('#importAppend').checked ? Subs.sortCues(state.cues.concat(incoming)) : incoming;
    state.selected = null;
    afterChange();
    toast(t('tImported', { n: res.cues.length, f: (label || res.format).toUpperCase() }));
    return true;
  }

  /** Read a subtitle file as UTF-8, falling back to Windows-1252 for older SRT files. */
  function readTextFile(file) {
    return file.arrayBuffer().then(function (buf) {
      var txt = new TextDecoder('utf-8').decode(buf);
      if (txt.indexOf('\uFFFD') >= 0) {
        try { txt = new TextDecoder('windows-1252').decode(buf); } catch (e) { /* keep utf-8 */ }
      }
      return txt;
    });
  }

  function baseName() {
    return (state.mediaName || 'soustitres').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_') || 'soustitres';
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast(t('tExported', { f: name }));
  }

  function exportAs(kind) {
    if (!state.cues.length) { toast(t('tNothing')); return; }
    var c = state.cues, b = baseName();
    if (kind === 'srt') download(b + '.srt', Subs.toSRT(c), 'application/x-subrip');
    else if (kind === 'vtt') download(b + '.vtt', Subs.toVTT(c), 'text/vtt');
    else if (kind === 'txt') download(b + '.txt', Subs.toTXT(c), 'text/plain');
    else download(b + '.json', Subs.toJSON(c, { media: state.mediaName || null, style: state.style }), 'application/json');
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    var e = $('#toast');
    e.textContent = msg;
    e.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { e.classList.remove('show'); }, 2400);
  }

  /* ================================================================== */
  /* Language                                                            */
  /* ================================================================== */

  function applyLang(lang) {
    state.lang = I18N[lang] ? lang : 'fr';
    document.documentElement.lang = state.lang;
    document.querySelectorAll('[data-i18n]').forEach(function (e) { e.textContent = t(e.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-title]').forEach(function (e) { e.title = t(e.getAttribute('data-i18n-title')); });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (e) { e.placeholder = t(e.getAttribute('data-i18n-ph')); });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (e) { e.setAttribute('aria-label', t(e.getAttribute('data-i18n-aria'))); });
    $('#lang').value = state.lang;
    storageSet(LANG_KEY, state.lang);
    renderList();
    updateSummary();
    updateScriptCount();
    updateBadge();
    setRec();
    lastDrawT = -1;
  }

  /* ================================================================== */
  /* Events                                                              */
  /* ================================================================== */

  function isTyping(target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
    if (tag === 'INPUT') return !/^(checkbox|radio|range|button|color|file)$/.test(target.type);
    return false;
  }

  var holding = false;
  function onKeyDown(e) {
    var k = e.key;
    if (isTyping(e.target)) {
      if (k === 'Escape') e.target.blur();
      if (k === 'Enter' && e.target.matches('.t-start, .t-end')) e.target.blur();
      return;
    }
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      var lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((lk === 'z' && e.shiftKey) || lk === 'y') { e.preventDefault(); redo(); }
      return;
    }
    if (e.altKey) return;
    // Space / Enter on a focused button keep their normal meaning (activate the button)
    if ((k === ' ' || k === 'Enter') && e.target.tagName === 'BUTTON') return;
    var handled = true;
    switch (k) {
      case ' ': player.toggle(); break;
      case 'i': case 'I': markIn(); break;
      case 'o': case 'O': markOut(); break;
      case 'h': case 'H':
        if (e.repeat) break;
        if (state.opts.hold) { holding = true; markIn(); }
        else if (state.pendingIn == null) markIn(); else markOut();
        break;
      case 'n': case 'N': addCueAtPlayhead(false); break;
      case 'ArrowLeft': player.seek(player.t - (e.shiftKey ? 100 : 1000)); break;
      case 'ArrowRight': player.seek(player.t + (e.shiftKey ? 100 : 1000)); break;
      case 'ArrowUp': selectRelative(-1); break;
      case 'ArrowDown': selectRelative(1); break;
      case '[': setEdge('start'); break;
      case ']': setEdge('end'); break;
      case 's': case 'S': splitCue(state.selected != null ? state.selected : (activeAt(player.t)[0] || {}).id); break;
      case 'm': case 'M': mergeWithNext(state.selected); break;
      case 'Delete': if (state.selected != null) deleteCue(state.selected); break;
      case 'Escape': state.pendingIn = null; setRec(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }
  function onKeyUp(e) {
    if ((e.key === 'h' || e.key === 'H') && holding) { holding = false; markOut(); }
  }

  function bind() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    // Mouse clicks should not leave buttons focused (so Space keeps controlling playback)
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (b && e.detail > 0) b.blur();
    });

    $('#btnPlay').addEventListener('click', function () { player.toggle(); });
    $('#btnBack').addEventListener('click', function () { player.seek(player.t - 1000); });
    $('#btnFwd').addEventListener('click', function () { player.seek(player.t + 1000); });
    $('#rate').addEventListener('change', function () { player.setRate(Number(this.value)); });
    $('#btnIn').addEventListener('click', markIn);
    $('#btnOut').addEventListener('click', markOut);
    $('#btnAdd').addEventListener('click', function () { addCueAtPlayhead(true); });

    // Hold button: IN on press, OUT on release (works with mouse and touch)
    var hb = $('#btnHold'), hbDown = false;
    hb.addEventListener('pointerdown', function (e) { hbDown = true; hb.setPointerCapture(e.pointerId); hb.classList.add('armed'); markIn(); });
    var release = function () { if (!hbDown) return; hbDown = false; hb.classList.remove('armed'); markOut(); };
    hb.addEventListener('pointerup', release);
    hb.addEventListener('pointercancel', release);

    // Media
    $('#mediaFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      player.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(f);
      state.mediaName = f.name;
      video.src = objectUrl;
      video.playbackRate = player.rate;
      setMode(/^audio\//.test(f.type) ? 'audio' : 'video');
      toast(t('tMediaLoaded', { f: f.name }));
      save();
      this.value = '';
    });
    video.addEventListener('loadedmetadata', function () {
      if (player.mode === 'video' && !video.videoWidth) setMode('audio');
      renderTimeline();
      lastTc = '';
    });
    video.addEventListener('play', updatePlayButton);
    video.addEventListener('pause', updatePlayButton);
    video.addEventListener('ended', updatePlayButton);
    video.addEventListener('error', function () {
      if (!video.getAttribute('src')) return;
      toast(t('tMediaError'));
      goDemo(false);
    });
    $('#btnDemo').addEventListener('click', function () { goDemo(true); });

    // Timeline: click / drag to seek, click a block to select it
    timeline.addEventListener('pointerdown', function (e) {
      var blk = e.target.closest('.tl-cue');
      if (blk) {
        var id = Number(blk.getAttribute('data-id'));
        select(id);
        player.seek(byId(id).start);
        return;
      }
      scrubbing = true;
      timeline.setPointerCapture(e.pointerId);
      seekFromPointer(e);
    });
    timeline.addEventListener('pointermove', function (e) { if (scrubbing) seekFromPointer(e); });
    timeline.addEventListener('pointerup', function () { scrubbing = false; });
    timeline.addEventListener('pointercancel', function () { scrubbing = false; });
    $('#zoom').addEventListener('input', function () {
      var center = (timelineScroll.scrollLeft + timelineScroll.clientWidth / 2) / (timelineScroll.clientWidth * state.zoom);
      state.zoom = Number(this.value);
      renderTimeline();
      timelineScroll.scrollLeft = center * timelineScroll.clientWidth * state.zoom - timelineScroll.clientWidth / 2;
      save();
    });

    // Cue list (event delegation)
    list.addEventListener('click', function (e) {
      var li = e.target.closest('.cue');
      if (!li) return;
      var id = Number(li.getAttribute('data-id'));
      var act = e.target.closest('[data-act]');
      if (!act) { if (state.selected !== id) select(id, { scroll: false }); return; }
      var a = act.getAttribute('data-act');
      select(id, { scroll: false });
      if (a === 'seek') { player.seek(byId(id).start); player.play(); }
      else if (a === 'split') splitCue(id);
      else if (a === 'merge') mergeWithNext(id);
      else if (a === 'delete') deleteCue(id);
    });
    var typedSinceFocus = false;
    list.addEventListener('focusin', function (e) {
      var li = e.target.closest('.cue');
      if (li) { typedSinceFocus = false; var id = Number(li.getAttribute('data-id')); if (state.selected !== id) select(id, { scroll: false }); }
    });
    list.addEventListener('input', function (e) {
      if (!e.target.matches('.cue-text')) return;
      var li = e.target.closest('.cue'), c = byId(Number(li.getAttribute('data-id')));
      if (!c) return;
      if (!typedSinceFocus) { pushUndo(); typedSinceFocus = true; }
      c.text = e.target.value;
      computeWarnings();
      fillMeta(li, c);
      var blk = blockEls[c.id];
      if (blk) {
        blk.firstChild.textContent = Subs.stripTags(c.text).replace(/\n/g, ' ') || '…';
        blk.classList.toggle('warn', warnings[c.id].length > 0);
      }
      updateSummary();
      save();
    });
    list.addEventListener('change', function (e) {
      if (!e.target.matches('.t-start, .t-end')) return;
      var li = e.target.closest('.cue'), c = byId(Number(li.getAttribute('data-id')));
      if (!c) return;
      var isStart = e.target.matches('.t-start');
      var v = Subs.parseTime(e.target.value);
      if (isNaN(v)) { toast(t('tBadTime')); e.target.value = fmt(isStart ? c.start : c.end); e.target.classList.add('bad'); setTimeout(function () { e.target.classList.remove('bad'); }, 900); return; }
      if (v === (isStart ? c.start : c.end)) { e.target.value = fmt(v); return; }
      pushUndo();
      if (isStart) c.start = v; else c.end = v;
      state.cues = Subs.sortCues(state.cues);
      afterChange();
      select(c.id);
    });

    // Head actions
    $('#btnSort').addEventListener('click', function () { pushUndo(); state.cues = Subs.sortCues(state.cues); afterChange(); toast(t('tSorted')); });
    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);
    $('#btnNextWarn').addEventListener('click', nextWarning);

    // Tools
    $('#btnShiftMinus').addEventListener('click', function () { applyShift(-1); });
    $('#btnShiftPlus').addEventListener('click', function () { applyShift(1); });
    $('#btnFps').addEventListener('click', applyFps);
    $('#btnStretch').addEventListener('click', applyStretch);
    $('#btnFixOverlaps').addEventListener('click', function () {
      var before = 0; computeWarnings();
      for (var id in warnings) if (warnings[id].indexOf('overlap') >= 0) before++;
      if (!before) { toast(t('tFixed', { n: 0 })); return; }
      pushUndo();
      state.cues = Subs.fixOverlaps(Subs.sortCues(state.cues));
      afterChange();
      toast(t('tFixed', { n: before }));
    });

    // Import / export
    $('#subFile').addEventListener('change', function () {
      var f = this.files && this.files[0], input = this;
      if (!f) return;
      readTextFile(f).then(function (txt) { doImport(txt); input.value = ''; });
    });
    $('#btnPaste').addEventListener('click', function () {
      if (doImport($('#pasteBox').value)) $('#pasteBox').value = '';
    });
    $('#btnExample').addEventListener('click', function () {
      pushUndo(); state.cues = exampleCues(); state.selected = null; afterChange(); toast(t('tExample'));
    });
    $('#btnClear').addEventListener('click', function () {
      if (!state.cues.length) return;
      if (!window.confirm(t('tClearConfirm'))) return;
      pushUndo(); state.cues = []; state.selected = null; state.pendingIn = null; setRec(); afterChange(); toast(t('tCleared'));
    });
    $('#exSrt').addEventListener('click', function () { exportAs('srt'); });
    $('#exVtt').addEventListener('click', function () { exportAs('vtt'); });
    $('#exTxt').addEventListener('click', function () { exportAs('txt'); });
    $('#exJson').addEventListener('click', function () { exportAs('json'); });

    // Script queue
    $('#script').addEventListener('input', function () { state.script = this.value; updateScriptCount(); save(); });

    // Style
    var st = state.style;
    $('#stSize').addEventListener('input', function () { st.size = Number(this.value); applyStyle(); save(); });
    $('#stColor').addEventListener('input', function () { st.color = this.value; applyStyle(); save(); });
    $('#stBox').addEventListener('change', function () { st.box = this.checked; applyStyle(); save(); });
    $('#stBoxColor').addEventListener('input', function () { st.boxColor = this.value; applyStyle(); save(); });
    $('#stBoxOpacity').addEventListener('input', function () { st.boxOpacity = Number(this.value); applyStyle(); save(); });
    $('#stPos').addEventListener('change', function () { st.position = this.value; applyStyle(); save(); });
    $('#stOutline').addEventListener('change', function () { st.outline = this.checked; applyStyle(); save(); });
    $('#stBold').addEventListener('change', function () { st.bold = this.checked; applyStyle(); save(); });

    // Settings
    var o = state.opts;
    var numOpt = function (sel, key, min, max) {
      $(sel).addEventListener('change', function () {
        var v = Number(this.value);
        if (!isFinite(v)) v = o[key];
        o[key] = clamp(Math.round(v), min, max); this.value = o[key];
        afterChange();
      });
    };
    numOpt('#optCps', 'maxCps', 5, 40);
    numOpt('#optLine', 'maxLine', 10, 80);
    numOpt('#optMinDur', 'minDur', 0, 5000);
    numOpt('#optDefDur', 'defDur', 300, 10000);
    $('#optChain').addEventListener('change', function () { o.chain = this.checked; save(); });
    $('#optHold').addEventListener('change', function () { o.hold = this.checked; save(); });

    $('#lang').addEventListener('change', function () { applyLang(this.value); renderTimeline(); });

    window.addEventListener('resize', function () { renderTimeline(); scaleOverlay(); });
    if (window.ResizeObserver) new ResizeObserver(function () { scaleOverlay(); }).observe(stage);
    window.addEventListener('beforeunload', saveNow);
  }

  var scrubbing = false;
  function seekFromPointer(e) {
    var r = timeline.getBoundingClientRect();
    player.seek((e.clientX - r.left) / pxPerMs());
  }

  /** Switch to the demo clock (no media). */
  function goDemo(announce) {
    player.pause();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    video.removeAttribute('src');
    video.load();
    state.mediaName = '';
    player.demoT = 0;
    setMode('demo');
    if (!state.cues.length) { state.cues = exampleCues(); afterChange(); }
    if (announce) toast(t('tDemo', { s: Math.round(player.dur / 1000) }));
    updatePlayButton();
    save();
  }

  /* ================================================================== */
  /* Boot                                                                */
  /* ================================================================== */

  function fillControls() {
    var st = state.style, o = state.opts;
    $('#stSize').value = st.size; $('#stColor').value = st.color; $('#stBox').checked = st.box;
    $('#stBoxColor').value = st.boxColor; $('#stBoxOpacity').value = st.boxOpacity; $('#stPos').value = st.position;
    $('#stOutline').checked = st.outline; $('#stBold').checked = st.bold;
    $('#optCps').value = o.maxCps; $('#optLine').value = o.maxLine; $('#optMinDur').value = o.minDur; $('#optDefDur').value = o.defDur;
    $('#optChain').checked = o.chain; $('#optHold').checked = o.hold;
    $('#zoom').value = state.zoom;
    $('#script').value = state.script;
    ['#fpsFrom', '#fpsTo'].forEach(function (sel, i) {
      var s = $(sel);
      FPS_LIST.forEach(function (f) { var op = document.createElement('option'); op.value = f; op.textContent = f; s.appendChild(op); });
      s.value = i === 0 ? '23.976' : '25';
    });
  }

  function boot() {
    var lang = storageGet(LANG_KEY);
    state.lang = lang && I18N[lang] ? lang : 'fr';
    var had = load();
    // The media file itself is never stored; after a reload we restart in demo mode.
    state.mediaName = '';
    if (!had) state.cues = exampleCues();
    fillControls();
    bind();
    applyLang(state.lang);
    applyStyle();
    // On narrow screens keep the style panel folded so the cue list comes sooner
    if (window.matchMedia && window.matchMedia('(max-width: 960px)').matches) $('#stylePanel').open = false;
    setMode('demo');
    afterChange();
    updatePlayButton();
    requestAnimationFrame(frame);
  }

  // Expose a tiny read-only hook for automated tests
  window.SousTitres = {
    get state() { return state; },
    get player() { return player; }
  };

  boot();
})();
