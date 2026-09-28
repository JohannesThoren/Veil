// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Applied before first paint so a chosen theme never flashes. (External file: CSP forbids inline scripts.)
try {
  const t = localStorage.getItem('veil-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow system */ }
