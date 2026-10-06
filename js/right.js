// 右手（iPad）：畫吉他、偵測刷弦 / 撥弦 / 敲琴身 / 手掌悶音，並負責發聲
(function () {
  'use strict';
  const M = Music;
  const $ = (id) => document.getElementById(id);
  const store = Net.store;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const audio = new GuitarAudio();

  const settings = Object.assign({ volume: 0.8, reverb: 1, sens: 1, tapping: false, labels: true, flip: false, stage: false }, store('r.settings') || {});
  const st = {
    inst: M.INSTRUMENTS[store('r.inst')] ? store('r.inst') : 'acoustic',
    tunes: store('r.tunes') || {},
    capo: store('r.capo') || 0,
    preset: store('r.preset') || 'C',
    chordBar: store('r.chordBar'), // null = 自動（沒連手機時顯示）
    frets: [],
    padSel: -1,
    room: store('r.room') || String(1000 + Math.floor(Math.random() * 9000)),
    hint: true,
  };

  const inst = () => M.INSTRUMENTS[st.inst];
  const tuningObj = () => {
    const list = M.tuningsFor(st.inst);
    return list.find((t) => t.id === st.tunes[inst().family]) || list[0];
  };
  const tuning = () => tuningObj().notes;
  const nStr = () => tuning().length;
  const noteOf = (s, f) => tuning()[s] + st.capo + Math.max(0, f);
  const freqOf = (s, f) => M.midiToFreq(noteOf(s, f));
  st.frets = new Array(nStr()).fill(0);

  // ---------------- 連線 ----------------
  const link = new Net.Link({
    role: 'host',
    onStatus(state, text) {
      UI.statusDot($('dot'), state);
      UI.statusDot($('dot2'), state);
      $('statusText').textContent = text;
      if (state !== 'connected' && state !== 'unstable') {
        $('lat').textContent = '';
        stopMetro(); // 手機斷線就停掉節拍器
      }
      if (state === 'waiting' && wasConnected) {
        wasConnected = false;
        UI.toast('手機已斷線');
      }
      updateChordBarVisibility();
    },
    onOpen() {
      wasConnected = true;
      stopMetro(); // 換了一支手機 / 手機重新連上：之前那首歌的節拍器已經沒人在玩了
      UI.toast('手機（左手）已連線 🎉');
      $('qrModal').classList.add('hidden');
      sendCfg();
      updateChordBarVisibility();
    },
    onLatency(ms) {
      lastLatency = ms;
      $('lat').textContent = `延遲 ${ms.toFixed(0)}ms`;
    },
    onMessage,
  });
  let wasConnected = false;
  // 房號被別的分頁 / 裝置占用超過約 95 秒（net.js 會先等舊連線釋放）才換新房號
  link.onIdTaken = () => {
    newRoom();
    UI.toast('原房號被占用，已換新房號：' + st.room, 3500);
  };
  function startRoom() {
    store('r.room', st.room);
    $('roomCode').textContent = st.room;
    $('qrCode').textContent = st.room;
    link.host(st.room);
  }
  function newRoom() {
    st.room = String(1000 + Math.floor(Math.random() * 9000));
    startRoom();
    if (!$('qrModal').classList.contains('hidden')) showQR();
  }

  function onMessage(d) {
    if (d.t === 'hello') sendCfg();
    else if (d.t === 'game') handleGame(d);
    else if (d.t === 'stage') {
      // 手機切換演奏模式：iPad 跟著切（兩邊是同一把吉他）
      if (!!d.on !== !!settings.stage) {
        settings.stage = !!d.on;
        store('r.settings', settings);
        applyStage();
        UI.toast(settings.stage ? '演奏模式（面向觀眾）' : '放桌上模式');
      }
    }
    else if (d.t === 'L') {
      if (!Array.isArray(d.f) || d.f.length !== nStr()) {
        sendCfg();
        return;
      }
      if (d.hb && st.padSel >= 0) return; // iPad 和弦列優先，手機的心跳訊息不覆蓋
      if (st.padSel >= 0) {
        st.padSel = -1;
        markPads();
      }
      applyLeft(d.f, d.m === 'chord' ? 'chord' : 'fret', !!d.po);
    }
  }

  // ---------------- 音遊模式：節拍器（手機決定時間，iPad 發聲）----------------
  let lastLatency = 0;
  let metroGame = null; // 正在進行的歌（節拍器參數 + 第 0 拍的時間）
  let metro = []; // 已經排好的節拍聲
  function clearClicks() {
    metro.forEach((o) => { try { o.stop(); } catch (e) { /* 已經停了 */ } });
    metro = [];
  }
  function stopMetro() {
    metroGame = null;
    clearClicks();
  }
  function handleGame(d) {
    stopMetro();
    if (d.cmd !== 'start' || !d.click) return;
    // d.delay = 手機送出時到第 0 拍的毫秒數；扣掉網路延遲 = 這台 iPad 時鐘上的第 0 拍
    metroGame = {
      bpm: clamp(Number(d.bpm) || 90, 30, 300),
      bpb: clamp(Math.round(d.bpb) || 4, 2, 12),
      beats: clamp(Math.round(d.beats) || 0, 0, 2000),
      countIn: clamp(Math.round(d.countIn) || 0, 0, 16),
      beat0: performance.now() + (Number(d.delay) || 0) - lastLatency,
    };
    scheduleMetro();
  }
  // 用 performance.now() 對到 AudioContext 的時間再排程。聲音還沒啟動、或被暫停（iOS 中斷、切到背景）時先不排，
  // 等 AudioContext 回到 running 再重排剩下的拍子，才不會整首歌都慢掉或沒有節拍器
  function scheduleMetro() {
    clearClicks();
    const g = metroGame;
    if (!g || !audio.ready || audio.ctx.state !== 'running') return;
    const ctx = audio.ctx;
    const spb = 60 / g.bpm;
    const outLat = ctx.outputLatency || ctx.baseLatency || 0; // 喇叭輸出延遲
    const t0 = ctx.currentTime + (g.beat0 - performance.now()) / 1000 - outLat;
    for (let i = -g.countIn; i < g.beats; i++) {
      const when = t0 + i * spb;
      if (when < ctx.currentTime + 0.005) continue;
      const o = audio.click(when, (((i % g.bpb) + g.bpb) % g.bpb) === 0);
      if (o) metro.push(o);
    }
    if (!metro.length) metroGame = null; // 歌已經結束了
  }

  function sendCfg() {
    const t = tuningObj();
    link.send({ t: 'cfg', inst: st.inst, name: inst().name, n: nStr(), tuning: t.notes, tuneId: t.id, tuneName: t.name, capo: st.capo, stage: !!settings.stage });
  }

  // ---------------- 左手狀態 → 聲音 ----------------
  const amp = [];
  const visTau = [];
  function applyLeft(frets, src, pullRing) {
    for (let s = 0; s < nStr(); s++) {
      const old = st.frets[s];
      const neu = Number.isFinite(frets[s]) ? clamp(Math.round(frets[s]), -1, 24) : 0;
      if (old === neu) continue;
      st.frets[s] = neu;
      if (neu < 0) {
        audio.damp(s, 0.05);
        visTau[s] = 0.05;
      } else if (src === 'chord' || old < 0) {
        audio.damp(s, 0.04); // 換和弦：舊的音先止住，下一次撥弦才用新音高
        visTau[s] = 0.05;
      } else if (old > 0 && neu === 0 && !pullRing) {
        audio.damp(s, 0.07); // 放開手指 = 止音
        visTau[s] = 0.07;
      } else {
        // 搥弦 / 勾弦 / 滑音：弦還在響就滑到新音高
        audio.setFreq(s, freqOf(s, neu), Math.abs(neu - Math.max(0, old)) > 2 ? 30 : 12);
      }
      if (settings.tapping && src === 'fret' && neu > 0 && neu > old && (amp[s] || 0) < 1.2) {
        pluck(s, 0.42, geo ? geo.fbEnd : 0, 0, true);
      }
    }
    updateChord();
    dirty = true;
  }

  let chordName = '';
  let chordFretsStr = '';
  function updateChord() {
    const notes = [];
    st.frets.forEach((f, s) => { if (f >= 0) notes.push(noteOf(s, f)); });
    const tu = tuning();
    chordName = M.detectChord(notes, tu.some((m, i) => i > 0 && m < tu[i - 1]));
    chordFretsStr = M.fretsToString(st.frets);
    dirty = true;
  }

  // ---------------- 版面 ----------------
  const stage = $('stage');
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  const bgCanvas = document.createElement('canvas');
  const bgx = bgCanvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, geo = null, dirty = true;
  // 版面一律用「放桌上」的座標計算；演奏模式（面向觀眾）時左右翻轉，X() 在兩種座標間互換
  const X = (x) => (settings.stage ? W - x : x);
  const geomTransform = (c) => {
    if (settings.stage) c.setTransform(-dpr, 0, 0, dpr, W * dpr, 0);
    else c.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const SHAPE_ACOUSTIC = [[0, 0], [0.02, -0.36], [0.08, -0.62], [0.17, -0.76], [0.28, -0.79], [0.39, -0.73], [0.47, -0.65], [0.55, -0.71], [0.66, -0.9], [0.78, -0.98], [0.89, -0.93], [0.97, -0.72], [1, -0.38], [1, 0], [1, 0.38], [0.97, 0.72], [0.89, 0.93], [0.78, 0.98], [0.66, 0.9], [0.55, 0.71], [0.47, 0.65], [0.39, 0.73], [0.28, 0.79], [0.17, 0.76], [0.08, 0.62], [0.02, 0.36]];
  const SHAPE_GUARD = [[0.2, -0.36], [0.33, -0.52], [0.47, -0.5], [0.58, -0.46], [0.7, -0.46], [0.76, -0.3], [0.76, 0.05], [0.84, 0.18], [0.94, 0.4], [0.88, 0.62], [0.7, 0.7], [0.5, 0.72], [0.34, 0.7], [0.22, 0.58], [0.17, 0.3], [0.17, -0.1]];
  const SHAPE_SOLID = [[0.13, 0], [0.12, -0.28], [0.06, -0.52], [0, -0.8], [0.07, -0.93], [0.2, -0.86], [0.36, -0.74], [0.47, -0.72], [0.6, -0.9], [0.76, -1], [0.9, -0.93], [0.985, -0.66], [1, -0.3], [1, 0.3], [0.985, 0.66], [0.9, 0.93], [0.76, 1], [0.6, 0.92], [0.47, 0.76], [0.34, 0.84], [0.2, 0.88], [0.1, 0.82], [0.07, 0.62], [0.12, 0.4], [0.13, 0.22]];

  function smoothPath(pts) {
    const p = new Path2D();
    const n = pts.length;
    p.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      p.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    p.closePath();
    return p;
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = stage.clientWidth;
    H = stage.clientHeight;
    if (!W || !H) return;
    for (const c of [cv, bgCanvas]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const i = inst(), look = i.look, n = nStr();
    const solid = i.body === 'solid';
    let bodyH = Math.min(H * 0.94, W * 0.6) * (look.small ? 0.8 : 1);
    let bodyL = bodyH * (solid ? 1.32 : 1.38);
    const portrait = H > W;
    const maxL = W * (portrait ? 0.97 : 0.86);
    if (bodyL > maxL) {
      const k = maxL / bodyL;
      bodyL *= k;
      bodyH *= k;
    }
    const x0 = W - bodyL - Math.max(8, W * 0.02);
    const cy = H / 2;
    const spread = Math.min(bodyH * (portrait ? 0.46 : 0.4), H * 0.56) * (n === 4 ? 0.78 : 1);
    const spacing = spread / (n - 1);
    const ys = [];
    for (let s = 0; s < n; s++) ys[s] = cy - spread / 2 + (settings.flip ? n - 1 - s : s) * spacing;
    const bridgeX = x0 + bodyL * (solid ? 0.8 : 0.76);
    const holeX = x0 + bodyL * (look.small ? 0.4 : 0.34);
    const holeR = solid ? 0 : Math.min(spread * 0.5 + spacing * 0.3, bodyH * 0.27);
    const fbEnd = solid ? x0 + bodyL * 0.33 : holeX - holeR - 4;
    const half = Math.max(50, spacing * 0.9); // 弦上下的緩衝區：從這裡開始刷不會誤觸敲琴身
    const shape = solid ? SHAPE_SOLID : SHAPE_ACOUSTIC;
    const toBody = ([u, v]) => [x0 + u * bodyL, cy + (v * bodyH) / 2];
    const body = smoothPath(shape.map(toBody));
    const guard = solid ? smoothPath(SHAPE_GUARD.map(toBody)) : null;
    geo = {
      n, x0, cy, bodyL, bodyH, spread, spacing, ys, bridgeX, holeX, holeR, fbEnd, solid, body, guard,
      top: cy - spread / 2 - half,
      bot: cy + spread / 2 + half,
      strumEnd: bridgeX - 14,
      palmX0: bridgeX - 14,
      palmX1: bridgeX + Math.max(64, spacing * 1.5),
      neckHalf: spread / 2 + spacing * 0.55,
      tapTol: spacing * 0.42,
      hyst: Math.min(10, spacing * 0.16),
    };
    for (let s = 0; s < n; s++) {
      if (amp[s] == null) amp[s] = 0;
      if (visTau[s] == null) visTau[s] = 0.4;
    }
    amp.length = visTau.length = n;
    drawStatic();
    dirty = true;
  }

  // ---------------- 靜態背景（琴身、琴頸、響孔、琴橋）----------------
  function drawStatic() {
    const c = bgx, g = geo, i = inst(), look = i.look;
    geomTransform(c); // 靜態層沒有文字，整層一起翻轉
    const bg = c.createRadialGradient(W * 0.62, H * 0.5, 0, W * 0.62, H * 0.5, Math.max(W, H) * 0.8);
    bg.addColorStop(0, '#2c2119');
    bg.addColorStop(1, '#0b0907');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    // 琴身
    c.save();
    c.shadowColor = 'rgba(0,0,0,.65)';
    c.shadowBlur = 34;
    c.shadowOffsetY = 12;
    const grad = c.createRadialGradient(g.x0 + g.bodyL * 0.62, g.cy, g.bodyH * 0.05, g.x0 + g.bodyL * 0.6, g.cy, g.bodyL * 0.62);
    grad.addColorStop(0, look.top[0]);
    grad.addColorStop(0.62, look.top[1]);
    grad.addColorStop(1, look.top[2]);
    c.fillStyle = grad;
    c.fill(g.body);
    c.restore();

    c.save();
    c.clip(g.body);
    // 木紋
    if (!g.solid) {
      c.globalAlpha = 0.07;
      c.strokeStyle = '#3a1d05';
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let y = g.cy - g.bodyH / 2; y < g.cy + g.bodyH / 2; y += 2 + rnd() * 5) {
        c.lineWidth = 0.5 + rnd() * 1.5;
        c.beginPath();
        c.moveTo(g.x0, y);
        c.bezierCurveTo(g.x0 + g.bodyL * 0.3, y + rnd() * 4 - 2, g.x0 + g.bodyL * 0.7, y + rnd() * 4 - 2, g.x0 + g.bodyL, y);
        c.stroke();
      }
      c.globalAlpha = 1;
    } else {
      const shine = c.createLinearGradient(0, g.cy - g.bodyH / 2, 0, g.cy + g.bodyH / 2);
      shine.addColorStop(0, 'rgba(255,255,255,.18)');
      shine.addColorStop(0.35, 'rgba(255,255,255,0)');
      c.fillStyle = shine;
      c.fill(g.body);
    }
    // 滾邊
    c.lineWidth = g.solid ? 8 : 14;
    c.strokeStyle = g.solid ? 'rgba(0,0,0,.35)' : 'rgba(250,235,205,.85)';
    c.stroke(g.body);
    if (!g.solid) {
      c.lineWidth = 9;
      c.strokeStyle = look.edge;
      c.stroke(g.body);
    }

    if (!g.solid) {
      // 護板
      if (look.guard) {
        c.save();
        c.translate(g.holeX + g.holeR * 0.45, g.cy + g.holeR * 0.95);
        c.rotate(-0.35);
        c.beginPath();
        c.ellipse(0, 0, g.holeR * 0.95, g.holeR * 0.6, 0, 0, Math.PI * 2);
        c.fillStyle = look.guard;
        c.globalAlpha = 0.85;
        c.fill();
        c.restore();
      }
      // 響孔與音孔花
      const rings = look.rosette ? [[16, '#2c4a2e', 6], [10, '#d9c49a', 2], [22, '#6b3a17', 2], [6, '#d9c49a', 1.5]] : [[8, '#f0e2c4', 2], [13, '#2a1608', 2.5], [18, '#f0e2c4', 1.5]];
      for (const [r, col, w] of rings) {
        c.beginPath();
        c.arc(g.holeX, g.cy, g.holeR + r, 0, Math.PI * 2);
        c.strokeStyle = col;
        c.lineWidth = w;
        if (look.rosette && r === 16) c.setLineDash([3, 2]);
        c.stroke();
        c.setLineDash([]);
      }
      const hg = c.createRadialGradient(g.holeX - g.holeR * 0.2, g.cy - g.holeR * 0.2, g.holeR * 0.1, g.holeX, g.cy, g.holeR);
      hg.addColorStop(0, '#1e1209');
      hg.addColorStop(1, '#050302');
      c.beginPath();
      c.arc(g.holeX, g.cy, g.holeR, 0, Math.PI * 2);
      c.fillStyle = hg;
      c.fill();
    } else {
      // 電吉他護板
      c.save();
      c.shadowColor = 'rgba(0,0,0,.45)';
      c.shadowBlur = 10;
      c.fillStyle = look.guard;
      c.fill(g.guard);
      c.restore();
      c.strokeStyle = 'rgba(0,0,0,.3)';
      c.lineWidth = 1.5;
      c.stroke(g.guard);
      // 旋鈕
      for (let k = 0; k < 3; k++) {
        const kx = g.x0 + g.bodyL * (0.74 + k * 0.075), ky = g.cy + g.bodyH * (0.3 + k * 0.05);
        const kg = c.createRadialGradient(kx - 4, ky - 4, 2, kx, ky, 15);
        kg.addColorStop(0, '#fff');
        kg.addColorStop(1, '#8a8a8a');
        c.beginPath();
        c.arc(kx, ky, 14, 0, Math.PI * 2);
        c.fillStyle = kg;
        c.fill();
      }
    }
    c.restore();

    // 琴頸指板（含品絲）
    const nh = g.neckHalf;
    c.save();
    c.shadowColor = 'rgba(0,0,0,.6)';
    c.shadowBlur = 14;
    const ng = c.createLinearGradient(0, g.cy - nh, 0, g.cy + nh);
    const fb = look.strings === 'nickel' && !look.bass ? ['#5b3a22', '#3a2414'] : ['#3b2416', '#1f130b'];
    ng.addColorStop(0, fb[0]);
    ng.addColorStop(1, fb[1]);
    c.fillStyle = ng;
    c.fillRect(-10, g.cy - nh, g.fbEnd + 10, nh * 2);
    c.restore();
    const scale = (g.bridgeX - (g.fbEnd - 8)) * Math.pow(2, (g.solid ? 22 : 20) / 12);
    let prevX = g.bridgeX - scale;
    for (let k = 1; k <= 24; k++) {
      const x = g.bridgeX - scale * Math.pow(2, -k / 12);
      if (x > g.fbEnd) break;
      const mid = (x + prevX) / 2;
      if (mid > 0) {
        c.fillStyle = 'rgba(240,230,210,.8)';
        const dot = (yy) => { c.beginPath(); c.arc(mid, yy, Math.min(7, g.spacing * 0.14), 0, Math.PI * 2); c.fill(); };
        if (k % 12 === 0) { dot(g.cy - g.spacing); dot(g.cy + g.spacing); }
        else if ([3, 5, 7, 9, 15, 17, 19, 21].includes(k)) dot(g.cy);
      }
      if (x > 0) {
        c.fillStyle = '#cfc8bb';
        c.fillRect(x - 1.5, g.cy - nh, 3, nh * 2);
      }
      prevX = x;
    }

    // 拾音器
    if (g.solid) {
      const pos = look.pickups === 3 ? [0.47, 0.585, 0.7] : [0.5, 0.69];
      const wide = look.pickups !== 3;
      for (const u of pos) {
        const px = g.x0 + g.bodyL * u;
        const pw = g.spacing * (wide ? 1.5 : 0.75);
        const ph = g.spread + g.spacing * 1.1;
        c.fillStyle = '#121212';
        roundRect(c, px - pw / 2, g.cy - ph / 2, pw, ph, 8);
        c.fill();
        c.strokeStyle = '#333';
        c.lineWidth = 2;
        c.stroke();
        c.fillStyle = '#bfbfbf';
        const cols = wide ? [-pw * 0.22, pw * 0.22] : [0];
        for (const cx of cols) for (const y of g.ys) { c.beginPath(); c.arc(px + cx, y, 3.2, 0, Math.PI * 2); c.fill(); }
      }
    }

    // 琴橋
    const bh = g.spread / 2 + g.spacing * 1.0;
    if (!g.solid) {
      c.save();
      c.shadowColor = 'rgba(0,0,0,.5)';
      c.shadowBlur = 8;
      c.fillStyle = look.rosette ? '#4a2a14' : '#2a170b';
      roundRect(c, g.bridgeX - 22, g.cy - bh, 62, bh * 2, 12);
      c.fill();
      c.restore();
      c.fillStyle = '#f4ead6';
      c.fillRect(g.bridgeX - 2, g.cy - g.spread / 2 - g.spacing * 0.5, 4, g.spread + g.spacing);
      for (const y of g.ys) {
        c.beginPath();
        c.arc(g.bridgeX + 18, y, 4.5, 0, Math.PI * 2);
        c.fillStyle = look.rosette ? '#d8c7a5' : '#efe6d4';
        c.fill();
      }
    } else {
      const mg = c.createLinearGradient(0, g.cy - bh, 0, g.cy + bh);
      mg.addColorStop(0, '#f2f2f2');
      mg.addColorStop(0.5, '#9b9b9b');
      mg.addColorStop(1, '#e0e0e0');
      c.fillStyle = mg;
      roundRect(c, g.bridgeX - 16, g.cy - bh, 58, bh * 2, 6);
      c.fill();
      for (const y of g.ys) {
        c.fillStyle = '#6d6d6d';
        c.fillRect(g.bridgeX - 6, y - 4, 14, 8);
      }
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---------------- 每一幀（弦、標籤、效果）----------------
  const ripples = [];
  let palmCount = 0;

  function stringStyle(s, n) {
    const look = inst().look;
    const t = n > 1 ? s / (n - 1) : 0;
    let w = (3.8 - 2.5 * t) * (look.bass ? 1.45 : 1) * (look.small ? 0.8 : 1);
    let col = '#dcdcdc';
    if (look.strings === 'bronze') col = s < n - 2 ? '#d9a066' : '#ececec';
    else if (look.strings === 'nylon') col = look.small ? '#f2ead6' : s < 3 ? '#d8d8d8' : '#efe3c4';
    return { w, col };
  }

  function draw(now) {
    const g = geo;
    if (!g) return;
    const look = inst().look;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgCanvas, 0, 0);
    geomTransform(ctx);

    // 手掌悶音區
    const pz = palmCount > 0;
    ctx.fillStyle = pz ? 'rgba(255,90,90,.25)' : 'rgba(0,0,0,.10)';
    roundRect(ctx, g.palmX0, g.top, g.palmX1 - g.palmX0, g.bot - g.top, 14);
    ctx.fill();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = pz ? 'rgba(255,120,120,.9)' : 'rgba(0,0,0,.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 文字不翻轉
    ctx.translate(X((g.palmX0 + g.palmX1) / 2 + 14), g.bot - 70);
    ctx.rotate(-Math.PI / 2);
    ctx.font = '700 13px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lw = ctx.measureText('按住＝悶音').width + 18;
    ctx.fillStyle = pz ? 'rgba(200,50,50,.9)' : 'rgba(20,14,10,.72)';
    roundRect(ctx, -lw / 2, -11, lw, 22, 11);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText('按住＝悶音', 0, 0.5);
    ctx.restore();

    // 弦
    const n = g.n;
    for (let s = 0; s < n; s++) {
      const y = g.ys[s];
      const { w, col } = stringStyle(s, n);
      const a = amp[s] || 0;
      const off = a * Math.sin(now * 0.11 + s * 1.7);
      const endX = g.solid ? g.bridgeX + 30 : g.bridgeX + 18;
      const muted = st.frets[s] < 0;
      if (a > 0.6) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.quadraticCurveTo(g.bridgeX / 2, y - a * 2, g.bridgeX, y);
        ctx.quadraticCurveTo(g.bridgeX / 2, y + a * 2, 0, y);
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      const line = (dy, lw, color) => {
        ctx.beginPath();
        ctx.moveTo(0, y + dy);
        ctx.quadraticCurveTo(g.bridgeX / 2, y + dy + off * 2, g.bridgeX, y + dy);
        ctx.lineTo(endX, y + dy);
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.stroke();
      };
      line(2.5, w, 'rgba(0,0,0,.35)');
      line(0, w, muted ? '#8d7f73' : col);
      if (look.double) line(-w - 3, Math.max(1, w * 0.55), col);
    }

    // 以下是文字與觸控效果：用螢幕座標畫（不翻轉）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 音名標籤（在琴頸那一端）
    if (settings.labels) {
      ctx.font = '700 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let s = 0; s < n; s++) {
        const f = st.frets[s];
        const y = g.ys[s];
        const txt = f < 0 ? '✕' : M.noteName(noteOf(s, f), true) + (f > 0 ? ' ·' + f : '');
        const bw = Math.max(36, ctx.measureText(txt).width + 16);
        ctx.fillStyle = f < 0 ? 'rgba(200,60,60,.92)' : f > 0 ? 'rgba(242,168,59,.95)' : 'rgba(30,24,18,.85)';
        const lx = settings.stage ? W - 10 - bw : 10;
        roundRect(ctx, lx, y - 11, bw, 22, 11);
        ctx.fill();
        ctx.fillStyle = f > 0 ? '#1b1206' : '#f3ece3';
        ctx.fillText(txt, lx + bw / 2, y + 0.5);
      }
    }

    // 和弦名稱（琴頸那一側的上方；演奏模式在右上角）
    ctx.textAlign = settings.stage ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    if (chordName) {
      ctx.font = '800 44px -apple-system, sans-serif';
      ctx.fillStyle = '#ffcf7a';
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 10;
      ctx.fillText(chordName, X(16), 52);
      ctx.shadowBlur = 0;
      ctx.font = '600 14px ui-monospace, Menlo, monospace';
      ctx.fillStyle = 'rgba(243,236,227,.6)';
      ctx.fillText(chordFretsStr + (st.capo ? `  capo ${st.capo}` : ''), X(18), 74);
    }

    // 敲擊漣漪
    for (let k = ripples.length - 1; k >= 0; k--) {
      const r = ripples[k];
      const age = (now - r.t) / 420;
      if (age >= 1) { ripples.splice(k, 1); continue; }
      ctx.beginPath();
      ctx.arc(r.x, r.y, 14 + age * 70, 0, Math.PI * 2);
      ctx.strokeStyle = r.c;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 4 * (1 - age) + 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (st.hint) {
      ctx.font = '600 15px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,.65)';
      ctx.fillText('↕ 上下滑過琴弦刷弦　• 點弦＝單音　• 點其他地方＝敲琴身　• 按住琴橋＝悶音', W / 2, H - 16);
    }
  }

  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    let anim = ripples.length > 0;
    for (let s = 0; s < amp.length; s++) {
      if (amp[s] > 0.05) {
        amp[s] *= Math.exp(-dt / visTau[s]);
        anim = true;
      } else if (amp[s]) {
        amp[s] = 0;
        anim = true;
      }
    }
    if (anim || dirty) {
      draw(now);
      dirty = false;
    }
    requestAnimationFrame(frame);
  }

  // ---------------- 觸控 ----------------
  const ptrs = new Map();
  // 觸控點 → 「放桌上」座標（考慮整頁旋轉與演奏模式的左右翻轉）
  const pos = (e) => {
    const p = UI.localPoint(cv, e);
    return { x: X(p.x), y: p.y };
  };
  const inStrum = (x, y) => x >= 0 && x <= geo.strumEnd && y >= geo.top && y <= geo.bot;
  const inPalm = (x, y) => x >= geo.palmX0 && x <= geo.palmX1 && y >= geo.top && y <= geo.bot;
  const velFromSpeed = (v) => clamp(0.22 + 0.78 * Math.pow(Math.min(1, (v * settings.sens) / 3.2), 0.65), 0.2, 1);

  function pluck(s, vel, x, delay, soft) {
    const f = st.frets[s];
    const mode = f < 0 ? 'dead' : palmCount > 0 && !soft ? 'palm' : 'normal';
    const rel = clamp((geo.strumEnd - x) / Math.max(1, geo.strumEnd - geo.fbEnd), 0, 1);
    const pick = clamp(inst().dsp.pick * (0.5 + 1.1 * rel), 0.05, 0.45);
    audio.pluck(s, freqOf(s, Math.max(0, f)), vel, pick, mode, delay);
    amp[s] = Math.max(amp[s] || 0, mode === 'dead' ? 1.5 : mode === 'palm' ? 2.5 : 3 + 7 * vel);
    visTau[s] = mode === 'normal' ? 0.45 : 0.06;
    link.send({ t: 'pl', s, v: Math.round(vel * 100) / 100 });
  }

  function knockAt(x, y, e) {
    const g = geo;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const onNeck = x < g.fbEnd && Math.abs(y - g.cy) < g.neckHalf;
    const inBody = !onNeck && ctx.isPointInPath(g.body, x * dpr, y * dpr);
    let where = inBody ? 'top' : 'side';
    // 越靠下半部琴身中心越低沉
    const dx = x - (g.x0 + g.bodyL * 0.68), dy = y - g.cy;
    const depth = clamp(1 - Math.hypot(dx, dy) / (g.bodyH * 0.6), 0, 1);
    let vel = 0.85;
    if (e.width > 1) vel = clamp(0.55 + (e.width - 20) / 80, 0.5, 1);
    audio.knock(where, depth, vel);
    ripples.push({ x: X(x), y, t: performance.now(), c: where === 'top' ? '#ffd28a' : '#9fd3ff' }); // 漣漪用螢幕座標
  }

  function hideHint() {
    if (st.hint) {
      st.hint = false;
      dirty = true;
    }
  }

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!geo) return;
    audio.resume();
    if (appEl.classList.contains('showbar')) appEl.classList.remove('showbar'); // 開始彈就收起工具列
    const { x, y } = pos(e);
    const p = { x, y, t: e.timeStamp, speed: 0, kind: 'strum', armed: new Array(geo.n).fill(true) };
    ptrs.set(e.pointerId, p);
    hideHint();
    if (inPalm(x, y)) {
      p.kind = 'palm';
      palmCount++;
      audio.damp(-1, 0.08);
      for (let s = 0; s < geo.n; s++) visTau[s] = 0.06;
      dirty = true;
      return;
    }
    if (inStrum(x, y)) {
      let best = -1, bd = Infinity;
      geo.ys.forEach((yy, s) => {
        const d = Math.abs(y - yy);
        if (d < bd) { bd = d; best = s; }
      });
      if (bd <= geo.tapTol) {
        pluck(best, clamp(0.62 * Math.pow(settings.sens, 0.3), 0.3, 0.9), x, 0);
        p.armed[best] = false;
        p.tapS = best; // 手指越過這條弦、或離開夠遠之前不再觸發，避免刷弦開頭重複彈
        p.tapSide = Math.sign(y - geo.ys[best]);
      }
      return;
    }
    // 琴弦附近的觸控可能是刷弦的起手：先等一下，往弦的方向移動就取消敲擊
    const gapY = y < geo.top ? geo.top - y : y - geo.bot;
    if (x <= geo.strumEnd && gapY < geo.spacing * 2.5) {
      p.knockDir = y < geo.top ? 1 : -1;
      p.y0 = y;
      p.downT = e.timeStamp;
      p.knockArgs = [x, y, { width: e.width }];
      p.knockT = setTimeout(() => fireKnock(p), KNOCK_HOLD_MS);
    } else {
      knockAt(x, y, e);
    }
  });

  const KNOCK_HOLD_MS = 28;
  function fireKnock(p) {
    if (!p.knockT) return;
    clearTimeout(p.knockT);
    p.knockT = 0;
    knockAt(...p.knockArgs);
  }

  cv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p || !geo) return;
    const { x, y } = pos(e);
    const t = e.timeStamp;
    if (p.kind === 'palm') return;
    if (p.knockT && (y - p.y0) * p.knockDir > 5) {
      clearTimeout(p.knockT); // 可能是刷弦：先不敲；如果最後只是手指稍微滑動的點擊，放開時再敲
      p.knockT = 0;
      p.knockDeferred = true;
    }
    const dt = Math.max(1, t - p.t);
    const dy = y - p.y;
    const v = Math.abs(dy) / dt;
    p.speed = p.speed ? p.speed * 0.4 + v * 0.6 : v;
    if (dy !== 0) {
      const hits = [];
      for (let s = 0; s < geo.n; s++) {
        const ys = geo.ys[s];
        const a = p.y - ys, b = y - ys;
        if (p.armed[s] && (a * b < 0 || (b === 0 && a !== 0))) {
          const f = a / (a - b);
          const xc = p.x + (x - p.x) * f;
          if (xc >= 0 && xc <= geo.strumEnd) hits.push({ s, f, x: xc });
        }
      }
      if (hits.length) {
        hits.sort((h1, h2) => h1.f - h2.f);
        const vel = velFromSpeed(p.speed);
        const span = Math.min(dt, 45) / 1000;
        const f0 = hits[0].f;
        for (const h of hits) {
          pluck(h.s, vel, h.x, (h.f - f0) * span);
          p.armed[h.s] = false;
        }
        p.knockDeferred = false; // 真的刷到弦了，不是敲琴身
        // 音遊模式：一次刷弦只送一個事件給手機判定。下刷 = 從粗弦往細弦（弦序翻轉時是畫面往上滑）。
        // 換方向、或同方向又刷到這一刷已經刷過的弦（手指繞回去再刷）才算新的一刷；
        // 刷得慢、中間停一下、手指稍微滑到琴橋外面再回來，都還是同一刷
        const dir = (dy > 0) !== !!settings.flip ? 'D' : 'U';
        if (p.strokeDir !== dir || hits.some((h) => p.stroke.has(h.s))) {
          link.send({ t: 'st', d: dir });
          p.stroke = new Set();
        }
        for (const h of hits) p.stroke.add(h.s);
        p.strokeDir = dir;
      }
    }
    for (let s = 0; s < geo.n; s++) {
      if (p.armed[s]) continue;
      const d = y - geo.ys[s];
      const ok = s === p.tapS
        ? Math.abs(d) > geo.tapTol || (Math.sign(d) !== p.tapSide && Math.abs(d) > Math.max(geo.hyst, geo.tapTol * 0.6)) // 已經明顯越過這條弦（手指滾動不算）
        : Math.abs(d) > geo.hyst;
      if (ok) {
        p.armed[s] = true;
        if (s === p.tapS) p.tapS = -1;
      }
    }
    p.x = x;
    p.y = y;
    p.t = t;
  });

  const up = (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    fireKnock(p); // 很快的點擊：馬上敲
    if (p.knockDeferred && e.timeStamp - p.downT < 150 && (p.y - p.y0) * p.knockDir < geo.tapTol) {
      p.knockDeferred = false;
      knockAt(...p.knockArgs); // 手指落下時稍微滑動的點擊，仍然算敲琴身
    }
    if (p.kind === 'palm') {
      palmCount = Math.max(0, palmCount - 1);
      dirty = true;
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('lostpointercapture', up);

  // ---------------- 和弦列（沒連手機時，iPad 自己也能彈）----------------
  const presetChords = () => (M.PRESETS.find((p) => p.id === st.preset) || M.PRESETS[0]).chords;

  function renderChordBar() {
    const bar = $('chordBar');
    bar.innerHTML = '';
    presetChords().forEach((name, i) => {
      const frets = M.chordFrets(name, tuning(), tuningObj().id);
      const b = document.createElement('button');
      b.className = 'pad';
      b.innerHTML = `<span class="nm">${M.parseChord(name).name}</span>${UI.chordSVG(frets)}`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        tapPad(i);
      });
      bar.appendChild(b);
    });
    const sel = document.createElement('select');
    sel.innerHTML = M.PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.value = st.preset;
    sel.addEventListener('change', () => {
      st.preset = sel.value;
      store('r.preset', st.preset);
      st.padSel = -1;
      renderChordBar();
    });
    bar.appendChild(sel);
    markPads();
  }

  function markPads() {
    [...$('chordBar').querySelectorAll('.pad')].forEach((b, i) => b.classList.toggle('on', i === st.padSel));
  }

  function tapPad(i) {
    audio.resume();
    hideHint();
    if (st.padSel === i) {
      st.padSel = -1;
      applyLeft(new Array(nStr()).fill(0), 'chord');
    } else {
      st.padSel = i;
      applyLeft(M.chordFrets(presetChords()[i], tuning(), tuningObj().id), 'chord');
    }
    markPads();
  }

  function updateChordBarVisibility() {
    const show = st.chordBar == null ? !link.connected : st.chordBar;
    const bar = $('chordBar');
    if (bar.classList.contains('hidden') === !show) return;
    bar.classList.toggle('hidden', !show);
    $('chordBtn').classList.toggle('on', show);
    layout();
  }

  // ---------------- 選單 ----------------
  function fillSelects() {
    const instSel = $('instSel');
    instSel.innerHTML = Object.entries(M.INSTRUMENTS).map(([id, i]) => `<option value="${id}">${i.name}</option>`).join('');
    instSel.value = st.inst;
    fillTunings();
    const capoSel = $('capoSel');
    capoSel.innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${i}">${i ? '移調夾 ' + i : '無移調夾'}</option>`).join('');
    capoSel.value = String(st.capo);
  }
  function fillTunings() {
    $('tuneSel').innerHTML = M.tuningsFor(st.inst).map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
    $('tuneSel').value = tuningObj().id;
  }

  function retune() {
    // 調弦或樂器改變：重新套用目前的左手狀態
    audio.damp(-1, 0.05);
    if (st.frets.length !== nStr()) {
      st.frets = new Array(nStr()).fill(0);
      st.padSel = -1;
    } else if (st.padSel >= 0) {
      st.frets = M.chordFrets(presetChords()[st.padSel], tuning(), tuningObj().id);
    }
    renderChordBar();
    layout();
    updateChord();
    sendCfg();
  }

  $('instSel').addEventListener('change', (e) => {
    st.inst = e.target.value;
    store('r.inst', st.inst);
    fillTunings();
    audio.setInstrument(st.inst);
    retune();
    UI.toast(inst().name);
  });
  $('tuneSel').addEventListener('change', (e) => {
    st.tunes[inst().family] = e.target.value;
    store('r.tunes', st.tunes);
    retune();
  });
  $('capoSel').addEventListener('change', (e) => {
    st.capo = Number(e.target.value);
    store('r.capo', st.capo);
    retune();
  });
  $('chordBtn').addEventListener('click', () => {
    const showing = !$('chordBar').classList.contains('hidden');
    st.chordBar = !showing;
    store('r.chordBar', st.chordBar);
    updateChordBarVisibility();
  });

  // QR Code
  function joinUrl() {
    const u = new URL('left.html', location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', st.room);
    const ph = new URLSearchParams(location.search).get('ph');
    if (ph) u.searchParams.set('ph', ph);
    return u.toString();
  }
  function showQR() {
    const url = joinUrl();
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('qrBox').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch (e) {
      $('qrBox').textContent = '';
    }
    $('qrUrl').textContent = url;
    $('qrCode').textContent = st.room;
    $('qrModal').classList.remove('hidden');
  }
  $('qrBtn').addEventListener('click', showQR);
  $('roomCode').addEventListener('click', showQR);

  // 設定
  const bindRange = (id, key, fn) => {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      store('r.settings', settings);
      fn && fn(settings[key]);
    });
  };
  const bindCheck = (id, key, fn) => {
    const el = $(id);
    el.checked = !!settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      store('r.settings', settings);
      fn && fn(settings[key]);
    });
  };
  bindRange('volume', 'volume', (v) => audio.setVolume(v));
  bindRange('reverb', 'reverb', (v) => audio.setReverb(v));
  bindRange('sens', 'sens');
  bindCheck('tapping', 'tapping');
  bindCheck('labels', 'labels', () => { dirty = true; });
  bindCheck('flip', 'flip', () => layout());
  bindCheck('stageMode', 'stage', () => applyStage());
  $('setBtn').addEventListener('click', () => $('setModal').classList.remove('hidden'));
  $('newRoom').addEventListener('click', () => {
    newRoom();
    UI.toast('新房號：' + st.room);
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden');
    });
  });

  // 演奏模式（面向觀眾）：畫面左右翻轉、工具列收起來
  const appEl = document.querySelector('.app');
  function applyStage() {
    appEl.classList.toggle('perform', !!settings.stage);
    appEl.classList.remove('showbar');
    $('stageMode').checked = !!settings.stage;
    layout();
    sendCfg(); // 手機跟著翻轉
  }
  $('barToggle').addEventListener('click', () => appEl.classList.toggle('showbar'));
  UI.setupFullscreenButton($('fsBtn'), () => $('a2hsModal').classList.remove('hidden'));

  // 開始（解鎖聲音 + 全螢幕）。全部都要在點擊當下同步呼叫
  function start(stage) {
    audio.primeMediaSession(); // iPadOS 16.3 以前的靜音模式
    audio.volume = settings.volume;
    audio.reverbAmt = settings.reverb;
    audio.instId = st.inst;
    const ready = audio.init(); // 建立 AudioContext 的部分會在這個點擊裡同步完成
    UI.enterFullscreen();
    settings.stage = stage;
    store('r.settings', settings);
    applyStage();
    $('start').classList.add('hidden');
    ready.then(() => {
      Net.keepAwake();
      if (!audio.ctx) return;
      audio.ctx.addEventListener('statechange', () => { if (audio.ctx.state === 'running') scheduleMetro(); });
      scheduleMetro(); // 聲音啟動前手機就開始了一首歌
    });
  }
  $('startBtn').addEventListener('click', () => start(false));
  $('startStage').addEventListener('click', () => start(true));
  $(settings.stage ? 'startBtn' : 'startStage').classList.remove('primary'); // 上次用的模式比較醒目
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') audio.resume();
  });

  // ---------------- 啟動 ----------------
  UI.forceLandscape();
  Net.lockGestures();
  fillSelects();
  renderChordBar();
  window.addEventListener('resize', () => layout());
  if (window.ResizeObserver) new ResizeObserver(() => layout()).observe(stage);
  updateChordBarVisibility();
  applyStage();
  updateChord();
  startRoom();
  requestAnimationFrame(frame);

  // 給測試 / 除錯用
  window.__right = { st, geo: () => geo, audio, link, applyLeft, settings };
})();
