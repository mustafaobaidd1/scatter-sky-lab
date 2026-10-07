/** Inline stroke icons (24 × 24, currentColor). Original drawings. */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = {
  story: svg(
    '<path d="M3.5 5.5c3-1.3 5.8-1.2 8.5.6 2.7-1.8 5.5-1.9 8.5-.6v13c-3-1.3-5.8-1.2-8.5.6-2.7-1.8-5.5-1.9-8.5-.6z"/><path d="M12 6.1v13"/>',
  ),
  experiments: svg(
    '<path d="M9.5 3.5h5"/><path d="M10.5 3.5v5.2L5.6 17.4a2 2 0 0 0 1.8 3.1h9.2a2 2 0 0 0 1.8-3.1l-4.9-8.7V3.5"/><path d="M7.7 14.5h8.6"/>',
  ),
  probe: svg(
    '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  ),
  view: svg('<path d="M2.5 18.5l5.5-7 4 5 3-3.5 6.5 5.5z"/><circle cx="16.5" cy="6.5" r="2"/>'),
  info: svg(
    '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r=".6" fill="currentColor"/>',
  ),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  hand: svg(
    '<path d="M8.5 11V5.8a1.6 1.6 0 0 1 3.2 0V10m0-.6V4.6a1.6 1.6 0 0 1 3.2 0V10m0-.4V6.4a1.6 1.6 0 0 1 3.2 0v7.4c0 4.1-2.8 6.7-6.6 6.7-3.1 0-4.6-1.5-6.4-4.3l-1.9-3a1.6 1.6 0 0 1 2.6-1.9l1.4 1.7"/>',
  ),
  arrowUp: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  next: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  sun: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  ),
  zoom: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M11 8v6M8 11h6"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5V9h4.5"/>'),
};
