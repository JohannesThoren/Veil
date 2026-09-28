// Applied before first paint so a chosen theme never flashes. (External file: CSP forbids inline scripts.)
try {
  const t = localStorage.getItem('veil-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow system */ }
