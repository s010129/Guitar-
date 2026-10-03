// 樂理與樂器設定：音名、調弦、樂器音色參數、和弦指型、和弦辨識
(function (G) {
  'use strict';

  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const ALIAS = { Db: 'C#', 'D#': 'Eb', Gb: 'F#', 'G#': 'Ab', 'A#': 'Bb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };

  const pc = (m) => ((m % 12) + 12) % 12;
  const noteName = (m, oct) => NAMES[pc(m)] + (oct ? Math.floor(m / 12) - 1 : '');
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ---------- 樂器 ----------
  // dsp: t60 = [低音弦, 高音弦] 的餘音秒數；S = 弦迴路阻尼（越小越亮）；
  //      exc = 撥弦激發亮度；pick = 預設撥弦位置；click = 撥片聲；level = 音量
  const INSTRUMENTS = {
    acoustic: {
      name: '木吉他（鋼弦）', family: 'guitar', body: 'acoustic', chain: 'acoustic',
      dsp: { t60: [7, 2.6], S: 0.36, exc: 0.62, pick: 0.15, click: 0.10, level: 1.0 },
      reverb: 0.18, knock: 'hollow',
      look: { top: ['#e9b872', '#c8853f', '#8a4f1e'], edge: '#3a2210', guard: '#2a160a', hole: true, strings: 'bronze' },
    },
    twelve: {
      name: '12 弦吉他', family: 'guitar', body: 'acoustic', chain: 'acoustic', twelve: true,
      dsp: { t60: [7, 2.8], S: 0.36, exc: 0.62, pick: 0.15, click: 0.10, level: 0.8 },
      reverb: 0.2, knock: 'hollow',
      look: { top: ['#f1d3a1', '#d9a560', '#9c6327'], edge: '#40240f', guard: '#3a1f0c', hole: true, strings: 'bronze', double: true },
    },
    nylon: {
      name: '古典吉他（尼龍弦）', family: 'guitar', body: 'acoustic', chain: 'nylon',
      dsp: { t60: [5, 1.9], S: 0.5, exc: 0.32, pick: 0.22, click: 0.0, level: 1.15 },
      reverb: 0.22, knock: 'hollow',
      look: { top: ['#f3d9a4', '#dcb06a', '#a8763a'], edge: '#5a2e12', guard: null, hole: true, rosette: true, strings: 'nylon' },
    },
    electric: {
      name: '電吉他（Clean）', family: 'guitar', body: 'solid', chain: 'clean',
      dsp: { t60: [9, 4], S: 0.3, exc: 0.66, pick: 0.11, click: 0.06, level: 0.95 },
      reverb: 0.26, knock: 'solid',
      look: { top: ['#5aa7ff', '#1f5fbf', '#0d2b66'], edge: '#0a1a3a', guard: '#f4f1ea', pickups: 3, strings: 'nickel' },
    },
    crunch: {
      name: '電吉他（Crunch 輕破音）', family: 'guitar', body: 'solid', chain: 'crunch',
      dsp: { t60: [10, 5], S: 0.3, exc: 0.66, pick: 0.11, click: 0.05, level: 0.9 },
      reverb: 0.16, knock: 'solid',
      look: { top: ['#ffcf6b', '#e0812a', '#7a2d0a'], edge: '#2a0f04', guard: '#1b1b1b', pickups: 2, strings: 'nickel' },
    },
    distortion: {
      name: '電吉他（重破音）', family: 'guitar', body: 'solid', chain: 'dist',
      dsp: { t60: [13, 7], S: 0.3, exc: 0.72, pick: 0.1, click: 0.05, level: 0.85 },
      reverb: 0.12, knock: 'solid',
      look: { top: ['#3a3a3a', '#1a1a1a', '#050505'], edge: '#000', guard: '#7a0d0d', pickups: 2, strings: 'nickel' },
    },
    bass: {
      name: '電貝斯', family: 'bass', body: 'solid', chain: 'bass',
      dsp: { t60: [8, 4], S: 0.45, exc: 0.38, pick: 0.2, click: 0.02, level: 1.2 },
      reverb: 0.05, knock: 'solid',
      look: { top: ['#d9534f', '#a3201c', '#4a0907'], edge: '#200302', guard: '#111', pickups: 2, strings: 'nickel', bass: true },
    },
    ukulele: {
      name: '烏克麗麗', family: 'ukulele', body: 'acoustic', chain: 'uke',
      dsp: { t60: [2.6, 1.4], S: 0.48, exc: 0.42, pick: 0.25, click: 0.0, level: 1.1 },
      reverb: 0.2, knock: 'hollow',
      look: { top: ['#f6c48a', '#d98b3e', '#8f4a17'], edge: '#4a230b', guard: null, hole: true, strings: 'nylon', small: true },
    },
  };

  // ---------- 調弦 ----------
  const TUNINGS = {
    guitar: [
      { id: 'std', name: '標準 EADGBE', notes: [40, 45, 50, 55, 59, 64] },
      { id: 'dropd', name: 'Drop D', notes: [38, 45, 50, 55, 59, 64] },
      { id: 'halfdown', name: '降半音 Eb', notes: [39, 44, 49, 54, 58, 63] },
      { id: 'openg', name: 'Open G', notes: [38, 43, 50, 55, 59, 62] },
      { id: 'opend', name: 'Open D', notes: [38, 45, 50, 54, 57, 62] },
      { id: 'dadgad', name: 'DADGAD', notes: [38, 45, 50, 55, 57, 62] },
    ],
    bass: [
      { id: 'bstd', name: '標準 EADG', notes: [28, 33, 38, 43] },
      { id: 'bdropd', name: 'Drop D', notes: [26, 33, 38, 43] },
    ],
    ukulele: [
      { id: 'ustd', name: '標準 GCEA', notes: [67, 60, 64, 69] },
      { id: 'ulowg', name: 'Low G', notes: [55, 60, 64, 69] },
    ],
  };
  // 12 弦吉他：低音 4 組為八度弦，高音 2 組為同音弦
  const TWELVE_OCTAVE = [true, true, true, true, false, false];

  // ---------- 和弦 ----------
  const CHORD_TYPES = [
    { id: '', label: '大三', iv: [0, 4, 7] },
    { id: 'm', label: '小三', iv: [0, 3, 7] },
    { id: '7', label: '屬七', iv: [0, 4, 7, 10] },
    { id: 'maj7', label: '大七', iv: [0, 4, 7, 11] },
    { id: 'm7', label: '小七', iv: [0, 3, 7, 10] },
    { id: 'sus4', label: '掛四', iv: [0, 5, 7] },
    { id: 'sus2', label: '掛二', iv: [0, 2, 7] },
    { id: 'add9', label: '加九', iv: [0, 2, 4, 7] },
    { id: '6', label: '六', iv: [0, 4, 7, 9] },
    { id: 'dim', label: '減', iv: [0, 3, 6] },
    { id: 'aug', label: '增', iv: [0, 4, 8] },
    { id: '5', label: '強力', iv: [0, 7] },
  ];
  // 辨識用的額外和弦
  const DETECT_TYPES = CHORD_TYPES.concat([
    { id: 'm6', iv: [0, 3, 7, 9] },
    { id: 'dim7', iv: [0, 3, 6, 9] },
    { id: 'm7b5', iv: [0, 3, 6, 10] },
    { id: '9', iv: [0, 2, 4, 7, 10] },
    { id: '7sus4', iv: [0, 5, 7, 10] },
    { id: 'madd9', iv: [0, 2, 3, 7] },
    { id: 'maj9', iv: [0, 2, 4, 7, 11] },
    { id: 'm9', iv: [0, 2, 3, 7, 10] },
  ]);

  // 常用指型（標準調弦），x = 不彈
  const SHAPES = {
    std: {
      C: 'x32010', 'C#': 'x46664', D: 'xx0232', Eb: 'x68886', E: '022100', F: '133211', 'F#': '244322', G: '320003', Ab: '466544', A: 'x02220', Bb: 'x13331', B: 'x24442',
      Cm: 'x35543', 'C#m': 'x46654', Dm: 'xx0231', Ebm: 'x68876', Em: '022000', Fm: '133111', 'F#m': '244222', Gm: '355333', Abm: '466444', Am: 'x02210', Bbm: 'x13321', Bm: 'x24432',
      C7: 'x32310', 'C#7': 'x46464', D7: 'xx0212', Eb7: 'x68686', E7: '020100', F7: '131211', 'F#7': '242322', G7: '320001', Ab7: '464544', A7: 'x02020', Bb7: 'x13131', B7: 'x21202',
      Cmaj7: 'x32000', Dmaj7: 'xx0222', Emaj7: '021100', Fmaj7: 'xx3210', Gmaj7: '320002', Amaj7: 'x02120',
      Cm7: 'x35343', Dm7: 'xx0211', Em7: '020000', Fm7: '131111', 'F#m7': '242222', Gm7: '353333', Am7: 'x02010', Bm7: 'x20202',
      Dsus4: 'xx0233', Esus4: '022200', Asus4: 'x02230', Dsus2: 'xx0230', Asus2: 'x02200', Cadd9: 'x32030',
      E5: '022xxx', F5: '133xxx', 'F#5': '244xxx', G5: '355xxx', Ab5: '466xxx', A5: 'x022xx', Bb5: 'x133xx', B5: 'x244xx', C5: 'x355xx', 'C#5': 'x466xx', D5: 'xx023x', Eb5: 'x688xx',
    },
    uke: {
      C: '0003', 'C#': '1114', D: '2220', Eb: '0331', E: '4442', F: '2010', 'F#': '3121', G: '0232', Ab: '5343', A: '2100', Bb: '3211', B: '4322',
      Cm: '0333', 'C#m': '1104', Dm: '2210', Ebm: '3321', Em: '0432', Fm: '1013', 'F#m': '2120', Gm: '0231', Abm: '4342', Am: '2000', Bbm: '3111', Bm: '4222',
      C7: '0001', D7: '2223', E7: '1202', F7: '2313', G7: '0212', A7: '0100', Bb7: '1211', B7: '2322',
      Cmaj7: '0002', Gmaj7: '0222', Am7: '0000', Dm7: '2213', Em7: '0202',
    },
  };
  const SHAPE_TABLE_FOR = { std: 'std', ustd: 'uke', ulowg: 'uke' };

  const PRESETS = [
    { id: 'C', name: 'C 大調', chords: ['C', 'G', 'Am', 'F', 'Dm', 'Em', 'G7', 'E7'] },
    { id: 'G', name: 'G 大調', chords: ['G', 'D', 'Em', 'C', 'Am', 'Bm', 'D7', 'B7'] },
    { id: 'D', name: 'D 大調', chords: ['D', 'A', 'Bm', 'G', 'Em', 'F#m', 'A7', 'D7'] },
    { id: 'A', name: 'A 大調', chords: ['A', 'E', 'F#m', 'D', 'Bm', 'C#m', 'E7', 'A7'] },
    { id: 'E', name: 'E 大調', chords: ['E', 'B', 'C#m', 'A', 'F#m', 'G#m', 'B7', 'E7'] },
    { id: 'F', name: 'F 大調', chords: ['F', 'C', 'Dm', 'Bb', 'Gm', 'Am', 'C7', 'A7'] },
    { id: 'Am', name: 'A 小調', chords: ['Am', 'Dm', 'Em', 'F', 'G', 'C', 'E', 'E7'] },
    { id: 'Em', name: 'E 小調', chords: ['Em', 'Am', 'Bm', 'C', 'D', 'G', 'B7', 'D7'] },
    { id: 'pop', name: '流行卡農 C', chords: ['C', 'G', 'Am', 'Em', 'F', 'C', 'F', 'G'] },
    { id: 'rock', name: '搖滾強力和弦', chords: ['E5', 'G5', 'A5', 'C5', 'D5', 'B5', 'F#5', 'F5'] },
    { id: 'jazz', name: '七和弦', chords: ['Cmaj7', 'Am7', 'Dm7', 'G7', 'Fmaj7', 'Em7', 'A7', 'D7'] },
  ];

  function parseChord(name) {
    const m = /^([A-G])([#b]?)(.*)$/.exec(String(name).trim());
    if (!m) return null;
    let root = m[1] + m[2];
    if (ALIAS[root]) root = ALIAS[root];
    const rootPc = NAMES.indexOf(root);
    const type = CHORD_TYPES.find((t) => t.id === m[3]) || DETECT_TYPES.find((t) => t.id === m[3]);
    if (rootPc < 0 || !type) return null;
    return { root: rootPc, type, name: NAMES[rootPc] + type.id };
  }

  function shapeToFrets(s) {
    return s.split('').map((c) => (c === 'x' ? -1 : parseInt(c, 36)));
  }

  // 依調弦自動找出好按的和弦指型
  function generateVoicing(tuning, rootPc, iv) {
    const n = tuning.length;
    const tones = iv.map((i) => (rootPc + i) % 12);
    const toneSet = new Set(tones);
    const isPower = iv.length === 2;
    const reentrant = tuning.some((m, i) => i > 0 && m < tuning[i - 1]);
    const hasThird = iv.includes(3) || iv.includes(4);
    const fifthPc = iv.includes(7) ? (rootPc + 7) % 12 : -1;
    const minSounding = isPower ? 2 : Math.min(n, n >= 6 ? 4 : 3);
    let best = null;
    let bestScore = -Infinity;
    const cur = new Array(n);

    function score() {
      let first = -1, last = -1;
      for (let i = 0; i < n; i++) if (cur[i] >= 0) { if (first < 0) first = i; last = i; }
      if (first < 0) return -Infinity;
      for (let i = first; i <= last; i++) if (cur[i] < 0) return -Infinity; // 中間不能悶
      const sounding = last - first + 1;
      if (sounding < minSounding) return -Infinity;
      const bassMutes = first, trebleMutes = n - 1 - last;
      if (bassMutes > (n >= 6 ? 2 : 1) && !isPower) return -Infinity;
      if (trebleMutes > 0 && !isPower) return -Infinity;
      let lowest = Infinity, minF = Infinity, maxF = -Infinity, fretted = 0, opens = 0;
      const present = new Set();
      for (let i = first; i <= last; i++) {
        const note = tuning[i] + cur[i];
        if (note < lowest) lowest = note;
        present.add(pc(note));
        if (cur[i] > 0) { fretted++; if (cur[i] < minF) minF = cur[i]; if (cur[i] > maxF) maxF = cur[i]; }
        else opens++;
      }
      const span = fretted ? maxF - minF : 0;
      if (span > 3) return -Infinity;
      let barre = false;
      if (fretted > 4) {
        let atMin = 0, firstBarre = -1;
        for (let i = first; i <= last; i++) if (cur[i] === minF) { atMin++; if (firstBarre < 0) firstBarre = i; }
        if (atMin < 2 || fretted - atMin + 1 > 4) return -Infinity;
        for (let i = firstBarre; i <= last; i++) if (cur[i] < minF) return -Infinity;
        barre = true;
      }
      let s = 0;
      if (isPower) s += Math.min(sounding, 3) * 10 - Math.max(0, sounding - 3) * 12;
      else s += sounding * 6;
      for (const t of toneSet) {
        if (present.has(t)) continue;
        if (t === fifthPc) s -= 15;
        else if (hasThird && (t === (rootPc + 3) % 12 || t === (rootPc + 4) % 12)) s -= 80;
        else s -= 40;
      }
      if (!reentrant) s += pc(lowest) === rootPc ? 60 : -60;
      else if (present.has(rootPc)) s += 10;
      if (fretted) {
        s -= 3 * minF + 8 * span + 2 * fretted;
        if (minF >= 5) s -= 6 * opens;
        else s += 4 * opens;
      } else s += 4 * opens;
      if (barre) s -= 8;
      s -= 3 * bassMutes + 12 * trebleMutes;
      return s;
    }

    for (let p = 0; p <= 9; p++) {
      const cands = tuning.map((open) => {
        const c = [-1];
        if (toneSet.has(pc(open))) c.push(0);
        for (let f = Math.max(1, p); f <= p + 3; f++) if (toneSet.has(pc(open + f))) c.push(f);
        return c;
      });
      (function rec(i) {
        if (i === n) {
          const s = score();
          if (s > bestScore) { bestScore = s; best = cur.slice(); }
          return;
        }
        for (const f of cands[i]) { cur[i] = f; rec(i + 1); }
      })(0);
    }
    return best || new Array(n).fill(0);
  }

  const voicingCache = new Map();
  function chordFrets(name, tuning, tuningId) {
    const key = name + '|' + tuning.join(',');
    if (voicingCache.has(key)) return voicingCache.get(key).slice();
    const ch = parseChord(name);
    let frets;
    if (!ch) frets = new Array(tuning.length).fill(0);
    else {
      const table = SHAPES[SHAPE_TABLE_FOR[tuningId]];
      if (table && table[ch.name] && table[ch.name].length === tuning.length) frets = shapeToFrets(table[ch.name]);
      else frets = generateVoicing(tuning, ch.root, ch.type.iv);
    }
    voicingCache.set(key, frets);
    return frets.slice();
  }

  function fretsToString(frets) {
    return frets.map((f) => (f < 0 ? 'x' : f > 9 ? '(' + f + ')' : String(f))).join('');
  }

  // 由實際發聲的音判斷和弦名稱；reentrant（烏克麗麗等）時最低音不一定是根音，不加低音權重也不寫分數和弦
  function detectChord(notes, reentrant) {
    if (!notes.length) return '';
    let bassNote = Infinity;
    for (const n of notes) if (n < bassNote) bassNote = n;
    const bass = pc(bassNote);
    const pcs = [...new Set(notes.map(pc))];
    if (pcs.length === 1) return NAMES[pcs[0]];
    let best = null;
    const consider = (root, id, rank) => {
      const sc = (!reentrant && root === bass ? 10 : 0) - rank;
      if (!best || sc > best.sc) best = { root, id, sc };
    };
    for (const root of pcs) {
      const rel = new Set(pcs.map((p) => (p - root + 12) % 12));
      DETECT_TYPES.forEach((t, rank) => {
        const r = rank * 0.1;
        if (t.iv.length === rel.size && t.iv.every((i) => rel.has(i))) consider(root, t.id, r);
        else if (t.iv.includes(7) && t.iv.length - 1 === rel.size && t.iv.length >= 4 && t.iv.every((i) => i === 7 || rel.has(i))) consider(root, t.id, r + 12); // 省略五度的和弦排在完整和弦之後
      });
    }
    if (!best) return '';
    return NAMES[best.root] + best.id + (!reentrant && best.root !== bass ? '/' + NAMES[bass] : '');
  }

  function tuningsFor(instId) {
    return TUNINGS[INSTRUMENTS[instId].family];
  }

  G.Music = {
    NAMES, pc, noteName, midiToFreq,
    INSTRUMENTS, TUNINGS, TWELVE_OCTAVE, CHORD_TYPES, PRESETS,
    parseChord, chordFrets, fretsToString, detectChord, generateVoicing, tuningsFor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
