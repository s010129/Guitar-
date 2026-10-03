// 音訊引擎：弦模擬節點 + 各樂器音色鏈（琴身共鳴 / 音箱破音）+ 殘響 + 敲琴身聲
(function (G) {
  'use strict';

  function makeNoise(ctx, seconds) {
    const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  // 木頭琴身脈衝響應：數個衰減的共振模態 + 短雜訊
  function makeBodyIR(ctx, modes, len) {
    const sr = ctx.sampleRate;
    const n = Math.round(sr * len);
    const b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (const [f, decay, amp] of modes) {
        const ph = Math.random() * Math.PI * 2;
        const f2 = f * (1 + (c ? 0.01 : -0.01));
        for (let i = 0; i < n; i++) d[i] += amp * Math.sin((2 * Math.PI * f2 * i) / sr + ph) * Math.exp(-i / (decay * sr));
      }
      for (let i = 0; i < Math.min(n, sr * 0.012); i++) d[i] += (Math.random() * 2 - 1) * 0.5 * (1 - i / (sr * 0.012));
      d[0] += 1.5;
      let e = 0;
      for (let i = 0; i < n; i++) e += d[i] * d[i];
      const k = 1 / Math.sqrt(e);
      for (let i = 0; i < n; i++) d[i] *= k;
    }
    return b;
  }

  function makeRoomIR(ctx, seconds) {
    const sr = ctx.sampleRate;
    const n = Math.round(sr * seconds);
    const b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += (0.25 + 0.5 * (1 - t)) * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.pow(1 - t, 3.2) * (i < sr * 0.008 ? i / (sr * 0.008) : 1);
      }
    }
    return b;
  }

  function shaperCurve(k) {
    const n = 2048;
    const c = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / norm;
    }
    return c;
  }

  class GuitarAudio {
    constructor() {
      this.ctx = null;
      this.ready = false;
      this.instId = 'acoustic';
      this.chains = {};
      this.volume = 0.8;
      this.reverbAmt = 1;
    }

    // 必須在使用者手勢（點擊）中呼叫，iOS 才會出聲
    async init() {
      if (this.ctx) {
        this.resume();
        return;
      }
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iOS 17+：靜音模式也出聲
      } catch (e) { /* 不支援就略過 */ }
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.resume();
      // 舊版 iOS 解鎖：播放一段無聲
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);

      this.noise = makeNoise(ctx, 1);
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 8;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master.connect(comp).connect(ctx.destination);

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeRoomIR(ctx, 1.8);
      this.reverbSend = ctx.createGain();
      this.reverbSend.connect(this.reverb).connect(this.master);

      this.bus = ctx.createGain(); // 樂器音色鏈的輸出匯流排
      this.bus.connect(this.master);
      this.bus.connect(this.reverbSend);

      this.knockBus = ctx.createGain();
      this.knockBus.connect(this.master);
      this.knockRev = ctx.createGain();
      this.knockRev.gain.value = 0.25;
      this.knockBus.connect(this.knockRev).connect(this.reverbSend);
      this.knockBody = ctx.createConvolver();
      this.knockBody.buffer = makeBodyIR(ctx, [[98, 0.09, 1], [205, 0.06, 0.7], [290, 0.04, 0.5], [420, 0.03, 0.3]], 0.35);
      this.knockBody.connect(this.knockBus);

      if (ctx.audioWorklet && window.isSecureContext) {
        try {
          await ctx.audioWorklet.addModule('js/guitar-dsp.js');
          this.node = new AudioWorkletNode(ctx, 'guitar-dsp', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
          this.post = (m) => this.node.port.postMessage(m);
          this.mode = 'worklet';
        } catch (e) {
          console.warn('AudioWorklet 失敗，改用備援', e);
        }
      }
      if (!this.node) {
        const dsp = new window.GuitarDSP(ctx.sampleRate);
        const sp = ctx.createScriptProcessor(512, 0, 1);
        sp.onaudioprocess = (e) => dsp.render(e.outputBuffer.getChannelData(0));
        this.node = sp;
        this.post = (m) => dsp.msg(m);
        this.mode = 'script';
      }
      this.ready = true;
      this.setInstrument(this.instId);
    }

    resume() {
      if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    }

    setVolume(v) {
      this.volume = v;
      if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }

    setReverb(v) {
      this.reverbAmt = v;
      this.applyReverb();
    }

    applyReverb() {
      if (!this.ready) return;
      const inst = Music.INSTRUMENTS[this.instId];
      this.reverbSend.gain.setTargetAtTime(inst.reverb * this.reverbAmt * 1.6, this.ctx.currentTime, 0.05);
    }

    // ---------- 音色鏈 ----------
    chain(type) {
      if (this.chains[type]) return this.chains[type];
      const ctx = this.ctx;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const f = (t, freq, q, gain) => {
        const b = ctx.createBiquadFilter();
        b.type = t;
        b.frequency.value = freq;
        if (q != null) b.Q.value = q;
        if (gain != null) b.gain.value = gain;
        return b;
      };
      const series = (...nodes) => {
        for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
        return nodes[nodes.length - 1];
      };
      const body = (modes, wet, dry) => {
        const conv = ctx.createConvolver();
        conv.buffer = makeBodyIR(ctx, modes, 0.3);
        const w = ctx.createGain();
        w.gain.value = wet;
        const d = ctx.createGain();
        d.gain.value = dry;
        const sum = ctx.createGain();
        return { conv, w, d, sum };
      };
      const hollow = (modes, wet, dry, pre, post) => {
        const b = body(modes, wet, dry);
        const last = series(input, ...pre);
        last.connect(b.d).connect(b.sum);
        last.connect(b.conv);
        b.conv.connect(b.w).connect(b.sum);
        series(b.sum, ...post, out);
      };
      const amp = (preGain, k, pre, post, postGain) => {
        const g1 = ctx.createGain();
        g1.gain.value = preGain;
        const ws = ctx.createWaveShaper();
        ws.curve = shaperCurve(k);
        ws.oversample = '4x';
        const g2 = ctx.createGain();
        g2.gain.value = postGain;
        series(input, ...pre, g1, ws, ...post, g2, out);
      };

      switch (type) {
        case 'acoustic':
          hollow([[102, 0.1, 1], [198, 0.07, 0.75], [248, 0.06, 0.6], [395, 0.045, 0.4], [560, 0.035, 0.3], [820, 0.025, 0.2]], 0.9, 0.75,
            [f('highpass', 70, 0.7)], [f('peaking', 3200, 0.8, 2.5), f('lowpass', 11000, 0.5)]);
          out.gain.value = 1.6;
          break;
        case 'nylon':
          hollow([[96, 0.12, 1], [190, 0.08, 0.8], [235, 0.06, 0.6], [380, 0.04, 0.35]], 1.0, 0.7,
            [f('highpass', 60, 0.7)], [f('peaking', 200, 1, 2), f('lowpass', 5200, 0.6)]);
          out.gain.value = 1.15;
          break;
        case 'uke':
          hollow([[180, 0.06, 1], [320, 0.045, 0.7], [520, 0.03, 0.4]], 0.7, 0.8,
            [f('highpass', 130, 0.7)], [f('peaking', 2200, 0.9, 2), f('lowpass', 8000, 0.6)]);
          out.gain.value = 1.5;
          break;
        case 'clean': {
          const hp = f('highpass', 80, 0.7);
          const pres = f('peaking', 2500, 1, 3);
          const lp = f('lowpass', 7500, 0.6);
          series(input, hp, pres);
          // 合唱效果
          const dl = ctx.createDelay(0.05);
          dl.delayTime.value = 0.014;
          const lfo = ctx.createOscillator();
          lfo.frequency.value = 0.7;
          const depth = ctx.createGain();
          depth.gain.value = 0.0025;
          lfo.connect(depth).connect(dl.delayTime);
          lfo.start();
          const wet = ctx.createGain();
          wet.gain.value = 0.35;
          pres.connect(lp);
          pres.connect(dl).connect(wet).connect(lp);
          lp.connect(out);
          out.gain.value = 1.4;
          break;
        }
        case 'crunch':
          amp(2.6, 1.8, [f('highpass', 100, 0.7), f('peaking', 900, 0.8, 4)],
            [f('lowpass', 5200, 0.7), f('peaking', 2400, 1, 2)], 0.55);
          break;
        case 'dist':
          amp(9, 4, [f('highpass', 120, 0.7), f('peaking', 1400, 0.7, 6)],
            [f('peaking', 450, 1, -4), f('peaking', 1800, 1.2, 3), f('lowpass', 3900, 0.8), f('lowpass', 6500, 0.7), f('highpass', 80, 0.7)], 0.32);
          break;
        case 'bass': {
          const c = ctx.createDynamicsCompressor();
          c.threshold.value = -20;
          c.ratio.value = 3;
          series(input, f('highpass', 35, 0.7), f('lowshelf', 110, null, 3), f('peaking', 800, 1, -2), f('lowpass', 2800, 0.7), c, out);
          out.gain.value = 1.0;
          break;
        }
      }
      out.connect(this.bus);
      this.chains[type] = { input, out };
      return this.chains[type];
    }

    setInstrument(id) {
      this.instId = id;
      if (!this.ready) return;
      const inst = Music.INSTRUMENTS[id];
      const ch = this.chain(inst.chain);
      this.post({ type: 'damp', s: -1, time: 0.05 });
      try { this.node.disconnect(); } catch (e) { /* 尚未連接 */ }
      this.node.connect(ch.input);
      this.post({ type: 'config', params: inst.dsp, twelve: !!inst.twelve, octave: Music.TWELVE_OCTAVE });
      this.applyReverb();
    }

    // ---------- 弦 ----------
    pluck(s, freq, vel, pick, mode, delay) {
      if (!this.ready) return;
      this.post({ type: 'pluck', s, freq, vel, pick, mode, delay: delay || 0 });
    }
    setFreq(s, freq, glide) {
      if (this.ready) this.post({ type: 'freq', s, freq, glide });
    }
    damp(s, time) {
      if (this.ready) this.post({ type: 'damp', s, time });
    }

    // ---------- 敲琴身 ----------
    // where: 'top'（面板，深沉）/ 'side'（側板、琴身外，清脆）；depth 0~1 越靠中央越低沉
    knock(where, depth, vel) {
      if (!this.ready) return;
      const ctx = this.ctx;
      const t = ctx.currentTime + 0.002;
      const inst = Music.INSTRUMENTS[this.instId];
      const hollow = inst.knock === 'hollow';
      const small = inst.look.small;
      const dest = hollow ? this.knockBody : this.knockBus;
      vel = Math.max(0.2, Math.min(1, vel));

      const tone = (f0, f1, dur, amp) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f1, t + Math.min(dur, 0.05));
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(dest);
        o.start(t);
        o.stop(t + dur + 0.02);
      };
      const noise = (type, freq, q, dur, amp) => {
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const b = ctx.createBiquadFilter();
        b.type = type;
        b.frequency.value = freq;
        b.Q.value = q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp, t + 0.001);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(b).connect(g).connect(dest);
        src.start(t, Math.random() * 0.5);
        src.stop(t + dur + 0.02);
      };

      if (hollow) {
        const up = small ? 1.6 : 1;
        if (where === 'top') {
          const f0 = (75 + (1 - depth) * 95) * up;
          tone(f0 * 1.9, f0, 0.16 + 0.16 * depth, 0.9 * vel);
          tone(f0 * 2.4, f0 * 2.1, 0.07, 0.3 * vel);
          noise('bandpass', (1900 - depth * 900) * up, 0.9, 0.035, 0.6 * vel);
        } else {
          tone(260 * up, 210 * up, 0.08, 0.5 * vel);
          noise('bandpass', 2600 * up, 1.4, 0.03, 0.9 * vel);
        }
      } else {
        if (where === 'top') {
          tone(140, 85, 0.09, 0.6 * vel);
          noise('lowpass', 1300, 0.7, 0.025, 0.45 * vel);
        } else {
          tone(320, 260, 0.04, 0.3 * vel);
          noise('bandpass', 3200, 1.2, 0.02, 0.6 * vel);
        }
      }
    }
  }

  G.GuitarAudio = GuitarAudio;
})(window);
