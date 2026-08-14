import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer, hammerHeadPoint } from '../render/hammer';
import { FlyingLabels, SwingAnim, wobbleAngle } from '../render/motion';
import { RectObject, rectPerimeter, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { icon } from '../ui/icons';
import { clipFromObject, spawnFromClip } from '../core/clipboard';

const PX = 40; // пикселей на клетку (единичный квадрат)
const EDGE_HIT = 8;
const SEAM_HIT = 6;
const DRAG_THRESHOLD = 5;
const BAND_MIN = 6;

interface Pos { x: number; y: number } // scenePos: НИЖНИЙ ЛЕВЫЙ угол, px

type Gesture =
  | { type: 'edge-h' | 'edge-w'; obj: RectObject }
  | { type: 'body'; offsets: Map<string, Pos>; startX: number; startY: number; moved: boolean;
      rectId: string; wasSelected: boolean }
  | { type: 'band'; x0: number; y0: number; x1: number; y1: number; additive: boolean };

/**
 * Сцена «Площади»: прямоугольники на клетчатом поле.
 * Отрезок — прямоугольник нулевой высоты; экструзия за верхнюю кромку
 * превращает 1D в 2D. Резы по линиям сетки раскладывают произведение
 * в сумму площадей: (3+2)·3 = 3·3 + 2·3 читается прямо с картинки.
 */
export class AreaScene implements Scene {
  readonly id = 'area';
  readonly title = 'Площади';
  readonly sidebar: { tools?: boolean; objects?: boolean } = { objects: false };

  private ctx: SceneContext | null = null;
  /** Пан полотна (СКМ, как в GeoGebra): чистая презентация, мир бесконечен. */
  private readonly pan = { x: 0, y: 0 };
  private panDrag: { sx: number; sy: number; bx: number; by: number } | null = null;
  private unsubscribe: (() => void) | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  private canvasEl: HTMLElement | null = null;

  private gesture: Gesture | null = null;
  private readonly selection = new Set<string>();
  private card: HTMLElement | null = null;
  private cardRectId: string | null = null;
  private readonly outsideClick = (e: PointerEvent): void => {
    if (this.card && !this.card.hidden && !this.card.contains(e.target as Node)) {
      if ((e.target as HTMLElement).id !== 'stage') this.hideCard();
    }
  };
  private readonly swing = new SwingAnim();
  private readonly labels = new FlyingLabels();

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      for (const id of [...this.selection]) this.ctx.session.removeObject(id);
      this.selection.clear();
    }
    if (e.key === 'Escape') this.selection.clear();

    if ((e.ctrlKey || e.metaKey) && this.ctx) {
      const k = e.code; // физический код: работает на любой раскладке
      if (k === 'KeyC' || k === 'KeyX') {
        const rects = [...this.selection]
          .map((id) => this.ctx!.session.objects.get(id))
          .filter((o): o is RectObject => o?.kind === 'rect');
        if (!rects.length) return;
        e.preventDefault();
        const ax = Math.min(...rects.map((r) => this.ensurePos(r).x));
        const ay = Math.min(...rects.map((r) => this.ensurePos(r).y));
        this.ctx.clipboard.items = rects.flatMap((r) => {
          const p = this.ensurePos(r);
          const item = clipFromObject(r, p.x - ax, p.y - ay);
          return item ? [item] : [];
        });
        if (k === 'KeyX' && this.ctx.restrictions.construct) {
          for (const id of [...this.selection]) this.ctx.session.removeObject(id);
          this.selection.clear();
        }
      }
      if (k === 'KeyV' && this.ctx.restrictions.construct && this.ctx.clipboard.items.length) {
        e.preventDefault();
        const ax = this.pointer.inside ? this.pointer.x : PX * 3;
        const ay = this.pointer.inside ? this.pointer.y : PX * 8;
        this.selection.clear();
        for (const item of this.ctx.clipboard.items) {
          const obj = spawnFromClip(this.ctx.session, item);
          if (obj.kind === 'rect') {
            obj.scenePos.set(this.id, {
              x: Math.round((ax + item.dx) / PX) * PX,
              y: Math.round((ay + item.dy) / PX) * PX,
            });
            this.selection.add(obj.id);
          }
        }
      }
    }
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
    document.addEventListener('pointerdown', this.outsideClick);
    this.buildCard();
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'tool-rejected') {
        const obj = ctx.session.objects.get(e.objectId);
        if (obj?.kind === 'rect') this.labels.spawn('⛔', this.pointer.x, this.pointer.y - 30);
      }
      if (e.kind === 'object-removed') this.selection.delete(e.objectId);
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('pointerdown', this.outsideClick);
    this.card?.remove();
    this.card = null;
    if (this.canvasEl) this.canvasEl.style.cursor = '';
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.gesture = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Фигуры</h3>
      <div class="series-row">
        <label class="field">длина<input id="seg-len" value="5" /></label>
        <button id="spawn-seg" class="btn primary"><span class="ic">${icon('plus', 12)}</span>Отрезок</button>
      </div>
      <div class="series-row">
        <label class="field">ширина<input id="rect-w" value="5" /></label>
        <label class="field">высота<input id="rect-h" value="3" /></label>
        <button id="spawn-rect" class="btn primary"><span class="ic">${icon('plus', 12)}</span></button>
      </div>
      <p class="hint">Тяни верхнюю кромку — экструзия (отрезок станет прямоугольником).
        Клик по линии сетки внутри фигуры — рез, по резу — склейка.
        Площади кусков подписаны: рез превращает произведение в сумму.</p>
    `;
    root.querySelector<HTMLButtonElement>('#spawn-seg')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const len = Rational.parse(root.querySelector<HTMLInputElement>('#seg-len')!.value);
      if (len && len.sign() > 0) this.ctx.session.spawnRect(len, Rational.of(0));
    });
    root.querySelector<HTMLButtonElement>('#spawn-rect')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const w = Rational.parse(root.querySelector<HTMLInputElement>('#rect-w')!.value);
      const h = Rational.parse(root.querySelector<HTMLInputElement>('#rect-h')!.value);
      if (w && h && w.sign() > 0 && h.sign() >= 0) this.ctx.session.spawnRect(w, h);
    });
    return root;
  }

  private buildCard(): void {
    const host = document.querySelector('.stage-wrap');
    if (!host) return;
    this.card = document.createElement('div');
    this.card.className = 'tape-popup';
    this.card.hidden = true;
    this.card.innerHTML = `
      <div class="task-head"><b id="ar-title">Фигура</b>
        <span class="task-actions"><button id="ar-close" class="btn ghost" title="Закрыть">${icon('close', 12)}</button></span>
      </div>
      <label class="field tp-check"><input type="checkbox" id="ar-w" /> показывать ширину</label>
      <label class="field tp-check"><input type="checkbox" id="ar-h" /> показывать высоту</label>
      <label class="field tp-check"><input type="checkbox" id="ar-area" /> показывать площадь</label>
      <label class="field tp-check"><input type="checkbox" id="ar-perim" /> показывать периметр</label>
      <button id="ar-rotate" class="btn primary"><span class="ic">${icon('refresh', 13)}</span>Повернуть на 90°</button>
      <button id="ar-del" class="btn ghost"><span class="ic">${icon('trash', 13)}</span>Удалить фигуру</button>
    `;
    host.appendChild(this.card);
    const q = <T extends HTMLElement>(sel: string) => this.card!.querySelector<T>(sel)!;
    q('#ar-close').addEventListener('click', () => this.hideCard());
    // Галочки показа — применяются мгновенно (настройка вида, не математики)
    const bindFlag = (sel: string, apply: (r: RectObject, on: boolean) => void) => {
      q<HTMLInputElement>(sel).addEventListener('change', () => {
        const r = this.cardRect();
        if (r) apply(r, q<HTMLInputElement>(sel).checked);
      });
    };
    bindFlag('#ar-w', (r, on) => { r.showW = on; });
    bindFlag('#ar-h', (r, on) => { r.showH = on; });
    bindFlag('#ar-area', (r, on) => { r.showArea = on; });
    bindFlag('#ar-perim', (r, on) => { r.showPerimeter = on; });
    q('#ar-rotate').addEventListener('click', () => {
      const r = this.cardRect();
      if (r && this.ctx) this.ctx.session.rotateRect(r.id);
    });
    q('#ar-del').addEventListener('click', () => {
      const r = this.cardRect();
      if (r && this.ctx && this.ctx.restrictions.construct) {
        this.ctx.session.removeObject(r.id);
        this.hideCard();
      }
    });
  }

  private cardRect(): RectObject | null {
    if (!this.ctx || !this.cardRectId) return null;
    const o = this.ctx.session.objects.get(this.cardRectId);
    return o?.kind === 'rect' ? o : null;
  }

  private openCard(r: RectObject, x: number, y: number): void {
    if (!this.card || !this.ctx) return;
    this.cardRectId = r.id;
    const q = <T extends HTMLElement>(sel: string) => this.card!.querySelector<T>(sel)!;
    q('#ar-title').textContent = r.label;
    q<HTMLInputElement>('#ar-w').checked = r.showW;
    q<HTMLInputElement>('#ar-h').checked = r.showH;
    q<HTMLInputElement>('#ar-area').checked = r.showArea;
    q<HTMLInputElement>('#ar-perim').checked = r.showPerimeter;
    (q('#ar-rotate') as HTMLButtonElement).hidden = r.h.isZero(); // отрезку вертеться некуда
    (q('#ar-del') as HTMLButtonElement).hidden = !this.ctx.restrictions.construct;
    const host = this.card.parentElement!;
    this.card.hidden = false;
    const sx = x + this.pan.x;
    const sy = y + this.pan.y;
    this.card.style.left = `${Math.min(Math.max(sx, 10), host.clientWidth - 280)}px`;
    this.card.style.top = `${Math.min(Math.max(sy + 12, 10), host.clientHeight - 220)}px`;
  }

  private hideCard(): void {
    if (this.card) this.card.hidden = true;
    this.cardRectId = null;
  }

  // ---------- геометрия ----------

  private rects(): RectObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is RectObject => o.kind === 'rect');
  }

  private ensurePos(r: RectObject): Pos {
    let pos = r.scenePos.get(this.id);
    if (!pos) {
      const taken = this.rects()
        .map((o) => o.scenePos.get(this.id))
        .filter((p): p is Pos => !!p);
      for (let k = 0; k < 60; k++) {
        const x = PX * (2 + (k % 3) * 9);
        const y = PX * (7 + Math.floor(k / 3) * 7);
        if (!taken.some((p) => Math.abs(p.x - x) < PX * 6 && Math.abs(p.y - y) < PX * 5)) {
          pos = { x, y };
          break;
        }
      }
      pos = pos ?? { x: PX * 2, y: PX * 7 };
      r.scenePos.set(this.id, pos);
    }
    return pos;
  }

  private rectAt(x: number, y: number): RectObject | null {
    const list = this.rects();
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i]!;
      const p = this.ensurePos(r);
      const wPx = r.w.toNumber() * PX;
      const hPx = r.h.toNumber() * PX;
      const top = p.y - hPx;
      if (x >= p.x - 4 && x <= p.x + wPx + 4 && y >= top - 4 && y <= p.y + 6) return r;
    }
    return null;
  }

  /** Что под курсором у фигуры: кромка, рез, линия сетки или тело. */
  private hitPart(r: RectObject, x: number, y: number):
    | { part: 'edge-h' | 'edge-w' | 'body' }
    | { part: 'cut' | 'seam'; axis: 'x' | 'y'; pos: Rational }
    | null {
    const p = this.ensurePos(r);
    const wPx = r.w.toNumber() * PX;
    const hPx = r.h.toNumber() * PX;
    const top = p.y - hPx;

    // Верхняя кромка (у отрезка — ручка над серединой)
    if (r.h.isZero()) {
      if (Math.abs(y - p.y) <= EDGE_HIT + 4 && Math.abs(x - (p.x + wPx / 2)) <= 22) return { part: 'edge-h' };
    } else if (Math.abs(y - top) <= EDGE_HIT && x >= p.x && x <= p.x + wPx) {
      return { part: 'edge-h' };
    }
    // Правая кромка
    if (Math.abs(x - (p.x + wPx)) <= EDGE_HIT && y >= top && y <= p.y && !r.h.isZero()) {
      return { part: 'edge-w' };
    }
    if (x < p.x - 4 || x > p.x + wPx + 4 || y < top - 4 || y > p.y + 4) return null;

    // Существующие резы
    for (const c of r.cutsX) {
      if (Math.abs(x - (p.x + c.toNumber() * PX)) <= SEAM_HIT) return { part: 'cut', axis: 'x', pos: c };
    }
    for (const c of r.cutsY) {
      if (Math.abs(y - (p.y - c.toNumber() * PX)) <= SEAM_HIT) return { part: 'cut', axis: 'y', pos: c };
    }
    // Линии сетки (целые) внутри фигуры
    if (!r.h.isZero()) {
      const kx = Math.round((x - p.x) / PX);
      if (kx >= 1 && kx < r.w.toNumber() && Math.abs(x - (p.x + kx * PX)) <= SEAM_HIT) {
        return { part: 'seam', axis: 'x', pos: Rational.of(kx) };
      }
      const ky = Math.round((p.y - y) / PX);
      if (ky >= 1 && ky < r.h.toNumber() && Math.abs(y - (p.y - ky * PX)) <= SEAM_HIT) {
        return { part: 'seam', axis: 'y', pos: Rational.of(ky) };
      }
    }
    return { part: 'body' };
  }

  // ---------- ввод ----------

  onPointerDown(raw: { x: number; y: number; button: number; shift?: boolean }): void {
    if (raw.button === 1) {
      this.panDrag = { sx: raw.x, sy: raw.y, bx: this.pan.x, by: this.pan.y };
      return;
    }
    const p = { ...raw, x: raw.x - this.pan.x, y: raw.y - this.pan.y };
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };

    if (p.button === 2) {
      this.ctx.dropHand();
      return;
    }
    if (p.button !== 0) return;

    if (this.ctx.hand.toolId) {
      const head = hammerHeadPoint(p.x, p.y);
      const target = this.rectAt(head.x, head.y) ?? this.rectAt(p.x, p.y);
      if (target) {
        this.swing.start();
        this.ctx.hit(target.id); // числовой молоток по фигуре — честный отказ
      }
      return;
    }

    this.hideCard();

    const r = this.rectAt(p.x, p.y);
    if (r) {
      const hit = this.hitPart(r, p.x, p.y);
      if (hit?.part === 'edge-h' || hit?.part === 'edge-w') {
        this.gesture = { type: hit.part, obj: r };
        return;
      }
      if (hit?.part === 'cut') {
        if (this.ctx.session.mergeRect(r.id, hit.axis, hit.pos)) this.labels.spawn('∪', p.x, p.y - 24);
        return;
      }
      if (hit?.part === 'seam') {
        if (this.ctx.session.cutRect(r.id, hit.axis, hit.pos)) this.labels.spawn('✂', p.x, p.y - 24);
        return;
      }
      // Тело: выделение и групповое перетаскивание
      if (p.shift) {
        if (this.selection.has(r.id)) this.selection.delete(r.id);
        else this.selection.add(r.id);
        return;
      }
      const wasSelected = this.selection.has(r.id);
      if (!wasSelected) {
        this.selection.clear();
        this.selection.add(r.id);
      }
      const offsets = new Map<string, Pos>();
      for (const id of this.selection) {
        const obj = this.ctx.session.objects.get(id);
        const sp = obj?.kind === 'rect' ? obj.scenePos.get(this.id) : undefined;
        if (sp) offsets.set(id, { x: p.x - sp.x, y: p.y - sp.y });
      }
      this.gesture = { type: 'body', offsets, startX: p.x, startY: p.y, moved: false, rectId: r.id, wasSelected };
      return;
    }

    this.gesture = { type: 'band', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: !!p.shift };
  }

  onPointerMove(raw: { x: number; y: number; button: number }): void {
    if (this.panDrag) {
      this.pan.x = this.panDrag.bx + (raw.x - this.panDrag.sx);
      this.pan.y = this.panDrag.by + (raw.y - this.panDrag.sy);
      return;
    }
    const p = { ...raw, x: raw.x - this.pan.x, y: raw.y - this.pan.y };
    this.pointer = { x: p.x, y: p.y, inside: true };
    const g = this.gesture;
    if (!g || !this.ctx) return;

    if (g.type === 'edge-h') {
      const pos = this.ensurePos(g.obj);
      const h = Rational.of(Math.round(((pos.y - p.y) / PX) * 2), 2);
      this.ctx.session.setRectSize(g.obj.id, g.obj.w, h, false);
    } else if (g.type === 'edge-w') {
      const pos = this.ensurePos(g.obj);
      const w = Rational.of(Math.round(((p.x - pos.x) / PX) * 2), 2);
      this.ctx.session.setRectSize(g.obj.id, w, g.obj.h, false);
    } else if (g.type === 'body') {
      if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) > DRAG_THRESHOLD) g.moved = true;
      if (g.moved) {
        for (const [id, off] of g.offsets) {
          const obj = this.ctx.session.objects.get(id);
          obj?.scenePos.set(this.id, { x: p.x - off.x, y: p.y - off.y });
        }
      }
    } else if (g.type === 'band') {
      g.x1 = p.x;
      g.y1 = p.y;
    }
  }

  onPointerUp(_p: { x: number; y: number; button: number }): void {
    if (this.panDrag) {
      this.panDrag = null;
      return;
    }
    const g = this.gesture;
    this.gesture = null;
    if (!g || !this.ctx) return;

    if (g.type === 'edge-h' || g.type === 'edge-w') {
      // фиксация размеров: одна запись в журнал
      this.ctx.session.setRectSize(g.obj.id, g.obj.w, g.obj.h, true);
      return;
    }
    if (g.type === 'body' && !g.moved && g.wasSelected) {
      const r = this.ctx.session.objects.get(g.rectId);
      if (r?.kind === 'rect') this.openCard(r, this.pointer.x, this.pointer.y);
      return;
    }
    if (g.type === 'body' && g.moved) {
      // прищёлкиваем к сетке, чтобы резы совпадали с фоновыми линиями
      for (const id of g.offsets.keys()) {
        const obj = this.ctx.session.objects.get(id);
        const sp = obj?.kind === 'rect' ? obj.scenePos.get(this.id) : undefined;
        if (obj && sp) {
          obj.scenePos.set(this.id, { x: Math.round(sp.x / PX) * PX, y: Math.round(sp.y / PX) * PX });
        }
      }
      return;
    }
    if (g.type === 'band') {
      const x0 = Math.min(g.x0, g.x1);
      const x1 = Math.max(g.x0, g.x1);
      const y0 = Math.min(g.y0, g.y1);
      const y1 = Math.max(g.y0, g.y1);
      if (!g.additive) this.selection.clear();
      if (x1 - x0 > BAND_MIN || y1 - y0 > BAND_MIN) {
        for (const r of this.rects()) {
          const p = this.ensurePos(r);
          const wPx = r.w.toNumber() * PX;
          const hPx = r.h.toNumber() * PX;
          if (p.x + wPx >= x0 && p.x <= x1 && p.y >= y0 && p.y - hPx <= y1) this.selection.add(r.id);
        }
      }
    }
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    g.save();
    g.translate(this.pan.x, this.pan.y);
    this.renderWorld(g, w, h, dt, now);
    g.restore();
  }

  private renderWorld(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;

    // Клетчатое поле
    g.strokeStyle = theme.grid;
    g.lineWidth = 1;
    for (let x = 0; x < w; x += PX) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y < h; y += PX) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

    for (const r of this.rects()) this.drawRect(g, r);

    // Рамка выделения
    if (this.gesture?.type === 'band') {
      const b = this.gesture;
      g.save();
      g.fillStyle = 'rgba(40, 220, 120, 0.08)';
      g.strokeStyle = theme.accentBorder;
      g.lineWidth = 1;
      g.setLineDash([5, 5]);
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.restore();
    }

    this.labels.update(dt);
    this.labels.draw(g, theme.gold);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    if (hand && this.pointer.inside) {
      const swingAngle = this.swing.update(dt);
      drawHammer(g, this.pointer.x, this.pointer.y, swingAngle !== 0 ? swingAngle : wobbleAngle(now), visibleLabel(hand));
    }

    this.updateCursor(hand !== null);
  }

  private updateCursor(hasHand: boolean): void {
    this.canvasEl ??= document.getElementById('stage');
    if (!this.canvasEl) return;
    let cursor = '';
    const gt = this.gesture?.type;
    if (gt === 'edge-h') cursor = 'ns-resize';
    else if (gt === 'edge-w') cursor = 'ew-resize';
    else if (gt === 'body') cursor = 'grabbing';
    else if (!hasHand && this.pointer.inside) {
      const r = this.rectAt(this.pointer.x, this.pointer.y);
      const hit = r ? this.hitPart(r, this.pointer.x, this.pointer.y) : null;
      if (hit?.part === 'edge-h') cursor = 'ns-resize';
      else if (hit?.part === 'edge-w') cursor = 'ew-resize';
      else if (hit?.part === 'cut' || hit?.part === 'seam') cursor = 'pointer';
      else if (hit?.part === 'body') cursor = 'grab';
    }
    this.canvasEl.style.cursor = cursor;
  }

  private drawRect(g: CanvasRenderingContext2D, r: RectObject): void {
    const p = this.ensurePos(r);
    const wPx = r.w.toNumber() * PX;
    const hPx = r.h.toNumber() * PX;
    const top = p.y - hPx;
    const selected = this.selection.has(r.id);

    if (r.h.isZero()) {
      // Отрезок: жирная линия + ручка экструзии
      g.strokeStyle = selected ? theme.textPrimary : theme.boxStroke(1);
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x + wPx, p.y);
      g.stroke();
      // ручка ↑ над серединой
      const cx = p.x + wPx / 2;
      g.strokeStyle = theme.accentBorder;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx, p.y - 4);
      g.lineTo(cx, p.y - 16);
      g.moveTo(cx - 5, p.y - 11);
      g.lineTo(cx, p.y - 16);
      g.lineTo(cx + 5, p.y - 11);
      g.stroke();
    } else {
      g.fillStyle = theme.boxFill(1);
      g.globalAlpha = 0.85;
      g.fillRect(p.x, top, wPx, hPx);
      g.globalAlpha = 1;

      // внутренняя клетка — «сколько клеток внутри» считается глазами
      g.strokeStyle = 'rgba(90, 255, 170, 0.12)';
      g.lineWidth = 1;
      for (let k = 1; k < r.w.toNumber(); k++) {
        g.beginPath(); g.moveTo(p.x + k * PX, top); g.lineTo(p.x + k * PX, p.y); g.stroke();
      }
      for (let k = 1; k < r.h.toNumber(); k++) {
        g.beginPath(); g.moveTo(p.x, p.y - k * PX); g.lineTo(p.x + wPx, p.y - k * PX); g.stroke();
      }

      g.strokeStyle = selected ? theme.textPrimary : theme.boxStroke(1);
      g.lineWidth = selected ? 3 : 2;
      if (selected) { g.shadowColor = theme.textPrimary; g.shadowBlur = 10; }
      g.strokeRect(p.x, top, wPx, hPx);
      g.shadowBlur = 0;

      // Резы — сплошные тёмные линии
      g.strokeStyle = theme.bgPrimary;
      g.lineWidth = 3;
      for (const c of r.cutsX) {
        const x = p.x + c.toNumber() * PX;
        g.beginPath(); g.moveTo(x, top - 3); g.lineTo(x, p.y + 3); g.stroke();
      }
      for (const c of r.cutsY) {
        const y = p.y - c.toNumber() * PX;
        g.beginPath(); g.moveTo(p.x - 3, y); g.lineTo(p.x + wPx + 3, y); g.stroke();
      }

      // Площади кусков
      const xs = [Rational.of(0), ...r.cutsX, r.w];
      const ys = [Rational.of(0), ...r.cutsY, r.h];
      g.fillStyle = theme.textPrimary;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      if (r.showArea) for (let row = 0; row < ys.length - 1; row++) {
        for (let col = 0; col < xs.length - 1; col++) {
          const cw = xs[col + 1]!.sub(xs[col]!);
          const ch = ys[row + 1]!.sub(ys[row]!);
          const pieceW = cw.toNumber() * PX;
          const pieceH = ch.toNumber() * PX;
          if (pieceW < 26 || pieceH < 20) continue;
          const cx = p.x + (xs[col]!.toNumber() + cw.toNumber() / 2) * PX;
          const cy = p.y - (ys[row]!.toNumber() + ch.toNumber() / 2) * PX;
          g.font = `bold ${Math.min(pieceW, pieceH) < 44 ? 12 : 16}px Inter, sans-serif`;
          g.fillText(cw.mul(ch).toDisplay(), cx, cy);
        }
      }

      // Сегменты сторон: ширины снизу, высоты слева
      g.fillStyle = theme.accent;
      g.font = 'bold 12px Inter, sans-serif';
      if (r.showW) for (let col = 0; col < xs.length - 1; col++) {
        const cw = xs[col + 1]!.sub(xs[col]!);
        const cx = p.x + (xs[col]!.toNumber() + cw.toNumber() / 2) * PX;
        g.fillText(cw.toDisplay(), cx, p.y + 12);
      }
      if (r.showH) for (let row = 0; row < ys.length - 1; row++) {
        const ch = ys[row + 1]!.sub(ys[row]!);
        const cy = p.y - (ys[row]!.toNumber() + ch.toNumber() / 2) * PX;
        g.fillText(ch.toDisplay(), p.x - 14, cy);
      }

      // Периметр («забор») — по запросу, под фигурой
      if (r.showPerimeter) {
        g.fillStyle = theme.gold;
        g.font = 'bold 12px Inter, sans-serif';
        g.fillText(`P = ${rectPerimeter(r).toDisplay()}`, p.x + (r.w.toNumber() * PX) / 2, p.y + 28);
      }
    }

    // Отрезок: подпись длины
    if (r.h.isZero()) {
      g.fillStyle = theme.accent;
      g.font = 'bold 12px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(r.w.toDisplay(), p.x + wPx / 2, p.y + 12);
    }

    // Имя фигуры
    g.fillStyle = theme.textSecondary;
    g.globalAlpha = 0.7;
    g.font = '11px Inter, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillText(r.label, p.x, (r.h.isZero() ? p.y : top) - 4);
    g.globalAlpha = 1;

  }
}
