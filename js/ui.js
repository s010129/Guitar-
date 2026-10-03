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

  G.UI = { toast, chordSVG, statusDot };
})(window);
