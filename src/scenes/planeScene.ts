import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer } from '../render/hammer';
import { FlyingLabels, wobbleAngle } from '../render/motion';
import { PointObject, VectorObject, Tool, PrimitiveOp, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { icon } from '../ui/icons';

const POINT_R = 7;
const HIT_R = 12;
const DRAG_THRESHOLD = 4;
const DBLCLICK_MS = 350;
const AXIS_HIT = 16;
const VEC_END_R = 11;    // захват головы/хвоста стрелки
const VEC_SHAFT_R = 7;   // захват древка
const CHAIN_SNAP = 0.45; // прилипание хвоста к чужому носу, в клетках
const MAX_PINNED = 3;
const PIN_COLORS = ['#4fc3f7', '#ff9e64', '#9ece6a'];
const FILL_ABOVE = '#2ecc71';

type NumFn = (x: number) => number | null;

function primEval(op: PrimitiveOp, n: Rational): NumFn {
  const k = n.toNumber();
  switch (op) {
    case 'add': return (x) => x + k;
    case 'sub': return (x) => x - k;
    case 'mul': return (x) => x * k;
    case 'div': return (x) => x / k;
    case 'sq': return (x) => x * x;
    case 'cube': return (x) => x * x * x;
    case 'sqrt': return (x) => (x < 0 ? null : Math.sqrt(x));
    case 'cbrt': return (x) => Math.cbrt(x);
    case 'abs': return (x) => Math.abs(x);
    case 'round': return (x) => Math.floor(x / k + 0.5) * k;
    case 'mod': return (x) => x - Math.floor(x / k) * k;
    case 'quot': return (x) => Math.floor(x / k);
    case 'pow': {
      const a = Number(n.num);
      const b = Number(n.den);
      return (x) => {
        if (x === 0) return a > 0 ? 0 : null; // 0^отриц и 0⁰ — отказы
        if (x < 0) {
          if (b % 2 === 0) return null; // корень чётной степени из отрицательного
          const mag = Math.pow(-x, a / b);
          return Math.abs(a) % 2 === 0 ? mag : -mag;
        }
        return Math.pow(x, a / b);
      };
    }
  }
}

/**
 * Float-версия инструмента — ТОЛЬКО для отрисовки следа (модель остаётся
 * точной, все ходы идут через Rational). Отказы сигнатуры честны и здесь:
 * null = «в этой точке следа не существует» — дыра видна глазами.
 * У молотков ±x следа нет вовсе (им нужен x, а не вход).
 */
export function traceEval(tool: Tool): NumFn | null {
  if (tool.op === 'addx' || tool.op === 'subx') return null;
  const steps = tool.op === 'seq'
    ? (tool.steps ?? [])
    : [{ op: tool.op as PrimitiveOp, n: tool.n }];
  const prims = steps.map((s) => primEval(s.op, s.n));
  return (x) => {
    let v = x;
    for (const f of prims) {
      const next = f(v);
      if (next === null || !Number.isFinite(next)) return null;
      v = next;
    }
    return v;
  };
}

interface PinnedTrace {
  toolId: string;
  label: string;
  fn: NumFn;
  color: string;
}

/**
 * Сцена «Плоскость» — этапы A «Адреса» и B «Следы» (docs/design-plane.md).
 * Точки-объекты с точными адресами; след инструмента, взятого в руку
 * (молоток и его портрет — одно и то же), жест «прогони вход» по оси X,
 * закрепление до трёх следов и чтение: проколы, точки встречи, выше/ниже оси.
 */
export class PlaneScene implements Scene {
  readonly id = 'plane';
  readonly title = 'Плоскость';
  readonly sidebar: { tools?: boolean; objects?: boolean } = { objects: false };

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private widthPx = 800;
  private heightPx = 600;

  /** Камера: пикселей на единицу и экранное положение начала координат. */
  private scale = 40;
  private origin = { x: 0, y: 0 };
  private originInit = false;

  private readonly selection = new Set<string>();
  private gesture:
    | { type: 'pan'; startX: number; startY: number; baseX: number; baseY: number }
    | { type: 'point'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean }
    | { type: 'vec-head'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean }
    | { type: 'vec-tail'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean;
        grabDX: number; grabDY: number }
    | { type: 'band'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
    | null = null;
  private lastClick = { time: 0, x: 0, y: 0 };
  private lastTrace = { time: 0, key: '' };
  /** Точка под хвостом перетаскиваемой стрелки: отпускание выполнит команду. */
  private dropPoint: string | null = null;
  private shiftDown = false;
  private pointer = { x: 0, y: 0, inside: false };
  private readonly labels = new FlyingLabels();

  private readonly pinned: PinnedTrace[] = [];
  private showRoots = false;
  private showMeets = false;
  private showFill = false;
  private showSecant = false;
  private showCells = false;
  private cellsA = 0;
  private cellsB = 4;
  private pinBtn: HTMLButtonElement | null = null;
  private pinList: HTMLElement | null = null;
  private sumBtn: HTMLButtonElement | null = null;
  private flipXBtn: HTMLButtonElement | null = null;
  private flipYBtn: HTMLButtonElement | null = null;
  private rotCcwBtn: HTMLButtonElement | null = null;
  private rotCwBtn: HTMLButtonElement | null = null;

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    this.shiftDown = e.shiftKey;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      for (const id of [...this.selection]) this.ctx.session.removeObject(id);
      this.selection.clear();
    }
    if (e.key === 'Escape') this.selection.clear();
  };
  private readonly keyUpHandler = (e: KeyboardEvent): void => {
    this.shiftDown = e.shiftKey;
  };
  private readonly wheelHandler = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    // зум без упоров: сетка сама перещёлкивает шаг 1-2-5
    const next = Math.min(1e7, Math.max(1e-5, this.scale * factor));
    // зум к курсору: точка мира под курсором остаётся на месте
    const k = next / this.scale;
    this.origin.x = e.offsetX - (e.offsetX - this.origin.x) * k;
    this.origin.y = e.offsetY - (e.offsetY - this.origin.y) * k;
    this.scale = next;
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('keyup', this.keyUpHandler);
    document.getElementById('stage')?.addEventListener('wheel', this.wheelHandler, { passive: false });
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'object-removed') this.selection.delete(e.objectId);
      // закреплённый след живёт, пока жив его молоток (и пока тот не чёрный ящик)
      if (e.kind === 'tool-removed') this.unpin((p) => p.toolId === e.toolId);
      if (e.kind === 'tool-changed' && e.tool.hidden) this.unpin((p) => p.toolId === e.tool.id);
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('keyup', this.keyUpHandler);
    document.getElementById('stage')?.removeEventListener('wheel', this.wheelHandler);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.gesture = null;
    this.pinBtn = null;
    this.pinList = null;
    this.sumBtn = null;
    this.flipXBtn = null;
    this.flipYBtn = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Точки</h3>
      <div class="series-row">
        <label class="field">x<input id="pt-x" value="3" /></label>
        <label class="field">y<input id="pt-y" value="2" /></label>
        <button id="pt-spawn" class="btn primary"><span class="ic">${icon('plus', 12)}</span>Точка</button>
      </div>
      <div class="series-row btns-even">
        <button id="pt-flip-x" class="btn" title="Зеркало: отразить выделенные точки от оси X">↕ от X</button>
        <button id="pt-flip-y" class="btn" title="Зеркало: отразить выделенные точки от оси Y">↔ от Y</button>
      </div>
      <div class="series-row btns-even">
        <button id="pt-rot-ccw" class="btn" title="Повернуть выделенные точки на 90° против часовой">⟲ 90°</button>
        <button id="pt-rot-cw" class="btn" title="Повернуть выделенные точки на 90° по часовой">⟳ 90°</button>
      </div>
      <p class="hint">Адрес — пара чисел В СТРОГОМ ПОРЯДКЕ: вбок, потом вверх.
        Двойной клик по плоскости тоже ставит точку. Перенос — со снапом
        к целым (с Shift — к половинкам). Зеркала отражают выделенные точки;
        молотки ×k и ÷k по точке — растяжение от нуля и разворот.
        Колесо — зум, пустое место — пан.</p>
      <h3>Стрелки</h3>
      <div class="series-row">
        <label class="field">dx<input id="vc-dx" value="2" /></label>
        <label class="field">dy<input id="vc-dy" value="1" /></label>
        <button id="vc-spawn" class="btn primary"><span class="ic">${icon('plus', 12)}</span>Стрелка</button>
      </div>
      <div class="series-row">
        <button id="vc-sum" class="btn">➕ Сумма выделенных</button>
      </div>
      <p class="hint">Стрелка — команда «сколько вбок и сколько вверх» БЕЗ места:
        тащи её за древко куда угодно — команда не меняется. Голова меняет
        команду, хвост липнет к чужому носу — так стрелки складываются
        (выдели две и жми «Сумма»). А хвост, отпущенный НА ТОЧКЕ, выполняет
        команду: точка проходит путь и оказывается на носу.</p>
      <h3>Следы</h3>
      <div class="series-row">
        <button id="tr-pin" class="btn">📌 Закрепить след</button>
      </div>
      <div id="tr-list"></div>
      <label class="field tp-check"><input type="checkbox" id="tr-roots" /> проколы оси X</label>
      <label class="field tp-check"><input type="checkbox" id="tr-meets" /> точки встречи</label>
      <label class="field tp-check"><input type="checkbox" id="tr-fill" /> подсветить выше/ниже оси</label>
      <label class="field tp-check"><input type="checkbox" id="tr-secant" /> секущая через 2 точки</label>
      <label class="field tp-check"><input type="checkbox" id="tr-cells" /> клетки под следом</label>
      <div class="series-row" id="tr-cells-range" hidden>
        <label class="field">от<input id="tr-cells-a" value="0" /></label>
        <label class="field">до<input id="tr-cells-b" value="4" /></label>
      </div>
      <p class="hint">Возьми молоток в руку — его след ляжет на плоскость:
        молоток и его портрет — одно и то же. Клик молотком по оси X —
        «прогони вход»: пара вход-выход становится точкой. След чёрного
        ящика спрятан — прогоняй входы и разгадывай.</p>
    `;
    root.querySelector<HTMLButtonElement>('#pt-spawn')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const x = Rational.parse(root.querySelector<HTMLInputElement>('#pt-x')!.value);
      const y = Rational.parse(root.querySelector<HTMLInputElement>('#pt-y')!.value);
      if (x && y) this.ctx.session.spawnPoint(x, y);
    });

    root.querySelector<HTMLButtonElement>('#vc-spawn')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const dx = Rational.parse(root.querySelector<HTMLInputElement>('#vc-dx')!.value);
      const dy = Rational.parse(root.querySelector<HTMLInputElement>('#vc-dy')!.value);
      if (!dx || !dy) return;
      const v = this.ctx.session.spawnVector(dx, dy);
      v.scenePos.set(this.id, { x: this.vectors().length - 1, y: 0 }); // лесенкой, чтобы не слипались
    });
    this.sumBtn = root.querySelector<HTMLButtonElement>('#vc-sum');
    this.sumBtn!.addEventListener('click', () => {
      const pair = this.selectedVectors();
      if (!this.ctx || pair.length !== 2) return;
      // порядок суммы — порядок цепочки, если она есть (хвост b на носу a)
      const [a, b] = this.chainOrdered(pair[0]!, pair[1]!);
      const sum = this.ctx.session.sumVectors(a.id, b.id);
      if (!sum) return;
      const tail = this.tailOf(a);
      sum.scenePos.set(this.id, { x: tail.x, y: tail.y });
      this.selection.clear();
      this.selection.add(sum.id);
    });

    const flip = (axis: 'x' | 'y'): void => {
      if (!this.ctx) return;
      for (const pt of this.points()) {
        if (this.selection.has(pt.id)) this.ctx.session.flipPoint(pt.id, axis);
      }
    };
    this.flipXBtn = root.querySelector<HTMLButtonElement>('#pt-flip-x');
    this.flipYBtn = root.querySelector<HTMLButtonElement>('#pt-flip-y');
    this.flipXBtn!.addEventListener('click', () => flip('x'));
    this.flipYBtn!.addEventListener('click', () => flip('y'));
    const rotate = (dir: 'ccw' | 'cw'): void => {
      if (!this.ctx) return;
      for (const pt of this.points()) {
        if (this.selection.has(pt.id)) this.ctx.session.rotatePoint(pt.id, dir);
      }
    };
    this.rotCcwBtn = root.querySelector<HTMLButtonElement>('#pt-rot-ccw');
    this.rotCwBtn = root.querySelector<HTMLButtonElement>('#pt-rot-cw');
    this.rotCcwBtn!.addEventListener('click', () => rotate('ccw'));
    this.rotCwBtn!.addEventListener('click', () => rotate('cw'));

    this.pinBtn = root.querySelector<HTMLButtonElement>('#tr-pin');
    this.pinList = root.querySelector<HTMLElement>('#tr-list');
    this.pinBtn!.addEventListener('click', () => this.pinHandTrace());
    const bindCheck = (id: string, set: (v: boolean) => void): void => {
      root.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener('change', (e) => {
        set((e.target as HTMLInputElement).checked);
      });
    };
    bindCheck('tr-roots', (v) => { this.showRoots = v; });
    bindCheck('tr-meets', (v) => { this.showMeets = v; });
    bindCheck('tr-fill', (v) => { this.showFill = v; });
    bindCheck('tr-secant', (v) => { this.showSecant = v; });
    bindCheck('tr-cells', (v) => {
      this.showCells = v;
      root.querySelector<HTMLElement>('#tr-cells-range')!.hidden = !v;
    });
    const bindRange = (id: string, set: (v: number) => void): void => {
      root.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener('change', (e) => {
        const v = Rational.parse((e.target as HTMLInputElement).value);
        if (v) set(Math.round(v.toNumber()));
      });
    };
    bindRange('tr-cells-a', (v) => { this.cellsA = v; });
    bindRange('tr-cells-b', (v) => { this.cellsB = v; });
    this.refreshPinList();
    return root;
  }

  // ---------- следы ----------

  private handTool(): Tool | null {
    if (!this.ctx?.hand.toolId) return null;
    return this.ctx.session.tools.get(this.ctx.hand.toolId) ?? null;
  }

  private canPin(): boolean {
    const hand = this.handTool();
    return !!hand && !hand.hidden && !!traceEval(hand) &&
      this.pinned.length < MAX_PINNED && !this.pinned.some((p) => p.toolId === hand.id);
  }

  private pinHandTrace(): void {
    const hand = this.handTool();
    if (!hand || !this.canPin()) return;
    const fn = traceEval(hand);
    if (!fn) return;
    const used = new Set(this.pinned.map((p) => p.color));
    const color = PIN_COLORS.find((c) => !used.has(c)) ?? PIN_COLORS[0]!;
    this.pinned.push({ toolId: hand.id, label: hand.label, fn, color });
    this.refreshPinList();
  }

  private unpin(match: (p: PinnedTrace) => boolean): void {
    for (let i = this.pinned.length - 1; i >= 0; i--) {
      if (match(this.pinned[i]!)) this.pinned.splice(i, 1);
    }
    this.refreshPinList();
  }

  private refreshPinList(): void {
    if (!this.pinList) return;
    this.pinList.innerHTML = '';
    for (const p of this.pinned) {
      const row = document.createElement('div');
      row.className = 'series-row';
      row.innerHTML = `
        <span style="color:${p.color}; font-weight:bold">▬ ${p.label}</span>
        <button class="btn" title="снять след">✕</button>
      `;
      row.querySelector('button')!.addEventListener('click', () => {
        this.unpin((q) => q === p);
      });
      this.pinList.appendChild(row);
    }
  }

  /** Все следы на плоскости: закреплённые + след руки (если не чёрный ящик). */
  private visibleTraces(): { fn: NumFn; color: string }[] {
    const out: { fn: NumFn; color: string }[] = this.pinned.map((p) => ({ fn: p.fn, color: p.color }));
    const hand = this.handTool();
    if (hand && !hand.hidden && !this.pinned.some((p) => p.toolId === hand.id)) {
      const fn = traceEval(hand);
      if (fn) out.push({ fn, color: theme.accent });
    }
    return out;
  }

  /** Шаг сетки 1-2-5×10^k: клетка держится в коридоре 36…90 пикселей. */
  private gridStep(): { step: number; decimals: number } {
    let exp = 0;
    let mant = 1;
    const px = () => mant * Math.pow(10, exp) * this.scale;
    while (px() < 36) {
      if (mant === 1) mant = 2;
      else if (mant === 2) mant = 5;
      else { mant = 1; exp++; }
    }
    while (px() >= 90) {
      if (mant === 5) mant = 2;
      else if (mant === 2) mant = 1;
      else { mant = 5; exp--; }
    }
    const decimals = Math.max(0, -exp);
    return { step: mant * Math.pow(10, exp), decimals };
  }

  // ---------- координаты ----------

  private ensureOrigin(): void {
    if (this.originInit) return;
    this.origin = { x: this.widthPx * 0.42, y: this.heightPx * 0.58 };
    this.originInit = true;
  }

  private toScreen(x: Rational, y: Rational): { x: number; y: number } {
    return {
      x: this.origin.x + x.toNumber() * this.scale,
      y: this.origin.y - y.toNumber() * this.scale,
    };
  }

  /** Экран → мир со снапом: целые, с Shift — половинки. */
  private toWorldSnapped(sx: number, sy: number): { x: Rational; y: Rational } {
    const denom = this.shiftDown ? 2 : 1;
    const wx = Math.round(((sx - this.origin.x) / this.scale) * denom);
    const wy = Math.round(((this.origin.y - sy) / this.scale) * denom);
    return { x: Rational.of(wx, denom), y: Rational.of(wy, denom) };
  }

  private points(): PointObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is PointObject => o.kind === 'point');
  }

  private pointAt(sx: number, sy: number): PointObject | null {
    for (const pt of this.points().reverse()) {
      const p = this.toScreen(pt.x, pt.y);
      if (Math.hypot(p.x - sx, p.y - sy) <= HIT_R) return pt;
    }
    return null;
  }

  // ---------- стрелки ----------

  private vectors(): VectorObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is VectorObject => o.kind === 'vector');
  }

  private selectedVectors(): VectorObject[] {
    return this.vectors().filter((v) => this.selection.has(v.id));
  }

  /** Хвост стрелки в мировых координатах — презентация, живёт в scenePos. */
  private tailOf(v: VectorObject): { x: number; y: number } {
    return v.scenePos.get(this.id) ?? { x: 0, y: 0 };
  }

  private headOf(v: VectorObject): { x: number; y: number } {
    const t = this.tailOf(v);
    return { x: t.x + v.dx.toNumber(), y: t.y + v.dy.toNumber() };
  }

  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: this.origin.x + wx * this.scale, y: this.origin.y - wy * this.scale };
  }

  /** Если хвост b стоит на носу a — вернуть цепочку (a, b), иначе как дали. */
  private chainOrdered(p: VectorObject, q: VectorObject): [VectorObject, VectorObject] {
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
    if (near(this.headOf(q), this.tailOf(p))) return [q, p];
    return [p, q];
  }

  private vectorHitAt(sx: number, sy: number):
    | { v: VectorObject; part: 'head' | 'tail' | 'shaft' }
    | null {
    for (const v of this.vectors().reverse()) {
      const t = this.worldToScreen(this.tailOf(v).x, this.tailOf(v).y);
      const h = this.worldToScreen(this.headOf(v).x, this.headOf(v).y);
      if (Math.hypot(h.x - sx, h.y - sy) <= VEC_END_R) return { v, part: 'head' };
      if (Math.hypot(t.x - sx, t.y - sy) <= VEC_END_R) return { v, part: 'tail' };
      // расстояние до отрезка древка
      const len2 = (h.x - t.x) ** 2 + (h.y - t.y) ** 2;
      if (len2 > 0) {
        const k = Math.max(0, Math.min(1, ((sx - t.x) * (h.x - t.x) + (sy - t.y) * (h.y - t.y)) / len2));
        const px = t.x + k * (h.x - t.x);
        const py = t.y + k * (h.y - t.y);
        if (Math.hypot(px - sx, py - sy) <= VEC_SHAFT_R) return { v, part: 'shaft' };
      }
    }
    return null;
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number }): void {
    if (!this.ctx) return;
    this.ensureOrigin();
    this.pointer = { x: p.x, y: p.y, inside: true };
    this.dropPoint = null;

    if (p.button === 2) {
      if (this.ctx.hand.toolId) this.ctx.dropHand();
      return;
    }
    if (p.button === 1) { // СКМ — пан, как в GeoGebra
      this.gesture = { type: 'pan', startX: p.x, startY: p.y, baseX: this.origin.x, baseY: this.origin.y };
      return;
    }
    if (p.button !== 0) return;

    // Молоток в руке: по точке — гомотетия/разворот, по стрелке — растяжка,
    // по оси X — «прогони вход»
    const handId = this.ctx.hand.toolId;
    if (handId) {
      const hammerPt = this.pointAt(p.x, p.y);
      if (hammerPt) {
        const tool = this.ctx.session.tools.get(handId);
        const ok = this.ctx.session.pointApply(hammerPt.id, handId);
        this.labels.spawn(ok && tool ? visibleLabel(tool) : '⛔', p.x, p.y - 10);
        return;
      }
      const hitVec = this.vectorHitAt(p.x, p.y);
      if (hitVec) {
        const tool = this.ctx.session.tools.get(handId);
        const ok = this.ctx.session.vectorApply(hitVec.v.id, handId);
        this.labels.spawn(ok && tool ? visibleLabel(tool) : '⛔', p.x, p.y - 10);
        return;
      }
    }
    if (handId && Math.abs(p.y - this.origin.y) <= AXIS_HIT) {
      const w = this.toWorldSnapped(p.x, this.origin.y);
      const key = w.x.toDisplay();
      const now = performance.now();
      if (now - this.lastTrace.time < DBLCLICK_MS && this.lastTrace.key === key) return;
      this.lastTrace = { time: now, key };
      const tool = this.ctx.session.tools.get(handId);
      const pt = this.ctx.session.tracePoint(handId, w.x);
      if (pt) {
        this.labels.spawn(tool ? visibleLabel(tool) : '⚒', p.x, this.origin.y);
        this.selection.clear();
        this.selection.add(pt.id);
      } else {
        this.labels.spawn('⛔', p.x, this.origin.y - 10);
      }
      return;
    }

    const hitPt = this.pointAt(p.x, p.y);
    const now = performance.now();
    const isDouble =
      now - this.lastClick.time < DBLCLICK_MS &&
      Math.hypot(p.x - this.lastClick.x, p.y - this.lastClick.y) < 6;
    this.lastClick = { time: now, x: p.x, y: p.y };

    if (!handId && !hitPt && isDouble && this.ctx.restrictions.construct) {
      const w = this.toWorldSnapped(p.x, p.y);
      const pt = this.ctx.session.spawnPoint(w.x, w.y);
      this.selection.clear();
      this.selection.add(pt.id);
      return;
    }

    if (!handId && hitPt) {
      this.gesture = {
        type: 'point', id: hitPt.id, startX: p.x, startY: p.y, moved: false,
        wasSelected: this.selection.has(hitPt.id),
      };
      return;
    }
    if (!handId) {
      const hitVec = this.vectorHitAt(p.x, p.y);
      if (hitVec) {
        const wasSelected = this.selection.has(hitVec.v.id);
        if (hitVec.part === 'head') {
          this.gesture = { type: 'vec-head', id: hitVec.v.id, startX: p.x, startY: p.y, moved: false, wasSelected };
        } else {
          // хвост и древко — перенос всей стрелки: команда не меняется
          const t = this.worldToScreen(this.tailOf(hitVec.v).x, this.tailOf(hitVec.v).y);
          this.gesture = {
            type: 'vec-tail', id: hitVec.v.id, startX: p.x, startY: p.y, moved: false, wasSelected,
            grabDX: p.x - t.x, grabDY: p.y - t.y,
          };
        }
        return;
      }
    }
    // ЛКМ по пустому месту — рамка выделения (пан переехал на СКМ)
    this.gesture = { type: 'band', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: this.shiftDown };
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (!this.ctx || !this.gesture) return;
    if (this.gesture.type === 'pan') {
      this.origin.x = this.gesture.baseX + (p.x - this.gesture.startX);
      this.origin.y = this.gesture.baseY + (p.y - this.gesture.startY);
      return;
    }
    if (this.gesture.type === 'band') {
      this.gesture.x1 = p.x;
      this.gesture.y1 = p.y;
      return;
    }
    const g = this.gesture;
    if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) < DRAG_THRESHOLD) return;
    g.moved = true;

    if (g.type === 'point') {
      const w = this.toWorldSnapped(p.x, p.y);
      this.ctx.session.setPointPos(g.id, w.x, w.y, false); // транзиент
      return;
    }
    if (g.type === 'vec-head') {
      const d = this.headDelta(g.id, p.x, p.y);
      if (d) this.ctx.session.setVectorData(g.id, d.dx, d.dy, false); // транзиент
      return;
    }
    // vec-tail: перенос всей стрелки — презентация, журнал не трогаем
    this.moveTail(g.id, p.x - g.grabDX, p.y - g.grabDY);
  }

  /** Голова стрелки на экране (sx, sy) → команда (dx; dy) со снапом дельты. */
  private headDelta(id: string, sx: number, sy: number): { dx: Rational; dy: Rational } | null {
    const v = this.ctx?.session.objects.get(id);
    if (!v || v.kind !== 'vector') return null;
    const t = this.tailOf(v);
    const denom = this.shiftDown ? 2 : 1;
    const dx = Math.round(((sx - this.origin.x) / this.scale - t.x) * denom);
    const dy = Math.round(((this.origin.y - sy) / this.scale - t.y) * denom);
    return { dx: Rational.of(dx, denom), dy: Rational.of(dy, denom) };
  }

  /**
   * Перенос хвоста: прилипание к точке (отпускание выполнит команду — точка
   * пройдёт путь), к чужому носу (цепочка суммы) или снап к сетке.
   */
  private moveTail(id: string, sx: number, sy: number): void {
    const v = this.ctx?.session.objects.get(id);
    if (!v || v.kind !== 'vector') return;
    const wx = (sx - this.origin.x) / this.scale;
    const wy = (this.origin.y - sy) / this.scale;
    this.dropPoint = null;
    for (const pt of this.points()) {
      if (Math.hypot(pt.x.toNumber() - wx, pt.y.toNumber() - wy) < CHAIN_SNAP) {
        v.scenePos.set(this.id, { x: pt.x.toNumber(), y: pt.y.toNumber() });
        this.dropPoint = pt.id; // хвост к месту — команда наготове
        return;
      }
    }
    for (const other of this.vectors()) {
      if (other.id === v.id) continue;
      const h = this.headOf(other);
      if (Math.hypot(h.x - wx, h.y - wy) < CHAIN_SNAP) {
        v.scenePos.set(this.id, { x: h.x, y: h.y }); // хвост к носу — цепочка
        return;
      }
    }
    const denom = this.shiftDown ? 2 : 1;
    v.scenePos.set(this.id, { x: Math.round(wx * denom) / denom, y: Math.round(wy * denom) / denom });
  }

  onPointerUp(p: { x: number; y: number; button: number }): void {
    if (!this.ctx || !this.gesture) return;
    const g = this.gesture;
    this.gesture = null;
    if (g.type === 'pan') return;
    if (g.type === 'band') {
      const x0 = Math.min(g.x0, g.x1);
      const x1 = Math.max(g.x0, g.x1);
      const y0 = Math.min(g.y0, g.y1);
      const y1 = Math.max(g.y0, g.y1);
      if (!g.additive) this.selection.clear();
      if (x1 - x0 > 6 || y1 - y0 > 6) {
        const inside = (sp: { x: number; y: number }) =>
          sp.x >= x0 && sp.x <= x1 && sp.y >= y0 && sp.y <= y1;
        for (const pt of this.points()) {
          if (inside(this.toScreen(pt.x, pt.y))) this.selection.add(pt.id);
        }
        for (const v of this.vectors()) {
          const t = this.tailOf(v);
          const hd = this.headOf(v);
          if (inside(this.worldToScreen(t.x, t.y)) && inside(this.worldToScreen(hd.x, hd.y))) {
            this.selection.add(v.id);
          }
        }
      }
      return;
    }

    if (g.moved) {
      if (g.type === 'point') {
        const w = this.toWorldSnapped(p.x, p.y);
        this.ctx.session.setPointPos(g.id, w.x, w.y, true); // коммит
      } else if (g.type === 'vec-head') {
        const d = this.headDelta(g.id, p.x, p.y);
        if (d) this.ctx.session.setVectorData(g.id, d.dx, d.dy, true); // коммит
      } else if (g.type === 'vec-tail' && this.dropPoint) {
        // хвост отпущен на точке — точка выполняет команду и уезжает на нос
        this.ctx.session.movePointBy(this.dropPoint, g.id);
        this.dropPoint = null;
      }
      // перенос хвоста без точки — команда не менялась, нечего коммитить
      return;
    }
    // клик без движения — выделение (Shift добавляет)
    if (!this.shiftDown) this.selection.clear();
    if (g.wasSelected && this.shiftDown) this.selection.delete(g.id);
    else this.selection.add(g.id);
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;
    this.widthPx = w;
    this.heightPx = h;
    this.ensureOrigin();
    this.labels.update(dt);
    if (this.pinBtn) this.pinBtn.disabled = !this.canPin();
    if (this.sumBtn) this.sumBtn.disabled = this.selectedVectors().length !== 2;
    const anyPtSelected = this.points().some((pt) => this.selection.has(pt.id));
    if (this.flipXBtn) this.flipXBtn.disabled = !anyPtSelected;
    if (this.flipYBtn) this.flipYBtn.disabled = !anyPtSelected;
    if (this.rotCcwBtn) this.rotCcwBtn.disabled = !anyPtSelected;
    if (this.rotCwBtn) this.rotCwBtn.disabled = !anyPtSelected;

    const { step, decimals } = this.gridStep();
    const px = this.scale * step;

    // Сетка
    g.strokeStyle = theme.border;
    g.lineWidth = 1;
    g.globalAlpha = 0.5;
    const startX = this.origin.x % px;
    for (let x = startX; x < w; x += px) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    const startY = this.origin.y % px;
    for (let y = startY; y < h; y += px) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
    g.globalAlpha = 1;

    const traces = this.visibleTraces();

    // Заливка «выше/ниже оси» — у следа руки (последнего), иначе у первого
    if (this.showFill && traces.length) this.drawFill(g, w, h, traces[traces.length - 1]!.fn);

    // Клетки под следом (этап D): полные клетки между следом и осью на [a; b]
    if (this.showCells && traces.length) this.drawCells(g, traces[traces.length - 1]!.fn);

    // Оси со стрелками и именами
    g.strokeStyle = theme.textSecondary;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, this.origin.y); g.lineTo(w, this.origin.y); g.stroke();
    g.beginPath(); g.moveTo(this.origin.x, 0); g.lineTo(this.origin.x, h); g.stroke();
    g.fillStyle = theme.textSecondary;
    g.beginPath(); // стрелка оси X (вправо)
    g.moveTo(w - 2, this.origin.y);
    g.lineTo(w - 12, this.origin.y - 5);
    g.lineTo(w - 12, this.origin.y + 5);
    g.closePath(); g.fill();
    g.beginPath(); // стрелка оси Y (вверх)
    g.moveTo(this.origin.x, 2);
    g.lineTo(this.origin.x - 5, 12);
    g.lineTo(this.origin.x + 5, 12);
    g.closePath(); g.fill();
    g.font = 'bold 14px Inter, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText('x', w - 6, this.origin.y - 8);
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText('y', this.origin.x + 10, 6);

    // Подписи целых на осях
    g.fillStyle = theme.textSecondary;
    g.font = '11px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const tick = (idx: number): string => {
      const v = idx * step;
      return decimals > 0 ? v.toFixed(decimals).replace('.', ',') : String(Math.round(v));
    };
    const fromI = Math.ceil(-this.origin.x / px);
    const toI = Math.floor((w - this.origin.x) / px);
    for (let i = fromI; i <= toI; i++) {
      if (i === 0) continue;
      g.fillText(tick(i), this.origin.x + i * px, this.origin.y + 5);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const fromYI = Math.ceil((this.origin.y - h) / px);
    const toYI = Math.floor(this.origin.y / px);
    for (let i = fromYI; i <= toYI; i++) {
      if (i === 0) continue;
      g.fillText(tick(i), this.origin.x - 6, this.origin.y - i * px);
    }
    // Начало координат
    g.fillStyle = theme.accent;
    g.beginPath();
    g.arc(this.origin.x, this.origin.y, 3.5, 0, Math.PI * 2);
    g.fill();
    g.textAlign = 'right';
    g.textBaseline = 'top';
    g.fillText('0', this.origin.x - 6, this.origin.y + 5);

    // Следы: закреплённые тоньше, след руки поверх и ярче
    for (let i = 0; i < traces.length; i++) {
      const isHand = i === traces.length - 1 && traces[i]!.color === theme.accent;
      this.drawTrace(g, w, h, traces[i]!.fn, traces[i]!.color, isHand ? 0.85 : 0.6, isHand ? 2.5 : 2);
    }

    // Чтение следов: проколы оси и точки встречи
    if (this.showRoots) {
      for (const t of traces) {
        for (const x of this.findRoots(t.fn, w)) this.drawMarker(g, x, 0, this.fmtNum(x));
      }
    }
    if (this.showMeets) {
      for (let i = 0; i < traces.length; i++) {
        for (let j = i + 1; j < traces.length; j++) {
          const fi = traces[i]!.fn;
          const fj = traces[j]!.fn;
          for (const x of this.findRoots((v) => {
            const a = fi(v); const b = fj(v);
            return a === null || b === null ? null : a - b;
          }, w)) {
            const y = fi(x);
            if (y !== null) this.drawMarker(g, x, y, `(${this.fmtNum(x)}; ${this.fmtNum(y)})`);
          }
        }
      }
    }

    // Секущая через две точки (этап D): крутизна — точной дробью
    if (this.showSecant) this.drawSecant(g, w);

    // Точки
    for (const pt of this.points()) {
      const s = this.toScreen(pt.x, pt.y);
      const selected = this.selection.has(pt.id);
      const dragging = this.gesture?.type === 'point' && this.gesture.id === pt.id && this.gesture.moved;

      // Маршрут «вбок, потом вверх» — у выделенной или перетаскиваемой
      if (selected || dragging) {
        g.strokeStyle = theme.gold;
        g.lineWidth = 1.5;
        g.setLineDash([5, 4]);
        g.beginPath();
        g.moveTo(this.origin.x, this.origin.y);
        g.lineTo(s.x, this.origin.y);
        g.lineTo(s.x, s.y);
        g.stroke();
        g.setLineDash([]);
      }

      // точка под хвостом стрелки — золотое кольцо: «команда наготове»
      if (this.dropPoint === pt.id) {
        g.strokeStyle = theme.gold;
        g.lineWidth = 2.5;
        g.beginPath();
        g.arc(s.x, s.y, POINT_R + 5, 0, Math.PI * 2);
        g.stroke();
      }

      g.fillStyle = selected ? theme.accent : theme.bgTertiary;
      g.strokeStyle = selected ? theme.accentBorder : theme.textSecondary;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.x, s.y, POINT_R, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (selected) {
        g.shadowColor = theme.accentGlow;
        g.shadowBlur = 10;
        g.stroke();
        g.shadowBlur = 0;
      }

      g.fillStyle = selected ? theme.accent : theme.textPrimary;
      g.font = 'bold 12px Inter, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText(`${pt.label} (${pt.x.toDisplay()}; ${pt.y.toDisplay()})`, s.x + POINT_R + 4, s.y - 4);
    }

    // Стрелки и пунктиры их цепочек
    this.drawChainSums(g);
    for (const v of this.vectors()) this.drawVector(g, v);

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
      g.setLineDash([]);
      g.restore();
    }

    this.labels.draw(g, theme.gold);

    // Молоток у курсора
    const hand = this.handTool();
    if (hand && this.pointer.inside) {
      drawHammer(g, this.pointer.x, this.pointer.y, wobbleAngle(now), visibleLabel(hand));
    }
  }

  private drawVector(g: CanvasRenderingContext2D, v: VectorObject): void {
    const selected = this.selection.has(v.id);
    const t = this.worldToScreen(this.tailOf(v).x, this.tailOf(v).y);
    const h = this.worldToScreen(this.headOf(v).x, this.headOf(v).y);
    const color = selected ? theme.accent : theme.textPrimary;
    const zero = v.dx.isZero() && v.dy.isZero();

    if (zero) {
      // нулевая стрелка — команда «стой на месте»: кружок вместо древка
      g.strokeStyle = color;
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(t.x, t.y, 6, 0, Math.PI * 2);
      g.stroke();
    } else {
      const ang = Math.atan2(h.y - t.y, h.x - t.x);
      const headLen = 12;
      g.strokeStyle = color;
      g.lineWidth = selected ? 3.5 : 2.5;
      if (selected) { g.shadowColor = theme.accentGlow; g.shadowBlur = 8; }
      g.beginPath();
      g.moveTo(t.x, t.y);
      g.lineTo(h.x - Math.cos(ang) * headLen * 0.6, h.y - Math.sin(ang) * headLen * 0.6);
      g.stroke();
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(h.x, h.y);
      g.lineTo(h.x - Math.cos(ang - 0.42) * headLen, h.y - Math.sin(ang - 0.42) * headLen);
      g.lineTo(h.x - Math.cos(ang + 0.42) * headLen, h.y - Math.sin(ang + 0.42) * headLen);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;
      // пятка хвоста — за неё переносят
      g.beginPath();
      g.arc(t.x, t.y, 3, 0, Math.PI * 2);
      g.fill();
    }

    g.fillStyle = selected ? theme.accent : theme.textPrimary;
    g.font = 'bold 12px Inter, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    const mx = (t.x + h.x) / 2;
    const my = (t.y + h.y) / 2;
    g.fillText(`${v.label} (${v.dx.toDisplay()}; ${v.dy.toDisplay()})`, mx + 8, my - 6);
  }

  /** Пунктир суммы для каждой цепочки «хвост на носу»: от хвоста a к носу b. */
  private drawChainSums(g: CanvasRenderingContext2D): void {
    const vs = this.vectors();
    for (const a of vs) {
      for (const b of vs) {
        if (a.id === b.id) continue;
        const ha = this.headOf(a);
        const tb = this.tailOf(b);
        if (Math.hypot(ha.x - tb.x, ha.y - tb.y) > 1e-6) continue;
        const from = this.worldToScreen(this.tailOf(a).x, this.tailOf(a).y);
        const hb = this.headOf(b);
        const to = this.worldToScreen(hb.x, hb.y);
        g.strokeStyle = theme.gold;
        g.lineWidth = 2;
        g.setLineDash([6, 5]);
        g.globalAlpha = 0.8;
        g.beginPath();
        g.moveTo(from.x, from.y);
        g.lineTo(to.x, to.y);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
        g.fillStyle = theme.gold;
        g.font = 'bold 12px Inter, sans-serif';
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(
          `${a.label} ⊕ ${b.label} = (${a.dx.add(b.dx).toDisplay()}; ${a.dy.add(b.dy).toDisplay()})`,
          (from.x + to.x) / 2 + 8, (from.y + to.y) / 2 + 6,
        );
      }
    }
  }

  /**
   * Секущая через две точки (выделенные, иначе первые две на доске) —
   * с ТОЧНОЙ крутизной Δy/Δx. Прогони два входа рядом и приближай их
   * зумом — секущая прилипает к следу: лупа-касательная.
   */
  private drawSecant(g: CanvasRenderingContext2D, w: number): void {
    const pts = this.points();
    const selected = pts.filter((p) => this.selection.has(p.id));
    const pair = (selected.length >= 2 ? selected : pts).slice(0, 2);
    if (pair.length < 2) return;
    const [p1, p2] = [pair[0]!, pair[1]!];
    const a = this.toScreen(p1.x, p1.y);
    const b = this.toScreen(p2.x, p2.y);

    g.strokeStyle = theme.gold;
    g.lineWidth = 1.8;
    g.globalAlpha = 0.9;
    g.beginPath();
    if (p1.x.equals(p2.x)) {
      if (p1.y.equals(p2.y)) { g.globalAlpha = 1; return; } // одна точка — секущей нет
      g.moveTo(a.x, 0);
      g.lineTo(a.x, this.heightPx);
    } else {
      const k = (b.y - a.y) / (b.x - a.x); // экранный наклон — только для отрисовки
      g.moveTo(0, a.y - a.x * k);
      g.lineTo(w, a.y + (w - a.x) * k);
    }
    g.stroke();
    g.globalAlpha = 1;

    const label = p1.x.equals(p2.x)
      ? 'вертикаль — крутизна не определена'
      : `крутизна = ${p2.y.sub(p1.y).toDisplay()}/${p2.x.sub(p1.x).toDisplay()} = ${p2.y.sub(p1.y).div(p2.x.sub(p1.x)).toDisplay()}`;
    g.fillStyle = theme.gold;
    g.font = 'bold 12px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText(label, (a.x + b.x) / 2, Math.min(a.y, b.y) - 12);
  }

  /**
   * Клетки под следом на отрезке [a; b] (этап D): закрашиваются только
   * ПОЛНЫЕ клетки между следом и осью, счётчик честно говорит «полных».
   * Родство с «Площадями»: площадь под следом считается кубиками-клетками.
   */
  private drawCells(g: CanvasRenderingContext2D, fn: NumFn): void {
    const a = Math.min(this.cellsA, this.cellsB);
    const b = Math.max(this.cellsA, this.cellsB);
    if (b - a < 1 || b - a > 60) return;

    let count = 0;
    g.fillStyle = theme.gold;
    g.strokeStyle = theme.gold;
    for (let i = a; i < b; i++) {
      const ys = [fn(i), fn(i + 0.5), fn(i + 1)];
      if (ys.some((y) => y === null)) continue;
      const vals = ys as number[];
      let rows = 0;
      let sign = 1;
      if (vals.every((y) => y >= 0)) {
        rows = Math.floor(Math.min(...vals) + 1e-9);
      } else if (vals.every((y) => y <= 0)) {
        rows = Math.floor(-Math.max(...vals) + 1e-9);
        sign = -1;
      } // столбец через ось — полных клеток нет
      for (let j = 0; j < rows; j++) {
        const tl = this.worldToScreen(i, sign * (j + 1));
        g.globalAlpha = 0.16;
        g.fillRect(tl.x, sign > 0 ? tl.y : this.worldToScreen(i, -j).y,
          this.scale, this.scale);
        g.globalAlpha = 0.45;
        g.lineWidth = 1;
        g.strokeRect(tl.x, sign > 0 ? tl.y : this.worldToScreen(i, -j).y,
          this.scale, this.scale);
        count++;
      }
    }
    g.globalAlpha = 1;
    const mid = this.worldToScreen((a + b) / 2, 0);
    g.fillStyle = theme.gold;
    g.font = 'bold 12px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText(`полных клеток на [${a}; ${b}]: ${count}`, mid.x, mid.y + 22);
  }

  private drawTrace(
    g: CanvasRenderingContext2D, w: number, h: number,
    fn: NumFn, color: string, alpha: number, width: number,
  ): void {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.globalAlpha = alpha;
    g.beginPath();
    let pen = false;
    let prevSy = 0;
    for (let sx = 0; sx <= w; sx += 2) {
      const y = fn((sx - this.origin.x) / this.scale);
      if (y === null) { pen = false; continue; } // дыра следа — отказ сигнатуры
      const sy = this.origin.y - y * this.scale;
      if (sy < -h * 3 || sy > h * 4) { pen = false; continue; } // далеко за экраном
      if (pen && Math.abs(sy - prevSy) > h) pen = false;        // разрыв-асимптота
      if (!pen) { g.moveTo(sx, sy); pen = true; } else { g.lineTo(sx, sy); }
      prevSy = sy;
    }
    g.stroke();
    g.globalAlpha = 1;
  }

  /** Заливка между следом и осью X: выше — зелёным, ниже — красным. */
  private drawFill(g: CanvasRenderingContext2D, w: number, h: number, fn: NumFn): void {
    for (const above of [true, false]) {
      g.save();
      g.beginPath();
      if (above) g.rect(0, 0, w, Math.max(this.origin.y, 0));
      else g.rect(0, Math.min(this.origin.y, h), w, h);
      g.clip();
      g.fillStyle = above ? FILL_ABOVE : theme.danger;
      g.globalAlpha = 0.12;
      g.beginPath();
      let started = false;
      let prevSx = 0;
      for (let sx = 0; sx <= w; sx += 2) {
        const y = fn((sx - this.origin.x) / this.scale);
        if (y === null) {
          if (started) { g.lineTo(prevSx, this.origin.y); started = false; }
          continue;
        }
        const sy = Math.min(Math.max(this.origin.y - y * this.scale, -h), h * 2);
        if (!started) { g.moveTo(sx, this.origin.y); started = true; }
        g.lineTo(sx, sy);
        prevSx = sx;
      }
      if (started) g.lineTo(prevSx, this.origin.y);
      g.fill();
      g.restore();
    }
  }

  /** Смены знака функции по видимой ширине; уточнение — бисекцией (только пиксели). */
  private findRoots(fn: NumFn, w: number): number[] {
    const out: number[] = [];
    const stepPx = 3;
    let prevX = 0;
    let prevY: number | null = null;
    for (let sx = 0; sx <= w; sx += stepPx) {
      const x = (sx - this.origin.x) / this.scale;
      const y = fn(x);
      if (y !== null && prevY !== null && ((prevY < 0 && y > 0) || (prevY > 0 && y < 0))) {
        let a = prevX; let b = x; let fa = prevY;
        for (let i = 0; i < 40; i++) {
          const m = (a + b) / 2;
          const fm = fn(m);
          if (fm === null) break;
          if ((fa < 0) !== (fm < 0)) b = m;
          else { a = m; fa = fm; }
        }
        const root = (a + b) / 2;
        if (!out.some((r) => Math.abs(r - root) * this.scale < 8)) out.push(root);
      }
      prevX = x;
      prevY = y;
    }
    return out;
  }

  private drawMarker(g: CanvasRenderingContext2D, x: number, y: number, label: string): void {
    const sx = this.origin.x + x * this.scale;
    const sy = this.origin.y - y * this.scale;
    g.strokeStyle = theme.gold;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sx, sy, 5.5, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = theme.gold;
    g.font = 'bold 11px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText(label, sx, sy + 8);
  }

  /** Подпись float-значения маркера: полуцелые — точно, прочие — честное «≈». */
  private fmtNum(v: number): string {
    const snapped = Math.round(v * 2) / 2;
    if (Math.abs(v - snapped) < 1e-6) return String(snapped).replace('.', ',');
    return `≈${v.toFixed(2).replace('.', ',')}`;
  }
}
