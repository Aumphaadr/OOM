import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer } from '../render/hammer';
import { FlyingLabels, wobbleAngle } from '../render/motion';
import {
  PointObject, VectorObject, FunctionObject, PolygonObject, CircleObject, Tool, PrimitiveOp,
  visibleLabel, polygonArea, polygonPerimeter, polygonIsSimple, polygonVertexAngle,
  circleAreaText, circleCircumferenceText,
} from '../core/model';
import { clipFromObject, spawnFromClip } from '../core/clipboard';
import { loadSettings } from '../ui/settings';
import { parseFormula, evalNum, FormulaNode } from '../core/formula';
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
const POLY_VERT_R = 10;  // захват вершины выделенной фигуры
const POLY_CLOSE_R = 14; // клик у первой вершины замыкает постройку
const CIRC_CENTER_R = 10; // захват центра окружности
const CIRC_EDGE_R = 8;    // захват обода (радиус тянется за любую его точку)
/** Свотчи выбора цвета функции: фиксированная палитра, одинаковая во всех браузерах. */
const SWATCHES = [
  '#4fc3f7', '#ff9e64', '#9ece6a', '#f7768e', '#bb9af7',
  '#e0af68', '#7dcfff', '#73daca', '#ff7a93', '#c0caf5',
];
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

/**
 * Сцена «Плоскость» — этапы A «Адреса» и B «Следы» (docs/design-plane.md).
 * Точки-объекты с точными адресами; след инструмента, взятого в руку
 * (молоток и его портрет — одно и то же), жест «прогони вход» по оси X,
 * закрепление до трёх следов и чтение: проколы, точки встречи, выше/ниже оси.
 */
export class PlaneScene implements Scene {
  readonly id = 'plane';
  readonly title = 'Плоскость';
  readonly sidebar: { tools?: boolean; objects?: boolean } = { tools: false, objects: false };

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
    | { type: 'poly'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean }
    | { type: 'poly-vertex'; id: string; index: number; startX: number; startY: number; moved: boolean;
        wasSelected: boolean }
    | { type: 'circ-center'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean }
    | { type: 'circ-edge'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean }
    | { type: 'band'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
    | null = null;
  private lastClick = { time: 0, x: 0, y: 0 };
  private lastTrace = { time: 0, key: '' };
  /** Точка под хвостом перетаскиваемой стрелки: отпускание выполнит команду. */
  private dropPoint: string | null = null;
  private shiftDown = false;
  private pointer = { x: 0, y: 0, inside: false };
  private readonly labels = new FlyingLabels();

  /** Кэш разборов формул: id функции → {formula, ast}. */
  private readonly astCache = new Map<string, { formula: string; ast: FormulaNode | null }>();
  /** Черновики формул (живой предпросмотр при наборе; ход — по change). */
  private readonly drafts = new Map<string, string>();
  /** Анимации порождения: id функции → старт и направление. */
  private readonly genAnims = new Map<string, { start: number; dir: 1 | -1 }>();
  private showRoots = false;
  private showMeets = false;
  private showFill = false;
  private showSecant = false;
  private showCells = false;
  private cellsA = 0;
  private cellsB = 4;
  private funcList: HTMLElement | null = null;
  private colorPop: HTMLElement | null = null;
  private colorPopFor: string | null = null;
  private sumBtn: HTMLButtonElement | null = null;
  private flipXBtn: HTMLButtonElement | null = null;
  private flipYBtn: HTMLButtonElement | null = null;
  private rotCcwBtn: HTMLButtonElement | null = null;
  private rotCwBtn: HTMLButtonElement | null = null;
  /** Постройка многоугольника: набранные вершины (null — режим выключен). */
  private buildVerts: { x: Rational; y: Rational }[] | null = null;
  private buildBtn: HTMLButtonElement | null = null;
  /** Постройка окружности: null — выключена, center: null — ждём клик-центр. */
  private buildCirc: { center: { x: Rational; y: Rational } | null } | null = null;
  private buildCircBtn: HTMLButtonElement | null = null;
  /** Фигура/круг под хвостом стрелки: отпускание выполнит команду. */
  private dropPoly: string | null = null;
  private dropCirc: string | null = null;
  /** ПКМ-карточка личных подписей фигуры (площадь/периметр/углы…). */
  private figCard: HTMLElement | null = null;
  private figCardFor: string | null = null;
  private canvasEl: HTMLElement | null = null;

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    this.shiftDown = e.shiftKey;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      for (const id of [...this.selection]) this.ctx.session.removeObject(id);
      this.selection.clear();
    }
    if (e.key === 'Escape') {
      this.selection.clear();
      this.setBuild(null); // Esc обрывает постройку
      this.setBuildCirc(null);
      if (this.figCard) this.figCard.hidden = true;
    }

