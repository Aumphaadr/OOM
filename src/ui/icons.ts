/**
 * Фирменный набор инлайн-SVG иконок: уверенный контур 2.4px + залитые тела
 * у «предметных» иконок и залитые наконечники у стрелок. Сетка 24×24,
 * цвет — currentColor (наследуется от кнопки).
 * Статические элементы помечаются data-icon="имя" (+ data-icon-size),
 * динамические вставляют icon(...) прямо в разметку.
 */
export type IconName =
  | 'menu' | 'book' | 'export' | 'save' | 'open' | 'history' | 'undo'
  | 'close' | 'plus' | 'minus' | 'hammer' | 'trash' | 'play' | 'target'
  | 'check' | 'bulb' | 'refresh' | 'chevron-left' | 'chevron-right'
  | 'scales' | 'swap';

const F = 'fill="currentColor" stroke="none"';

const PATHS: Record<IconName, string> = {
  menu:
    '<line x1="4" y1="6.4" x2="20" y2="6.4" stroke-width="2.6"/>' +
    '<line x1="4" y1="12" x2="20" y2="12" stroke-width="2.6"/>' +
    '<line x1="4" y1="17.6" x2="20" y2="17.6" stroke-width="2.6"/>',

  hammer:
    `<rect x="3.5" y="6.4" width="11" height="5.2" rx="1.8" transform="rotate(-45 9 9)" ${F}/>` +
    '<line x1="11.6" y1="11.6" x2="19.6" y2="19.6" stroke-width="3.4"/>',

  book:
    `<path d="M4 5.4C6.5 4.3 9.8 4.7 11.2 6v13.3C9.8 18.1 6.5 17.7 4 18.7z" ${F}/>` +
    `<path d="M20 5.4C17.5 4.3 14.2 4.7 12.8 6v13.3c1.4-1.2 4.7-1.6 7.2-.6z" ${F}/>`,

  export:
    '<path d="M4.6 14.6v3.8a1.7 1.7 0 0 0 1.7 1.7h11.4a1.7 1.7 0 0 0 1.7-1.7v-3.8"/>' +
    '<line x1="12" y1="6" x2="12" y2="14.6"/>' +
    `<polygon points="12,2.2 16.4,7.4 7.6,7.4" ${F}/>`,

  save:
    '<path d="M4.6 14.6v3.8a1.7 1.7 0 0 0 1.7 1.7h11.4a1.7 1.7 0 0 0 1.7-1.7v-3.8"/>' +
    '<line x1="12" y1="3.6" x2="12" y2="10.4"/>' +
    `<polygon points="12,15 16.4,9.8 7.6,9.8" ${F}/>`,

  open:
    `<path d="M3 6.8a1.7 1.7 0 0 1 1.7-1.7h4.1l2 2.3h8.5A1.7 1.7 0 0 1 21 9.1v8.8a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 17.9z" ${F}/>`,

  history:
    '<path d="M12 4a8 8 0 1 0 8 8"/>' +
    `<polygon points="13.2,0.8 13.2,7.2 7.4,4" ${F}/>`,

  refresh:
    '<path d="M12 4a8 8 0 1 1-8 8"/>' +
    `<polygon points="10.8,0.8 10.8,7.2 16.6,4" ${F}/>`,

  undo:
    '<path d="M5.4 10h8.2a4.9 4.9 0 0 1 0 9.8H9.4"/>' +
    `<polygon points="9.2,5.4 9.2,14.6 2.2,10" ${F}/>`,

  close:
    '<line x1="6" y1="6" x2="18" y2="18" stroke-width="2.6"/>' +
    '<line x1="18" y1="6" x2="6" y2="18" stroke-width="2.6"/>',

  plus:
    '<line x1="12" y1="4.8" x2="12" y2="19.2" stroke-width="2.6"/>' +
    '<line x1="4.8" y1="12" x2="19.2" y2="12" stroke-width="2.6"/>',

  minus: '<line x1="4.8" y1="12" x2="19.2" y2="12" stroke-width="2.6"/>',

  trash:
    `<path d="M6.1 8.6h11.8l-.9 10.4a1.9 1.9 0 0 1-1.9 1.7H8.9A1.9 1.9 0 0 1 7 19z" ${F}/>` +
    '<line x1="4.4" y1="6" x2="19.6" y2="6"/>' +
    '<path d="M9.4 6V4.4a1.1 1.1 0 0 1 1.1-1.1h3a1.1 1.1 0 0 1 1.1 1.1V6"/>',

  play:
    `<path d="M8 5.2v13.6a1 1 0 0 0 1.55.84l10-6.8a1 1 0 0 0 0-1.68l-10-6.8A1 1 0 0 0 8 5.2z" ${F}/>`,

  target:
    '<circle cx="12" cy="12" r="6.6"/>' +
    `<circle cx="12" cy="12" r="2.2" ${F}/>` +
    '<line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>' +
    '<line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>',

  check: '<polyline points="4.5 13 9.8 18.2 19.5 6.5" stroke-width="3"/>',

  bulb:
    `<path d="M12 2.6a6.5 6.5 0 0 1 4.05 11.6c-.76.62-1.07 1.5-1.17 2.5h-5.76c-.1-1-.41-1.88-1.17-2.5A6.5 6.5 0 0 1 12 2.6z" ${F}/>` +
    '<line x1="9.5" y1="19.6" x2="14.5" y2="19.6"/>' +
    '<line x1="10.5" y1="22" x2="13.5" y2="22"/>',

  'chevron-left': '<polyline points="14.5 5.5 8 12 14.5 18.5" stroke-width="3"/>',
  'chevron-right': '<polyline points="9.5 5.5 16 12 9.5 18.5" stroke-width="3"/>',

  scales:
    '<line x1="12" y1="4.6" x2="12" y2="18.6"/>' +
    '<line x1="8" y1="20" x2="16" y2="20" stroke-width="2.6"/>' +
    '<line x1="4.8" y1="6.6" x2="19.2" y2="6.6"/>' +
    `<path d="M5 6.6 2 12.6a3.3 3.3 0 0 0 6 0z" ${F}/>` +
    `<path d="M19 6.6l-3 6a3.3 3.3 0 0 0 6 0z" ${F}/>` +
    `<circle cx="12" cy="4.4" r="1.5" ${F}/>`,

  swap:
    '<line x1="4.4" y1="8" x2="15.6" y2="8"/>' +
    `<polygon points="15,4.6 20.6,8 15,11.4" ${F}/>` +
    '<line x1="19.6" y1="16" x2="8.4" y2="16"/>' +
    `<polygon points="9,12.6 3.4,16 9,19.4" ${F}/>`,
};

export function icon(name: IconName, size = 16): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

/** Заполняет все элементы с data-icon соответствующими SVG. */
export function applyIcons(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName;
    if (name in PATHS) el.innerHTML = icon(name, Number(el.dataset.iconSize ?? 16));
  });
}
