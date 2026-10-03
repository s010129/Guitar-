// 共用 UI 小工具
(function (G) {
  'use strict';

  let toastTimer = 0;
  function toast(text, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, ms || 1800);
  }

  // 迷你和弦圖（直式：左邊是最低音弦）
  function chordSVG(frets) {
    const n = frets.length;
    const played = frets.filter((f) => f > 0);
    const maxF = played.length ? Math.max(...played) : 0;
    const base = maxF > 4 ? Math.min(...played) : 1;
    const W = 46, H = 40, x0 = 6, x1 = W - 6, y0 = 9, rows = 4;
    const dx = (x1 - x0) / (n - 1);
    const dy = (H - y0 - 2) / rows;
    let s = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    s += `<g stroke="currentColor" stroke-opacity=".55" stroke-width="1">`;
    for (let i = 0; i < n; i++) s += `<line x1="${x0 + i * dx}" y1="${y0}" x2="${x0 + i * dx}" y2="${H - 2}"/>`;
    for (let r = 0; r <= rows; r++) s += `<line x1="${x0}" y1="${y0 + r * dy}" x2="${x1}" y2="${y0 + r * dy}"/>`;
    s += '</g>';
    if (base === 1) s += `<rect x="${x0 - 1}" y="${y0 - 2}" width="${x1 - x0 + 2}" height="2.5" fill="currentColor"/>`;
    else s += `<text x="${W - 1}" y="${y0 + dy * 0.8}" font-size="8" text-anchor="end" fill="currentColor">${base}</text>`;
    frets.forEach((f, i) => {
      const x = x0 + i * dx;
      if (f < 0) s += `<text x="${x}" y="7" font-size="7" text-anchor="middle" fill="currentColor">×</text>`;
      else if (f === 0) s += `<circle cx="${x}" cy="4.5" r="2" fill="none" stroke="currentColor" stroke-width="1"/>`;
      else {
        const r = f - base;
        if (r >= 0 && r < rows) s += `<circle cx="${x}" cy="${y0 + (r + 0.5) * dy}" r="2.8" fill="currentColor"/>`;
      }
    });
    return s + '</svg>';
  }

  function statusDot(dot, state) {
    dot.className = 'dot' + (state === 'connected' ? ' ok' : state === 'error' ? '' : ' wait');
  }

  // ---------- 永遠橫向 ----------
  // iOS 網頁不能鎖定方向：「裝置」直放時把整頁順時針轉 90°（畫面頂端朝向裝置右側）。
  // 用裝置方向判斷，不用視窗比例：iPad 分割畫面時視窗可能是直的，但 iPad 本身是橫的，不能轉。
  let rotated = false;
  function devicePortrait() {
    const so = screen.orientation;
    if (so && typeof so.type === 'string') return so.type.indexOf('portrait') === 0;
    if (typeof window.orientation === 'number') return window.orientation === 0 || window.orientation === 180;
    return window.innerHeight > window.innerWidth;
  }
  // 轉的方向跟著「上一次橫放」的方向，裝置抬起哪一端都不會讓畫面上下顛倒
  let lastLand = null;
  let ccw = false;
  function angle() {
    if (typeof window.orientation === 'number') return ((window.orientation % 360) + 360) % 360;
    const so = screen.orientation;
    if (so && typeof so.angle === 'number') return ((so.angle % 360) + 360) % 360;
    return null;
  }
  function applyOrientation() {
    const root = document.documentElement;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const a = angle();
    if (a === 90 || a === 270) lastLand = a;
    rotated = devicePortrait() && h > w;
    // 預設順時針（例如鎖定方向時不知道之前怎麼放）
    ccw = rotated && lastLand !== null && a !== null && (lastLand - a + 360) % 360 === 270;
    root.classList.toggle('rot', rotated);
    root.classList.toggle('ccw', ccw);
    root.style.setProperty('--vw', w + 'px');
    root.style.setProperty('--vh', h + 'px');
    // 版面實際的寬高（轉過之後）：CSS 用這些 class 取代 media query 和 vw
    const ew = rotated ? h : w;
    const eh = rotated ? w : h;
    root.style.setProperty('--ew', ew / 100 + 'px');
    root.classList.toggle('port', eh > ew);
    root.classList.toggle('short', eh <= 440);
    root.classList.toggle('narrow', ew <= 820);
  }
  function forceLandscape() {
    applyOrientation();
    window.addEventListener('resize', applyOrientation);
    window.addEventListener('orientationchange', () => setTimeout(applyOrientation, 60));
    if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', applyOrientation);
  }
  // 觸控點 → 元素內的座標（考慮整頁旋轉）
  function localPoint(el, e) {
    const r = el.getBoundingClientRect();
    if (!rotated) return { x: e.clientX - r.left, y: e.clientY - r.top };
    // 逆時針：元素的 x 軸朝螢幕上方、y 軸朝螢幕右方，原點在外框左下角
    if (ccw) return { x: r.bottom - e.clientY, y: e.clientX - r.left };
    // 順時針：元素的 x 軸朝螢幕下方、y 軸朝螢幕左方，原點在外框右上角
    return { x: e.clientY - r.top, y: r.right - e.clientX };
  }

  // ---------- 全螢幕 ----------
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  // iPhone / iPad（含 iPadOS 的桌面版 UA）
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // iOS / iPadOS 不用 Safari 的網頁全螢幕：往下滑（= 往下刷弦）會被當成「離開全螢幕」，
  // 快速連續觸控也會跳出警告。改用「加入主畫面」，從主畫面打開才是真正的全螢幕
  function fsSupported() {
    if (isIOS()) return false;
    const d = document.documentElement;
    return !!(d.requestFullscreen || d.webkitRequestFullscreen) && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }
  function standalone() {
    return navigator.standalone === true || window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  }
  // 必須在點擊當下呼叫；不支援（iPhone 的 Safari）時回傳 false
  function enterFullscreen() {
    if (fsElement()) return true;
    if (!fsSupported()) return false;
    const d = document.documentElement;
    const lock = () => {
      try {
        const q = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape');
        if (q && q.catch) q.catch(() => {});
      } catch (e) { /* iOS 不支援鎖定方向 */ }
    };
    try {
      const p = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : d.webkitRequestFullscreen();
      if (p && p.then) p.then(lock).catch(() => {});
      else lock();
      return true;
    } catch (e) {
      return false;
    }
  }
  function exitFullscreen() {
    try {
      const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }
  // 全螢幕按鈕：已經是主畫面 App 就藏起來；按了切換；不支援就說明怎麼「加入主畫面」
  function setupFullscreenButton(btn, onUnsupported) {
    if (standalone()) {
      btn.classList.add('hidden');
      return;
    }
    const sync = () => {
      const on = !!fsElement();
      btn.textContent = on ? '⤡' : '⛶';
      btn.setAttribute('aria-label', on ? '離開全螢幕' : '全螢幕');
    };
    btn.addEventListener('click', () => {
      if (fsElement()) exitFullscreen();
      else if (!enterFullscreen()) onUnsupported();
    });
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
  }

  G.UI = { toast, chordSVG, statusDot, forceLandscape, localPoint, isRotated: () => rotated, fsSupported, standalone, enterFullscreen, setupFullscreenButton };
})(window);