    // Копирование фигур: Ctrl+C/X/V (физические коды — любая раскладка)
    if ((e.ctrlKey || e.metaKey) && this.ctx) {
      const k = e.code;
      if (k === 'KeyC' || k === 'KeyX') {
        const items = [...this.selection].flatMap((id) => {
          const obj = this.ctx!.session.objects.get(id);
          if (!obj || (obj.kind !== 'polygon' && obj.kind !== 'circle')) return [];
          const item = clipFromObject(obj, 0, 0);
          return item ? [item] : [];
        });
        if (!items.length) return;
        e.preventDefault();
        this.ctx.clipboard.items = items;
        if (k === 'KeyX' && this.ctx.restrictions.construct) {
          for (const item of [...this.selection]) {
            const o = this.ctx.session.objects.get(item);
            if (o && (o.kind === 'polygon' || o.kind === 'circle')) this.ctx.session.removeObject(item);
          }
        }
      }
      if (k === 'KeyV' && this.ctx.restrictions.construct) {
        const items = this.ctx.clipboard.items.filter(
          (it) => it.kind === 'polygon' || it.kind === 'circle');
        if (!items.length) return;
        e.preventDefault();
        const step = this.gridStep().rat; // копия на клетку вправо-вниз, чтобы не слиться с оригиналом
        this.selection.clear();
        for (const item of items) {
          const obj = spawnFromClip(this.ctx.session, item);
          if (obj.kind === 'polygon') {
            obj.vertices = obj.vertices.map((v) => ({ x: v.x.add(step), y: v.y.sub(step) }));
          } else if (obj.kind === 'circle') {
            obj.cx = obj.cx.add(step);
            obj.cy = obj.cy.sub(step);
          }
          this.selection.add(obj.id);
        }
      }
    }
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
      if (e.kind === 'object-removed') {
        this.selection.delete(e.objectId);
        this.genAnims.delete(e.objectId);
        this.drafts.delete(e.objectId);
      }
      // список функций в панели следует за сессией (загрузка упражнений, undo)
      if ((e.kind === 'object-spawned' && e.object.kind === 'function') ||
          e.kind === 'object-removed' || e.kind === 'undo') {
        this.refreshFuncList();
      }
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
    this.funcList = null;
    this.colorPop?.remove();
    this.colorPop = null;
    this.sumBtn = null;
    this.flipXBtn = null;
    this.flipYBtn = null;
    this.buildBtn = null;
    this.buildVerts = null;
    this.buildCircBtn = null;
    this.buildCirc = null;
    this.dropPoly = null;
    this.dropCirc = null;
    document.removeEventListener('click', this.figCardOutside);
    this.figCard?.remove();
    this.figCard = null;
    if (this.canvasEl) this.canvasEl.style.cursor = '';
    this.canvasEl = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'panels-split';
    root.dataset.panels = 'split';
    root.innerHTML = `
      <section class="panel">
      <h3>Точки</h3>
      <div class="series-row">
        <label class="field" title="Адрес: сколько вбок (первое число пары)">x<input id="pt-x" value="3" /></label>
        <label class="field" title="Адрес: сколько вверх (второе число пары)">y<input id="pt-y" value="2" /></label>
        <button id="pt-spawn" class="btn primary" title="Поставить точку по адресу (x; y)"><span class="ic">${icon('plus', 12)}</span>Точка</button>
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
        к шагу видимой сетки (приблизился до десятых — ходишь по десятым;
        Shift — полшага). Зеркала и повороты действуют на выделенные точки.
        Колесо — зум, СКМ — пан, ЛКМ по пустому — рамка выделения.</p>
      </section>
      <section class="panel">
      <h3>Векторы</h3>
      <div class="series-row">
        <label class="field" title="Команда: сколько вбок">dx<input id="vc-dx" value="2" /></label>
        <label class="field" title="Команда: сколько вверх">dy<input id="vc-dy" value="1" /></label>
        <button id="vc-spawn" class="btn primary" title="Создать вектор с командой (dx; dy)"><span class="ic">${icon('plus', 12)}</span>Вектор</button>
      </div>
      <div class="series-row">
        <button id="vc-sum" class="btn" title="Сложить ровно ДВА выделенных вектора: новая стрелка = обе команды подряд (хвост к носу)">➕ Сумма выделенных</button>
      </div>
      <p class="hint">Вектор — команда «сколько вбок и сколько вверх» БЕЗ места:
        тащи её за древко куда угодно — команда не меняется. Голова меняет
        команду, хвост липнет к чужому носу — так стрелки складываются
        (выдели две и жми «Сумма»). А хвост, отпущенный НА ТОЧКЕ, выполняет
        команду: точка проходит путь и оказывается на носу.</p>
      </section>
      <section class="panel">
      <h3>Фигуры</h3>
      <div class="series-row btns-even">
        <button id="fg-build" class="btn primary" title="Построить полигон: клики по плоскости ставят вершины (со снапом к сетке), клик по первой вершине замыкает; Esc отменяет">⬠ Полигон</button>
        <button id="fg-circle" class="btn primary" title="Построить круг: первый клик — центр, второй — радиус (по шагу сетки); Esc отменяет">⊙ Круг</button>
      </div>
      <p class="hint">Полигон — построение: вершина за вершиной, замкнул —
        фигура готова. У круга два клика: центр и радиус. Тащи фигуру
        за тело (вся едет строем), вершину выделенной — за кружок, обод
        круга — радиус. ПКМ по фигуре — карточка подписей (площадь,
        периметр, углы; у круга — радиус и длина). Зеркала, повороты
        и молоток ×k действуют как на точки. Хвост стрелки, отпущенный
        на фигуре, ведёт её всю по команде. Ctrl+C/V копирует выделенные
        фигуры, Del удаляет, Esc обрывает постройку.</p>
      </section>
      <section class="panel">
      <h3>Функции</h3>
      <div id="fn-list"></div>
      <div class="series-row">
        <button id="fn-add" class="btn primary" title="Добавить функцию: пустая строка с полем формулы"><span class="ic">${icon('plus', 12)}</span>функция</button>
      </div>
      <label class="field tp-check" title="Золотые кольца там, где след протыкает ось X (выход равен нулю) — это корни"><input type="checkbox" id="tr-roots" /> проколы оси X</label>
      <label class="field tp-check" title="Кольца на пересечениях СЛЕДОВ ДРУГ С ДРУГОМ: входы, где две разные функции дают одинаковый выход. Нужны минимум две функции"><input type="checkbox" id="tr-meets" /> точки встречи</label>
      <label class="field tp-check" title="Закрасить плоскость по выходам последнего следа: зелёное — выход положительный, красное — отрицательный"><input type="checkbox" id="tr-fill" /> подсветить выше/ниже оси</label>
      <label class="field tp-check" title="Прямая через две выделенные точки (иначе — первые две на доске) с точной крутизной Δy/Δx"><input type="checkbox" id="tr-secant" /> секущая через 2 точки</label>
      <label class="field tp-check" title="Закрасить и посчитать ПОЛНЫЕ клетки между следом и осью X на отрезке [от; до]"><input type="checkbox" id="tr-cells" /> клетки под следом</label>
      <div class="series-row" id="tr-cells-range" hidden>
        <label class="field" title="Левый край отрезка для счёта клеток">от<input id="tr-cells-a" value="0" /></label>
        <label class="field" title="Правый край отрезка для счёта клеток">до<input id="tr-cells-b" value="4" /></label>
      </div>
      <p class="hint">Функция — машина с паспортом-формулой, её след ложится
        на плоскость своим цветом (кнопка «y =» выбирает цвет). Клик по оси X
        или прямо по следу — «прогони вход»: пара вход-выход становится
        точкой. ▶ проигрывает порождение следа по точкам, ✕ стирает функцию.
        В формуле можно x, скобки, + − * / ^, sqrt(), cbrt(), abs().</p>
      </section>
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

    this.buildBtn = root.querySelector<HTMLButtonElement>('#fg-build');
    this.buildBtn!.addEventListener('click', () => {
      if (!this.ctx?.restrictions.construct) return;
      this.setBuildCirc(null); // режимы постройки не совмещаются
      this.setBuild(this.buildVerts ? null : []);
    });
    this.buildCircBtn = root.querySelector<HTMLButtonElement>('#fg-circle');
    this.buildCircBtn!.addEventListener('click', () => {
      if (!this.ctx?.restrictions.construct) return;
      this.setBuild(null);
      this.setBuildCirc(this.buildCirc ? null : { center: null });
    });
    this.buildFigCard();

    const flip = (axis: 'x' | 'y'): void => {
      if (!this.ctx) return;
      for (const pt of this.points()) {
        if (this.selection.has(pt.id)) this.ctx.session.flipPoint(pt.id, axis);
      }
      for (const poly of this.polygons()) {
        if (this.selection.has(poly.id)) this.ctx.session.flipPolygon(poly.id, axis);
      }
      for (const c of this.circles()) {
        if (this.selection.has(c.id)) this.ctx.session.flipCircle(c.id, axis);
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
      for (const poly of this.polygons()) {
        if (this.selection.has(poly.id)) this.ctx.session.rotatePolygon(poly.id, dir);
      }
      for (const c of this.circles()) {
        if (this.selection.has(c.id)) this.ctx.session.rotateCircle(c.id, dir);
      }
    };
    this.rotCcwBtn = root.querySelector<HTMLButtonElement>('#pt-rot-ccw');
    this.rotCwBtn = root.querySelector<HTMLButtonElement>('#pt-rot-cw');
    this.rotCcwBtn!.addEventListener('click', () => rotate('ccw'));
    this.rotCwBtn!.addEventListener('click', () => rotate('cw'));

    this.funcList = root.querySelector<HTMLElement>('#fn-list');
    root.querySelector<HTMLButtonElement>('#fn-add')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      this.ctx.session.spawnFunction('');
      this.refreshFuncList(true);
    });
    this.buildColorPop();
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
    this.refreshFuncList();
    return root;
  }

  // ---------- следы ----------

  private handTool(): Tool | null {
    if (!this.ctx?.hand.toolId) return null;
    return this.ctx.session.tools.get(this.ctx.hand.toolId) ?? null;
  }

  private funcObjs(): FunctionObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()]
      .filter((o): o is FunctionObject => o.kind === 'function');
  }

  /** Вычислитель следа функции (черновик набора важнее сохранённой формулы). */
  private fnFor(f: FunctionObject): NumFn | null {
    const formula = this.drafts.get(f.id) ?? f.formula;
    const cached = this.astCache.get(f.id);
    if (!cached || cached.formula !== formula) {
      this.astCache.set(f.id, { formula, ast: parseFormula(formula) });
    }
    const ast = this.astCache.get(f.id)!.ast;
    return ast ? (x) => evalNum(ast, x) : null;
  }

  /** Перестройка списка функций в панели (focus=true — фокус в последнее поле). */
  private refreshFuncList(focus = false): void {
    if (!this.funcList || !this.ctx) return;
    this.funcList.innerHTML = '';
    const construct = this.ctx.restrictions.construct;
    for (const f of this.funcObjs()) {
      const row = document.createElement('div');
      row.className = 'fn-row';
      const formula = this.drafts.get(f.id) ?? f.formula;
      row.innerHTML = `
        <button class="fn-color" title="Цвет следа ${f.label}" style="background:${f.color}">y=</button>
        <input class="fn-formula" spellcheck="false" placeholder="например: x^2 - 2(x+5) + 10" />
        <button class="fn-mini fn-anim" title="Анимация порождения следа">▶</button>
        <button class="fn-mini fn-del" title="Стереть функцию" ${construct ? '' : 'hidden'}>✕</button>
      `;
      const input = row.querySelector<HTMLInputElement>('.fn-formula')!;
      input.value = formula;
      const syncBad = (): void => {
        const txt = input.value.trim();
        input.classList.toggle('bad', txt !== '' && !parseFormula(txt));
      };
      syncBad();
      input.addEventListener('input', () => {
        this.drafts.set(f.id, input.value); // живой предпросмотр без хода
        syncBad();
      });
      input.addEventListener('change', () => {
        this.drafts.delete(f.id);
        this.ctx?.session.setFunctionFormula(f.id, input.value.trim()); // ход
        syncBad();
      });
      row.querySelector<HTMLButtonElement>('.fn-color')!.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openColorPop(f.id, ev.currentTarget as HTMLElement);
      });
      row.querySelector<HTMLButtonElement>('.fn-anim')!.addEventListener('click', () => {
        const cur = this.genAnims.get(f.id);
        this.genAnims.set(f.id, { start: performance.now(), dir: cur?.dir === 1 ? -1 : 1 });
      });
      row.querySelector<HTMLButtonElement>('.fn-del')!.addEventListener('click', () => {
        this.ctx?.session.removeObject(f.id);
      });
      this.funcList.appendChild(row);
    }
    if (focus) {
      const inputs = this.funcList.querySelectorAll<HTMLInputElement>('.fn-formula');
      inputs[inputs.length - 1]?.focus();
    }
  }

  /** Кастомный выбор цвета: поповер со свотчами — одинаков во всех браузерах. */
  private buildColorPop(): void {
    this.colorPop?.remove();
    this.colorPop = document.createElement('div');
    this.colorPop.className = 'color-pop';
    this.colorPop.hidden = true;
    for (const c of SWATCHES) {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        if (this.colorPopFor) this.ctx?.session.setFunctionColor(this.colorPopFor, c);
        this.colorPop!.hidden = true;
        this.refreshFuncList();
      });
      this.colorPop.appendChild(b);
    }
    document.body.appendChild(this.colorPop);
    document.addEventListener('click', (ev) => {
      if (this.colorPop && !this.colorPop.hidden && !this.colorPop.contains(ev.target as Node)) {
        this.colorPop.hidden = true;
      }
    });
  }

  private openColorPop(funcId: string, anchor: HTMLElement): void {
    if (!this.colorPop) return;
    this.colorPopFor = funcId;
    const r = anchor.getBoundingClientRect();
    this.colorPop.style.left = `${r.left}px`;
    this.colorPop.style.top = `${r.bottom + 6}px`;
    this.colorPop.hidden = false;
  }

  /** Все следы на плоскости: функции + след молотка в руке (упражнения). */
  private visibleTraces(): { fn: NumFn; color: string }[] {
    const out: { fn: NumFn; color: string }[] = [];
    for (const f of this.funcObjs()) {
      const fn = this.fnFor(f);
      if (fn) out.push({ fn, color: f.color });
    }
    const hand = this.handTool();
    if (hand && !hand.hidden) {
      const fn = traceEval(hand);
      if (fn) out.push({ fn, color: theme.accent });
    }
    return out;
  }

  /** Шаг сетки 1-2-5×10^k: клетка держится в коридоре 36…90 пикселей. */
  private gridStep(): { step: number; decimals: number; rat: Rational } {
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
    const rat = exp >= 0
      ? Rational.of(BigInt(mant) * 10n ** BigInt(exp))
      : Rational.of(BigInt(mant), 10n ** BigInt(-exp));
    return { step: mant * Math.pow(10, exp), decimals, rat };
  }

  /**
   * Снап-шаг = текущему шагу сетки (Shift — половина шага): что видно
   * глазами, по тому и ходим — приблизился до десятых, двигаешь по десятым.
   */
  private snapStep(): Rational {
    const rat = this.gridStep().rat;
    return this.shiftDown ? rat.div(Rational.of(2)) : rat;
  }

  /** Экранный X → мировой, прищёлкнутый к шагу сетки. */
  private snapX(sx: number): Rational {
    const step = this.snapStep();
    const k = Math.round(((sx - this.origin.x) / this.scale) / step.toNumber());
    return step.mul(Rational.of(k));
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

  /** Экран → мир со снапом к шагу сетки (Shift — половина шага). */
  private toWorldSnapped(sx: number, sy: number): { x: Rational; y: Rational } {
    const step = this.snapStep();
    const n = step.toNumber();
    const kx = Math.round(((sx - this.origin.x) / this.scale) / n);
    const ky = Math.round(((this.origin.y - sy) / this.scale) / n);
    return { x: step.mul(Rational.of(kx)), y: step.mul(Rational.of(ky)) };
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

  // ---------- многоугольники ----------

  private polygons(): PolygonObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is PolygonObject => o.kind === 'polygon');
  }

  /** Вход/выход из режима постройки: кнопка меняет подпись. */
  private setBuild(v: { x: Rational; y: Rational }[] | null): void {
    this.buildVerts = v;
    if (this.buildBtn) {
      this.buildBtn.textContent = v ? '✕ Отмена' : '⬠ Полигон';
      this.buildBtn.classList.toggle('primary', !v);
    }
  }

  private setBuildCirc(v: { center: { x: Rational; y: Rational } | null } | null): void {
    this.buildCirc = v;
    if (this.buildCircBtn) {
      this.buildCircBtn.textContent = v ? '✕ Отмена' : '⊙ Круг';
      this.buildCircBtn.classList.toggle('primary', !v);
    }
  }

  /** ПКМ-карточка: личные подписи фигуры, презентация — не ход. */
  private buildFigCard(): void {
    this.figCard?.remove();
    this.figCard = document.createElement('div');
    this.figCard.className = 'fig-card';
    this.figCard.hidden = true;
    document.body.appendChild(this.figCard);
    document.addEventListener('click', this.figCardOutside);
  }

  private readonly figCardOutside = (ev: MouseEvent): void => {
    if (this.figCard && !this.figCard.hidden && !this.figCard.contains(ev.target as Node)) {
      this.figCard.hidden = true;
    }
  };

  private openFigCard(obj: PolygonObject | CircleObject, sx: number, sy: number): void {
    if (!this.figCard) return;
    this.figCardFor = obj.id;
    const rows: [name: string, key: string, on: boolean][] = obj.kind === 'polygon'
      ? [['площадь', 'showArea', obj.showArea],
         ['периметр', 'showPerimeter', obj.showPerimeter],
         ['углы', 'showAngles', obj.showAngles]]
      : [['радиус', 'showRadius', obj.showRadius],
         ['площадь', 'showArea', obj.showArea],
         ['длина', 'showCircumference', obj.showCircumference]];
    this.figCard.innerHTML =
      `<div class="fig-card-title">${obj.label} — подписи</div>` +
      rows.map(([name, key, on]) =>
        `<label class="field tp-check"><input type="checkbox" data-key="${key}"${on ? ' checked' : ''}/> ${name}</label>`,
      ).join('');
    for (const input of this.figCard.querySelectorAll<HTMLInputElement>('input')) {
      input.addEventListener('change', () => {
        const o = this.figCardFor ? this.ctx?.session.objects.get(this.figCardFor) : null;
        if (o && (o.kind === 'polygon' || o.kind === 'circle')) {
          (o as unknown as Record<string, boolean>)[input.dataset.key!] = input.checked;
        }
      });
    }
    const stage = document.getElementById('stage')?.getBoundingClientRect();
    this.figCard.style.left = `${(stage?.left ?? 0) + sx + 10}px`;
    this.figCard.style.top = `${(stage?.top ?? 0) + sy + 10}px`;
    this.figCard.hidden = false;
  }

  private circles(): CircleObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is CircleObject => o.kind === 'circle');
  }

  /** Центр или обод окружности под курсором (верхняя — последняя). */
  private circleHitAt(sx: number, sy: number): { c: CircleObject; part: 'center' | 'edge' } | null {
    for (const c of this.circles().reverse()) {
      const s = this.toScreen(c.cx, c.cy);
      const dist = Math.hypot(s.x - sx, s.y - sy);
      if (dist <= CIRC_CENTER_R) return { c, part: 'center' };
      if (Math.abs(dist - c.r.toNumber() * this.scale) <= CIRC_EDGE_R) return { c, part: 'edge' };
    }
    return null;
  }

  /** Радиус по курсору: расстояние от центра, округлённое к шагу сетки (≥ шага). */
  private circleRadiusAt(center: { x: Rational; y: Rational }, sx: number, sy: number): Rational {
    const wx = (sx - this.origin.x) / this.scale;
    const wy = (this.origin.y - sy) / this.scale;
    const dist = Math.hypot(wx - center.x.toNumber(), wy - center.y.toNumber());
    const step = this.snapStep();
    const k = Math.max(1, Math.round(dist / step.toNumber()));
    return step.mul(Rational.of(k));
  }

  /** Тело фигуры под курсором (верхняя — последняя нарисованная). */
  private polygonAt(sx: number, sy: number): PolygonObject | null {
    for (const poly of this.polygons().reverse()) {
      const pts = poly.vertices.map((v) => this.toScreen(v.x, v.y));
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i]!;
        const b = pts[j]!;
        if ((a.y > sy) !== (b.y > sy) && sx < ((b.x - a.x) * (sy - a.y)) / (b.y - a.y) + a.x) {
          inside = !inside;
        }
      }
      if (inside) return poly;
    }
    return null;
  }

  /** Вершина ВЫДЕЛЕННОЙ фигуры под курсором — ручка для перетаскивания. */
  private polyVertexAt(sx: number, sy: number): { poly: PolygonObject; index: number } | null {
    for (const poly of this.polygons().reverse()) {
      if (!this.selection.has(poly.id)) continue;
      for (let i = 0; i < poly.vertices.length; i++) {
        const s = this.toScreen(poly.vertices[i]!.x, poly.vertices[i]!.y);
        if (Math.hypot(s.x - sx, s.y - sy) <= POLY_VERT_R) return { poly, index: i };
      }
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
    this.dropPoly = null;
    this.dropCirc = null;

    if (p.button === 2) {
      if (this.ctx.hand.toolId) {
        this.ctx.dropHand();
        return;
      }
      // ПКМ по фигуре — карточка личных подписей
      const hit = this.circleHitAt(p.x, p.y)?.c ?? this.polygonAt(p.x, p.y);
      if (hit) this.openFigCard(hit, p.x, p.y);
      return;
    }
    if (p.button === 1) { // СКМ — пан, как в GeoGebra
      this.gesture = { type: 'pan', startX: p.x, startY: p.y, baseX: this.origin.x, baseY: this.origin.y };
      return;
    }
    if (p.button !== 0) return;

    // Постройка многоугольника: клик — вершина, клик по первой — замыкание
    if (this.buildVerts && !this.ctx.hand.toolId) {
      const w = this.toWorldSnapped(p.x, p.y);
      if (this.buildVerts.length >= 3) {
        const first = this.toScreen(this.buildVerts[0]!.x, this.buildVerts[0]!.y);
        if (Math.hypot(first.x - p.x, first.y - p.y) <= POLY_CLOSE_R) {
          const poly = this.ctx.session.spawnPolygon(this.buildVerts);
          this.setBuild(null);
          if (poly) {
            const st = loadSettings(); // дефолтные подписи — из глобальных настроек
            poly.showArea = st.showAreaDefault;
            poly.showPerimeter = st.showPerimeterDefault;
            poly.showAngles = st.showAnglesDefault;
            this.selection.clear();
            this.selection.add(poly.id);
          }
          return;
        }
      }
      const last = this.buildVerts[this.buildVerts.length - 1];
      if (!last || !last.x.equals(w.x) || !last.y.equals(w.y)) this.buildVerts.push(w);
      return;
    }

    // Постройка окружности: первый клик — центр, второй — радиус
    if (this.buildCirc && !this.ctx.hand.toolId) {
      if (!this.buildCirc.center) {
        this.buildCirc.center = this.toWorldSnapped(p.x, p.y);
        return;
      }
      const center = this.buildCirc.center;
      const r = this.circleRadiusAt(center, p.x, p.y);
      const c = this.ctx.session.spawnCircle(center.x, center.y, r);
      this.setBuildCirc(null);
      if (c) {
        const st = loadSettings();
        c.showArea = st.showAreaDefault;
        c.showCircumference = st.showPerimeterDefault;
        this.selection.clear();
        this.selection.add(c.id);
      }
      return;
    }

    // Молоток в руке: по точке — гомотетия/разворот, по стрелке — растяжка,
    // по фигуре — гомотетия всем строем, по оси X — «прогони вход»
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
      const hitCirc = this.circleHitAt(p.x, p.y);
      if (hitCirc) {
        const tool = this.ctx.session.tools.get(handId);
        const ok = this.ctx.session.circleApply(hitCirc.c.id, handId);
        this.labels.spawn(ok && tool ? visibleLabel(tool) : '⛔', p.x, p.y - 10);
        return;
      }
      const hitPoly = this.polygonAt(p.x, p.y);
      if (hitPoly) {
        const tool = this.ctx.session.tools.get(handId);
        const ok = this.ctx.session.polygonApply(hitPoly.id, handId);
        this.labels.spawn(ok && tool ? visibleLabel(tool) : '⛔', p.x, p.y - 10);
        return;
      }
    }
    // Рука пуста: клик по оси X или прямо по следу — «прогони вход» функциями
    if (!handId && this.funcObjs().length > 0) {
      const wx = this.snapX(p.x);
      const key = wx.toDisplay();
      const nearAxis = Math.abs(p.y - this.origin.y) <= AXIS_HIT;
      const targets: FunctionObject[] = [];
      if (nearAxis) {
        targets.push(...this.funcObjs());
      } else {
        for (const f of this.funcObjs()) {
          const fn = this.fnFor(f);
          if (!fn) continue;
          const y = fn(wx.toNumber());
          if (y === null) continue;
          if (Math.abs((this.origin.y - y * this.scale) - p.y) <= 10) targets.push(f);
        }
      }
      if (targets.length > 0 && !this.pointAt(p.x, p.y) && !this.vectorHitAt(p.x, p.y)) {
        const now = performance.now();
        if (now - this.lastTrace.time < DBLCLICK_MS && this.lastTrace.key === key) return;
        this.lastTrace = { time: now, key };
        let ok = false;
        for (const f of targets) {
          if (this.ctx.session.probeFunction(f.id, wx)) ok = true;
        }
        this.labels.spawn(ok ? '⚙' : '⛔', p.x, this.origin.y - 10);
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
      // фигуры — после точек и стрелок: мелкие цели в приоритете
      const hitCirc = this.circleHitAt(p.x, p.y);
      if (hitCirc) {
        this.gesture = {
          type: hitCirc.part === 'center' ? 'circ-center' : 'circ-edge',
          id: hitCirc.c.id, startX: p.x, startY: p.y, moved: false,
          wasSelected: this.selection.has(hitCirc.c.id),
        };
        return;
      }
      const vh = this.polyVertexAt(p.x, p.y);
      if (vh) {
        this.gesture = {
          type: 'poly-vertex', id: vh.poly.id, index: vh.index,
          startX: p.x, startY: p.y, moved: false, wasSelected: true,
        };
        return;
      }
      const hitPoly = this.polygonAt(p.x, p.y);
      if (hitPoly) {
        this.gesture = {
          type: 'poly', id: hitPoly.id, startX: p.x, startY: p.y, moved: false,
          wasSelected: this.selection.has(hitPoly.id),
        };
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
    if (g.type === 'poly') {
      const d = this.polyDragDelta(g, p.x, p.y);
      this.ctx.session.movePolygon(g.id, d.dx, d.dy, false); // транзиент
      return;
    }
    if (g.type === 'poly-vertex') {
      const w = this.toWorldSnapped(p.x, p.y);
      this.ctx.session.setPolygonVertex(g.id, g.index, w.x, w.y, false); // транзиент
      return;
    }
    if (g.type === 'circ-center') {
      const w = this.toWorldSnapped(p.x, p.y);
      this.ctx.session.setCirclePos(g.id, w.x, w.y, false); // транзиент
      return;
    }
    if (g.type === 'circ-edge') {
      const c = this.ctx.session.objects.get(g.id);
      if (c?.kind === 'circle') {
        this.ctx.session.setCircleRadius(g.id, this.circleRadiusAt({ x: c.cx, y: c.cy }, p.x, p.y), false);
      }
      return;
    }
    // vec-tail: перенос всей стрелки — презентация, журнал не трогаем
    this.moveTail(g.id, p.x - g.grabDX, p.y - g.grabDY);
  }

  /** Смещение тела фигуры от начала жеста — оба конца прищёлкнуты к сетке. */
  private polyDragDelta(g: { startX: number; startY: number }, sx: number, sy: number):
    { dx: Rational; dy: Rational } {
    const w0 = this.toWorldSnapped(g.startX, g.startY);
    const w1 = this.toWorldSnapped(sx, sy);
    return { dx: w1.x.sub(w0.x), dy: w1.y.sub(w0.y) };
  }

  /** Голова стрелки на экране (sx, sy) → команда (dx; dy) со снапом дельты. */
  private headDelta(id: string, sx: number, sy: number): { dx: Rational; dy: Rational } | null {
    const v = this.ctx?.session.objects.get(id);
    if (!v || v.kind !== 'vector') return null;
    const t = this.tailOf(v);
    const step = this.snapStep();
    const n = step.toNumber();
    const dx = Math.round((((sx - this.origin.x) / this.scale) - t.x) / n);
    const dy = Math.round(((this.origin.y - sy) / this.scale - t.y) / n);
    return { dx: step.mul(Rational.of(dx)), dy: step.mul(Rational.of(dy)) };
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
    this.dropPoly = null;
    this.dropCirc = null;
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
    // хвост над фигурой/окружностью — команда наготове для всей фигуры
    const sp = this.worldToScreen(wx, wy);
    const poly = this.polygonAt(sp.x, sp.y);
    if (poly) {
      this.dropPoly = poly.id;
    } else {
      for (const c of this.circles()) {
        if (Math.hypot(c.cx.toNumber() - wx, c.cy.toNumber() - wy) < c.r.toNumber()) {
          this.dropCirc = c.id;
          break;
        }
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
        for (const poly of this.polygons()) {
          if (poly.vertices.every((v) => inside(this.toScreen(v.x, v.y)))) {
            this.selection.add(poly.id);
          }
        }
        for (const c of this.circles()) {
          const s = this.toScreen(c.cx, c.cy);
          const R = c.r.toNumber() * this.scale;
          if (s.x - R >= x0 && s.x + R <= x1 && s.y - R >= y0 && s.y + R <= y1) {
            this.selection.add(c.id);
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
      } else if (g.type === 'poly') {
        const d = this.polyDragDelta(g, p.x, p.y);
        this.ctx.session.movePolygon(g.id, d.dx, d.dy, true); // коммит
      } else if (g.type === 'poly-vertex') {
        const w = this.toWorldSnapped(p.x, p.y);
        this.ctx.session.setPolygonVertex(g.id, g.index, w.x, w.y, true); // коммит
      } else if (g.type === 'circ-center') {
        const w = this.toWorldSnapped(p.x, p.y);
        this.ctx.session.setCirclePos(g.id, w.x, w.y, true); // коммит
      } else if (g.type === 'circ-edge') {
        const c = this.ctx.session.objects.get(g.id);
        if (c?.kind === 'circle') {
          this.ctx.session.setCircleRadius(g.id, this.circleRadiusAt({ x: c.cx, y: c.cy }, p.x, p.y), true);
        }
      } else if (g.type === 'vec-tail' && this.dropPoint) {
        // хвост отпущен на точке — точка выполняет команду и уезжает на нос
        this.ctx.session.movePointBy(this.dropPoint, g.id);
        this.dropPoint = null;
      } else if (g.type === 'vec-tail' && this.dropPoly) {
        // хвост отпущен на фигуре — вся фигура проходит путь строем
        this.ctx.session.movePolygonBy(this.dropPoly, g.id);
        this.dropPoly = null;
      } else if (g.type === 'vec-tail' && this.dropCirc) {
        this.ctx.session.moveCircleBy(this.dropCirc, g.id);
        this.dropCirc = null;
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
    if (this.sumBtn) this.sumBtn.disabled = this.selectedVectors().length !== 2;
    const anyMovable = this.points().some((pt) => this.selection.has(pt.id)) ||
      this.polygons().some((poly) => this.selection.has(poly.id)) ||
      this.circles().some((c) => this.selection.has(c.id));
    if (this.flipXBtn) this.flipXBtn.disabled = !anyMovable;
    if (this.flipYBtn) this.flipYBtn.disabled = !anyMovable;
    if (this.rotCcwBtn) this.rotCcwBtn.disabled = !anyMovable;
    if (this.rotCwBtn) this.rotCwBtn.disabled = !anyMovable;

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

    // Анимация порождения следов: кружочки-входы поднимаются к выходам
    this.drawGenAnims(g, w, now);

    // Чтение следов: проколы оси и точки встречи
    if (this.showRoots) {
      for (const t of traces) {
        for (const x of this.findRoots(t.fn, w)) this.drawMarker(g, x, 0, this.fmtNum(x));
      }
    }
    if (this.showMeets && traces.length < 2) {
      g.fillStyle = theme.gold;
      g.font = '12px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillText('точки встречи: нужен ВТОРОЙ след — добавь ещё одну функцию', w / 2, 14);
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

    // Фигуры — под точками и стрелками: тело большое, мелкие цели поверх
    for (const poly of this.polygons()) this.drawPolygon(g, poly);
    for (const c of this.circles()) this.drawCircle(g, c);

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

    // Постройка многоугольника: набранные вершины и резинка к курсору
    this.drawBuild(g);

    this.labels.draw(g, theme.gold);

    // Молоток у курсора
    const hand = this.handTool();
    if (hand && this.pointer.inside) {
      drawHammer(g, this.pointer.x, this.pointer.y, wobbleAngle(now), visibleLabel(hand));
    }

    this.updateCursor(hand !== null);
  }

  /** Направление ресайза обода: по лучу центр→курсор (как у углов фигур). */
  private edgeCursor(c: CircleObject, sx: number, sy: number): string {
    const s = this.toScreen(c.cx, c.cy);
    const ang = Math.atan2(-(sy - s.y), sx - s.x); // экранный Y вниз
    const oct = Math.round(ang / (Math.PI / 4)) & 3; // 0 →, 1 ↗, 2 ↑, 3 ↖
    return ['ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize'][oct]!;
  }

  /**
   * Курсор — язык жестов (как у «Лент» и «Площадей»): рука над тем,
   * что можно схватить, схватившая — пока тащишь, ресайз — над ободом круга,
   * прицел — в режиме постройки.
   */
  private updateCursor(hasHand: boolean): void {
    this.canvasEl ??= document.getElementById('stage');
    if (!this.canvasEl) return;
    let cursor = '';
    const gt = this.gesture?.type;
    if (gt === 'circ-edge') {
      const c = this.gesture && 'id' in this.gesture ? this.ctx?.session.objects.get(this.gesture.id) : null;
      cursor = c?.kind === 'circle' ? this.edgeCursor(c, this.pointer.x, this.pointer.y) : 'grabbing';
    } else if (gt === 'point' || gt === 'poly' || gt === 'poly-vertex' || gt === 'circ-center' ||
               gt === 'vec-head' || gt === 'vec-tail') {
      cursor = 'grabbing';
    } else if (!gt && !hasHand && this.pointer.inside) {
      if (this.buildVerts || this.buildCirc) {
        cursor = 'crosshair';
      } else {
        const circ = this.circleHitAt(this.pointer.x, this.pointer.y);
        if (circ?.part === 'edge') cursor = this.edgeCursor(circ.c, this.pointer.x, this.pointer.y);
        else if (circ || this.pointAt(this.pointer.x, this.pointer.y) ||
                 this.vectorHitAt(this.pointer.x, this.pointer.y) ||
                 this.polyVertexAt(this.pointer.x, this.pointer.y) ||
                 this.polygonAt(this.pointer.x, this.pointer.y)) {
          cursor = 'grab';
        }
      }
    }
    this.canvasEl.style.cursor = cursor;
  }

  private drawPolygon(g: CanvasRenderingContext2D, poly: PolygonObject): void {
    const pts = poly.vertices.map((v) => this.toScreen(v.x, v.y));
    if (pts.length < 3) return;
    const selected = this.selection.has(poly.id);

    g.beginPath();
    pts.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
    g.closePath();
    g.fillStyle = theme.accent;
    g.globalAlpha = selected ? 0.16 : 0.07;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = selected ? theme.accent : theme.textSecondary;
    g.lineWidth = selected ? 2.5 : 2;
    g.stroke();
    if (selected) {
      g.shadowColor = theme.accentGlow;
      g.shadowBlur = 10;
      g.stroke();
      g.shadowBlur = 0;
    }

    // Вершины: у выделенной — крупные ручки для перетаскивания
    for (const s of pts) {
      g.fillStyle = theme.bgTertiary;
      g.strokeStyle = selected ? theme.accent : theme.textSecondary;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.x, s.y, selected ? 5 : 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // хвост стрелки над фигурой — золотой контур: «команда наготове»
    if (this.dropPoly === poly.id) {
      g.strokeStyle = theme.gold;
      g.lineWidth = 3;
      g.beginPath();
      pts.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
      g.closePath();
      g.stroke();
    }

    const cx = pts.reduce((a, s) => a + s.x, 0) / pts.length;
    const cy = pts.reduce((a, s) => a + s.y, 0) / pts.length;

    // Углы при вершинах: подпись чуть внутрь фигуры от каждой вершины
    if (poly.showAngles) {
      g.font = '11px Inter, sans-serif';
      g.fillStyle = theme.gold;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i < pts.length; i++) {
        const s = pts[i]!;
        const dx = cx - s.x;
        const dy = cy - s.y;
        const len = Math.hypot(dx, dy) || 1;
        const ang = polygonVertexAngle(poly, i);
        g.fillText(
          `${ang.exact ? '' : '≈'}${ang.v.toDisplay()}°`,
          s.x + (dx / len) * 22, s.y + (dy / len) * 22,
        );
      }
    }

    // Подписи в центре тяжести вершин: имя, площадь, периметр
    const lines: string[] = [poly.label];
    if (poly.showArea) {
      lines.push(polygonIsSimple(poly)
        ? `S = ${polygonArea(poly).toDisplay()}`
        : 'стороны пересекаются — S не определена');
    }
    if (poly.showPerimeter) {
      const per = polygonPerimeter(poly);
      lines.push(`P ${per.exact ? '=' : '≈'} ${per.v.toDisplay()}`);
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      g.font = i === 0 ? 'bold 13px Inter, sans-serif' : '12px Inter, sans-serif';
      g.fillStyle = i === 0 ? (selected ? theme.accent : theme.textPrimary) : theme.textSecondary;
      g.fillText(lines[i]!, cx, cy + (i - (lines.length - 1) / 2) * 16);
    }
  }

  private drawCircle(g: CanvasRenderingContext2D, c: CircleObject): void {
    const s = this.toScreen(c.cx, c.cy);
    const R = c.r.toNumber() * this.scale;
    const selected = this.selection.has(c.id);

    g.beginPath();
    g.arc(s.x, s.y, R, 0, Math.PI * 2);
    g.fillStyle = theme.accent;
    g.globalAlpha = selected ? 0.16 : 0.07;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = selected ? theme.accent : theme.textSecondary;
    g.lineWidth = selected ? 2.5 : 2;
    g.stroke();
    if (selected) {
      g.shadowColor = theme.accentGlow;
      g.shadowBlur = 10;
      g.stroke();
      g.shadowBlur = 0;
    }
    if (this.dropCirc === c.id) {
      g.strokeStyle = theme.gold;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(s.x, s.y, R + 4, 0, Math.PI * 2);
      g.stroke();
    }

    // центр и (у выделенной) пунктирный радиус к ободу
    g.fillStyle = theme.bgTertiary;
    g.strokeStyle = selected ? theme.accent : theme.textSecondary;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(s.x, s.y, selected ? 5 : 3.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    if (selected) {
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(s.x, s.y);
      g.lineTo(s.x + R, s.y);
      g.stroke();
      g.setLineDash([]);
    }

    const lines: string[] = [c.label];
    if (c.showRadius) lines.push(`r = ${c.r.toDisplay()}`);
    if (c.showArea) lines.push(`S = ${circleAreaText(c)}`);
    if (c.showCircumference) lines.push(`C = ${circleCircumferenceText(c)}`);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      g.font = i === 0 ? 'bold 13px Inter, sans-serif' : '12px Inter, sans-serif';
      g.fillStyle = i === 0 ? (selected ? theme.accent : theme.textPrimary) : theme.textSecondary;
      g.fillText(lines[i]!, s.x, s.y + 14 + i * 16);
    }
  }

  /** Превью постройки: набранные вершины, пунктир-резинка, кольцо замыкания. */
  private drawBuild(g: CanvasRenderingContext2D): void {
    // окружность: после клика-центра — пунктирный круг с радиусом у курсора
    if (this.buildCirc?.center && this.pointer.inside) {
      const c = this.buildCirc.center;
      const s = this.toScreen(c.x, c.y);
      const r = this.circleRadiusAt(c, this.pointer.x, this.pointer.y);
      const R = r.toNumber() * this.scale;
      g.strokeStyle = theme.gold;
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath();
      g.arc(s.x, s.y, R, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(s.x, s.y);
      g.lineTo(s.x + R, s.y);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = theme.gold;
      g.beginPath();
      g.arc(s.x, s.y, 4, 0, Math.PI * 2);
      g.fill();
      g.font = '12px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillText(`r = ${r.toDisplay()}`, s.x + R / 2, s.y - 6);
    }
    if (!this.buildVerts || !this.buildVerts.length) return;
    const pts = this.buildVerts.map((v) => this.toScreen(v.x, v.y));

    g.strokeStyle = theme.gold;
    g.lineWidth = 2;
    g.beginPath();
    pts.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
    g.stroke();

    if (this.pointer.inside && !this.gesture) {
      const w = this.toWorldSnapped(this.pointer.x, this.pointer.y);
      const c = this.toScreen(w.x, w.y);
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
      g.lineTo(c.x, c.y);
      g.stroke();
      g.setLineDash([]);
    }

    for (let i = 0; i < pts.length; i++) {
      g.fillStyle = theme.gold;
      g.beginPath();
      g.arc(pts[i]!.x, pts[i]!.y, 4, 0, Math.PI * 2);
      g.fill();
    }
    // ≥3 вершин: первая предлагает замкнуться — кольцо-мишень
    if (pts.length >= 3) {
      const near = Math.hypot(pts[0]!.x - this.pointer.x, pts[0]!.y - this.pointer.y) <= POLY_CLOSE_R;
      g.strokeStyle = theme.gold;
      g.lineWidth = near ? 3 : 1.5;
      g.beginPath();
      g.arc(pts[0]!.x, pts[0]!.y, POLY_CLOSE_R - 4, 0, Math.PI * 2);
      g.stroke();
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

  /**
   * Порождение следа по точкам: на каждом видимом делении сетки кружок
   * стартует с оси X и (с паузой 0,1 с между соседями, слева направо)
   * поднимается к своему выходу. Повторное нажатие ▶ проигрывает обратно.
   * Дыры следа честны: где значения нет, кружок не появляется вовсе.
   */
  private drawGenAnims(g: CanvasRenderingContext2D, w: number, now: number): void {
    if (this.genAnims.size === 0) return;
    const { step } = this.gridStep();
    const RISE = 350;   // мс подъёма одного кружка
    const STAGGER = 100; // пауза между соседями
    for (const [id, anim] of this.genAnims) {
      const f = this.ctx?.session.objects.get(id);
      if (!f || f.kind !== 'function') { this.genAnims.delete(id); continue; }
      const fn = this.fnFor(f);
      if (!fn) continue;
      const fromI = Math.ceil((-this.origin.x) / (this.scale * step));
      const toI = Math.floor((w - this.origin.x) / (this.scale * step));
      const count = toI - fromI + 1;
      if (count <= 0 || count > 120) continue;
      const elapsed = now - anim.start;
      let allDone = true;
      for (let i = fromI; i <= toI; i++) {
        const x = i * step;
        const y = fn(x);
        if (y === null) continue; // дыра — входа с выходом нет
        const local = (elapsed - (i - fromI) * STAGGER) / RISE;
        const t = Math.max(0, Math.min(1, local));
        if (t < 1) allDone = false;
        const ease = 1 - (1 - t) * (1 - t);
        const p = anim.dir === 1 ? ease : 1 - ease;
        if (anim.dir === -1 && t >= 1) continue; // уехал домой — не рисуем
        const sx = this.origin.x + x * this.scale;
        const sy = this.origin.y - y * this.scale * p;
        g.fillStyle = f.color;
        g.globalAlpha = 0.9;
        g.beginPath();
        g.arc(sx, sy, 5, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
      if (allDone && anim.dir === -1) this.genAnims.delete(id);
    }
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
