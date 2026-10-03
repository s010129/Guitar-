// 左手（手機）：指板多點觸控 / 和弦按鈕，把按弦狀態傳給 iPad
(function () {
  'use strict';
  const M = Music;
  const $ = (id) => document.getElementById(id);
  const store = Net.store;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const settings = Object.assign({ frets: 0, flip: false, lefty: false, names: true, pullRing: false, perform: false }, store('l.settings') || {});
  // 指板左右翻轉（琴頭在右）：演奏模式面向觀眾時翻轉；左撇子再反過來
  const mirrored = () => !!settings.lefty !== !!settings.perform;
  const cfg = Object.assign({ inst: 'acoustic', name: '木吉他（鋼弦）', n: 6, tuning: [40, 45, 50, 55, 59, 64], tuneId: 'std', tuneName: '標準 EADGBE', capo: 0 }, store('l.cfg') || {});
  const st = {
    mode: store('l.mode') === 'chord' ? 'chord' : 'fret',
    start: store('l.start') || 1,
    muted: new Array(cfg.n).fill(false),
    pads: store('l.pads') || M.PRESETS[0].chords.slice(),
    preset: store('l.preset') || 'C',
    padSel: -1,
    muteHold: 0,
    editing: false,
    frets: new Array(cfg.n).fill(0),
    lastKey: '',
  };

  // ---------------- 連線 ----------------
  const link = new Net.Link({
    role: 'guest',
    onStatus(state, text) {
      UI.statusDot($('dot'), state);
      $('statusText').textContent = text;
      if (state !== 'connected' && state !== 'unstable') $('lat').textContent = '';
    },
    onOpen() {
      link.send({ t: 'hello' });
      st.lastKey = '';
      sendState(true);
      UI.toast('已連上 iPad 🎸');
    },
    onLatency(ms) {
      $('lat').textContent = `${ms.toFixed(0)}ms`;
    },
    onMessage(d) {
      if (d.t === 'cfg') applyCfg(d);
      else if (d.t === 'pl' && d.s < cfg.n) {
        amp[d.s] = Math.max(amp[d.s] || 0, 1.5 + 5 * (d.v || 0.5));
        dirty = true;
      }
    },
  });

  function join(code) {
    code = String(code || '').replace(/\D/g, '').slice(0, 4);
    if (code.length !== 4) {
      UI.toast('請輸入 4 位數房號');
      return false;
    }
    store('l.room', code);
    $('roomInput').value = code;
    link.join(code);
    Net.keepAwake();
    return true;
  }

  function applyCfg(d) {
    const changed = d.n !== cfg.n;
    Object.assign(cfg, { inst: d.inst, name: d.name, n: d.n, tuning: d.tuning, tuneId: d.tuneId, tuneName: d.tuneName, capo: d.capo || 0 });
    store('l.cfg', cfg);
    // 跟著 iPad 的演奏模式（抱吉他、面向觀眾）一起左右翻轉
    if (typeof d.stage === 'boolean' && d.stage !== !!settings.perform) {
      setPerform(d.stage, false);
      UI.toast(d.stage ? 'iPad 切到演奏模式：指板也左右翻轉了' : 'iPad 切回放桌上：指板翻回來了', 2500);
    }
    if (changed) {
      st.muted = new Array(cfg.n).fill(false);
      // 清掉觸控前，先放開它們按住的「悶音」，否則之後放手也解除不了
      for (const p of ptrs.values()) if (p.kind === 'mute') st.muteHold = Math.max(0, st.muteHold - 1);
      ptrs.clear();
      amp.length = 0;
    }
    $('instLbl').textContent = cfg.name + (cfg.capo ? ` · capo ${cfg.capo}` : '');
    renderPads();
    layout();
    st.lastKey = '';
    sendState(true);
  }

  // ---------------- 狀態 ----------------
  const padFrets = (i) => M.chordFrets(st.pads[i], cfg.tuning, cfg.tuneId);

  function computeFrets() {
    const n = cfg.n;
    let f;
    if (st.mode === 'chord') {
      f = st.padSel >= 0 ? padFrets(st.padSel) : new Array(n).fill(0);
    } else {
      f = st.muted.map((m) => (m ? -1 : 0));
      for (const p of ptrs.values()) {
        if (p.kind !== 'fret') continue;
        for (const s of p.strings) if (s < n) f[s] = Math.max(f[s], p.fret);
      }
    }
    if (st.muteHold > 0) f = f.map(() => -1);
    return f;
  }

  function sendState(force) {
    const f = computeFrets();
    const key = st.mode + f.join(',');
    st.frets = f;
    dirty = true;
    if (key === st.lastKey && !force) return;
    st.lastKey = key;
    link.send({ t: 'L', f, m: st.mode, po: !!settings.pullRing });
  }
  setInterval(() => link.connected && link.send({ t: 'L', f: st.frets, m: st.mode, po: !!settings.pullRing, hb: 1 }), 2000);

  // ---------------- 指板版面 ----------------
  const stage = $('stage');
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, g = null, dirty = true;
  const amp = [];

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    W = stage.clientWidth;
    H = stage.clientHeight;
    if (!W || !H) return;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const portrait = H > W;
    const Lu = portrait ? H : W;
    const Lv = portrait ? W : H;
    const labelW = clamp(Lu * 0.075, 40, 56);
    const muteW = clamp(Lu * 0.07, 40, 56);
    const count = settings.frets || clamp(Math.round((Lu - labelW - muteW) / 80), 4, 12);
    st.start = clamp(st.start, 1, 25 - count);
    store('l.start', st.start);
    const total = Lu - labelW - muteW;
    const ws = [];
    let sum = 0;
    for (let k = 0; k < count; k++) {
      ws.push(Math.pow(0.955, st.start - 1 + k));
      sum += ws[k];
    }
    const edges = [labelW];
    for (let k = 0; k < count; k++) edges.push(edges[k] + (ws[k] / sum) * total);
    const n = cfg.n;
    const rowH = Lv / n;
    g = { portrait, Lu, Lv, labelW, muteW, count, edges, n, rowH, fretEnd: Lu - muteW };
    $('posLbl').textContent = `${st.start}–${st.start + count - 1}`;
    // 指板翻轉時，往琴頭的箭頭也要指向右邊
    const m = mirrored();
    $('posBox').classList.toggle('rev', m);
    $('posL').textContent = m ? '▶' : '◀';
    $('posR').textContent = m ? '◀' : '▶';
    dirty = true;
  }

  // u = 沿著弦的方向（琴頭→琴身），v = 橫跨弦的方向
  function toUV(x, y) {
    let u, v;
    if (g.portrait) { u = y; v = x; if (mirrored()) v = g.Lv - v; }
    else { u = x; v = y; if (mirrored()) u = g.Lu - u; }
    return { u, v };
  }
  function toXY(u, v) {
    if (g.portrait) return { x: mirrored() ? g.Lv - v : v, y: u };
    return { x: mirrored() ? g.Lu - u : u, y: v };
  }
  const rowOf = (s) => (settings.flip ? g.n - 1 - s : s);
  const stringAtV = (v) => {
    const r = clamp(Math.floor(v / g.rowH), 0, g.n - 1);
    return settings.flip ? g.n - 1 - r : r;
  };
  const vOf = (s) => (rowOf(s) + 0.5) * g.rowH;
  function fretAtU(u) {
    for (let k = 0; k < g.count; k++) if (u < g.edges[k + 1]) return st.start + k;
    return st.start + g.count - 1;
  }
  const cellMid = (fret) => {
    const k = fret - st.start;
    return (g.edges[k] + g.edges[k + 1]) / 2;
  };

  // 在 uv 座標畫圖的小工具
  function rectUV(u0, v0, u1, v1) {
    const a = toXY(u0, v0), b = toXY(u1, v1);
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  function lineUV(u0, v0, u1, v1) {
    const a = toXY(u0, v0), b = toXY(u1, v1);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  function circleUV(u, v, r) {
    const p = toXY(u, v);
    ctx.moveTo(p.x + r, p.y);
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  }
  function textUV(t, u, v) {
    const p = toXY(u, v);
    ctx.fillText(t, p.x, p.y);
  }

  function draw(now) {
    if (!g) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f0d0b';
    ctx.fillRect(0, 0, W, H);
    const { Lv, labelW, fretEnd, n, rowH } = g;

    // 指板木頭
    const a = toXY(labelW, 0), b = toXY(fretEnd, Lv);
    const grad = g.portrait ? ctx.createLinearGradient(a.x, 0, b.x, 0) : ctx.createLinearGradient(0, a.y, 0, b.y);
    grad.addColorStop(0, '#3e2617');
    grad.addColorStop(0.5, '#2c1a0f');
    grad.addColorStop(1, '#3a2315');
    ctx.fillStyle = grad;
    ctx.beginPath();
    rectUV(labelW, 0, fretEnd, Lv);
    ctx.fill();

    // 正在按的格子底色
    ctx.fillStyle = 'rgba(242,168,59,.10)';
    for (let s = 0; s < n; s++) {
      const f = st.frets[s];
      if (st.mode === 'fret' && f > 0 && f >= st.start && f < st.start + g.count) {
        const k = f - st.start;
        ctx.beginPath();
        rectUV(g.edges[k], rowOf(s) * rowH, g.edges[k + 1], (rowOf(s) + 1) * rowH);
        ctx.fill();
      }
    }

    // 指板記號
    ctx.fillStyle = 'rgba(235,225,205,.55)';
    for (let k = 0; k < g.count; k++) {
      const fr = st.start + k;
      const mu = (g.edges[k] + g.edges[k + 1]) / 2;
      const r = Math.min(9, rowH * 0.16);
      ctx.beginPath();
      if (fr % 12 === 0) { circleUV(mu, Lv * 0.3, r); circleUV(mu, Lv * 0.7, r); }
      else if ([3, 5, 7, 9, 15, 17, 19, 21].includes(fr)) circleUV(mu, Lv / 2, r);
      ctx.fill();
    }

    // 品絲與上弦枕
    ctx.strokeStyle = '#bdb6a8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let k = 1; k <= g.count; k++) lineUV(g.edges[k], 0, g.edges[k], Lv);
    ctx.stroke();
    ctx.strokeStyle = st.start === 1 ? '#efe6d2' : '#bdb6a8';
    ctx.lineWidth = st.start === 1 ? 8 : 3;
    ctx.beginPath();
    lineUV(labelW, 0, labelW, Lv);
    ctx.stroke();

    // 格數
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(243,236,227,.45)';
    for (let k = 0; k < g.count; k++) textUV(String(st.start + k), (g.edges[k] + g.edges[k + 1]) / 2, g.portrait ? 8 : Lv - 8);

    // 弦
    for (let s = 0; s < n; s++) {
      const v = vOf(s);
      const t = n > 1 ? s / (n - 1) : 0;
      const w = (3.6 - 2.4 * t) * (cfg.inst === 'bass' ? 1.4 : 1);
      const muted = st.frets[s] < 0;
      const am = amp[s] || 0;
      const off = am * Math.sin(now * 0.12 + s * 1.3);
      const p0 = toXY(labelW, v), p1 = toXY(fretEnd, v), pm = toXY((labelW + fretEnd) / 2, v + off);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(pm.x, pm.y, p1.x, p1.y);
      ctx.lineWidth = w;
      ctx.strokeStyle = muted ? '#7c6e62' : s < n - 2 && cfg.inst === 'acoustic' ? '#d9a066' : '#dedede';
      ctx.stroke();
    }

    // 封閉和弦（橫按）的橫條
    for (const p of ptrs.values()) {
      if (p.kind !== 'fret' || p.strings.size < 2) continue;
      const rows = [...p.strings].map(rowOf);
      const r0 = Math.min(...rows), r1 = Math.max(...rows);
      const mu = cellMid(p.fret);
      const half = Math.min(16, (g.edges[1] - g.edges[0]) * 0.25);
      ctx.fillStyle = 'rgba(242,168,59,.75)';
      ctx.beginPath();
      rectUV(mu - half, (r0 + 0.5) * rowH, mu + half, (r1 + 0.5) * rowH);
      ctx.fill();
    }

    // 按住的位置
    ctx.font = '800 14px -apple-system, sans-serif';
    for (let s = 0; s < n; s++) {
      const f = st.frets[s];
      if (st.mode !== 'fret' || f <= 0 || f < st.start || f >= st.start + g.count) continue;
      const mu = cellMid(f);
      const v = vOf(s);
      const r = Math.min(rowH * 0.36, 20);
      ctx.beginPath();
      circleUV(mu, v, r);
      ctx.fillStyle = '#f2a83b';
      ctx.shadowColor = 'rgba(242,168,59,.8)';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#1b1206';
      textUV(settings.names ? M.noteName(cfg.tuning[s] + cfg.capo + f) : String(f), mu, v + 0.5);
    }

    // 左側：弦名 / 悶音切換
    ctx.fillStyle = '#17120e';
    ctx.beginPath();
    rectUV(0, 0, labelW - 4, Lv);
    ctx.fill();
    ctx.font = '800 15px -apple-system, sans-serif';
    for (let s = 0; s < n; s++) {
      const v = vOf(s);
      const m = st.muted[s];
      const r = Math.min(rowH * 0.36, 17);
      ctx.beginPath();
      circleUV(labelW / 2 - 2, v, r);
      ctx.fillStyle = m ? '#c43a3a' : st.frets[s] === 0 ? 'rgba(76,208,125,.25)' : '#2a221b';
      ctx.fill();
      ctx.fillStyle = m ? '#fff' : '#f3ece3';
      textUV(m ? '✕' : M.noteName(cfg.tuning[s] + cfg.capo), labelW / 2 - 2, v + 0.5);
    }

    // 右側：按住悶音
    ctx.fillStyle = st.muteHold > 0 ? '#c43a3a' : '#2a1717';
    ctx.beginPath();
    rectUV(fretEnd + 3, 0, g.Lu, Lv);
    ctx.fill();
    ctx.fillStyle = st.muteHold > 0 ? '#fff' : '#d99';
    ctx.font = '800 16px -apple-system, sans-serif';
    const mm = fretEnd + (g.Lu - fretEnd) / 2 + 1;
    textUV('悶', mm, Lv / 2 - 12);
    textUV('音', mm, Lv / 2 + 10);
    if (st.muteHold > 0) {
      ctx.fillStyle = 'rgba(196,58,58,.18)';
      ctx.beginPath();
      rectUV(labelW, 0, fretEnd, Lv);
      ctx.fill();
    }
  }

  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    let anim = false;
    for (let s = 0; s < amp.length; s++) {
      if (amp[s] > 0.05) {
        amp[s] *= Math.exp(-dt / 0.35);
        anim = true;
      } else if (amp[s]) {
        amp[s] = 0;
        anim = true;
      }
    }
    if ((anim || dirty) && st.mode === 'fret') {
      draw(now);
      dirty = false;
    }
    requestAnimationFrame(frame);
  }

  // ---------------- 指板觸控 ----------------
  const ptrs = new Map();
  const posOf = (e) => {
    const p = UI.localPoint(cv, e); // 考慮整頁旋轉
    return toUV(p.x, p.y);
  };

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!g) return;
    const { u, v } = posOf(e);
    const s = stringAtV(v);
    if (u < g.labelW) {
      st.muted[s] = !st.muted[s];
      ptrs.set(e.pointerId, { kind: 'label' });
    } else if (u > g.fretEnd) {
      st.muteHold++;
      ptrs.set(e.pointerId, { kind: 'mute' });
    } else {
      ptrs.set(e.pointerId, { kind: 'fret', fret: fretAtU(u), strings: new Set([s]), lastS: s });
    }
    sendState();
  });

  cv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p || p.kind !== 'fret') return;
    const { u, v } = posOf(e);
    const s = stringAtV(v);
    const f = fretAtU(clamp(u, g.labelW, g.fretEnd - 1));
    let changed = false;
    if (f !== p.fret) {
      // 橫按的手指整條一起滑；單指就是滑音
      if (!(p.strings.size > 1 && p.strings.has(s))) p.strings = new Set([s]);
      p.fret = f;
      p.lastS = s;
      changed = true;
    } else if (s !== p.lastS) {
      // 同一格往旁邊的弦拖 = 橫按（封閉和弦）
      const a = Math.min(rowOf(s), rowOf(p.lastS)), b = Math.max(rowOf(s), rowOf(p.lastS));
      for (let r = a; r <= b; r++) p.strings.add(settings.flip ? g.n - 1 - r : r);
      p.lastS = s;
      changed = true;
    }
    if (changed) sendState();
  });

  const up = (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    if (p.kind === 'mute') st.muteHold = Math.max(0, st.muteHold - 1);
    sendState();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('lostpointercapture', up);

  // ---------------- 和弦模式 ----------------
  function renderPads() {
    const box = $('pads');
    box.innerHTML = '';
    st.pads.forEach((name, i) => {
      const ch = M.parseChord(name);
      const frets = padFrets(i);
      const b = document.createElement('button');
      b.className = 'pad' + (i === st.padSel ? ' on' : '') + (st.editing ? ' edit' : '');
      b.innerHTML = `<span class="nm">${ch ? ch.name : name}</span>${UI.chordSVG(frets)}<span class="fr">${M.fretsToString(frets)}</span>`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (st.editing) openPicker(i);
        else {
          st.padSel = st.padSel === i ? -1 : i;
          markPads();
          sendState();
        }
      });
      box.appendChild(b);
    });
  }
  function markPads() {
    [...$('pads').children].forEach((b, i) => b.classList.toggle('on', i === st.padSel));
  }

  const muteBtn = $('muteBtn');
  muteBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { muteBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    st.muteHold++;
    muteBtn.classList.add('on');
    sendState();
  });
  const muteUp = () => {
    if (!muteBtn.classList.contains('on')) return;
    st.muteHold = Math.max(0, st.muteHold - 1);
    if (!st.muteHold) muteBtn.classList.remove('on');
    sendState();
  };
  muteBtn.addEventListener('pointerup', muteUp);
  muteBtn.addEventListener('pointercancel', muteUp);

  const presetSel = $('presetSel');
  presetSel.innerHTML = '<option value="">換一組和弦…</option>' + M.PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  presetSel.addEventListener('change', () => {
    const p = M.PRESETS.find((x) => x.id === presetSel.value);
    presetSel.value = '';
    if (!p) return;
    st.pads = p.chords.slice();
    store('l.pads', st.pads);
    st.padSel = -1;
    renderPads();
    sendState();
    UI.toast(p.name);
  });
  $('editBtn').addEventListener('click', () => {
    st.editing = !st.editing;
    $('editBtn').classList.toggle('on', st.editing);
    $('editBtn').textContent = st.editing ? '✓ 完成' : '✎ 編輯和弦';
    if (st.editing) UI.toast('點一個和弦按鈕來更換');
    renderPads();
  });

  // 和弦選擇器
  let pickIdx = 0, pickRoot = 0, pickType = '';
  function openPicker(i) {
    pickIdx = i;
    const ch = M.parseChord(st.pads[i]) || { root: 0, type: { id: '' } };
    pickRoot = ch.root;
    pickType = ch.type.id;
    $('pickRoots').innerHTML = M.NAMES.map((nm, k) => `<button data-root="${k}">${nm}</button>`).join('');
    $('pickTypes').innerHTML = M.CHORD_TYPES.map((t) => `<button data-type="${t.id}">${t.id || 'maj'}<br><small>${t.label}</small></button>`).join('');
    refreshPicker();
    $('pickModal').classList.remove('hidden');
  }
  function refreshPicker() {
    $('pickPreview').textContent = M.NAMES[pickRoot] + pickType;
    $('pickRoots').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.root) === pickRoot));
    $('pickTypes').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.type === pickType));
  }
  $('pickRoots').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { pickRoot = Number(b.dataset.root); refreshPicker(); }
  });
  $('pickTypes').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { pickType = b.dataset.type; refreshPicker(); }
  });
  $('pickOk').addEventListener('click', () => {
    st.pads[pickIdx] = M.NAMES[pickRoot] + pickType;
    store('l.pads', st.pads);
    $('pickModal').classList.add('hidden');
    renderPads();
    if (st.padSel === pickIdx) sendState();
  });

  // ---------------- 模式 / 把位 / 設定 ----------------
  function setMode(m) {
    st.mode = m;
    store('l.mode', m);
    $('tabFret').classList.toggle('on', m === 'fret');
    $('tabChord').classList.toggle('on', m === 'chord');
    $('chordPanel').classList.toggle('hidden', m !== 'chord');
    $('posBox').classList.toggle('hidden', m !== 'fret');
    ptrs.clear();
    st.muteHold = 0;
    muteBtn.classList.remove('on');
    dirty = true;
    sendState();
  }
  $('tabFret').addEventListener('click', () => setMode('fret'));
  $('tabChord').addEventListener('click', () => setMode('chord'));
  $('posL').addEventListener('click', () => { st.start--; layout(); });
  $('posR').addEventListener('click', () => { st.start++; layout(); });

  const fc = $('fretCount');
  fc.innerHTML = '<option value="0">自動</option>' + Array.from({ length: 12 }, (_, k) => `<option value="${k + 4}">${k + 4} 格</option>`).join('');
  fc.value = String(settings.frets);
  fc.addEventListener('change', () => {
    settings.frets = Number(fc.value);
    store('l.settings', settings);
    layout();
  });
  // 演奏模式：手機和 iPad 同步
  function setPerform(on, tellIpad) {
    settings.perform = !!on;
    store('l.settings', settings);
    $('perform').checked = settings.perform;
    ptrs.clear();
    layout();
    if (tellIpad) link.send({ t: 'stage', on: settings.perform });
  }
  $('perform').checked = !!settings.perform;
  $('perform').addEventListener('change', () => setPerform($('perform').checked, true));

  for (const key of ['flip', 'lefty', 'names', 'pullRing']) {
    const el = $(key);
    el.checked = !!settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      store('l.settings', settings);
      layout();
      sendState(true);
    });
  }
  $('setBtn').addEventListener('click', () => $('setModal').classList.remove('hidden'));
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden');
    });
  });

  // 房號
  $('joinBtn').addEventListener('click', () => join($('roomInput').value));
  $('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('roomInput').value); });
  $('startJoin').addEventListener('click', () => {
    UI.enterFullscreen(); // Android 等支援的瀏覽器：順便全螢幕
    if (join($('startRoom').value)) $('start').classList.add('hidden');
  });
  $('startRoom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && join($('startRoom').value)) $('start').classList.add('hidden');
  });
  $('startSkip').addEventListener('click', () => $('start').classList.add('hidden'));

  // ---------------- 啟動 ----------------
  UI.forceLandscape();
  Net.lockGestures();
  UI.setupFullscreenButton($('fsBtn'), () => $('a2hsModal').classList.remove('hidden'));
  $('instLbl').textContent = cfg.name + (cfg.capo ? ` · capo ${cfg.capo}` : '');
  renderPads();
  setMode(st.mode);
  window.addEventListener('resize', layout);
  if (window.ResizeObserver) new ResizeObserver(layout).observe(stage);
  layout();
  requestAnimationFrame(frame);

  const qRoom = new URLSearchParams(location.search).get('room');
  const saved = store('l.room');
  if (qRoom && join(qRoom)) {
    // 從 QR Code 進來：直接連線
  } else {
    if (saved) {
      $('startRoom').value = saved;
      $('roomInput').value = saved;
    }
    $('start').classList.remove('hidden');
  }
  document.addEventListener('pointerdown', () => Net.keepAwake(), { once: true });

  window.__left = { st, cfg, link, settings, computeFrets };
})();
