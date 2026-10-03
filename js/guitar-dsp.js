// 吉他弦物理模擬（擴充版 Karplus-Strong）
// 同一份程式可載入 AudioWorklet（registerProcessor），或在主執行緒當備援（window.GuitarDSP）
(function () {
  'use strict';

  const SIZE = 4096; // 延遲線長度：48kHz 下最低約 12Hz
  const MASK = SIZE - 1;
  const DETUNE_12 = 1.0018; // 12 弦吉他副弦微走音，產生合唱感

  class StringVoice {
    constructor(sr) {
      this.sr = sr;
      this.buf = new Float32Array(SIZE);
      this.w = 0;
      this.delay = 200;
      this.target = 200;
      this.glide = 0;
      this.S = 0.5;
      this.g = 0.99;
      this.prev = 0;
      this.damp = 1;
      this.dampTarget = 1;
      this.freq = 110;
      this.gain = 1;
      this.active = false;
      this.quiet = 0;
      this.click = 0;
      this.clickN = 0;
      this.clickLen = 1;
      this.clickPrev = 0;
    }

    // 迴路總延遲 = 延遲線 + 兩點濾波器的 S 個取樣
    setFreq(freq, glideMs) {
      this.freq = freq;
      const d = Math.min(SIZE - 4, Math.max(2, this.sr / freq - this.S));
      this.target = d;
      if (!this.active || !glideMs) {
        this.delay = d;
        this.glide = 0;
      } else {
        this.glide = 1 - Math.exp(-1 / (glideMs * 0.001 * this.sr));
      }
    }

    // 在 seconds 秒內衰減 60dB（悶音、換和弦、手掌制音）
    dampOut(seconds) {
      if (!this.active) return;
      this.dampTarget = Math.pow(10, -3 / (Math.max(0.005, seconds) * this.freq));
    }

    pluck(freq, vel, o, e) {
      const sr = this.sr;
      let t60 = o.t60;
      let S = o.S;
      let exc = o.exc;
      if (o.mode === 'palm') {
        t60 = Math.min(t60, 0.16 + 0.14 * vel);
        exc *= 0.42;
        S = Math.max(S, 0.5);
      } else if (o.mode === 'dead') {
        t60 = 0.03;
        exc *= 0.55;
        S = 0.5;
      }
      const wasActive = this.active;
      this.active = false; // 讓 setFreq 直接跳到新音高
      this.S = S;
      this.setFreq(freq, 0);
      this.g = Math.pow(10, -3 / (t60 * freq));
      this.damp = 1;
      this.dampTarget = 1;

      const P = Math.max(4, Math.min(SIZE - 8, Math.round(sr / freq)));
      const k = Math.max(1, Math.min(P - 1, Math.round(o.pick * P)));

      // 激發訊號：低通雜訊（越用力越亮）經撥弦位置梳狀濾波 + 撥弦三角形位移
      const a = Math.min(0.98, exc * (0.55 + 0.6 * vel));
      let lp = 0;
      let lp2 = 0;
      for (let i = 0; i < P; i++) {
        lp += a * (Math.random() * 2 - 1 - lp);
        lp2 += a * (lp - lp2);
        e[i] = lp2;
      }
      for (let i = P - 1; i >= k; i--) e[i] -= e[i - k];
      let peak = 1e-9;
      for (let i = 0; i < P; i++) peak = Math.max(peak, Math.abs(e[i]));
      const noiseAmt = (0.25 + 0.6 * exc) / peak;
      const triAmt = 1 - 0.5 * exc;
      let mean = 0;
      for (let i = 0; i < P; i++) {
        const tri = i < k ? i / k : (P - i) / (P - k);
        e[i] = e[i] * noiseAmt + tri * triAmt;
        mean += e[i];
      }
      mean /= P;
      peak = 1e-9;
      for (let i = 0; i < P; i++) {
        e[i] -= mean;
        peak = Math.max(peak, Math.abs(e[i]));
      }
      const amp = (0.38 * vel) / peak;
      const keep = wasActive ? 0.3 : 0;
      const start = this.w - P;
      const buf = this.buf;
      for (let i = 0; i < P; i++) {
        const j = (start + i) & MASK;
        buf[j] = buf[j] * keep + e[i] * amp;
      }
      this.prev = 0;
      this.click = o.click * vel;
      this.clickLen = Math.max(1, Math.round(0.004 * sr));
      this.clickN = this.click > 0 ? this.clickLen : 0;
      this.active = true;
      this.quiet = 0;
    }

    render(out, n) {
      if (this.damp !== this.dampTarget) {
        this.damp += (this.dampTarget - this.damp) * 0.35;
        if (Math.abs(this.damp - this.dampTarget) < 1e-4) this.damp = this.dampTarget;
      }
      const buf = this.buf;
      const tgt = this.target;
      const gl = this.glide;
      const S = this.S;
      const A = 1 - S;
      const g = this.g * this.damp;
      const gain = this.gain;
      let w = this.w;
      let prev = this.prev;
      let D = this.delay;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        if (gl) D += (tgt - D) * gl;
        let rp = w - D;
        if (rp < 0) rp += SIZE;
        const i0 = rp | 0;
        const a0 = buf[i0];
        const y = a0 + (buf[(i0 + 1) & MASK] - a0) * (rp - i0);
        const v = g * (A * y + S * prev);
        prev = y;
        buf[w] = v;
        w = (w + 1) & MASK;
        let s = v;
        if (this.clickN > 0) {
          const env = this.clickN / this.clickLen;
          const x = Math.random() * 2 - 1;
          s += (x - this.clickPrev) * this.click * env * env;
          this.clickPrev = x;
          this.clickN--;
        }
        out[i] += s * gain;
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
      }
      this.w = w;
      this.prev = prev;
      this.delay = D;
      if (gl && Math.abs(D - tgt) < 1e-3) {
        this.delay = tgt;
        this.glide = 0;
      }
      if (peak < 2e-5) {
        if (++this.quiet > 30) {
          this.active = false;
          buf.fill(0);
          this.quiet = 0;
        }
      } else this.quiet = 0;
    }
  }

  class GuitarDSP {
    constructor(sr) {
      this.sr = sr;
      this.frame = 0;
      this.voices = [];
      for (let i = 0; i < 16; i++) this.voices.push(new StringVoice(sr)); // 每弦 2 個（12 弦用）
      this.scratch = new Float32Array(SIZE);
      this.queue = [];
      this.p = { t60: [6, 2.5], S: 0.4, exc: 0.6, pick: 0.15, click: 0.08, level: 1 };
      this.twelve = false;
      this.octave = [];
    }

    // 低音弦餘音長、高音弦短（以 82Hz~660Hz 對數內插）
    t60For(freq) {
      const lo = this.p.t60[0];
      const hi = this.p.t60[1];
      const x = Math.min(1, Math.max(0, Math.log2(freq / 82) / 3));
      return lo * Math.pow(hi / lo, x);
    }

    msg(m) {
      if (m.delay > 0) this.queue.push({ at: this.frame + Math.round(m.delay * this.sr), m });
      else this.exec(m);
    }

    each(s, fn) {
      if (s == null || s < 0) {
        for (let i = 0; i < this.voices.length; i++) fn(this.voices[i], i & 1);
      } else {
        fn(this.voices[s * 2], 0);
        fn(this.voices[s * 2 + 1], 1);
      }
    }

    exec(m) {
      switch (m.type) {
        case 'config':
          this.p = Object.assign({}, this.p, m.params || {});
          this.twelve = !!m.twelve;
          this.octave = m.octave || [];
          break;
        case 'pluck': {
          const o = {
            t60: this.t60For(m.freq),
            S: this.p.S,
            exc: this.p.exc,
            pick: m.pick != null ? m.pick : this.p.pick,
            click: this.p.click,
            mode: m.mode,
          };
          const v = this.voices[m.s * 2];
          v.gain = this.p.level;
          v.pluck(m.freq, m.vel, o, this.scratch);
          if (this.twelve) {
            const oct = !!this.octave[m.s];
            this.queue.push({
              at: this.frame + Math.round(0.006 * this.sr),
              m: { type: 'pluck2', s: m.s, freq: m.freq * (oct ? 2 : 1) * DETUNE_12, vel: m.vel * (oct ? 0.6 : 0.8), o },
            });
          }
          break;
        }
        case 'pluck2': {
          const v = this.voices[m.s * 2 + 1];
          v.gain = this.p.level;
          v.pluck(m.freq, m.vel, Object.assign({}, m.o, { t60: this.t60For(m.freq) }), this.scratch);
          break;
        }
        case 'freq':
          this.each(m.s, (v, second) => {
            if (!second) v.setFreq(m.freq, m.glide);
            else if (this.twelve) v.setFreq(m.freq * (this.octave[m.s] ? 2 : 1) * DETUNE_12, m.glide);
          });
          break;
        case 'damp':
          this.each(m.s, (v) => v.dampOut(m.time));
          break;
      }
    }

    render(out) {
      const n = out.length;
      const end = this.frame + n;
      if (this.queue.length) {
        for (let i = 0; i < this.queue.length; ) {
          if (this.queue[i].at < end) {
            const q = this.queue[i];
            this.queue.splice(i, 1);
            this.exec(q.m);
          } else i++;
        }
      }
      out.fill(0);
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v.active) v.render(out, n);
      }
      this.frame = end;
    }
  }

  if (typeof registerProcessor === 'function') {
    class GuitarProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.dsp = new GuitarDSP(sampleRate);
        this.port.onmessage = (e) => {
          const d = e.data;
          if (Array.isArray(d)) for (let i = 0; i < d.length; i++) this.dsp.msg(d[i]);
          else this.dsp.msg(d);
        };
      }
      process(inputs, outputs) {
        const out = outputs[0];
        this.dsp.render(out[0]);
        for (let c = 1; c < out.length; c++) out[c].set(out[0]);
        return true;
      }
    }
    registerProcessor('guitar-dsp', GuitarProcessor);
  } else {
    (typeof window !== 'undefined' ? window : globalThis).GuitarDSP = GuitarDSP;
  }
})();
