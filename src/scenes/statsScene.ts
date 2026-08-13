import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer } from '../render/hammer';
import { FlyingLabels, wobbleAngle } from '../render/motion';
import { NumberObject, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { icon } from '../ui/icons';

const SLOT_W = 72;
const BAR_W = 46;
const CAP_R = 9;
const DRAG_THRESHOLD = 4;

/**
 * Сцена «Столбики» (серия 31, статистика): набор чисел как столбики.
 * Три жеста: ковшик на макушке переливает единицу в другой столбик
 * (сумма-инвариант, среднее = «перелить поровну»), тело столбика тянется
 * вбок — перестановка (шеренга по росту руками), молотки бьют как обычно.
 * Чтение: сумма, линия среднего, середина шеренги (медиана).
 */
export class StatsScene implements Scene {
  readonly id = 'stats';
  readonly title = 'Столбики';
  readonly sidebar: { tools?: boolean; objects?: boolean } = { objects: false };

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private widthPx = 800;
  private heightPx = 600;

  /** Порядок шеренги — презентация сцены, в журнал не пишется. */
  private order: string[] = [];
  private readonly selection = new Set<string>();
  private gesture:
    | { type: 'pour'; fromId: string; startX: number; startY: number; moved: boolean }
    | { type: 'slide'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean }
    | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  private readonly labels = new FlyingLabels();

  private showSum = false;
  private showMean = false;
  private showMedian = false;

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
      if (e.kind === 'object-removed') {
        this.selection.delete(e.objectId);
        this.order = this.order.filter((id) => id !== e.objectId);
      }
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
      <h3>Набор</h3>
      <div class="series-row">
        <label class="field">числа<input id="st-values" value="5, 1, 9, 3, 7" /></label>
        <button id="st-spawn" class="btn primary"><span class="ic">${icon('plus', 12)}</span>Набор</button>
      </div>
      <div class="series-row">
        <button id="st-sort" class="btn">Шеренга по росту</button>
      </div>
      <label class="field tp-check"><input type="checkbox" id="st-sum" /> показывать сумму</label>
      <label class="field tp-check"><input type="checkbox" id="st-mean" /> линия среднего</label>
      <label class="field tp-check"><input type="checkbox" id="st-median" /> середина шеренги</label>
      <p class="hint">Ковшик на макушке столбика переливает единицу в другой
        столбик — сумма при этом не меняется. Тело столбика тянется вбок —
        перестановка. «Середина шеренги» подсвечивает средний столбик
        ТЕКУЩЕГО порядка: осмысленна она только после построения по росту.</p>
    `;
    root.querySelector<HTMLButtonElement>('#st-spawn')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const raw = root.querySelector<HTMLInputElement>('#st-values')!.value;
      for (const part of raw.split(/[,;\s]+/)) {
        if (!part) continue;
        const v = Rational.parse(part);
        if (v) this.ctx.session.spawnObject(v);
      }
    });
    root.querySelector<HTMLButtonElement>('#st-sort')!.addEventListener('click', () => {
      this.syncOrder();
      const byId = new Map(this.numbers().map((o) => [o.id, o]));
      this.order.sort((a, b) => byId.get(a)!.value.compare(byId.get(b)!.value));
    });
    const bindCheck = (id: string, set: (v: boolean) => void): void => {
      root.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener('change', (e) => {
        set((e.target as HTMLInputElement).checked);
      });
    };
    bindCheck('st-sum', (v) => { this.showSum = v; });
    bindCheck('st-mean', (v) => { this.showMean = v; });
    bindCheck('st-median', (v) => { this.showMedian = v; });
    return root;
  }

  // ---------- набор и раскладка ----------

  private numbers(): NumberObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()]
      .filter((o): o is NumberObject => o.kind === 'number' && !o.variable);
  }

  private syncOrder(): void {
    const ids = new Set(this.numbers().map((o) => o.id));
    this.order = this.order.filter((id) => ids.has(id));
    for (const o of this.numbers()) {
      if (!this.order.includes(o.id)) this.order.push(o.id);
    }
  }

  private ordered(): NumberObject[] {
    this.syncOrder();
    const byId = new Map(this.numbers().map((o) => [o.id, o]));
    return this.order.map((id) => byId.get(id)!);
  }

  private layout(): { left: number; baseline: number; scaleY: number } {
    const n = Math.max(this.order.length, 1);
    const left = Math.max(40, (this.widthPx - n * SLOT_W) / 2);
    const baseline = this.heightPx * 0.68;
    const maxAbs = Math.max(4, ...this.numbers().map((o) => Math.abs(o.value.toNumber())));
    const scaleY = (this.heightPx * 0.5) / maxAbs;
    return { left, baseline, scaleY };
  }

  private slotX(index: number): number {
    return this.layout().left + index * SLOT_W + SLOT_W / 2;
  }

  private slotAt(sx: number): number | null {
    const { left } = this.layout();
    const i = Math.floor((sx - left) / SLOT_W);
    return i >= 0 && i < this.order.length ? i : null;
  }

  /** Макушка столбика (для отрицательных — нижний торец). */
  private capPos(index: number, o: NumberObject): { x: number; y: number } {
    const { baseline, scaleY } = this.layout();
    return { x: this.slotX(index), y: baseline - o.value.toNumber() * scaleY };
  }

  private barHit(sx: number, sy: number): { index: number; o: NumberObject } | null {
    const { baseline, scaleY } = this.layout();
    const list = this.ordered();
    const i = this.slotAt(sx);
    if (i === null) return null;
    const o = list[i]!;
    const top = baseline - Math.max(o.value.toNumber(), 0) * scaleY;
    const bot = baseline - Math.min(o.value.toNumber(), 0) * scaleY;
    if (Math.abs(sx - this.slotX(i)) > BAR_W / 2 + 6) return null;
    if (sy < top - 14 || sy > bot + 14) return null;
    return { index: i, o };
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
    this.syncOrder();

    const hit = this.barHit(p.x, p.y);

    // Молоток в руке — удар по столбику-числу
    if (this.ctx.hand.toolId) {
      if (hit) {
        const tool = this.ctx.session.tools.get(this.ctx.hand.toolId);
        this.ctx.hit(hit.o.id);
        this.labels.spawn(tool ? visibleLabel(tool) : '⚒', p.x, p.y - 10);
      }
      return;
    }
    if (!hit) return;

    // Ковшик на макушке — переливание
    const cap = this.capPos(hit.index, hit.o);
    if (Math.hypot(cap.x - p.x, cap.y - p.y) <= CAP_R + 4) {
      this.gesture = { type: 'pour', fromId: hit.o.id, startX: p.x, startY: p.y, moved: false };
      return;
    }
    // Тело — перестановка в шеренге
    this.gesture = {
      type: 'slide', id: hit.o.id, startX: p.x, startY: p.y, moved: false,
      wasSelected: this.selection.has(hit.o.id),
    };
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
    const g = this.gesture;
    if (!g) return;
    if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) >= DRAG_THRESHOLD) g.moved = true;
  }

  onPointerUp(p: { x: number; y: number; button: number }): void {
    if (!this.ctx || !this.gesture) return;
    const g = this.gesture;
    this.gesture = null;

    if (g.type === 'pour') {
      if (!g.moved) return;
      const target = this.barHit(p.x, p.y) ?? (this.slotAt(p.x) !== null
        ? { index: this.slotAt(p.x)!, o: this.ordered()[this.slotAt(p.x)!]! }
        : null);
      if (target && target.o.id !== g.fromId) {
        if (this.ctx.session.transfer(g.fromId, target.o.id)) {
          this.labels.spawn('⇄1', p.x, p.y - 10);
        }
      }
      return;
    }

    // slide
    if (g.moved) {
      const to = this.slotAt(p.x);
      const from = this.order.indexOf(g.id);
      if (to !== null && from !== -1 && to !== from) {
        this.order.splice(from, 1);
        this.order.splice(to, 0, g.id);
      }
      return;
    }
    // клик без движения — выделение
    if (!g.wasSelected) {
      this.selection.clear();
      this.selection.add(g.id);
    } else {
      this.selection.delete(g.id);
    }
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;
    this.widthPx = w;
    this.heightPx = h;
    this.labels.update(dt);
    this.syncOrder();

    const list = this.ordered();
    const { baseline, scaleY } = this.layout();
    const n = list.length;

    // Пол-ось
    g.strokeStyle = theme.textSecondary;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(30, baseline);
    g.lineTo(w - 30, baseline);
    g.stroke();

    // Линия среднего (точной дробью)
    if (this.showMean && n > 0) {
      const sum = list.reduce((acc, o) => acc.add(o.value), Rational.of(0));
      const mean = sum.div(Rational.of(n));
      const y = baseline - mean.toNumber() * scaleY;
      g.strokeStyle = theme.gold;
      g.lineWidth = 1.5;
      g.setLineDash([6, 5]);
      g.beginPath();
      g.moveTo(30, y);
      g.lineTo(w - 30, y);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = theme.gold;
      g.font = 'bold 12px Inter, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText(`среднее = ${mean.toDisplay()}`, 34, y - 4);
    }

    // Сумма
    if (this.showSum && n > 0) {
      const sum = list.reduce((acc, o) => acc.add(o.value), Rational.of(0));
      g.fillStyle = theme.textPrimary;
      g.font = 'bold 13px Inter, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(`сумма набора = ${sum.toDisplay()}`, 34, 18);
    }

    // Середина шеренги (текущего порядка!)
    const medianIdx = new Set<number>();
    if (this.showMedian && n > 0) {
      if (n % 2 === 1) medianIdx.add((n - 1) / 2);
      else { medianIdx.add(n / 2 - 1); medianIdx.add(n / 2); }
    }

    // Столбики
    for (let i = 0; i < n; i++) {
      const o = list[i]!;
      const x = this.slotX(i);
      const v = o.value.toNumber();
      const top = baseline - Math.max(v, 0) * scaleY;
      const height = Math.abs(v) * scaleY;
      const selected = this.selection.has(o.id);

      if (medianIdx.has(i)) {
        g.strokeStyle = theme.gold;
        g.lineWidth = 2;
        g.setLineDash([4, 3]);
        g.strokeRect(x - BAR_W / 2 - 5, top - 22, BAR_W + 10, height + 44);
        g.setLineDash([]);
      }

      g.fillStyle = selected ? theme.accent : theme.bgTertiary;
      g.strokeStyle = selected ? theme.accentBorder : theme.textSecondary;
      g.lineWidth = 2;
      if (height > 0.5) {
        g.beginPath();
        g.roundRect(x - BAR_W / 2, v >= 0 ? top : baseline, BAR_W, height, 4);
        g.fill();
        g.stroke();
        // насечки единиц
        g.globalAlpha = 0.35;
        g.lineWidth = 1;
        const units = Math.floor(Math.abs(v));
        for (let u = 1; u <= units; u++) {
          const y = baseline - Math.sign(v) * u * scaleY;
          g.beginPath();
          g.moveTo(x - BAR_W / 2, y);
          g.lineTo(x + BAR_W / 2, y);
          g.stroke();
        }
        g.globalAlpha = 1;
      }

      // Ковшик-макушка
      const cap = this.capPos(i, o);
      g.fillStyle = theme.bgTertiary;
      g.strokeStyle = theme.gold;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cap.x, cap.y, CAP_R, 0, Math.PI * 2);
      g.fill();
      g.stroke();

      // Значение
      g.fillStyle = selected ? theme.accent : theme.textPrimary;
      g.font = 'bold 13px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = v >= 0 ? 'bottom' : 'top';
      g.fillText(o.value.toDisplay(), x, v >= 0 ? cap.y - CAP_R - 4 : cap.y + CAP_R + 4);
    }

    // Струя переливания за курсором
    if (this.gesture?.type === 'pour' && this.gesture.moved) {
      g.strokeStyle = theme.gold;
      g.lineWidth = 2;
      g.setLineDash([3, 4]);
      g.beginPath();
      g.moveTo(this.gesture.startX, this.gesture.startY);
      g.lineTo(this.pointer.x, this.pointer.y);
      g.stroke();
      g.setLineDash([]);
    }

    this.labels.draw(g, theme.gold);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    if (hand && this.pointer.inside) {
      drawHammer(g, this.pointer.x, this.pointer.y, wobbleAngle(now), visibleLabel(hand));
    }
  }
}
