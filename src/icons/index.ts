/**
 * Значки ООМ. Все, кроме молотка, — из набора Klaarheid Icons, вариант
 * «контур заливкой» (svg/fill набора): файлы в ./klaarheid/ — копии байт
 * в байт, их обновляет tools/sync-icons.mjs. Молоток — двухцветный рисунок
 * ООМ (./hammer.svg, он же значок вкладки).
 *
 * Потребителей три: разметка для DOM (icon, data-icon), фигуры для холста
 * (drawIcon, fillRichText — через Path2D) и пиктограммы-метки в текстах
 * (PICTOGRAMS): ядро и учебник пишут в субтитры и задания «📍», «⭐», «↺»,
 * а на экран вместо символа шрифта выходит значок набора.
 */
import { KLAARHEID_NAMES } from './names';

export type IconName = (typeof KLAARHEID_NAMES)[number] | 'hammer';

interface IconData {
  viewBox: string;
  /** minX, minY, ширина, высота — из viewBox */
  box: [number, number, number, number];
  /** разметка внутри <svg> как в файле */
  body: string;
  /** пути для холста; fill null — currentColor */
  paths: { d: string; fill: string | null }[];
}

const FILES = import.meta.glob<string>(['./klaarheid/*.svg', './hammer.svg'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag);
  return m ? m[1]! : null;
}

function parseIcon(file: string, text: string): IconData {
  const root = /<svg\b[^>]*>/u.exec(text);
  const viewBox = root ? attr(root[0], 'viewBox') : null;
  if (!root || !viewBox) throw new Error(`значок ${file}: нет <svg> с viewBox`);
  const box = viewBox.trim().split(/[\s,]+/u).map(Number);
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v)) || box[2]! <= 0 || box[3]! <= 0) {
    throw new Error(`значок ${file}: странный viewBox «${viewBox}»`);
  }
  const body = text.slice(root.index + root[0].length, text.lastIndexOf('</svg>')).trim();
  // только пути: иначе холст нарисует не то, что DOM
  if (body.replace(/<path\b[^>]*\/>/gu, '').trim()) {
    throw new Error(`значок ${file}: кроме <path> в нём есть другие элементы`);
  }
  const paths = [...body.matchAll(/<path\b[^>]*\/>/gu)].map((m) => {
    const d = attr(m[0], 'd');
    if (!d) throw new Error(`значок ${file}: <path> без d`);
    const fill = attr(m[0], 'fill');
    return { d, fill: !fill || fill === 'currentColor' ? null : fill };
  });
  return { viewBox, box: box as [number, number, number, number], body, paths };
}

