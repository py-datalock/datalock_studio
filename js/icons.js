/**
 * icons.js
 * ========
 * Conjunto de ícones em SVG inline, estilo "linha" (stroke, sem fill) —
 * mesma família visual usada por ferramentas técnicas de referência
 * (Linear, Raycast, GitHub, DBeaver). Substitui os emojis usados na
 * primeira versão da interface, que lêem como protótipo, não como
 * software.
 *
 * Uso: `icon("filter")` devolve a string do <svg>, injetada via v-html.
 * Todo ícone usa viewBox "0 0 24 24", stroke="currentColor" (herda a cor
 * do texto ao redor) e o mesmo peso de traço — é a consistência entre
 * ícones, não o realismo de cada um, que dá a sensação de "kit
 * desenhado", não de emoji avulso.
 */

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

// Dentes da engrenagem gerados em código (em vez de 8 linhas manuais
// repetidas) — reduz a chance de erro de digitação num SVG longo.
const _gearTeeth = Array.from({ length: 8 }, (_, i) =>
  `<rect x="11" y="1" width="2" height="3.4" rx="0.6" fill="currentColor" transform="rotate(${i * 45} 12 12)"/>`
).join("");

const PATHS = {
  // ── Arquivo / navegação ─────────────────────────────────────────────
  folder: `<path ${STROKE} d="M3 6.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>`,
  "folder-plus": `<path ${STROKE} d="M3 6.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path ${STROKE} d="M12 11v4M10 13h4"/>`,
  upload: `<path ${STROKE} d="M12 15V4M8 8l4-4 4 4"/><path ${STROKE} d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>`,
  download: `<path ${STROKE} d="M12 4v11M8 11l4 4 4-4"/><path ${STROKE} d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>`,
  save: `<path ${STROKE} d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path ${STROKE} d="M8 4v5h7V4M8 20v-6h8v6"/>`,
  plus: `<path ${STROKE} d="M12 5v14M5 12h14"/>`,
  x: `<path ${STROKE} d="M6 6l12 12M18 6L6 18"/>`,

  // ── Passos do pipeline ────────────────────────────────────────────
  columns: `<rect ${STROKE} x="3.5" y="4" width="17" height="16" rx="1.5"/><path ${STROKE} d="M9.5 4v16M14.5 4v16"/>`,
  "columns-x": `<rect ${STROKE} x="3.5" y="4" width="17" height="16" rx="1.5"/><path ${STROKE} d="M9.5 4v16"/><path ${STROKE} d="M13.5 10l4 4m0-4l-4 4"/>`,
  edit: `<path ${STROKE} d="M4 20h4L18.5 9.5a2 2 0 0 0-4-4L4 16v4z"/><path ${STROKE} d="M13 6l4 4"/>`,
  filter: `<path ${STROKE} d="M4 5h16l-6 7.5V19l-4 2v-8.5z"/>`,
  "arrow-updown": `<path ${STROKE} d="M8 5v14M5 8l3-3 3 3"/><path ${STROKE} d="M16 19V5M13 16l3 3 3-3"/>`,
  layers: `<path ${STROKE} d="M12 3l8 4.5-8 4.5-8-4.5z"/><path ${STROKE} d="M4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5"/>`,
  repeat: `<path ${STROKE} d="M4 7h13l-2.5-2.5M20 17H7l2.5 2.5"/>`,
  droplet: `<path ${STROKE} d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/>`,
  "plus-circle": `<circle ${STROKE} cx="12" cy="12" r="8.5"/><path ${STROKE} d="M12 8.5v7M8.5 12h7"/>`,
  scissors: `<circle ${STROKE} cx="6.5" cy="6.5" r="2.3"/><circle ${STROKE} cx="6.5" cy="17.5" r="2.3"/><path ${STROKE} d="M8.3 8l11.7 11.7M8.3 16L20 4.3"/>`,
  link: `<path ${STROKE} d="M9.5 14.5l5-5"/><path ${STROKE} d="M13 7l1.5-1.5a3.2 3.2 0 0 1 4.5 4.5L17.5 11.5"/><path ${STROKE} d="M11 17l-1.5 1.5a3.2 3.2 0 0 1-4.5-4.5L6.5 12.5"/>`,
  "bar-chart": `<path ${STROKE} d="M5 19V10M12 19V5M19 19v-6"/><path ${STROKE} d="M3 19h18"/>`,
  grid: `<rect ${STROKE} x="4" y="4" width="16" height="16" rx="1.5"/><path ${STROKE} d="M4 10h16M4 15h16M10 4v16M15 4v16"/>`,
  shield: `<path ${STROKE} d="M12 3.5l7 2.5v6c0 5-3 7.8-7 8.5-4-.7-7-3.5-7-8.5V6z"/>`,
  "shield-key": `<path ${STROKE} d="M12 3.5l7 2.5v6c0 5-3 7.8-7 8.5-4-.7-7-3.5-7-8.5V6z"/><circle ${STROKE} cx="11" cy="12" r="1.7"/><path ${STROKE} d="M12.3 13.3L15 16m0 0l1.3-1.3M15 16l1.3 1.3"/>`,
  key: `<circle ${STROKE} cx="8" cy="15" r="3.2"/><path ${STROKE} d="M10.3 12.7L18 5M15 8l2 2M17.5 5.5l2 2"/>`,

  // ── Segurança / detecção ─────────────────────────────────────────────
  search: `<circle ${STROKE} cx="10.5" cy="10.5" r="6.5"/><path ${STROKE} d="M20 20l-4.8-4.8"/>`,
  eye: `<path ${STROKE} d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle ${STROKE} cx="12" cy="12" r="2.7"/>`,
  "eye-off": `<path ${STROKE} d="M3.5 3.5l17 17"/><path ${STROKE} d="M9.9 5.7A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15 15 0 0 1-3.2 3.9M6.4 7.1A15.6 15.6 0 0 0 2.5 12S6 18.5 12 18.5a9.9 9.9 0 0 0 3.2-.55"/><path ${STROKE} d="M9.9 12a2.7 2.7 0 0 0 3.9 2.4"/>`,
  database: `<ellipse ${STROKE} cx="12" cy="6" rx="7.5" ry="2.8"/><path ${STROKE} d="M4.5 6v6c0 1.5 3.3 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path ${STROKE} d="M4.5 12v6c0 1.5 3.3 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/>`,

  // ── Ações comuns ─────────────────────────────────────────────────────
  trash: `<path ${STROKE} d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M18 7l-.8 12a1.5 1.5 0 0 1-1.5 1.4H8.3A1.5 1.5 0 0 1 6.8 19L6 7"/>`,
  play: `<path ${STROKE} d="M7 5.5v13l11-6.5z"/>`,
  pause: `<path ${STROKE} d="M7.5 5.5v13M16.5 5.5v13"/>`,
  "grip-vertical": `<circle cx="9" cy="6" r="1.1" fill="currentColor"/><circle cx="9" cy="12" r="1.1" fill="currentColor"/><circle cx="9" cy="18" r="1.1" fill="currentColor"/><circle cx="15" cy="6" r="1.1" fill="currentColor"/><circle cx="15" cy="12" r="1.1" fill="currentColor"/><circle cx="15" cy="18" r="1.1" fill="currentColor"/>`,
  info: `<circle ${STROKE} cx="12" cy="12" r="8.5"/><path ${STROKE} d="M12 11v5.5"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>`,
  sun: `<circle ${STROKE} cx="12" cy="12" r="4"/><path ${STROKE} d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.55 1.55M17.55 17.55L19.1 19.1M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.55-1.55M17.55 6.45L19.1 4.9"/>`,
  moon: `<path ${STROKE} d="M20 14.2A8.5 8.5 0 1 1 9.8 4a6.8 6.8 0 0 0 10.2 10.2z"/>`,
  alert: `<path ${STROKE} d="M12 3.5L2.5 20h19z"/><path ${STROKE} d="M12 10v4"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>`,
  check: `<path ${STROKE} d="M5 12.5l4.5 4.5L19 7"/>`,
  zap: `<path ${STROKE} d="M12.5 3L5 13.5h5.5L11 21l7.5-10.5H13z"/>`,
  clock: `<circle ${STROKE} cx="12" cy="12" r="8.5"/><path ${STROKE} d="M12 7.5V12l3 2"/>`,
  "refresh-cw": `<path ${STROKE} d="M4 11a8 8 0 0 1 14-4.5M20 6v5h-5"/><path ${STROKE} d="M20 13a8 8 0 0 1-14 4.5M4 18v-5h5"/>`,
  history: `<path ${STROKE} d="M4 12a8 8 0 1 0 2.5-5.8"/><path ${STROKE} d="M4 4v4h4"/><path ${STROKE} d="M12 8v4l3 2"/>`,
  "arrow-right": `<path ${STROKE} d="M5 12h14M13 6l6 6-6 6"/>`,
  "arrow-left": `<path ${STROKE} d="M19 12H5M11 6l-6 6 6 6"/>`,
  settings: `<circle ${STROKE} cx="12" cy="12" r="3.2"/><circle ${STROKE} cx="12" cy="12" r="7.2"/>${_gearTeeth}`,
  "help-circle": `<circle ${STROKE} cx="12" cy="12" r="8.5"/><path ${STROKE} d="M9.2 9.3a2.8 2.8 0 1 1 3.9 2.6c-.8.4-1.1.9-1.1 1.7"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>`,
  palette: `<path ${STROKE} d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.5-.6 1.5-1.4 0-.4-.15-.7-.4-1-.25-.3-.4-.6-.4-1 0-.8.6-1.4 1.4-1.4h1.6a3.3 3.3 0 0 0 3.3-3.3C19 6.9 16 3.5 12 3.5z"/><circle cx="7.5" cy="10.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.5" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="16.5" cy="10.5" r="1.1" fill="currentColor" stroke="none"/>`,
  layout: `<rect ${STROKE} x="3.5" y="4" width="17" height="16" rx="1.5"/><path ${STROKE} d="M14.5 4v16"/>`,
  sparkles: `<path ${STROKE} d="M11 3l1.2 3.8L16 8l-3.8 1.2L11 13l-1.2-3.8L6 8l3.8-1.2z"/><path ${STROKE} d="M17.5 14l.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7z"/>`,
};

export function icon(name, { size = 18 } = {}) {
  const inner = PATHS[name];
  if (!inner) {
    console.warn(`icons.js: ícone "${name}" não existe.`);
    return "";
  }
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${inner}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
