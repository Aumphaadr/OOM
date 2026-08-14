import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer, hammerHeadPoint } from '../render/hammer';
import { FlyingLabels, ShakeAnim, SwingAnim, wobbleAngle } from '../render/motion';
import { NumberObject, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { clipFromObject, spawnFromClip } from '../core/clipboard';
import { drawDeleteBadge, DELETE_R } from '../render/widgets';
import { icon } from '../ui/icons';

const CART_W = 66;
const CART_H = 50;
const CART_R = 10;
const SECTION_W = 118;
const SECTION_H = 92;
const SECTION_MAX = 4;
const RIDE_SPEED = 240; // px/с
const BAND_MIN = 6;
const DRAG_THRESHOLD = 5; // px — меньше — это клик, а не перетаскивание

interface Pos { x: number; y: number }

/** Функциональный участок на ленте: слот под инструмент + положение (доля ширины). */
interface Section {
  toolId: string | null;
  x: number; // 0..1
}

/** Поездка: текущая позиция → [въезд на ленту →] выезд → домой. */
interface Ride {
  objectId: string;
  dist: number;
  applied: boolean[];
  jammed: boolean;
  path: Pos[];
  length: number;
  segLengths: number[];
  home: Pos;
  /** Индекс сегмента пути, лежащего на ленте (участки применяются только на нём). */
  beltSeg: number;
}

/**
 * Сцена «Конвейер»: инструмент как машина.
 * Участки (1–4) перетаскиваются вдоль ленты; порядок применения = порядок по x.
 * Депо работает как «Коробки»: выделение кликом и рамкой, групповое перетаскивание;
 * объект едет через ленту, если его бросили на неё (drag-n-drop), и возвращается домой.
 * Реверс применяет обратные инструменты; необратимый участок (×0) клинит.
 */
export class ConveyorScene implements Scene {
  readonly id = 'conveyor';
  readonly title = 'Конвейер';

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;

  private pointer = { x: 0, y: 0, inside: false };
  private widthPx = 800;
  private heightPx = 600;

  private sections: Section[] = [
    { toolId: null, x: 0.5 },
  ];
  private reversed = false;
  /** Множитель скорости ленты и возврата в док (регулятор в панели). */
  private speedK = 2;
  private reverseBtn: HTMLButtonElement | null = null;
  private countLabel: HTMLElement | null = null;

  /** Кольцо: выход подаётся обратно на вход (прогрессии, сложные проценты). */
  private loop = false;
  private loopLaps = 5;
  private readonly lapsLeft = new Map<string, number>();

  /** Перетаскивание участка; до порога движения трактуется как клик. */
  private sectionDrag: { index: number; dx: number; startX: number; startY: number; moved: boolean } | null = null;

  private readonly selection = new Set<string>();
  private band: { x0: number; y0: number; x1: number; y1: number; additive: boolean } | null = null;
  private groupDrag: { offsets: Map<string, Pos>; homes: Map<string, Pos>; moved: boolean } | null = null;

  private readonly rides = new Map<string, Ride>();
  private launchQueue: { id: string; home: Pos | null }[] = [];
  private launchTimer = 0;
  private static readonly LAUNCH_INTERVAL = 900; // мс

  private beltDashOffset = 0;
  private readonly swing = new SwingAnim();
  private readonly shakes = new Map<string, ShakeAnim>();
  private readonly labels = new FlyingLabels();

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      this.deleteSelection();
    }
    if (e.key === 'Escape') this.selection.clear();

    if ((e.ctrlKey || e.metaKey) && this.ctx) {
      const k = e.code; // физический код: работает на любой раскладке
      if (k === 'KeyC' || k === 'KeyX') {
        const positions = [...this.selection]
          .map((id) => ({ id, pos: this.posOf(id) }))
          .filter((p): p is { id: string; pos: Pos } => !!p.pos && !this.rides.has(p.id));
        if (!positions.length) return;
        e.preventDefault();
        const ax = Math.min(...positions.map((p) => p.pos.x));
        const ay = Math.min(...positions.map((p) => p.pos.y));
        this.ctx.clipboard.items = positions.flatMap(({ id, pos }) => {
          const obj = this.ctx!.session.objects.get(id);
          const item = obj && clipFromObject(obj, pos.x - ax, pos.y - ay);
          return item ? [item] : [];
        });
        if (k === 'KeyX' && this.ctx.restrictions.construct) this.deleteSelection();
      }
      if (k === 'KeyV' && this.ctx.restrictions.construct && this.ctx.clipboard.items.length) {
        e.preventDefault();
        const ax = this.pointer.inside ? this.pointer.x : 120;
        const ay = this.pointer.inside ? this.pointer.y : this.heightPx * 0.6;
        this.selection.clear();
        for (const item of this.ctx.clipboard.items) {
          const obj = spawnFromClip(this.ctx.session, item);
          if (obj.kind === 'number') {
            obj.scenePos.set(this.id, { x: ax + item.dx, y: ay + item.dy });
            this.selection.add(obj.id);
          }
        }
      }
    }
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'tool-applied') {
        const ride = this.rides.get(e.objectId);
        if (ride) {
          const pos = this.ridePos(ride);
          this.labels.spawn(visibleLabel(e.tool), pos.x, pos.y - CART_H);
        } else {
          const pos = this.posOf(e.objectId);
          if (pos) {
            this.labels.spawn(visibleLabel(e.tool), pos.x, pos.y - CART_H);
            if (!e.before.equals(e.after)) this.shakeFor(e.objectId).start();
          }
        }
      }
      if (e.kind === 'tool-rejected' && this.rides.has(e.objectId)) {
        const ride = this.rides.get(e.objectId)!;
        const pos = this.ridePos(ride);
        this.labels.spawn('⛔', pos.x, pos.y - CART_H);
        ride.jammed = true;
      }
      if (e.kind === 'tool-removed') {
        for (const s of this.sections) {
          if (s.toolId === e.toolId) s.toolId = null;
        }
      }
      if (e.kind === 'object-removed') {
        this.rides.delete(e.objectId);
        this.shakes.delete(e.objectId);
        this.selection.delete(e.objectId);
        this.lapsLeft.delete(e.objectId);
        this.launchQueue = this.launchQueue.filter((q) => q.id !== e.objectId);
      }
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.reverseBtn = null;
    this.countLabel = null;
    this.band = null;
    this.groupDrag = null;
    this.sectionDrag = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Конвейер</h3>
      <button id="belt-reverse" class="btn ghost"></button>
      <div class="series-row">
        <span class="field">скорость</span>
        <select id="belt-speed" style="flex:1">
          <option value="1">1× — не спеша</option>
          <option value="2" selected>2× — бодро</option>
          <option value="4">4× — вжух</option>
        </select>
      </div>
      <div class="series-row">
        <span class="field">участков: <b id="section-count"></b></span>
        <button id="section-add" class="btn ghost">+</button>
        <button id="section-del" class="btn ghost">−</button>
      </div>
      <div class="series-row">
        <label class="field tp-check" style="flex:2"><input type="checkbox" id="belt-loop" /> кольцо (выход → вход)</label>
        <label class="field">кругов<input id="belt-laps" type="number" value="5" min="2" max="20" /></label>
      </div>
      <div class="series-row">
        <label class="field">старт<input id="series-start" value="1" /></label>
        <label class="field">шаг<input id="series-step" value="1" /></label>
        <label class="field">штук<input id="series-count" type="number" value="5" min="1" max="12" /></label>
      </div>
      <button id="series-btn" class="btn primary"><span class="ic">${icon('play', 12)}</span>Пустить серию</button>
      <p class="hint">Участки перетаскиваются вдоль ленты; порядок применения — слева направо
        (в реверсе — справа налево, обратными инструментами). Объект едет, если бросить его
        на ленту; клик — выделение, рамка — группа, Delete — удалить выделенное.</p>
    `;
    this.reverseBtn = root.querySelector<HTMLButtonElement>('#belt-reverse')!;
    this.countLabel = root.querySelector<HTMLElement>('#section-count')!;
    this.updatePanel();

    this.reverseBtn.addEventListener('click', () => {
      this.reversed = !this.reversed;
      this.updatePanel();
    });
    root.querySelector<HTMLSelectElement>('#belt-speed')!.addEventListener('change', (e) => {
      this.speedK = Number((e.target as HTMLSelectElement).value) || 2;
    });
    const loopBox = root.querySelector<HTMLInputElement>('#belt-loop')!;
    const lapsInput = root.querySelector<HTMLInputElement>('#belt-laps')!;
    loopBox.addEventListener('change', () => { this.loop = loopBox.checked; });
    lapsInput.addEventListener('change', () => {
      const v = parseInt(lapsInput.value, 10);
      if (Number.isFinite(v)) this.loopLaps = Math.max(2, Math.min(20, v));
    });
    loopBox.checked = this.loop;
    lapsInput.value = String(this.loopLaps);

    root.querySelector<HTMLButtonElement>('#section-add')!.addEventListener('click', () => {
      if (this.sections.length >= SECTION_MAX) return;
      this.sections.push({ toolId: null, x: 0.5 });
      this.updatePanel();
    });
    root.querySelector<HTMLButtonElement>('#section-del')!.addEventListener('click', () => {
      if (this.sections.length <= 1) return;
      const removed = this.sections.pop()!;
      if (removed.toolId) this.ctx?.session.setToolHidden(removed.toolId, false);
      this.updatePanel();
    });

    root.querySelector<HTMLButtonElement>('#series-btn')!.addEventListener('click', () => {
      // серия создаёт объекты — в запертом упражнении это обход цели
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const start = Rational.parse(root.querySelector<HTMLInputElement>('#series-start')!.value);
      const step = Rational.parse(root.querySelector<HTMLInputElement>('#series-step')!.value);
      const count = Math.min(Math.max(Number(root.querySelector<HTMLInputElement>('#series-count')!.value) || 1, 1), 12);
      if (!start || !step) return;
      let v = start;
      for (let i = 0; i < count; i++) {
        const obj = this.ctx.session.spawnObject(v);
        this.launchQueue.push({ id: obj.id, home: null });
        v = v.add(step);
      }
    });
    return root;
  }

  private updatePanel(): void {
    if (this.reverseBtn) {
      this.reverseBtn.innerHTML =
        `<span class="ic">${icon('swap', 13)}</span>Лента: ${this.reversed ? 'реверс' : 'вперёд'}`;
    }
    if (this.countLabel) this.countLabel.textContent = String(this.sections.length);
  }

  // ---------- геометрия ----------

  private beltY(): number { return this.heightPx * 0.36; }
  private beltX0(): number { return 46; }
  private beltX1(): number { return this.widthPx - 46; }

  private sectionCenter(i: number): Pos {
    return { x: this.widthPx * this.sections[i]!.x, y: this.beltY() - SECTION_H / 2 + 14 };
  }
  private sectionRect(i: number): { x: number; y: number; w: number; h: number } {
    const c = this.sectionCenter(i);
    return { x: c.x - SECTION_W / 2, y: c.y - SECTION_H / 2, w: SECTION_W, h: SECTION_H };
  }
  private hiddenToggleCenter(i: number): Pos {
    const r = this.sectionRect(i);
    return { x: r.x + r.w - 4, y: r.y + 4 };
  }
  private sectionIndexAt(x: number, y: number): number | null {
    for (let i = this.sections.length - 1; i >= 0; i--) {
      const r = this.sectionRect(i);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
    }
    return null;
  }
  /** Буква участка по порядку применения (слева направо). */
  private sectionLetter(i: number): string {
    const order = [...this.sections.keys()].sort((a, b) => this.sections[a]!.x - this.sections[b]!.x);
    return String.fromCharCode(65 + order.indexOf(i)); // A, B, C, D
  }

  /** Зона «бросили на ленту». */
  private onBeltZone(p: Pos): boolean {
    return p.x >= this.beltX0() && p.x <= this.beltX1() && Math.abs(p.y - this.beltY()) <= 52;
  }

  private ensurePos(obj: NumberObject): Pos {
    let pos = obj.scenePos.get(this.id);
    if (!pos) {
      pos = this.firstFreeSlot();
      obj.scenePos.set(this.id, pos);
    }
    return pos;
  }

  /** Первое свободное место сетки депо: дырки от удалённых занимаются заново. */
  private firstFreeSlot(): Pos {
    const perRow = Math.max(1, Math.floor((this.widthPx - 60) / (CART_W + 18)));
    const taken: Pos[] = [];
    if (this.ctx) {
      for (const o of this.ctx.session.objects.values()) {
        if (o.kind !== 'number') continue;
        const p = o.scenePos.get(this.id);
        if (p) taken.push(p);
      }
    }
    for (let i = 0; i < 500; i++) {
      const x = 40 + (i % perRow) * (CART_W + 18) + CART_W / 2;
      const y = this.heightPx * 0.58 + Math.floor(i / perRow) * (CART_H + 16) + CART_H / 2;
      if (!taken.some((t) => Math.abs(t.x - x) < CART_W * 0.8 && Math.abs(t.y - y) < CART_H * 0.8)) {
        return { x, y };
      }
    }
    return { x: 40 + CART_W / 2, y: this.heightPx * 0.58 + CART_H / 2 };
  }

  private posOf(objectId: string): Pos | null {
    const obj = this.ctx?.session.objects.get(objectId);
    return obj ? (obj.scenePos.get(this.id) ?? null) : null;
  }

  private cartAt(x: number, y: number): NumberObject | null {
    if (!this.ctx) return null;
    const list = [...this.ctx.session.objects.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const obj = list[i]!;
      if (obj.kind !== 'number') continue;
      if (this.rides.has(obj.id)) continue;
      const p = obj.scenePos.get(this.id);
      if (p && Math.abs(x - p.x) <= CART_W / 2 && Math.abs(y - p.y) <= CART_H / 2) return obj;
    }
    return null;
  }

  private deleteBadgePos(pos: Pos): Pos {
    return { x: pos.x + CART_W / 2 - 3, y: pos.y - CART_H / 2 + 3 };
  }

  private deleteSelection(): void {
    if (!this.ctx) return;
    for (const id of [...this.selection]) this.ctx.session.removeObject(id);
    this.selection.clear();
  }

  // ---------- поездки ----------

  /**
   * Запуск поездки. fromBelt=true — объект брошен прямо на ленту:
   * X сохраняется (выравнивается только Y), въездного отрезка нет,
   * участки позади точки падения уже не применятся.
   */
  private startRide(obj: NumberObject, home: Pos, fromBelt = false): void {
    if (this.rides.has(obj.id)) return;
    const cur = obj.scenePos.get(this.id) ?? home;
    const yCart = this.beltY() - CART_H / 2 - 6;
    const enterX = this.reversed ? this.beltX1() - CART_W / 2 : this.beltX0() + CART_W / 2;
    const exitX = this.reversed ? this.beltX0() + CART_W / 2 : this.beltX1() - CART_W / 2;

    let path: Pos[];
    let beltSeg: number;
    if (fromBelt) {
      // не позволяем упасть «за выездом» и поехать задом
      const dropX = this.reversed ? Math.max(cur.x, exitX) : Math.min(cur.x, exitX);
      path = [
        { x: dropX, y: yCart },
        { x: exitX, y: yCart },
        { x: home.x, y: home.y },
      ];
      beltSeg = 0;
    } else {
      path = [
        { x: cur.x, y: cur.y },
        { x: enterX, y: yCart },
        { x: exitX, y: yCart },
        { x: home.x, y: home.y },
      ];
      beltSeg = 1;
    }

    const segLengths: number[] = [];
    let length = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const l = Math.hypot(path[i + 1]!.x - path[i]!.x, path[i + 1]!.y - path[i]!.y);
      segLengths.push(l);
      length += l;
    }
    this.rides.set(obj.id, {
      objectId: obj.id,
      dist: 0,
      applied: this.sections.map(() => false),
      jammed: false,
      path,
      length,
      segLengths,
      home,
      beltSeg,
    });
  }

  private ridePos(ride: Ride): Pos {
    let d = ride.dist;
    for (let i = 0; i < ride.segLengths.length; i++) {
      const l = ride.segLengths[i]!;
      if (d <= l) {
        const a = ride.path[i]!;
        const b = ride.path[i + 1]!;
        const t = l === 0 ? 1 : d / l;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      d -= l;
    }
    return ride.path[ride.path.length - 1]!;
  }

  private shakeFor(id: string): ShakeAnim {
    let s = this.shakes.get(id);
    if (!s) { s = new ShakeAnim(); this.shakes.set(id, s); }
    return s;
  }

  private updateRides(dt: number): void {
    if (!this.ctx) return;

    if (this.launchQueue.length) {
      this.launchTimer -= dt;
      if (this.launchTimer <= 0) {
        const item = this.launchQueue[0]!;
        const obj = this.ctx.session.objects.get(item.id);
        if (obj && obj.kind === 'number' && obj.scenePos.has(this.id)) {
          this.launchQueue.shift();
          this.startRide(obj, item.home ?? obj.scenePos.get(this.id)!);
          this.launchTimer = ConveyorScene.LAUNCH_INTERVAL;
        } else if (!obj) {
          this.launchQueue.shift();
        }
      }
    }

    for (const [id, ride] of this.rides) {
      if (ride.jammed) {
        ride.dist -= (RIDE_SPEED * this.speedK * dt) / 1000;
        if (ride.dist <= 0) {
          const obj = this.ctx.session.objects.get(id);
          // брошенным на ленту после клина некуда откатываться — домой
          const settle = ride.beltSeg === 0 ? ride.home : ride.path[0]!;
          obj?.scenePos.set(this.id, { ...settle });
          this.rides.delete(id);
        }
        continue;
      }

      const beforePos = this.ridePos(ride);
      ride.dist += (RIDE_SPEED * this.speedK * dt) / 1000;
      const afterPos = this.ridePos(ride);

      let beltStart = 0;
      for (let s = 0; s < ride.beltSeg; s++) beltStart += ride.segLengths[s]!;
      const onBelt = ride.dist > beltStart && ride.dist < beltStart + ride.segLengths[ride.beltSeg]!;
      if (onBelt) {
        for (let i = 0; i < this.sections.length; i++) {
          if (ride.applied[i]) continue;
          const cx = this.sectionCenter(i).x;
          const crossed = (beforePos.x - cx) * (afterPos.x - cx) <= 0 && beforePos.x !== afterPos.x;
          if (!crossed) continue;
          ride.applied[i] = true;
          const toolId = this.sections[i]!.toolId;
          if (toolId) {
            if (this.reversed) {
              this.ctx.session.applyInverse(toolId, ride.objectId);
            } else {
              this.ctx.hit(ride.objectId, toolId);
            }
          }
          if (ride.jammed) break;
        }
      }

      if (ride.dist >= ride.length) {
        const obj = this.ctx.session.objects.get(id);
        obj?.scenePos.set(this.id, { ...ride.home });
        this.rides.delete(id);

        // Кольцо: выход снова на вход, пока не выйдут круги (клин прерывает)
        if (this.loop && !ride.jammed) {
          const left = this.lapsLeft.get(id) ?? this.loopLaps;
          if (left > 1) {
            this.lapsLeft.set(id, left - 1);
            this.launchQueue.push({ id, home: ride.home });
          } else {
            this.lapsLeft.delete(id);
          }
        }
      }
    }
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number; shift?: boolean }): void {
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };

    if (p.button === 2) {
      this.ctx.dropHand();
      return;
    }
    if (p.button !== 0) return;

    // Тумблеры «чёрный ящик»
    for (let i = 0; i < this.sections.length; i++) {
      const toggle = this.hiddenToggleCenter(i);
      const toolId = this.sections[i]!.toolId;
      if (toolId && Math.hypot(p.x - toggle.x, p.y - toggle.y) <= 12) {
        const tool = this.ctx.session.tools.get(toolId);
        if (tool) this.ctx.session.setToolHidden(tool.id, !tool.hidden);
        return;
      }
    }

    // Участок: с молотком в руке — вставить сразу; с пустой рукой — клик/перетаскивание
    const si = this.sectionIndexAt(p.x, p.y);
    if (si !== null) {
      if (this.ctx.hand.toolId) {
        this.sections[si]!.toolId = this.ctx.hand.toolId;
        this.ctx.dropHand();
        return;
      }
      const c = this.sectionCenter(si);
      this.sectionDrag = { index: si, dx: p.x - c.x, startX: p.x, startY: p.y, moved: false };
      return;
    }

    // Молоток в руке бьёт по депо
    if (this.ctx.hand.toolId) {
      const head = hammerHeadPoint(p.x, p.y);
      const target = this.cartAt(head.x, head.y) ?? this.cartAt(p.x, p.y);
      if (target) {
        this.swing.start();
        this.ctx.hit(target.id);
      }
      return;
    }

    // Пустая рука: выделение и групповое перетаскивание, как в «Коробках»
    const cart = this.cartAt(p.x, p.y);
    if (cart) {
      // Shift+клик: добавить/убрать из выделения, без перетаскивания
      if (p.shift) {
        if (this.selection.has(cart.id)) this.selection.delete(cart.id);
        else this.selection.add(cart.id);
        return;
      }
      const pos = cart.scenePos.get(this.id)!;
      if (this.selection.has(cart.id)) {
        const b = this.deleteBadgePos(pos);
        if (this.ctx.restrictions.construct && Math.hypot(p.x - b.x, p.y - b.y) <= DELETE_R) {
          this.deleteSelection();
          return;
        }
      } else {
        this.selection.clear();
        this.selection.add(cart.id);
      }
      const offsets = new Map<string, Pos>();
      const homes = new Map<string, Pos>();
      for (const id of this.selection) {
        const sp = this.posOf(id);
        if (sp) {
          offsets.set(id, { x: p.x - sp.x, y: p.y - sp.y });
          homes.set(id, { ...sp });
        }
      }
      this.groupDrag = { offsets, homes, moved: false };
    } else {
      this.band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: !!p.shift };
    }
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };

    if (this.sectionDrag) {
      const d = this.sectionDrag;
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > DRAG_THRESHOLD) d.moved = true;
      if (d.moved) {
        const frac = (p.x - d.dx) / this.widthPx;
        this.sections[d.index]!.x = Math.min(Math.max(frac, 0.09), 0.91);
      }
      return;
    }

    if (this.groupDrag && this.ctx) {
      this.groupDrag.moved = true;
      for (const [id, off] of this.groupDrag.offsets) {
        const obj = this.ctx.session.objects.get(id);
        obj?.scenePos.set(this.id, { x: p.x - off.x, y: p.y - off.y });
      }
    }
    if (this.band) {
      this.band.x1 = p.x;
      this.band.y1 = p.y;
    }
  }

  onPointerUp(p: { x: number; y: number; button: number }): void {
    if (!this.ctx) return;

    // Участок: клик без движения = забрать инструмент в руку
    if (this.sectionDrag) {
      const d = this.sectionDrag;
      this.sectionDrag = null;
      if (!d.moved) {
        const toolId = this.sections[d.index]!.toolId;
        if (toolId) {
          this.sections[d.index]!.toolId = null;
          this.ctx.session.setToolHidden(toolId, false); // тайна раскрыта
          this.ctx.takeHand(toolId);
        }
      }
      return;
    }

    // Бросили группу: кто оказался на ленте — сразу едет с того же X и вернётся домой
    if (this.groupDrag) {
      const gd = this.groupDrag;
      this.groupDrag = null;
      if (gd.moved) {
        for (const [id, home] of gd.homes) {
          const cur = this.posOf(id);
          const obj = this.ctx.session.objects.get(id);
          if (cur && obj?.kind === 'number' && this.onBeltZone(cur)) {
            this.startRide(obj, home, true);
          }
        }
      }
      return;
    }

    // Рамка выделения
    if (this.band) {
      const x0 = Math.min(this.band.x0, this.band.x1);
      const x1 = Math.max(this.band.x0, this.band.x1);
      const y0 = Math.min(this.band.y0, this.band.y1);
      const y1 = Math.max(this.band.y0, this.band.y1);
      if (!this.band.additive) this.selection.clear();
      if (x1 - x0 > BAND_MIN || y1 - y0 > BAND_MIN) {
        for (const obj of this.ctx.session.objects.values()) {
          if (obj.kind !== 'number' || this.rides.has(obj.id)) continue;
          const c = obj.scenePos.get(this.id);
          if (c && c.x + CART_W / 2 >= x0 && c.x - CART_W / 2 <= x1 && c.y + CART_H / 2 >= y0 && c.y - CART_H / 2 <= y1) {
            this.selection.add(obj.id);
          }
        }
      }
      this.band = null;
    }
    void p;
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;
    this.widthPx = w;
    this.heightPx = h;

    this.updateRides(dt);
    this.beltDashOffset += ((this.reversed ? 1 : -1) * (RIDE_SPEED * this.speedK * dt)) / 1000;

    this.drawBelt(g);
    for (let i = 0; i < this.sections.length; i++) this.drawSection(g, i);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    const head = hand ? hammerHeadPoint(this.pointer.x, this.pointer.y) : null;
    const targeted = head ? (this.cartAt(head.x, head.y) ?? this.cartAt(this.pointer.x, this.pointer.y)) : null;

    for (const obj of this.ctx.session.objects.values()) {
      if (obj.kind !== 'number') continue;
      const ride = this.rides.get(obj.id);
      const pos = ride ? this.ridePos(ride) : this.ensurePos(obj);
      const shake = this.shakes.get(obj.id)?.update(dt) ?? 0;
      this.drawCart(g, obj, pos.x, pos.y, obj === targeted, !!ride, ride?.jammed ?? false, shake, this.selection.has(obj.id));
    }

    // Крестики на выделенных (рука пуста, конструирование открыто)
    if (!hand && this.ctx.restrictions.construct) {
      for (const id of this.selection) {
        if (this.rides.has(id)) continue;
        const pos = this.posOf(id);
        if (!pos) continue;
        const b = this.deleteBadgePos(pos);
        drawDeleteBadge(g, b.x, b.y, Math.hypot(this.pointer.x - b.x, this.pointer.y - b.y) <= DELETE_R);
      }
    }

    // Рамка выделения
    if (this.band) {
      const x = Math.min(this.band.x0, this.band.x1);
      const y = Math.min(this.band.y0, this.band.y1);
      g.save();
      g.fillStyle = 'rgba(40, 220, 120, 0.08)';
      g.strokeStyle = theme.accentBorder;
      g.lineWidth = 1;
      g.setLineDash([5, 5]);
      g.fillRect(x, y, Math.abs(this.band.x1 - this.band.x0), Math.abs(this.band.y1 - this.band.y0));
      g.strokeRect(x, y, Math.abs(this.band.x1 - this.band.x0), Math.abs(this.band.y1 - this.band.y0));
      g.restore();
    }

    this.labels.update(dt);
    this.labels.draw(g, theme.gold);

    if (hand && this.pointer.inside) {
      const swingAngle = this.swing.update(dt);
      const angle = swingAngle !== 0 ? swingAngle : wobbleAngle(now);
      drawHammer(g, this.pointer.x, this.pointer.y, angle, visibleLabel(hand));
    }
  }

  private drawBelt(g: CanvasRenderingContext2D): void {
    const y = this.beltY();
    const x0 = this.beltX0();
    const x1 = this.beltX1();

    g.fillStyle = theme.bgSecondary;
    g.strokeStyle = theme.border;
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x0 - 16, y - 7, x1 - x0 + 32, 26, 13);
    g.fill();
    g.stroke();

    g.save();
    g.strokeStyle = theme.grid;
    g.lineWidth = 8;
    g.setLineDash([14, 18]);
    g.lineDashOffset = this.beltDashOffset;
    g.beginPath();
    g.moveTo(x0, y + 6);
    g.lineTo(x1, y + 6);
    g.stroke();
    g.restore();

    for (const rx of [x0 - 16 + 13, x1 + 16 - 13]) {
      g.fillStyle = theme.metal;
      g.strokeStyle = theme.metalStroke;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(rx, y + 6, 11, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = theme.ferrule;
      g.beginPath();
      g.arc(rx, y + 6, 3.5, 0, Math.PI * 2);
      g.fill();
    }

    g.fillStyle = theme.textSecondary;
    g.globalAlpha = 0.7;
    g.font = 'bold 14px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(this.reversed ? '←' : '→', (x0 + x1) / 2, y + 40);
    g.globalAlpha = 1;
  }

  private drawSection(g: CanvasRenderingContext2D, i: number): void {
    if (!this.ctx) return;
    const r = this.sectionRect(i);
    const toolId = this.sections[i]!.toolId;
    const tool = toolId ? this.ctx.session.tools.get(toolId) : null;

    g.fillStyle = theme.bgTertiary;
    g.beginPath();
    g.roundRect(r.x, r.y, r.w, r.h, 12);
    g.fill();

    if (tool) {
      g.strokeStyle = tool.hidden ? theme.gold : theme.accentBorder;
      g.lineWidth = 2;
      g.shadowColor = tool.hidden ? theme.gold : theme.accentGlow;
      g.shadowBlur = 12;
    } else {
      g.strokeStyle = theme.border;
      g.lineWidth = 2;
      g.shadowBlur = 0;
      g.setLineDash([6, 6]);
    }
    g.beginPath();
    g.roundRect(r.x, r.y, r.w, r.h, 12);
    g.stroke();
    g.shadowBlur = 0;
    g.setLineDash([]);

    // Бирка порядка применения (по x) и точки-грип, что участок можно таскать
    g.fillStyle = theme.textSecondary;
    g.globalAlpha = 0.7;
    g.font = 'bold 12px Inter, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(this.sectionLetter(i), r.x + 8, r.y + 6);
    g.globalAlpha = 0.45;
    g.textAlign = 'center';
    g.fillText('⋮⋮', r.x + r.w / 2, r.y + 4);
    g.globalAlpha = 1;

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (tool) {
      g.fillStyle = tool.hidden ? theme.gold : theme.accent;
      g.font = 'bold 24px Inter, sans-serif';
      g.fillText(visibleLabel(tool), r.x + r.w / 2, r.y + r.h / 2);

      const t = this.hiddenToggleCenter(i);
      g.fillStyle = tool.hidden ? theme.gold : theme.bgSecondary;
      g.strokeStyle = tool.hidden ? theme.gold : theme.border;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(t.x, t.y, 11, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = tool.hidden ? theme.bgPrimary : theme.textSecondary;
      g.font = 'bold 13px Inter, sans-serif';
      g.fillText('?', t.x, t.y + 0.5);
    } else {
      g.fillStyle = theme.textSecondary;
      g.font = '11px Inter, sans-serif';
      g.fillText('клик с молотком', r.x + r.w / 2, r.y + r.h / 2 - 8);
      g.fillText('— вставить', r.x + r.w / 2, r.y + r.h / 2 + 8);
    }
  }

  private drawCart(
    g: CanvasRenderingContext2D,
    obj: NumberObject,
    cx: number,
    cy: number,
    targeted: boolean,
    riding: boolean,
    jammed: boolean,
    shake: number,
    selected: boolean,
  ): void {
    const x = cx - CART_W / 2;
    const y = cy - CART_H / 2;
    const sign = obj.value.sign();

    g.save();
    if (shake !== 0) {
      g.translate(cx, cy);
      g.rotate(shake);
      g.translate(-cx, -cy);
    }

    g.fillStyle = theme.boxFill(sign);
    g.beginPath();
    g.roundRect(x, y, CART_W, CART_H, CART_R);
    g.fill();

    if (selected && !riding) {
      g.strokeStyle = theme.textPrimary;
      g.lineWidth = 3;
      g.shadowColor = theme.textPrimary;
      g.shadowBlur = 12;
      g.setLineDash([]);
      g.beginPath();
      g.roundRect(x - 3, y - 3, CART_W + 6, CART_H + 6, CART_R + 3);
      g.stroke();
      g.shadowBlur = 0;
    } else if (targeted) {
      g.strokeStyle = theme.canvasGreen;
      g.lineWidth = 3;
      g.shadowColor = theme.canvasGreen;
      g.shadowBlur = 15;
      g.setLineDash([5, 5]);
      g.beginPath();
      g.roundRect(x - 4, y - 4, CART_W + 8, CART_H + 8, CART_R + 2);
      g.stroke();
      g.shadowBlur = 0;
      g.setLineDash([]);
    } else {
      const strokeColor = jammed ? theme.danger : riding ? theme.accentBorder : theme.boxStroke(sign);
      g.strokeStyle = strokeColor;
      g.lineWidth = 2;
      if (riding) {
        g.shadowColor = jammed ? theme.danger : theme.accentGlow;
        g.shadowBlur = 10;
      }
      g.beginPath();
      g.roundRect(x, y, CART_W, CART_H, CART_R);
      g.stroke();
      g.shadowBlur = 0;
    }

    const text = obj.value.toDisplay();
    g.fillStyle = theme.textPrimary;
    g.font = `bold ${text.length > 5 ? 14 : 18}px Inter, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cx, cy);

    if (obj.variable) {
      g.fillStyle = theme.accent;
      g.font = 'bold 10px Inter, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(obj.variable.name, x + 5, y + 3);
    }

    if (riding) {
      g.fillStyle = theme.metal;
      for (const wx of [cx - CART_W / 4, cx + CART_W / 4]) {
        g.beginPath();
        g.arc(wx, y + CART_H + 4, 5, 0, Math.PI * 2);
        g.fill();
      }
    }

    g.restore();
  }
}
