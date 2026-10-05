// 連線：WebRTC DataChannel 點對點（PeerJS 只負責一開始的配對）
// iPad（右手）開房 → 手機（左手）用 4 位數房號或掃 QR 加入
(function (G) {
  'use strict';

  const PREFIX = 'duoguitar-v1-';
  const NET_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed'];
  const ID_WAIT_MS = 95000; // 舊連線在配對伺服器上最久約 60~90 秒才會被清掉

  // 不覆寫 config：PeerJS 預設已含 STUN + TURN 中繼（AP 隔離、行動網路時才連得上）
  // ?ph=host:port/path 可改用自架的 PeerJS 伺服器（區網、測試用）
  function peerOptions(extra) {
    const opts = Object.assign({ debug: 1 }, extra || {});
    const ph = new URLSearchParams(location.search).get('ph');
    if (ph) {
      const m = /^([^:/]+)(?::(\d+))?(\/.*)?$/.exec(ph);
      if (m) {
        opts.host = m[1];
        opts.port = Number(m[2]) || (location.protocol === 'https:' ? 443 : 80);
        opts.path = m[3] || '/';
        opts.secure = location.protocol === 'https:';
      }
    }
    return opts;
  }

  // 每個分頁固定的 token：iPad 斷線或重新整理後，可以立刻拿回同一個房號
  const newToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  let memToken = null;
  function hostToken() {
    try {
      let t = sessionStorage.getItem('duoguitar.tok');
      if (!t) {
        t = newToken();
        sessionStorage.setItem('duoguitar.tok', t);
      }
      return t;
    } catch (e) {
      return memToken || (memToken = newToken()); // 無法儲存（封鎖 Cookie）：至少同一頁內固定
    }
  }
  const wsOpen = (peer) => !!(peer && peer.socket && peer.socket._wsOpen && peer.socket._wsOpen());
  // 丟棄一個 Peer：晚到的 ID 回應不可以再開一條沒人管的 WebSocket
  function retire(peer) {
    peer._initialize = () => {};
    try { peer.destroy(); } catch (e) { /* ignore */ }
  }
  const KICKED_MSG = '另一支手機已接手。按「連」可以再連回來';

  class Link {
    // role: 'host'（iPad）或 'guest'（手機）
    constructor({ role, onMessage, onStatus, onOpen, onLatency }) {
      this.role = role;
      this.onMessage = onMessage || (() => {});
      this.onStatus = onStatus || (() => {});
      this.onOpen = onOpen || (() => {});
      this.onLatency = onLatency || (() => {});
      this.conn = null;
      this.pending = null; // 手機：正在嘗試中的連線（同時只會有一個）
      this.peer = null;
      this.lastSeen = 0;
      this.timers = new Set();
      this.retryT = 0;
      this.idRetryT = 0;
      this.idWaitSince = 0;
      this.fails = 0;
      this.kicked = false;
      this.rtts = []; // 最近幾次的來回時間
      this.pingTimer = setInterval(() => this.tick(), 1500);
    }

    status(state, text) {
      if (this.kicked && state !== 'connected') {
        state = 'error'; // 被接手的手機不會自己重連，保留說明
        text = KICKED_MSG;
      }
      this.state = state;
      this.onStatus(state, text);
    }

    get connected() {
      return !!(this.conn && this.conn.open);
    }

    // 配對伺服器斷線時，用同一個 Peer 重連（保留 ID 與 token），間隔逐步拉長
    watchSignal(peer) {
      let delay = 1500;
      let gen = 0;
      let idWaits = 0;
      // 連線 / 重連後檢查：伺服器用同一個 token 接回舊連線時不會送 OPEN（peer.open 一直是 false，但其實能用）；
      // 若 WebSocket 卡在連線中（防火牆、伺服器沒回應）就強制重試。只有最新一次的檢查有效。
      const check = () => {
        const g = ++gen;
        this.later(() => { if (g === gen) checkNow(); }, 7000);
      };
      const checkNow = () => {
        if (this.peer !== peer || peer.destroyed || peer.disconnected || peer.open) return;
        if (wsOpen(peer) && peer.id) {
          delay = 1500;
          if (this.role === 'host') {
            this.idWaitSince = 0;
            if (!this.connected && (this.state === 'starting' || this.state === 'reconnecting')) this.status('waiting', '等待手機連線');
          } else {
            this.connect();
          }
        } else if (peer.id) {
          try { peer.disconnect(); } catch (e) { /* ignore */ } // 觸發 'disconnected' → 重連
        } else if (this.role === 'guest') {
          // 還在等伺服器配發 ID：網路慢就多等一下（約 28 秒）才整個重來
          if (++idWaits < 4) {
            check();
            return;
          }
          this.peer = null;
          retire(peer);
          this.guestPeer();
        }
      };
      check();
      if (this.role === 'guest' && !peer.id) {
        // ID 到了 PeerJS 才開 WebSocket：從那一刻重新計 7 秒，免得剛開始握手就被檢查中斷
        const init = peer._initialize;
        peer._initialize = (id) => {
          peer._initialize = init;
          init.call(peer, id);
          if (this.peer === peer && !peer.destroyed) check();
        };
      }
      peer.on('open', () => { delay = 1500; });
      peer.on('disconnected', () => {
        if (this.peer !== peer || peer.destroyed || this.idWait) return;
        if (!this.connected) this.status('reconnecting', '配對伺服器斷線，重連中…');
        this.later(() => {
          if (this.peer === peer && !peer.destroyed && peer.disconnected) {
            try { peer.reconnect(); } catch (e) { /* 正在連線中 */ }
            check();
          }
        }, delay);
        delay = Math.min(delay * 1.6, 15000);
      });
    }

    // ---------- 主機（iPad） ----------
    host(code, keepIdWait) {
      this.code = code;
      this.destroyPeer();
      this.idWait = false;
      if (!keepIdWait) this.idWaitSince = 0;
      this.status('starting', '建立房間中…');
      const peer = new Peer(PREFIX + code, peerOptions({ token: hostToken() }));
      this.peer = peer;
      this.watchSignal(peer);
      peer.on('open', () => {
        this.idWaitSince = 0;
        if (!this.connected) this.status('waiting', '等待手機連線');
      });
      peer.on('connection', (conn) => this.attach(conn));
      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        if (err.type === 'unavailable-id') {
          // 通常是自己上一次的連線還沒被伺服器清掉：等它釋放，不要馬上換房號
          this.idWait = true;
          if (!this.idWaitSince) this.idWaitSince = performance.now();
          const waited = performance.now() - this.idWaitSince;
          if (waited > ID_WAIT_MS && !this.connected) {
            this.idWaitSince = 0;
            if (this.onIdTaken) this.onIdTaken();
            return;
          }
          if (!this.connected) this.status('reconnecting', `房號 ${code} 還被舊連線占用，等待釋放…（${Math.round(waited / 1000)} 秒）`);
          clearTimeout(this.idRetryT);
          this.idRetryT = setTimeout(() => {
            if (this.code !== code || this.peer !== peer) return;
            if (!peer.destroyed && peer.disconnected) {
              // 已經連過伺服器的 Peer（手機可能還連著）：同一個 Peer 重試，不要中斷演奏
              this.idWait = false;
              try { peer.reconnect(); } catch (e) { /* ignore */ }
            } else {
              this.host(code, true);
            }
          }, 5000);
        } else if (NET_ERRORS.includes(err.type)) {
          if (!this.connected) this.status('error', '連不到配對伺服器（需要網路），重試中…');
          // 只有 Peer 已經被銷毀（從沒連上伺服器）才重建；已連上的手機不受影響
          this.later(() => { if (this.peer === peer && peer.destroyed && this.code === code) this.host(code); }, 4000);
        } else {
          console.warn('peer error', err.type, err);
        }
      });
    }

    // ---------- 加入（手機） ----------
    join(code) {
      this.code = code;
      this.kicked = false;
      this.fails = 0;
      this.destroyPeer();
      this.status('starting', '連線中…');
      this.guestPeer();
    }

    guestPeer() {
      const code = this.code;
      const peer = new Peer(peerOptions());
      this.peer = peer;
      this.watchSignal(peer);
      peer.on('open', () => this.connect());
      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        if (err.type === 'peer-unavailable') {
          this.dropPending();
          if (!this.connected) this.status('error', `找不到房號 ${code}，請確認 iPad 已開啟右手頁面`);
          this.scheduleRetry(2500);
        } else if (NET_ERRORS.includes(err.type)) {
          if (!this.connected) this.status('error', '連不到配對伺服器（需要網路），重試中…');
          this.later(() => {
            if (this.peer === peer && peer.destroyed && this.code === code && !this.connected) this.guestPeer();
          }, 4000);
        } else {
          console.warn('peer error', err.type, err);
        }
      });
    }

    // 同一時間只有一個嘗試中的連線、一個重試計時器
    connect() {
      const peer = this.peer;
      if (!peer || peer.destroyed || this.connected || this.kicked || this.pending) return;
      // 配對伺服器還不能用就稍後再試（不看 peer.open：伺服器接回舊連線時不會送 OPEN）
      if (peer.disconnected || !peer.id || !wsOpen(peer)) {
        this.scheduleRetry(3000);
        return;
      }
      this.status('connecting', this.fails >= 2
        ? '還連不上：請確認兩台在同一個 Wi-Fi，且路由器沒有開「AP 隔離」'
        : `連線到房號 ${this.code}…`);
      const conn = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
      this.pending = conn;
      this.attach(conn);
      this.scheduleRetry(9000, true);
    }

    scheduleRetry(ms, watchdog) {
      clearTimeout(this.retryT);
      this.retryT = setTimeout(() => {
        this.retryT = 0;
        if (this.connected || this.kicked) return;
        if (watchdog && this.pending) this.fails++; // iPad 在，但 P2P 打不通
        this.dropPending();
        this.connect();
      }, ms);
    }

    dropPending() {
      const c = this.pending;
      this.pending = null;
      if (c) {
        try { c.close(); } catch (e) { /* ignore */ }
      }
    }

    attach(conn) {
      conn.on('open', () => {
        if (this.pending === conn) {
          this.pending = null;
          clearTimeout(this.retryT);
          this.retryT = 0;
        }
        const old = this.conn;
        this.conn = conn;
        this.fails = 0;
        if (old && old !== conn) {
          // 新的手機接手：先告訴舊的手機，讓它不要自動搶回來
          try { old.send({ t: 'bye' }); } catch (e) { /* ignore */ }
          setTimeout(() => { try { old.close(); } catch (e) { /* ignore */ } }, 300);
        }
        this.lastSeen = performance.now();
        this.rtts = []; // 換了連線，舊的延遲不算數
        this.status('connected', '已連線');
        this.onOpen();
      });
      conn.on('data', (d) => {
        if (conn !== this.conn) return;
        this.lastSeen = performance.now();
        if (!d || typeof d !== 'object') return;
        if (d.t === 'ping') this.send({ t: 'pong', ts: d.ts });
        else if (d.t === 'pong') {
          if (typeof d.ts === 'number') {
            // 取最近 8 次（約 12 秒）裡最快的一次：偶爾一次 Wi-Fi 省電造成的慢回應不會讓延遲估計（音遊判定、節拍器）整個偏掉
            this.rtts.push(performance.now() - d.ts);
            if (this.rtts.length > 8) this.rtts.shift();
            this.onLatency(Math.min(...this.rtts) / 2);
          }
        } else if (d.t === 'bye') {
          this.kicked = true;
          this.conn = null;
          try { conn.close(); } catch (e) { /* ignore */ }
          this.status('error', KICKED_MSG);
        } else {
          try { this.onMessage(d); } catch (e) { console.warn('bad message', d, e); }
        }
      });
      const closed = () => {
        if (this.pending === conn) {
          // 嘗試失敗（例如 ICE 協商失敗）：稍後重試
          this.pending = null;
          if (this.role === 'guest' && !this.kicked) {
            this.fails++;
            this.scheduleRetry(2000);
          }
          return;
        }
        if (this.conn !== conn) return;
        this.conn = null;
        if (this.role === 'guest') {
          if (this.kicked) return;
          this.status('error', '連線中斷，重新連線…');
          this.scheduleRetry(1200);
        } else {
          this.status('waiting', '手機已斷線，等待重新連線');
        }
      };
      conn.on('close', closed);
      conn.on('error', (e) => {
        console.warn('conn error', e);
        closed();
      });
    }

    tick() {
      if (!this.connected) return;
      this.send({ t: 'ping', ts: performance.now() });
      const silent = performance.now() - this.lastSeen;
      if (silent > 6000 && this.state === 'connected') this.status('unstable', '連線不穩…');
      else if (silent < 6000 && this.state === 'unstable') this.status('connected', '已連線');
      if (silent > 12000 && this.role === 'guest') {
        const c = this.conn;
        this.conn = null; // 先拿掉，close 事件就不會再排一次重連
        try { c.close(); } catch (e) { /* ignore */ }
        this.status('error', '連線逾時，重新連線…');
        this.connect();
      } else if (silent > 15000 && this.role === 'host') {
        // 手機每 1.5 秒會 ping：15 秒沒消息就當作離開了（鎖屏、走出 Wi-Fi），不用等瀏覽器很久才發現
        const c = this.conn;
        this.conn = null;
        try { c.close(); } catch (e) { /* ignore */ }
        this.status('waiting', '手機已斷線，等待重新連線');
      }
    }

    send(msg) {
      if (this.connected) {
        try { this.conn.send(msg); } catch (e) { console.warn('send failed', e); }
      }
    }

    later(fn, ms) {
      const id = setTimeout(() => {
        this.timers.delete(id);
        fn();
      }, ms);
      this.timers.add(id);
      return id;
    }

    destroyPeer() {
      this.timers.forEach(clearTimeout);
      this.timers.clear();
      clearTimeout(this.retryT);
      clearTimeout(this.idRetryT);
      this.retryT = this.idRetryT = 0;
      const old = [this.conn, this.pending];
      this.conn = this.pending = null;
      for (const c of old) {
        if (c) {
          try { c.close(); } catch (e) { /* ignore */ }
        }
      }
      if (this.peer) {
        const p = this.peer;
        this.peer = null;
        retire(p);
      }
    }
  }

  // ---------- 螢幕常亮 ----------
  // iOS 16.4+ 用 Wake Lock；更舊的版本，或「加入主畫面」模式在 iOS 18.4 以前（Wake Lock 無效）
  // 改用 NoSleep.js 的做法：播放一段有靜音音軌的小影片
  let wakeLock = null;
  let video = null;
  function iosVersion() {
    const m = /(?:iPhone|iPad|iPod)[^)]* OS (\d+)_(\d+)/.exec(navigator.userAgent);
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  }
  function useVideo() {
    if (!('wakeLock' in navigator)) return true;
    if (navigator.standalone) {
      const v = iosVersion();
      return v === null || v < 1804;
    }
    return false;
  }
  function isAwake() {
    return useVideo() ? !!(video && !video.paused) : !!wakeLock;
  }
  function startVideo() {
    const media = window.NOSLEEP_MEDIA;
    if (!media) return;
    if (!video) {
      video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('title', '螢幕常亮');
      for (const [type, src] of [['webm', media.webm], ['mp4', media.mp4]]) {
        const s = document.createElement('source');
        s.src = src;
        s.type = 'video/' + type;
        video.appendChild(s);
      }
      video.addEventListener('loadedmetadata', () => {
        if (video.duration <= 1) video.loop = true;
        else video.addEventListener('timeupdate', () => { if (video.currentTime > 0.5) video.currentTime = Math.random(); });
      });
    }
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  }
  async function keepAwake() {
    if (isAwake()) return;
    if (useVideo()) {
      startVideo();
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* 需要使用者操作；下次點擊再試 */ }
  }
  let wantAwake = false;
  function requestAwake() {
    wantAwake = true;
    keepAwake();
  }
  // click / touchend 才算「使用者操作」，拿到之前每次都再試一次
  ['click', 'touchend'].forEach((t) => document.addEventListener(t, () => {
    if (wantAwake && !isAwake()) keepAwake();
  }, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (wantAwake) keepAwake();
    } else if (video) video.pause();
  });

  // 禁止 iOS 縮放、雙擊放大、長按選單（.scroll 和頂部工具列仍可捲動）
  function lockGestures() {
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
    document.addEventListener('touchmove', (e) => { if (!e.target.closest('.scroll, .bar')) e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    let last = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - last < 300 && !e.target.closest('input,select,button,.allow-dbl')) e.preventDefault();
      last = now;
    }, { passive: false });
  }

  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem('duoguitar.' + key));
      localStorage.setItem('duoguitar.' + key, JSON.stringify(val));
    } catch (e) { return null; }
    return val;
  }

  G.Net = { Link, PREFIX, keepAwake: requestAwake, lockGestures, store };
})(window);
