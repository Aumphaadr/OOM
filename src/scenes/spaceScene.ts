import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer } from '../render/hammer';
import { FlyingLabels, wobbleAngle } from '../render/motion';
import { CuboidObject, cuboidDims, cuboidVolume, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { icon } from '../ui/icons';

const S = 34; // пикселей на ребро кубика
const HANDLE_R = 9;
const DRAG_THRESHOLD = 4;

/** Изометрические оси (z вверх, ракурс фиксирован — чертёжный). */
const EX = { x: 0.866, y: 0.5 };
const EY = { x: -0.866, y: 0.5 };
const EZ = { x: 0, y: -1 };

type Pt = { x: number; y: number };

/**
 * Сцена «Объёмы» (docs/design-space.md): третья ступень экструзии —
 * отрезок → площадка → кубоид. Изометрия на Canvas 2D, без вращения камеры.
 * Объём читается по этажам: этаж w·d кубиков, этажей h.
 */
export class SpaceScene implements Scene {
  readonly id = 'space';
  readonly title = 'Объёмы';
  readonly sidebar: { tools?: boolean; objects?: boolean } = { objects: false };

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private widthPx = 800;
  private heightPx = 600;

  private readonly selection = new Set<string>();
  private gesture:
    | { type: 'size'; id: string; axis: 'w' | 'd' | 'h'; startSx: number; startSy: number;
        base: { w: Rational; d: Rational; h: Rational }; moved: boolean }
    | { type: 'move'; id: string; grabDX: number; grabDY: number; startSx: number; startSy: number;
        moved: boolean; wasSelected: boolean }
    | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  private showSlice = false;
  private sliceLevel = 1;
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
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'object-removed') this.selection.delete(e.objectId);
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.gesture = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Тела</h3>
      <div class="series-row">
        <label class="field">w<input id="cb-w" value="4" /></label>
        <label class="field">d<input id="cb-d" value="3" /></label>
        <label class="field">h<input id="cb-h" value="2" /></label>
        <button id="cb-spawn" class="btn primary"><span class="ic">${icon('plus', 12)}</span>Кубоид</button>
      </div>
      <label class="field tp-check"><input type="checkbox" id="cb-sizes" checked /> подписывать размеры</label>
      <label class="field tp-check"><input type="checkbox" id="cb-volume" /> подписывать объём (по этажам)</label>
      <div class="series-row">
        <label class="field tp-check" style="flex:2"><input type="checkbox" id="cb-slice" /> томограф: срез этажа</label>
        <label class="field">№<input id="cb-slice-k" value="1" /></label>
      </div>
      <p class="hint">Тяни кромки-ручки: ширину, глубину, высоту. Нулевая глубина —
        отрезок, нулевая высота — площадка: лесенка «отрезок → площадка → кубоид».
        Молотки ×k и ÷k масштабируют все рёбра — смотри, что делается с объёмом.</p>
    `;
    root.querySelector<HTMLButtonElement>('#cb-spawn')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const w = Rational.parse(root.querySelector<HTMLInputElement>('#cb-w')!.value);
      const d = Rational.parse(root.querySelector<HTMLInputElement>('#cb-d')!.value);
      const h = Rational.parse(root.querySelector<HTMLInputElement>('#cb-h')!.value);
      if (!w || !d || !h) return;
      const c = this.ctx.session.spawnCuboid(w, d, h);
      // подхватываем текущие галки подписей
      const sizes = root.querySelector<HTMLInputElement>('#cb-sizes')!.checked;
      c.showW = sizes; c.showD = sizes; c.showH = sizes;
      c.showVolume = root.querySelector<HTMLInputElement>('#cb-volume')!.checked;
      const n = this.cuboids().length - 1;
      c.scenePos.set(this.id, { x: 200 + n * 60, y: 300 + n * 30 });
      this.selection.clear();
      this.selection.add(c.id);
    });
    const applyChecks = (): void => {
      const sizes = root.querySelector<HTMLInputElement>('#cb-sizes')!.checked;
      const vol = root.querySelector<HTMLInputElement>('#cb-volume')!.checked;
      for (const c of this.cuboids()) {
        c.showW = sizes; c.showD = sizes; c.showH = sizes;
        c.showVolume = vol;
      }
    };
    root.querySelector<HTMLInputElement>('#cb-sizes')!.addEventListener('change', applyChecks);
    root.querySelector<HTMLInputElement>('#cb-volume')!.addEventListener('change', applyChecks);
    root.querySelector<HTMLInputElement>('#cb-slice')!.addEventListener('change', (e) => {
      this.showSlice = (e.target as HTMLInputElement).checked;
    });
    root.querySelector<HTMLInputElement>('#cb-slice-k')!.addEventListener('change', (e) => {
      const v = Rational.parse((e.target as HTMLInputElement).value);
      if (v) this.sliceLevel = Math.max(1, Math.round(v.toNumber()));
    });
    return root;
  }

  // ---------- геометрия ----------

  private cuboids(): CuboidObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is CuboidObject => o.kind === 'cuboid');
  }

  private anchorOf(c: CuboidObject): Pt {
    const saved = c.scenePos.get(this.id);
    if (saved) return saved;
    const a = { x: this.widthPx * 0.45, y: this.heightPx * 0.62 };
    c.scenePos.set(this.id, a);
    return a;
  }

  /** Мир (x — ширина, y — глубина, z — этажи) → экран. */
  private iso(c: CuboidObject, x: number, y: number, z: number): Pt {
    const a = this.anchorOf(c);
    return {
      x: a.x + (x * EX.x + y * EY.x) * S,
      y: a.y + (x * EX.y + y * EY.y) * S + z * EZ.y * S,
    };
  }

  private handles(c: CuboidObject): { axis: 'w' | 'd' | 'h'; p: Pt }[] {
    const w = c.w.toNumber();
    const d = c.d.toNumber();
    const h = c.h.toNumber();
    const off = 0.55; // ручка чуть дальше кромки, чтобы не липла к граням
    return [
      { axis: 'w', p: this.iso(c, w + off, 0, 0) },
      { axis: 'd', p: this.iso(c, 0, d + off, 0) },
      { axis: 'h', p: this.iso(c, 0, 0, h + off) },
    ];
  }

  private facePolys(c: CuboidObject): Pt[][] {
    const w = c.w.toNumber();
    const d = c.d.toNumber();
    const h = c.h.toNumber();
    const P = (x: number, y: number, z: number) => this.iso(c, x, y, z);
    if (cuboidDims(c) === 1) {
      return []; // отрезок рисуется линией, полигонов-граней нет
    }
    if (cuboidDims(c) === 2) {
      return [[P(0, 0, 0), P(w, 0, 0), P(w, d, 0), P(0, d, 0)]];
    }
    return [
      [P(0, 0, h), P(w, 0, h), P(w, d, h), P(0, d, h)],   // верх
      [P(0, 0, 0), P(w, 0, 0), P(w, 0, h), P(0, 0, h)],   // фронт (y = 0)
      [P(w, 0, 0), P(w, d, 0), P(w, d, h), P(w, 0, h)],   // бок (x = w)
    ];
  }

  private hitBody(sx: number, sy: number): CuboidObject | null {
    const inPoly = (poly: Pt[]): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!;
        const b = poly[j]!;
        if ((a.y > sy) !== (b.y > sy) && sx < ((b.x - a.x) * (sy - a.y)) / (b.y - a.y) + a.x) {
          inside = !inside;
        }
      }
      return inside;
    };
    for (const c of this.cuboids().reverse()) {
      if (cuboidDims(c) === 1) {
        const a = this.iso(c, 0, 0, 0);
        const b = this.iso(c, c.w.toNumber(), 0, 0);
        const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const k = Math.max(0, Math.min(1, ((sx - a.x) * (b.x - a.x) + (sy - a.y) * (b.y - a.y)) / len2));
        if (Math.hypot(a.x + k * (b.x - a.x) - sx, a.y + k * (b.y - a.y) - sy) <= 8) return c;
        continue;
      }
      if (this.facePolys(c).some(inPoly)) return c;
    }
    return null;
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number }): void {
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (p.button === 2) {
      if (this.ctx.hand.toolId) this.ctx.dropHand();
      return;
    }
    if (p.button !== 0) return;

    // Молоток в руке: удар по телу — масштаб всех рёбер
    if (this.ctx.hand.toolId) {
      const body = this.hitBody(p.x, p.y);
      if (body) {
        const tool = this.ctx.session.tools.get(this.ctx.hand.toolId);
        this.ctx.hit(body.id);
        this.labels.spawn(tool ? visibleLabel(tool) : '⚒', p.x, p.y - 10);
      }
      return;
    }

    // Ручки-кромки (у выделенного тела приоритет)
    const bodies = [...this.cuboids()].sort(
      (a, b) => Number(this.selection.has(a.id)) - Number(this.selection.has(b.id)),
    ).reverse();
    for (const c of bodies) {
      for (const hnd of this.handles(c)) {
        if (Math.hypot(hnd.p.x - p.x, hnd.p.y - p.y) <= HANDLE_R + 3) {
          this.gesture = {
            type: 'size', id: c.id, axis: hnd.axis, startSx: p.x, startSy: p.y,
            base: { w: c.w, d: c.d, h: c.h }, moved: false,
          };
          return;
        }
      }
    }

    const body = this.hitBody(p.x, p.y);
    if (body) {
      const a = this.anchorOf(body);
      this.gesture = {
        type: 'move', id: body.id, grabDX: p.x - a.x, grabDY: p.y - a.y,
        startSx: p.x, startSy: p.y, moved: false, wasSelected: this.selection.has(body.id),
      };
    }
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (!this.ctx || !this.gesture) return;
    const g = this.gesture;
    if (!g.moved && Math.hypot(p.x - g.startSx, p.y - g.startSy) < DRAG_THRESHOLD) return;
    g.moved = true;

    if (g.type === 'move') {
      const c = this.ctx.session.objects.get(g.id);
      if (c?.kind === 'cuboid') c.scenePos.set(this.id, { x: p.x - g.grabDX, y: p.y - g.grabDY });
      return;
    }
    this.applySizeDrag(g, p.x, p.y, false);
  }

  onPointerUp(p: { x: number; y: number; button: number }): void {
    if (!this.ctx || !this.gesture) return;
    const g = this.gesture;
    this.gesture = null;

    if (g.type === 'size') {
      if (g.moved) this.applySizeDrag(g, p.x, p.y, true);
      return;
    }
    if (!g.moved) {
      // клик без движения — выделение
      this.selection.clear();
      if (!g.wasSelected) this.selection.add(g.id);
    }
  }

  /** Проекция протяжки на изометрическую ось → новый размер (транзиент/коммит). */
  private applySizeDrag(
    g: { id: string; axis: 'w' | 'd' | 'h'; startSx: number; startSy: number;
         base: { w: Rational; d: Rational; h: Rational } },
    sx: number, sy: number, commit: boolean,
  ): void {
    if (!this.ctx) return;
    const dir = g.axis === 'w' ? EX : g.axis === 'd' ? EY : EZ;
    const delta = ((sx - g.startSx) * dir.x + (sy - g.startSy) * dir.y) / S;
    const next = (base: Rational): Rational => Rational.of(Math.round(base.toNumber() + delta));
    const w = g.axis === 'w' ? next(g.base.w) : g.base.w;
    const d = g.axis === 'd' ? next(g.base.d) : g.base.d;
    const h = g.axis === 'h' ? next(g.base.h) : g.base.h;
    this.ctx.session.setCuboidSize(g.id, w, d, h, commit);
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;
    this.widthPx = w;
    this.heightPx = h;
    this.labels.update(dt);

    for (const c of this.cuboids()) this.drawBody(g, c);

    this.labels.draw(g, theme.gold);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    if (hand && this.pointer.inside) {
      drawHammer(g, this.pointer.x, this.pointer.y, wobbleAngle(now), visibleLabel(hand));
    }
  }

  private drawBody(g: CanvasRenderingContext2D, c: CuboidObject): void {
    const selected = this.selection.has(c.id);
    const w = c.w.toNumber();
    const d = c.d.toNumber();
    const hh = c.h.toNumber();
    const dims = cuboidDims(c);
    const stroke = selected ? theme.accent : theme.textSecondary;

    if (dims === 1) {
      const a = this.iso(c, 0, 0, 0);
      const b = this.iso(c, w, 0, 0);
      g.strokeStyle = stroke;
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      // насечки кубиков-единиц
      g.lineWidth = 2;
      for (let i = 0; i <= w; i++) {
        const p = this.iso(c, i, 0, 0);
        g.beginPath(); g.moveTo(p.x - 3, p.y - 5); g.lineTo(p.x + 3, p.y + 5); g.stroke();
      }
    } else {
      const faces = this.facePolys(c);
      const shades = dims === 2
        ? ['rgba(255, 255, 255, 0.10)']
        : ['rgba(255, 255, 255, 0.14)', 'rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0.03)'];
      faces.forEach((poly, i) => {
        g.fillStyle = shades[i] ?? shades[0]!;
        g.strokeStyle = stroke;
        g.lineWidth = selected ? 2.5 : 1.8;
        g.beginPath();
        g.moveTo(poly[0]!.x, poly[0]!.y);
        for (const pt of poly.slice(1)) g.lineTo(pt.x, pt.y);
        g.closePath();
        g.fill();
        g.stroke();
      });
      this.drawGrids(g, c, w, d, hh, dims);
    }

    if (this.showSlice) this.drawSlice(g, c);

    this.drawHandlesAndLabels(g, c, selected);
  }

  /** Сетка единичных кубиков по видимым граням — слои читаются глазами. */
  private drawGrids(
    g: CanvasRenderingContext2D, c: CuboidObject,
    w: number, d: number, h: number, dims: 2 | 3,
  ): void {
    g.strokeStyle = theme.border;
    g.lineWidth = 1;
    g.globalAlpha = 0.9;
    const line = (a: Pt, b: Pt): void => {
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    };
    const z = dims === 2 ? 0 : h;
    for (let i = 1; i < w; i++) line(this.iso(c, i, 0, z), this.iso(c, i, d, z)); // верх: вдоль глубины
    for (let j = 1; j < d; j++) line(this.iso(c, 0, j, z), this.iso(c, w, j, z)); // верх: вдоль ширины
    if (dims === 3) {
      for (let i = 1; i < w; i++) line(this.iso(c, i, 0, 0), this.iso(c, i, 0, h)); // фронт: вертикали
      for (let k = 1; k < h; k++) {
        line(this.iso(c, 0, 0, k), this.iso(c, w, 0, k));  // фронт: этажи
        line(this.iso(c, w, 0, k), this.iso(c, w, d, k));  // бок: этажи
      }
      for (let j = 1; j < d; j++) line(this.iso(c, w, j, 0), this.iso(c, w, j, h)); // бок: вертикали
    }
    g.globalAlpha = 1;
  }

  /**
   * Томограф (серия 57): золотой ромб-срез на верхе этажа №k. У кубоида
   * все срезы одинаковы — стенки вертикальны, каждый этаж повторяет
   * фундамент. Подпись честно считает клетки среза.
   */
  private drawSlice(g: CanvasRenderingContext2D, c: CuboidObject): void {
    const hInt = Math.floor(c.h.toNumber());
    if (hInt < 1) return; // у площадки и отрезка этажей нет
    const k = Math.min(this.sliceLevel, hInt);
    const w = c.w.toNumber();
    const d = c.d.toNumber();
    const poly = [
      this.iso(c, 0, 0, k), this.iso(c, w, 0, k),
      this.iso(c, w, d, k), this.iso(c, 0, d, k),
    ];
    g.fillStyle = theme.gold;
    g.strokeStyle = theme.gold;
    g.globalAlpha = 0.22;
    g.beginPath();
    g.moveTo(poly[0]!.x, poly[0]!.y);
    for (const pt of poly.slice(1)) g.lineTo(pt.x, pt.y);
    g.closePath();
    g.fill();
    g.globalAlpha = 0.9;
    g.lineWidth = 2;
    g.stroke();
    g.globalAlpha = 1;
    const mid = this.iso(c, w, d / 2, k);
    g.fillStyle = theme.gold;
    g.font = 'bold 12px Inter, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(
      `этаж ${k}: ${c.w.toDisplay()}×${c.d.toDisplay()} = ${c.w.mul(c.d).toDisplay()} кубиков`,
      mid.x + 12, mid.y,
    );
  }

  private drawHandlesAndLabels(g: CanvasRenderingContext2D, c: CuboidObject, selected: boolean): void {
    // Ручки-кромки
    for (const hnd of this.handles(c)) {
      g.fillStyle = theme.bgTertiary;
      g.strokeStyle = selected ? theme.accent : theme.textSecondary;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(hnd.p.x, hnd.p.y, HANDLE_R, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = theme.textPrimary;
      g.font = 'bold 10px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(hnd.axis, hnd.p.x, hnd.p.y + 0.5);
    }

    // Подписи рёбер
    g.font = 'bold 12px Inter, sans-serif';
    g.fillStyle = selected ? theme.accent : theme.textPrimary;
    const w = c.w.toNumber();
    const d = c.d.toNumber();
    const h = c.h.toNumber();
    if (c.showW) {
      const m = this.iso(c, w / 2, 0, 0);
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText(c.w.toDisplay(), m.x, m.y + 8);
    }
    if (c.showD && !c.d.isZero()) {
      const m = this.iso(c, w, d / 2, 0);
      g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillText(c.d.toDisplay(), m.x + 8, m.y + 4);
    }
    if (c.showH && !c.h.isZero()) {
      const m = this.iso(c, 0, 0, h / 2);
      g.textAlign = 'right'; g.textBaseline = 'middle';
      g.fillText(c.h.toDisplay(), m.x - 8, m.y);
    }

    // Имя и объём по этажам
    const top = this.iso(c, 0, c.d.toNumber(), c.h.toNumber());
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText(c.label, top.x - 6, top.y - 6);
    if (c.showVolume) {
      const dims = cuboidDims(c);
      const text = dims === 3
        ? `V = (${c.w.toDisplay()}×${c.d.toDisplay()})·${c.h.toDisplay()} = ${cuboidVolume(c).toDisplay()} кубиков`
        : dims === 2
          ? `S = ${c.w.toDisplay()}×${c.d.toDisplay()} = ${c.w.mul(c.d).toDisplay()} клеток`
          : `L = ${c.w.toDisplay()}`;
      const base = this.iso(c, c.w.toNumber() / 2, 0, 0);
      g.fillStyle = theme.gold;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillText(text, base.x, base.y + 26);
    }
  }
}
