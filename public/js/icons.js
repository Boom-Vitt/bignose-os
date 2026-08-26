// public/js/icons.js — shared monoline icon set. READ-ONLY for all slices.
//
// DESIGN.md §Icons: inline <svg>, stroke="currentColor", stroke-width="1.25",
// fill="none", stroke-linecap="round", 20x20 viewBox. No emoji anywhere.
//
// Hand-authored on a 20x20 grid — no CDN, no build step, no network fetch.
// Slice F and slice G BOTH import from here. Do not duplicate this map.

/** name -> inner SVG markup (no <svg> wrapper) */
export const ICONS = {
  mail:
    '<rect x="2.2" y="4.4" width="15.6" height="11.2" rx="1.6"/>' +
    '<path d="M2.8 5.4 10 10.8 17.2 5.4"/>',

  calendar:
    '<rect x="2.5" y="4.2" width="15" height="13.3" rx="1.6"/>' +
    '<path d="M2.5 8.2h15M6.6 2.5v3.2M13.4 2.5v3.2"/>',

  bolt:
    '<path d="M11.6 2.2 4.4 11.4h5L8.4 17.8 15.6 8.6h-5z" stroke-linejoin="round"/>',

  'check-square':
    '<rect x="2.5" y="2.5" width="15" height="15" rx="1.8"/>' +
    '<path d="m6.4 10.1 2.6 2.6 4.9-5.4"/>',

  terminal:
    '<path d="m4.2 5.8 4 4.2-4 4.2M10.6 14.4H16"/>',

  play:
    '<path d="M6.6 4.3 15.6 10l-9 5.7z" stroke-linejoin="round"/>',

  gear:
    '<circle cx="10" cy="10" r="2.3"/>' +
    '<circle cx="10" cy="10" r="5.5"/>' +
    '<path d="M15.5 10h1.9M13.89 13.89l1.34 1.34M10 15.5v1.9M6.11 13.89 4.77 15.23' +
    'M4.5 10H2.6M6.11 6.11 4.77 4.77M10 4.5V2.6M13.89 6.11l1.34-1.34"/>',

  search:
    '<circle cx="8.8" cy="8.8" r="5.3"/>' +
    '<path d="m12.7 12.7 4.3 4.3"/>',

  pencil:
    '<path d="M13.2 3.3 16.7 6.8 7.4 16.1 3.4 17l.9-4z" stroke-linejoin="round"/>' +
    '<path d="m11.9 4.6 3.5 3.5"/>',

  grid:
    '<rect x="2.5" y="2.5" width="6.2" height="6.2" rx="1.2"/>' +
    '<rect x="11.3" y="2.5" width="6.2" height="6.2" rx="1.2"/>' +
    '<rect x="2.5" y="11.3" width="6.2" height="6.2" rx="1.2"/>' +
    '<rect x="11.3" y="11.3" width="6.2" height="6.2" rx="1.2"/>',

  info:
    '<circle cx="10" cy="10" r="7.5"/>' +
    '<path d="M10 9.3v4.6M10 6.4v.01"/>',

  image:
    '<rect x="2.5" y="3.6" width="15" height="12.8" rx="1.6"/>' +
    '<circle cx="7.2" cy="8" r="1.35"/>' +
    '<path d="m2.9 14.4 4.2-4 4.9 4.6 2.4-2.2 3.1 3"/>',

  monitor:
    '<rect x="2.2" y="3.6" width="15.6" height="10.4" rx="1.6"/>' +
    '<path d="M7 17.5h6M10 14v3.5"/>',

  brain:
    '<path d="M10 4.3C9.2 3 7.2 2.8 6.2 4 4.6 4 3.6 5.4 4 6.8 2.8 7.6 2.8 9.6 4 10.4' +
    'c-.4 1.6.8 3.2 2.4 3.2.6 1.6 2.8 1.8 3.6.8"/>' +
    '<path d="M10 4.3c.8-1.3 2.8-1.5 3.8-.3 1.6 0 2.6 1.4 2.2 2.8 1.2.8 1.2 2.8 0 3.6' +
    '.4 1.6-.8 3.2-2.4 3.2-.6 1.6-2.8 1.8-3.6.8"/>' +
    '<path d="M10 4.3v10.1"/>',

  'pen-tool':
    '<path d="M10 2.6 15.6 8.2 10 17.4 4.4 8.2z" stroke-linejoin="round"/>' +
    '<circle cx="10" cy="7.7" r="1.5"/>' +
    '<path d="M10 9.2v8.2"/>',

  clock:
    '<circle cx="10" cy="10" r="7.5"/>' +
    '<path d="M10 5.6V10l3.1 1.9"/>',

  hexagon:
    '<path d="M10 2.3 16.7 6.15v7.7L10 17.7 3.3 13.85v-7.7z" stroke-linejoin="round"/>',

  'star-4':
    '<path d="M10 2.2c.6 4.9 2.9 7.2 7.8 7.8-4.9.6-7.2 2.9-7.8 7.8-.6-4.9-2.9-7.2-7.8-7.8' +
    '4.9-.6 7.2-2.9 7.8-7.8z" stroke-linejoin="round"/>',

  chevron:
    '<path d="m7.6 4.6 5.4 5.4-5.4 5.4"/>',

  menu:
    '<path d="M3 6h14M3 10h14M3 14h14"/>',

  diamond:
    '<path d="M10 2.4 17.6 10 10 17.6 2.4 10z" stroke-linejoin="round"/>',

  // ---- supporting glyphs (same spec) ----
  folder:
    '<path d="M2.6 5.6a1.4 1.4 0 0 1 1.4-1.4h3.1l1.7 2.1h6.6a1.4 1.4 0 0 1 1.4 1.4v6.7' +
    'a1.4 1.4 0 0 1-1.4 1.4H4a1.4 1.4 0 0 1-1.4-1.4z" stroke-linejoin="round"/>',

  file:
    '<path d="M11.4 2.6H5.9a1.5 1.5 0 0 0-1.5 1.5v11.8a1.5 1.5 0 0 0 1.5 1.5h8.2' +
    'a1.5 1.5 0 0 0 1.5-1.5V6.6z" stroke-linejoin="round"/>' +
    '<path d="M11.4 2.6v4h4.2"/>',

  x:
    '<path d="m5.4 5.4 9.2 9.2M14.6 5.4l-9.2 9.2"/>',

  'chevron-down':
    '<path d="m4.6 7.6 5.4 5.4 5.4-5.4"/>',

  dot:
    '<circle cx="10" cy="10" r="2.6"/>',

  plus:
    '<path d="M10 4v12M4 10h12"/>',

  minus:
    '<path d="M4 10h12"/>',

  refresh:
    '<path d="M16.4 8.4A6.6 6.6 0 0 0 4.6 6.2M3.6 11.6a6.6 6.6 0 0 0 11.8 2.2"/>' +
    '<path d="M16.8 3.6v4.8H12M3.2 16.4v-4.8H8"/>',
};

export const ICON_NAMES = Object.keys(ICONS);

/**
 * Build an <svg> string for `name`.
 * @param {string} name  key in ICONS
 * @param {{size?:number, cls?:string, stroke?:number}} [opts]
 * @returns {string} SVG markup, or '' when the name is unknown
 */
export function icon(name, opts = {}) {
  const body = ICONS[name];
  if (!body) return '';
  const size = opts.size ?? 20;
  const stroke = opts.stroke ?? 1.25;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return (
    `<svg${cls} width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" ` +
    `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`
  );
}

/**
 * Same as icon(), but returns a live SVGElement instead of a string.
 * @returns {SVGElement|null}
 */
export function iconEl(name, opts = {}) {
  const markup = icon(name, opts);
  if (!markup) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild;
}
