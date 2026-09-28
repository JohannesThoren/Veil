// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Applied before first paint so a chosen theme never flashes. (External file: CSP forbids inline scripts.)
try {
  const t = localStorage.getItem('veil-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow system */ }

// No zooming: the app is laid out like a native app, and zoom (pinch, double-tap, Ctrl +/-,
// Ctrl + wheel) only leaves it half-zoomed and off-screen. Runs early on every page.
(() => {
  const stop = (e) => e.preventDefault();
  // iOS Safari ignores user-scalable=no; its pinch arrives as gesture events
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, stop, { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0', 'Add', 'Subtract'].includes(e.key)) e.preventDefault();
  });
})();
