// 連線：WebRTC DataChannel 點對點（PeerJS 只負責一開始的配對）
// iPad（右手）開房 → 手機（左手）用 4 位數房號或掃 QR 加入
(function (G) {
  'use strict';

  const PREFIX = 'duoguitar-v1-';

  // ?ph=host:port/path 可改用自架的 PeerJS 伺服器（區網、測試用）
  function peerOptions() {
    const opts = {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    };
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

  class Link {
    // role: 'host'（iPad）或 'guest'（手機）
    constructor({ role, onMessage, onStatus, onOpen, onLatency }) {
      this.role = role;
      this.onMessage = onMessage || (() => {});
      this.onStatus = onStatus || (() => {});
      this.onOpen = onOpen || (() => {});
      this.onLatency = onLatency || (() => {});
      this.conn = null;
      this.peer = null;
      this.lastSeen = 0;
      this.timers = [];
      this.pingTimer = setInterval(() => this.tick(), 1500);
    }

    status(state, text) {
      this.state = state;
      this.onStatus(state, text);
    }

    get connected() {
      return !!(this.conn && this.conn.open);
    }

    // ---------- 主機（iPad） ----------
    host(code) {
      this.code = code;
      this.destroyPeer();
      this.status('starting', '建立房間中…');
      const peer = new Peer(PREFIX + code, peerOptions());
      this.peer = peer;
      peer.on('open', () => {
        if (!this.connected) this.status('waiting', '等待手機連線');
      });
      peer.on('connection', (conn) => this.attach(conn));
      peer.on('disconnected', () => {
        if (peer.destroyed) return;
        if (!this.connected) this.status('reconnecting', '配對伺服器斷線，重連中…');
        this.later(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500);
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          this.status('error', '房號被占用，換一個…');
          this.onIdTaken && this.onIdTaken();
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          if (!this.connected) this.status('error', '連不到配對伺服器（需要網路），重試中…');
          this.later(() => this.code === code && (peer.destroyed || peer.disconnected) && this.host(code), 4000);
        } else {
          console.warn('peer error', err.type, err);
        }
      });
    }

    // ---------- 加入（手機） ----------
    join(code) {
      this.code = code;
      this.destroyPeer();
      this.status('starting', '連線中…');
      const peer = new Peer(peerOptions());
      this.peer = peer;
      peer.on('open', () => this.connect());
      peer.on('disconnected', () => {
        if (!peer.destroyed) this.later(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500);
      });
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          this.status('error', `找不到房號 ${code}，請確認 iPad 已開啟右手頁面`);
          this.later(() => this.code === code && !this.connected && this.connect(), 2500);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          if (!this.connected) this.status('error', '連不到配對伺服器（需要網路），重試中…');
          this.later(() => this.code === code && !this.connected && this.join(code), 4000);
        } else {
          console.warn('peer error', err.type, err);
        }
      });
    }

    connect() {
      if (!this.peer || this.peer.destroyed || this.connected) return;
      if (this.peer.disconnected) {
        this.peer.reconnect();
        return;
      }
      this.status('connecting', `連線到房號 ${this.code}…`);
      const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
      this.attach(conn);
      const code = this.code;
      this.later(() => {
        if (this.code === code && !conn.open) {
          try { conn.close(); } catch (e) { /* ignore */ }
          if (!this.connected) this.connect();
        }
      }, 9000);
    }

    attach(conn) {
      conn.on('open', () => {
        if (this.conn && this.conn !== conn) {
          try { this.conn.close(); } catch (e) { /* ignore */ }
        }
        this.conn = conn;
        this.lastSeen = performance.now();
        this.status('connected', '已連線');
        this.onOpen();
      });
      conn.on('data', (d) => {
        this.lastSeen = performance.now();
        if (!d || typeof d !== 'object') return;
        if (d.t === 'ping') this.send({ t: 'pong', ts: d.ts });
        else if (d.t === 'pong') this.onLatency((performance.now() - d.ts) / 2);
        else this.onMessage(d);
      });
      const closed = () => {
        if (this.conn !== conn) return;
        this.conn = null;
        if (this.role === 'guest') {
          this.status('error', '連線中斷，重新連線…');
          this.later(() => this.connect(), 1200);
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
        try { this.conn.close(); } catch (e) { /* ignore */ }
        this.conn = null;
        this.connect();
      }
    }

    send(msg) {
      if (this.connected) {
        try { this.conn.send(msg); } catch (e) { console.warn('send failed', e); }
      }
    }

    later(fn, ms) {
      this.timers.push(setTimeout(fn, ms));
    }

    destroyPeer() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
      if (this.conn) {
        try { this.conn.close(); } catch (e) { /* ignore */ }
      }
      this.conn = null;
      if (this.peer) {
        try { this.peer.destroy(); } catch (e) { /* ignore */ }
      }
      this.peer = null;
    }
  }

  // 螢幕不要自動變暗（iOS 16.4+）
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* 不支援就算了 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });

  // 禁止 iOS 縮放、雙擊放大、長按選單
  function lockGestures() {
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
    document.addEventListener('touchmove', (e) => { if (!e.target.closest('.scroll')) e.preventDefault(); }, { passive: false });
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

  G.Net = { Link, PREFIX, keepAwake, lockGestures, store };
})(window);
