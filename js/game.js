// 音遊模式：手機當音軌顯示器、自動按和弦；玩家在 iPad 上照著刷（↓ 下刷、↑ 上刷、↕ 來回刷）
(function (G) {
  'use strict';

  // ---------- 歌曲 ----------
  // 每小節：[和弦（空白分隔＝平均分配在小節裡）, 節奏]
  // 節奏每個字元是一個八分音符：D 下刷、U 上刷、R 開始來回刷、~ 繼續來回刷（可跨小節，長度不限）、- 休息
  const SONGS = [
    {
      id: 'twinkle', name: '小星星', sub: 'Twinkle Twinkle Little Star', level: 1, bpm: 92, bpb: 4,
      bars: [
        ['C', 'D-D-D-D-'], ['F C', 'D-D-D-D-'], ['F C', 'D-D-D-D-'], ['G C', 'D-D-D---'],
        ['C F', 'D-D-DUD-'], ['C G', 'D-D-DUD-'], ['C F', 'D-D-DUD-'], ['C G', 'D-D-DUD-'],
        ['C', 'D-DUD-DU'], ['F C', 'D-DUD-DU'], ['F C', 'D-DUD-DU'], ['G C', 'D-D-D---'],
      ],
    },
    {
      id: 'grace', name: '奇異恩典', sub: 'Amazing Grace（3/4 拍）', level: 2, bpm: 76, bpb: 3,
      bars: [
        ['G', 'D-D-D-'], ['G', 'D-D-D-'], ['C', 'D-D-D-'], ['G', 'D-D-D-'],
        ['G', 'D-DUDU'], ['Em', 'D-DUDU'], ['D', 'D-DUDU'], ['D', 'D-DUDU'],
        ['G', 'D-DUDU'], ['G', 'D-DUDU'], ['C', 'D-DUDU'], ['G', 'D-DUDU'],
        ['Em', 'D-DUDU'], ['D', 'D-DUDU'], ['G', 'D-D-D-'], ['G', 'R~~~~~'],
      ],
    },
    {
      id: 'canon', name: '卡農', sub: 'Canon（三輪由簡到難）', level: 3, bpm: 80, bpb: 4,
      bars: [
        ['C', 'D-D-D-D-'], ['G', 'D-D-D-D-'], ['Am', 'D-D-D-D-'], ['Em', 'D-D-D-D-'],
        ['F', 'D-D-D-D-'], ['C', 'D-D-D-D-'], ['F', 'D-D-D-D-'], ['G', 'D-D-D-D-'],
        ['C', 'D-DU-UDU'], ['G', 'D-DU-UDU'], ['Am', 'D-DU-UDU'], ['Em', 'D-DU-UDU'],
        ['F', 'D-DU-UDU'], ['C', 'D-DU-UDU'], ['F', 'D-DU-UDU'], ['G', 'D-DU-UDU'],
        ['C', 'R~~~~~~-'], ['G', 'D-DU-UDU'], ['Am', 'R~~~~~~-'], ['Em', 'D-DU-UDU'],
        ['F', 'D-DUD-DU'], ['C', 'R~~~~~~-'], ['F', 'D-DU-UDU'], ['G', 'D-DUR~~~'],
        ['C', '~~~~~~~~'], ['C', '~~~-D---'],
      ],
    },
  ];

  function parseSong(song) {
    const notes = [];
    const chords = [];
    const spb = song.bpb * 2;
    let roll = null;
    song.bars.forEach((bar, bi) => {
      const names = bar[0].trim().split(/\s+/);
      names.forEach((nm, k) => chords.push({ beat: bi * song.bpb + (k * song.bpb) / names.length, name: nm }));
      for (let i = 0; i < spb; i++) {
        const ch = bar[1][i] || '-';
        const beat = bi * song.bpb + i * 0.5;
        if (ch === '~' && roll) {
          roll.end = beat + 0.5;
          continue;
        }
        roll = null;
        if (ch === 'D' || ch === 'U') notes.push({ beat, type: ch });
        else if (ch === 'R') {
          roll = { beat, type: 'R', end: beat + 0.5 };
          notes.push(roll);
        }
      }
    });
    return { notes, chords, beats: song.bars.length * song.bpb };
  }

  // ---------- 判定 ----------
  const PERFECT = 70; // ms
  const GOOD = 140;
  const ROLL_PAD = 100;
  const COUNT_IN_BARS = 1;
  const LEAD = 400; // 開始前的準備時間（ms）
  const CHORD_EARLY = 0.25; // 提早幾拍按好和弦

  const GRADE = (acc) => (acc >= 0.95 ? 'S' : acc >= 0.85 ? 'A' : acc >= 0.7 ? 'B' : 'C');

  class RhythmGame {
    // o: { canvas, setChord(name|null), send(msg), latency(), connected(), toast(text), onState(state) }
    constructor(o) {
      this.o = o;
      this.cv = o.canvas;
      this.ctx = this.cv.getContext('2d');
      this.state = 'menu';
      this.raf = 0;
      this.W = 0;
      this.H = 0;
      this.dpr = 1;
      this.metronome = true;
      this.offset = 0; // 判定時間校正（ms，正值 = 判定往後）
    }

    resize() {
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.W = this.cv.clientWidth;
      this.H = this.cv.clientHeight;
      this.cv.width = Math.round(this.W * this.dpr);
      this.cv.height = Math.round(this.H * this.dpr);
      this.draw(performance.now());
    }

    beatMs() {
      return 60000 / this.song.bpm;
    }
    timeOf(beat) {
      return this.t0 + beat * this.beatMs();
    }

    start(song) {
      if (!this.o.connected()) {
        this.o.toast('先連上 iPad，才能在 iPad 上刷弦喔');
        return false;
      }
      this.song = song;
      const p = parseSong(song);
      this.notes = p.notes.map((n) => Object.assign({}, n, { judged: false, hits: 0 }));
      this.chords = p.chords;
      this.beats = p.beats;
      this.ci = 0;
      this.stats = { perfect: 0, good: 0, bad: 0, miss: 0, rollOk: 0, rollMiss: 0, score: 0, combo: 0, maxCombo: 0, acc: 0, count: 0 };
      this.pops = [];
      this.flash = 0;
      const countIn = COUNT_IN_BARS * song.bpb;
      const now = performance.now();
      this.t0 = now + LEAD + countIn * this.beatMs();
      this.endAt = this.timeOf(this.beats) + 800;
      this.o.send({ t: 'game', cmd: 'start', bpm: song.bpm, bpb: song.bpb, beats: this.beats, countIn, delay: this.t0 - now, click: this.metronome });
      this.o.setChord(this.chords[0].name); // 第一個和弦先按好
      this.ci = 1;
      this.setState('play');
      this.loop();
      return true;
    }

    stop() {
      if (this.state === 'play') {
        this.o.send({ t: 'game', cmd: 'stop' });
        this.o.setChord(null); // 放開自動按好的和弦
      }
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setState('menu');
      this.draw(performance.now());
    }

    setState(s) {
      this.state = s;
      this.o.onState(s);
    }

    loop() {
      cancelAnimationFrame(this.raf);
      const tick = (now) => {
        if (this.state !== 'play') return;
        this.update(now);
        this.draw(now);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }

    // 估計玩家實際刷弦的時間：收到的時間 − 網路單程延遲 − 校正
    adjNow(now) {
      return now - (this.o.latency() || 0) - this.offset;
    }

    update(now) {
      // 自動按和弦（提早一點點）
      while (this.ci < this.chords.length && this.timeOf(this.chords[this.ci].beat - CHORD_EARLY) <= now) {
        this.o.setChord(this.chords[this.ci].name);
        this.ci++;
      }
      const t = this.adjNow(now);
      for (const n of this.notes) {
        if (n.judged) continue;
        if (n.type === 'R') {
          if (t > this.timeOf(n.end) + ROLL_PAD + 50) this.finishRoll(n);
        } else if (t > this.timeOf(n.beat) + GOOD) {
          n.judged = true;
          this.judge('miss');
        }
      }
      if (now > this.endAt) this.finish();
    }

    onStrum(dir, now) {
      if (this.state !== 'play') return;
      const t = this.adjNow(now === undefined ? performance.now() : now);
      // 來回刷進行中：每一刷都算
      for (const n of this.notes) {
        if (n.type !== 'R' || n.judged) continue;
        if (t >= this.timeOf(n.beat) - ROLL_PAD && t <= this.timeOf(n.end) + ROLL_PAD) {
          n.hits++;
          this.stats.score += 30;
          this.flash = performance.now();
          return;
        }
      }
      // 找最接近的下刷 / 上刷
      let best = null;
      let bestErr = Infinity;
      for (const n of this.notes) {
        if (n.judged || n.type === 'R') continue;
        const err = t - this.timeOf(n.beat);
        if (Math.abs(err) <= GOOD && Math.abs(err) < Math.abs(bestErr)) {
          best = n;
          bestErr = err;
        }
      }
      if (!best) return; // 沒有音符的地方多刷不扣分
      best.judged = true;
      if (best.type !== dir) this.judge('bad');
      else this.judge(Math.abs(bestErr) <= PERFECT ? 'perfect' : 'good', bestErr);
    }

    finishRoll(n) {
      n.judged = true;
      const len = n.end - n.beat;
      const need = Math.max(2, Math.round(len * 1.5));
      const ratio = Math.min(1, n.hits / need);
      if (ratio >= 0.7) this.judge('roll', 0, ratio);
      else this.judge('rollmiss', 0, ratio);
    }

    judge(kind, err, ratio) {
      const s = this.stats;
      const pop = { t: performance.now(), text: '', color: '#fff' };
      switch (kind) {
        case 'perfect': s.perfect++; s.score += 300; s.combo++; s.acc += 1; pop.text = 'PERFECT'; pop.color = '#ffd34d'; break;
        case 'good': s.good++; s.score += 150; s.combo++; s.acc += 0.7; pop.text = err < 0 ? 'GOOD（早）' : 'GOOD（晚）'; pop.color = '#7ee08a'; break;
        case 'bad': s.bad++; s.score += 50; s.combo = 0; s.acc += 0.3; pop.text = '方向反了'; pop.color = '#ff9f43'; break;
        case 'miss': s.miss++; s.combo = 0; pop.text = 'MISS'; pop.color = '#ff6b6b'; break;
        case 'roll': s.rollOk++; s.combo++; s.acc += ratio; s.score += Math.round(200 * ratio); pop.text = '來回刷 ✓'; pop.color = '#c9a7ff'; break;
        case 'rollmiss': s.rollMiss++; s.combo = 0; s.acc += ratio * 0.5; pop.text = '來回刷不夠'; pop.color = '#ff6b6b'; break;
      }
      s.count++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      this.pops.push(pop);
      if (kind !== 'miss' && kind !== 'rollmiss') this.flash = performance.now();
    }

    finish() {
      // 還沒判定的都算 miss
      for (const n of this.notes) {
        if (n.judged) continue;
        if (n.type === 'R') this.finishRoll(n);
        else {
          n.judged = true;
          this.judge('miss');
        }
      }
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      const s = this.stats;
      const acc = s.count ? s.acc / s.count : 0;
      this.result = { song: this.song, acc, grade: GRADE(acc), stats: s };
      this.o.setChord(null);
      this.setState('result');
      this.draw(performance.now());
    }

    // ---------- 畫面 ----------
    draw(now) {
      const c = this.ctx, W = this.W, H = this.H;
      if (!W || !H) return;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const bg = c.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#1b1410');
      bg.addColorStop(1, '#0c0907');
      c.fillStyle = bg;
      c.fillRect(0, 0, W, H);
      if (this.state !== 'play' || !this.song) return;

      const hitX = Math.max(70, W * 0.16);
      const cy = H * 0.6;
      const laneH = Math.min(96, H * 0.3);
      const pxPerMs = Math.max(0.22, W / 2600); // 約 2.6 秒的預覽
      const X = (ms) => hitX + (ms - now) * pxPerMs;
      const beatMs = this.beatMs();

      // 軌道
      c.fillStyle = 'rgba(255,255,255,.05)';
      c.fillRect(0, cy - laneH / 2, W, laneH);
      c.strokeStyle = 'rgba(255,255,255,.12)';
      c.lineWidth = 1;
      c.strokeRect(-1, cy - laneH / 2, W + 2, laneH);

      // 拍線、小節線
      const firstBeat = Math.floor((now - this.t0 - hitX / pxPerMs) / beatMs) - 1;
      const lastBeat = Math.ceil((now - this.t0 + (W - hitX) / pxPerMs) / beatMs) + 1;
      for (let b = firstBeat; b <= lastBeat; b++) {
        const x = X(this.timeOf(b));
        const bar = ((b % this.song.bpb) + this.song.bpb) % this.song.bpb === 0;
        c.fillStyle = bar ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)';
        c.fillRect(x - (bar ? 1 : 0.5), cy - laneH / 2, bar ? 2 : 1, laneH);
      }

      // 和弦標記（軌道上方）
      c.font = '700 15px -apple-system, sans-serif';
      c.textBaseline = 'alphabetic';
      c.textAlign = 'left';
      for (const ch of this.chords) {
        const x = X(this.timeOf(ch.beat));
        if (x < -40 || x > W + 10) continue;
        c.fillStyle = 'rgba(255,207,122,.9)';
        c.fillRect(x, cy - laneH / 2 - 16, 2, 12);
        c.fillText(ch.name, x + 5, cy - laneH / 2 - 6);
      }

      // 判定線
      const pulse = 1 - Math.min(1, (now - this.flash) / 220);
      c.strokeStyle = `rgba(255,255,255,${0.55 + 0.45 * pulse})`;
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(hitX, cy - laneH / 2 - 4);
      c.lineTo(hitX, cy + laneH / 2 + 4);
      c.stroke();
      c.beginPath();
      c.arc(hitX, cy, laneH * 0.36 + pulse * 6, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255,211,77,${0.35 + 0.6 * pulse})`;
      c.lineWidth = 2;
      c.stroke();

      // 音符
      const r = Math.min(26, laneH * 0.3);
      for (const n of this.notes) {
        const xs = X(this.timeOf(n.beat));
        if (n.type === 'R') {
          const xe = X(this.timeOf(n.end));
          if (xe < -20 || xs > W + 20) continue;
          this.drawRoll(c, xs, xe, cy, r, n, now);
          continue;
        }
        if (n.judged || xs < -40 || xs > W + 40) continue;
        this.drawArrow(c, xs, cy, r, n.type);
      }

      // 判定文字
      c.textAlign = 'center';
      for (let k = this.pops.length - 1; k >= 0; k--) {
        const p = this.pops[k];
        const age = (now - p.t) / 650;
        if (age >= 1) { this.pops.splice(k, 1); continue; }
        c.globalAlpha = 1 - age;
        c.font = '800 22px -apple-system, sans-serif';
        c.fillStyle = p.color;
        c.fillText(p.text, hitX + 30, cy - laneH / 2 - 28 - age * 18);
        c.globalAlpha = 1;
      }

      // 上方資訊：現在的和弦、下一個和弦、分數、連擊
      const beatNow = (now - this.t0) / beatMs;
      let cur = this.chords[0];
      let next = null;
      for (let k = 0; k < this.chords.length; k++) {
        if (this.chords[k].beat <= beatNow + CHORD_EARLY) cur = this.chords[k];
        else { next = this.chords[k]; break; }
      }
      c.textAlign = 'left';
      c.fillStyle = '#ffcf7a';
      c.font = '800 34px -apple-system, sans-serif';
      c.fillText(cur.name, 14, 40);
      const cw = c.measureText(cur.name).width;
      if (next) {
        c.font = '600 14px -apple-system, sans-serif';
        c.fillStyle = 'rgba(243,236,227,.55)';
        c.fillText(`下一個 ${next.name}`, 24 + cw, 38);
      }
      c.textAlign = 'right';
      c.font = '800 22px ui-monospace, Menlo, monospace';
      c.fillStyle = '#f3ece3';
      c.fillText(String(this.stats.score).padStart(6, '0'), W - 14, 34);
      if (this.stats.combo > 1) {
        c.font = '700 14px -apple-system, sans-serif';
        c.fillStyle = '#ffd34d';
        c.fillText(`${this.stats.combo} 連擊`, W - 14, 54);
      }

      // 倒數
      if (now < this.t0) {
        const left = Math.ceil((this.t0 - now) / beatMs);
        c.textAlign = 'center';
        c.font = '900 64px -apple-system, sans-serif';
        c.fillStyle = 'rgba(255,255,255,.85)';
        c.fillText(String(Math.min(left, this.song.bpb)), W / 2, cy - laneH / 2 - 26);
      }

      // 進度
      const prog = Math.max(0, Math.min(1, (now - this.t0) / (this.timeOf(this.beats) - this.t0)));
      c.fillStyle = 'rgba(255,255,255,.08)';
      c.fillRect(0, H - 4, W, 4);
      c.fillStyle = '#f2a83b';
      c.fillRect(0, H - 4, W * prog, 4);
    }

    drawArrow(c, x, y, r, type) {
      const down = type === 'D';
      const g = c.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
      g.addColorStop(0, down ? '#ffd27a' : '#9fe3ff');
      g.addColorStop(1, down ? '#e0791f' : '#2a8fd6');
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = g;
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(255,255,255,.6)';
      c.stroke();
      const s = down ? 1 : -1;
      c.beginPath();
      c.moveTo(x, y - s * r * 0.55);
      c.lineTo(x, y + s * r * 0.4);
      c.moveTo(x - r * 0.38, y + s * r * 0.05);
      c.lineTo(x, y + s * r * 0.5);
      c.lineTo(x + r * 0.38, y + s * r * 0.05);
      c.strokeStyle = '#1b1206';
      c.lineWidth = 4;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.stroke();
    }

    drawRoll(c, xs, xe, y, r, n, now) {
      const h = r * 1.6;
      const x0 = Math.max(xs, -20);
      const x1 = Math.min(xe, this.W + 20);
      const active = !n.judged && now >= this.timeOf(n.beat) - ROLL_PAD && now <= this.timeOf(n.end) + ROLL_PAD;
      const g = c.createLinearGradient(0, y - h / 2, 0, y + h / 2);
      g.addColorStop(0, active ? '#d7b8ff' : '#b48cff');
      g.addColorStop(1, active ? '#8a4dff' : '#6a35d9');
      c.beginPath();
      const rr = h / 2;
      c.moveTo(x0 + rr, y - h / 2);
      c.arcTo(x1, y - h / 2, x1, y + h / 2, rr);
      c.arcTo(x1, y + h / 2, x0, y + h / 2, rr);
      c.arcTo(x0, y + h / 2, x0, y - h / 2, rr);
      c.arcTo(x0, y - h / 2, x1, y - h / 2, rr);
      c.closePath();
      c.globalAlpha = n.judged ? 0.35 : 1;
      c.fillStyle = g;
      c.fill();
      // 鋸齒 = 來回刷
      c.beginPath();
      const step = 12;
      let up = true;
      for (let x = x0 + rr * 0.6; x <= x1 - rr * 0.6; x += step) {
        const yy = y + (up ? -h * 0.28 : h * 0.28);
        if (x === x0 + rr * 0.6) c.moveTo(x, yy);
        else c.lineTo(x, yy);
        up = !up;
      }
      c.strokeStyle = 'rgba(27,18,6,.75)';
      c.lineWidth = 3;
      c.stroke();
      if (x1 - x0 > 90) {
        c.font = '800 13px -apple-system, sans-serif';
        c.textAlign = 'left';
        c.fillStyle = '#fff';
        c.fillText(`↕ 來回刷${active && n.hits ? ' ×' + n.hits : ''}`, Math.max(x0 + 10, 8), y - h / 2 - 6);
      }
      c.globalAlpha = 1;
    }
  }

  G.RhythmGame = RhythmGame;
  G.RhythmSongs = SONGS;
  G.parseRhythmSong = parseSong;
})(window);