const ICONS = new Map<string, IconData>();
for (const [file, text] of Object.entries(FILES)) {
  ICONS.set(file.replace(/^.*\//u, '').replace(/\.svg$/u, ''), parseIcon(file, text));
}
for (const name of [...KLAARHEID_NAMES, 'hammer']) {
  if (!ICONS.has(name)) throw new Error(`значок ${name}: файла нет — запустите npm run icons:sync`);
}

/** Есть ли такой значок (для имён из разметки, которые не проверит компилятор). */
export function isIconName(name: string): name is IconName {
  return ICONS.has(name);
}

// ---------- DOM ----------

/** SVG-разметка значка; цвет — currentColor (у молотка — свои два цвета). */
export function icon(name: IconName, size = 16): string {
  const d = ICONS.get(name)!;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="${d.viewBox}" aria-hidden="true">${d.body}</svg>`;
}

/** Заполняет элементы с data-icon="имя" (+ data-icon-size) значками. */
export function applyIcons(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon!;
    if (isIconName(name)) el.innerHTML = icon(name, Number(el.dataset.iconSize ?? 16));
  });
}

// ---------- холст ----------

const PATH2D = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = PATH2D.get(d);
  if (!p) {
    p = new Path2D(d);
    PATH2D.set(d, p);
  }
  return p;
}

/** Значок на холсте: центр (cx; cy), сторона size; color заменяет currentColor. */
export function drawIcon(
  g: CanvasRenderingContext2D,
  name: IconName,
  cx: number,
  cy: number,
  size: number,
  color: string | CanvasGradient | CanvasPattern,
): void {
  const d = ICONS.get(name)!;
  const [minX, minY, w, h] = d.box;
  const s = size / Math.max(w, h);
  g.save();
  g.translate(cx - (w * s) / 2 - minX * s, cy - (h * s) / 2 - minY * s);
  g.scale(s, s);
  for (const p of d.paths) {
    g.fillStyle = p.fill ?? color;
    g.fill(path2d(p.d));
  }
  g.restore();
}

/**
 * fillText, понимающий метки: на месте метки рисуется значок размером
 * с шрифт size. Выравнивание — по g.textAlign и g.textBaseline, цвет —
 * g.fillStyle.
 */
export function fillRichText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number): void {
  const runs = pictogramRuns(text);
  if (runs.every((r) => 'text' in r)) {
    g.fillText(text, x, y);
    return;
  }
  const iconW = size * 1.1;
  const widths = runs.map((r) => ('text' in r ? g.measureText(r.text).width : iconW));
  const total = widths.reduce((a, b) => a + b, 0);
  const align = g.textAlign;
  let cx = align === 'center' ? x - total / 2 : align === 'right' || align === 'end' ? x - total : x;
  const base = g.textBaseline;
  const iy = base === 'middle' ? y
    : base === 'top' || base === 'hanging' ? y + size / 2
    : base === 'alphabetic' ? y - size * 0.35
    : y - size / 2;
  const color = g.fillStyle;
  g.save();
  g.textAlign = 'left';
  runs.forEach((r, i) => {
    if ('text' in r) g.fillText(r.text, cx, y);
    else drawIcon(g, r.icon, cx + iconW / 2, iy, size, color);
    cx += widths[i]!;
  });
  g.restore();
}

// ---------- пиктограммы-метки в текстах ----------

/**
 * Метки → значки. Ядро, читалка и учебник пишут в тексты эти символы,
 * а показывают их значками: так пиктограмма не зависит от шрифтов
 * школьного компьютера. Одна метка — один смысл: отмена (↶) и поворот
 * (↺ ↻) — разные символы, зеркала различают ось (↕ — от оси X, ↔ — от Y).
 */
export const PICTOGRAMS: Readonly<Record<string, IconName>> = {
  // ходы и события ядра
  '↶': 'undo',
  '⚒': 'hammer',
  '⛔': 'ban',
  '📍': 'map-pin',
  '↗': 'arrow-up-right',
  '➕': 'plus',
  '↕': 'flip-vertical',
  '↔': 'flip-horizontal',
  '↺': 'rotate-ccw',
  '↻': 'rotate-cw',
  '⬠': 'pentagon',
  '⊙': 'circle-dot',
  '📦': 'cube',
  '⚙': 'square-function',
  '⚖': 'scale',
  '🔓': 'lock-open',
  '⇄': 'arrow-left-right',
  '✂': 'scissors',
  // читалка и оболочка
  '🎯': 'target',
  '🎉': 'party-popper',
  '✅': 'circle-check',
  '💥': 'circle-x',
  '🧪': 'flask-conical',
  '💡': 'bulb',
  '✓': 'check',
  '✗': 'x',
  '✕': 'x',
  '💾': 'save',
  '📂': 'folder-open',
  '⤓': 'download',
  '⤒': 'upload',
  '📤': 'copy',
  // учебник
  '⭐': 'star-fill',
  '▶': 'play',
};

const MARKERS = Object.keys(PICTOGRAMS).map((m) => m.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
/** Метка и, если есть, селектор варианта эмодзи после неё. */
const PICTO_ALL = new RegExp(`(${MARKERS})\\uFE0F?`, 'gu');
const PICTO_ANY = new RegExp(`(?:${MARKERS})`, 'u');

/** Разбивка текста на куски: обычный текст и значки на месте меток. */
export function pictogramRuns(text: string): ({ text: string } | { icon: IconName })[] {
  const runs: ({ text: string } | { icon: IconName })[] = [];
  let last = 0;
  for (const m of text.matchAll(PICTO_ALL)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    runs.push({ icon: PICTOGRAMS[m[1]!]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** Там, где разметки быть не может: текст остаётся текстом. */
const PLAIN_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'OPTION', 'TITLE']);

/** Меняет метки в текстовых узлах поддерева на значки (span.pic[data-pic]). */
export function decoratePictograms(root: Node): void {
  const texts: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) {
    texts.push(root as Text);
  } else if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
  }
  for (const t of texts) {
    if (!PICTO_ANY.test(t.data)) continue;
    const parent = t.parentElement;
    if (!parent || PLAIN_TEXT_PARENTS.has(parent.tagName) || parent.closest('svg')) continue;
    const frag = document.createDocumentFragment();
    for (const r of pictogramRuns(t.data)) {
      if ('text' in r) {
        frag.append(r.text);
      } else {
        const span = document.createElement('span');
        span.className = 'pic';
        span.dataset.pic = r.icon;
        span.innerHTML = icon(r.icon);
        frag.append(span);
      }
    }
    t.replaceWith(frag);
  }
}

/** Следит за поддеревом: всякий новый текст с метками получает значки. */
export function watchPictograms(root: Node): MutationObserver {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') decoratePictograms(r.target);
      else r.addedNodes.forEach((n) => decoratePictograms(n));
    }
  });
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  return observer;
}
