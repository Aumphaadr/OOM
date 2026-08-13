import { Rational, sqrtExact, cbrtExact, sqrtApprox, cbrtApprox, powInt, rootExact, rootApprox, floorRational } from './rational';

/**
 * Математические объекты — размеченное объединение типов (kind).
 * Ядро не знает о пикселях: расположение в конкретной сцене хранит сцена
 * (scenePos — карман для сцен, ключ = id сцены). Новый тип объекта
 * (фигура, угол, тело) = новый член объединения, существующий код не трогается.
 */
export interface ObjectBase {
  readonly id: string;
  /** Карманы сцен: произвольные данные представления, ядро их не трактует. */
  readonly scenePos: Map<string, { x: number; y: number }>;
}

/** Число-фишка со значением-состоянием. */
export interface NumberObject extends ObjectBase {
  readonly kind: 'number';
  value: Rational;
  /** История значений (включая текущее) — шлейф для сцен и отладки. */
  readonly trail: Rational[];
  /**
   * Переменная: число с ручкой. Значение крутится ползунком в границах
   * [min, max] с шагом step; молотки бьют по ней как по обычному числу.
   */
  variable?: { name: string; min: Rational; max: Rational; step: Rational };
}

/**
 * Лента: целое с подписью единицы. Рез — ТОЧКА (доля целого 0…1), а режим /n —
 * лишь линейка: сетка швов для кликов и способ подписывать куски.
 */
export interface TapeObject extends ObjectBase {
  readonly kind: 'tape';
  /** Короткое имя для субтитров: «Л1», «Л2»… */
  readonly label: string;
  /** Длина целого в условных единицах сцены (меняется через Session.setTapeLength). */
  whole: Rational;
  /** Режим-линейка /n; null — целая лента без швов. */
  mode: number | null;
  /**
   * Эталонная единица (в попугаях): /n делит ЕДИНИЦУ, а не ленту.
   * null — единица равна всей ленте (обычные дроби). Лента длиннее единицы
   * даёт неправильные дроби: кусок «7/4» больше единицы.
   */
  unitLen: Rational | null;
  /** Резы: точные позиции как доли целого (0 < p < 1), отсортированы. */
  cuts: Rational[];
  /**
   * «Целые обозначения»: линейка обязана давать всем резам целые числители.
   * Снята — лента принимает любой режим, куски подписываются дробно («3,5/7»),
   * непредставимые конечной записью — приближённо («≈3,33/10»).
   */
  strictGrid: boolean;
}

/** Числитель доли p (доли целого) в линейке ленты: p · (whole/unit) · n. */
export function tapeNumerator(t: TapeObject, p: Rational): Rational {
  const scale = t.unitLen ? t.whole.div(t.unitLen) : Rational.of(1);
  return p.mul(scale).mul(Rational.of(t.mode ?? 1));
}

/** Подписи кусков ленты в текущей линейке: «1/6», «7/4», «3,5/7», «≈3,33/10». */
export function tapePieceLabels(t: TapeObject): string[] {
  if (t.mode === null) return [];
  const bounds = [Rational.of(0), ...t.cuts, Rational.of(1)];
  const labels: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const num = tapeNumerator(t, bounds[i + 1]!.sub(bounds[i]!));
    if (num.isInteger()) {
      labels.push(`${num.num}/${t.mode}`);
    } else {
      const shown = num.toDisplay();
      if (shown.includes('/')) {
        // числитель не имеет конечной записи — честное приближение
        const v = Math.round(num.toNumber() * 100) / 100;
        labels.push(`≈${String(v).replace('.', ',')}/${t.mode}`);
      } else {
        labels.push(`${shown}/${t.mode}`); // «3,5/7»
      }
    }
  }
  return labels;
}

/**
 * Неизвестная — запертая коробка: значение существует и определено, но скрыто.
 * Применённые операции — стопка «наклеек»; правая чаша (rhs) живёт внутри объекта,
 * чтобы уравнение было самодостаточным и не расползалось по другим сценам.
 */
export interface UnknownObject extends ObjectBase {
  readonly kind: 'unknown';
  readonly name: string; // буква: x, y, a…
  readonly secret: Rational;
  ops: { op: PrimitiveOp; n: Rational }[];
  rhs: Rational;
  revealed: boolean;
}

/**
 * Прямоугольник на клетчатом поле. Высота 0 — это ОТРЕЗОК: экструзия
 * (потянуть кромку вверх) буквально превращает 1D в 2D.
 * Резы — точки на сторонах в АБСОЛЮТНЫХ клетках (не долях): растянул
 * фигуру — рез остался на «x = 3».
 */
export interface RectObject extends ObjectBase {
  readonly kind: 'rect';
  readonly label: string; // П1, П2…
  w: Rational;
  h: Rational;
  cutsX: Rational[]; // вертикальные резы: 0 < x < w
  cutsY: Rational[]; // горизонтальные резы: 0 < y < h
  /** Что подписывать на фигуре (препод прячет, чтобы ученик посчитал сам). */
  showW: boolean;
  showH: boolean;
  showArea: boolean;
  /** Показывать периметр («забор»); по умолчанию выключено. */
  showPerimeter: boolean;
}

/** Периметр («забор»): 2(w+h); у отрезка (h = 0) — просто удвоенная длина. */
export function rectPerimeter(r: RectObject): Rational {
  return r.w.add(r.h).mul(Rational.of(2));
}

/** Площади кусков: строки снизу вверх, в строке слева направо. */
export function rectPieceAreas(r: RectObject): Rational[] {
  const xs = [Rational.of(0), ...r.cutsX, r.w];
  const ys = [Rational.of(0), ...r.cutsY, r.h];
  const areas: Rational[] = [];
  for (let row = 0; row < ys.length - 1; row++) {
    const rh = ys[row + 1]!.sub(ys[row]!);
    for (let col = 0; col < xs.length - 1; col++) {
      areas.push(xs[col + 1]!.sub(xs[col]!).mul(rh));
    }
  }
  return areas;
}

/** Линейная форма k·x + b — чаша весов v2 (docs/design-scales-v2.md). */
export interface LinForm { k: Rational; b: Rational }

/**
 * Уравнение с x на обеих чашах: ax + b = cx + d (весы v2).
 * Чаша — не стопка-история, а форма: пара коэффициентов покрывает весь
 * материал 6–7 класса; нелинейное остаётся весам v1 и «Площадям».
 */
export interface EquationObject extends ObjectBase {
  kind: 'equation';
  name: string;          // имя неизвестного: x
  secret: Rational;      // истинное значение (инвариант: удовлетворяет уравнению)
  left: LinForm;
  right: LinForm;
  solved: boolean;       // достигнута форма x = c
}

export function linFormEval(f: LinForm, x: Rational): Rational {
  return f.k.mul(x).add(f.b);
}

/** «2x + 3», «x», «−x + 8», «5», «0» — текст чаши. */
export function linFormText(f: LinForm, name: string): string {
  const one = Rational.of(1);
  if (f.k.isZero()) return f.b.toDisplay();
  const kStr = f.k.equals(one) ? '' : f.k.equals(one.neg()) ? '−' : f.k.toDisplay();
  const head = `${kStr}${name}`;
  if (f.b.isZero()) return head;
  return f.b.sign() > 0 ? `${head} + ${f.b.toDisplay()}` : `${head} − ${f.b.neg().toDisplay()}`;
}

/** Разбор формы из текста панели: «2x+3», «x - 4», «-x», «5», «1/2x». */
export function parseLinForm(text: string, name = 'x'): LinForm | null {
  const s = text.replace(/\s+/g, '').replace(/−/g, '-');
  if (!s) return null;
  let k = Rational.of(0);
  let b = Rational.of(0);
  const terms = s.match(/[+-]?[^+-]+/g);
  if (!terms || terms.join('') !== s) return null;
  for (const t of terms) {
    const sign = t.startsWith('-') ? Rational.of(-1) : Rational.of(1);
    const body = t.replace(/^[+-]/, '');
    if (body.endsWith(name)) {
      const coefStr = body.slice(0, -name.length);
      const coef = coefStr === '' ? Rational.of(1) : Rational.parse(coefStr);
      if (!coef) return null;
      k = k.add(sign.mul(coef));
    } else {
      const c = Rational.parse(body);
      if (!c) return null;
      b = b.add(sign.mul(c));
    }
  }
  return { k, b };
}

export type MathObject = NumberObject | TapeObject | UnknownObject | RectObject | EquationObject;

/** Значение левой чаши: секрет, прогнанный через стопку наклеек. */
export function unknownValue(u: UnknownObject): Rational {
  let v = u.secret;
  for (const st of u.ops) v = makeTool(st.op, st.n).apply(v);
  return v;
}

/** Текст выражения левой чаши из стопки наклеек: x → (x × 2) + 3. */
export function exprFor(u: UnknownObject): string {
  let e = u.name;
  for (const s of u.ops) {
    const wrap = e.length > 1 ? `(${e})` : e;
    const n = s.n.sign() < 0 ? `(${s.n.toDisplay()})` : s.n.toDisplay();
    switch (s.op) {
      case 'add': e = `${e} + ${n}`; break;
      case 'sub': e = `${e} − ${n}`; break;
      case 'mul': e = `${wrap} × ${n}`; break;
      case 'div': e = `${wrap} ÷ ${n}`; break;
      case 'sq': e = `${wrap}²`; break;
      case 'cube': e = `${wrap}³`; break;
      case 'pow': e = `${wrap}${powSuffix(s.n)}`; break;
      case 'round': e = `окр(${e}; ${n})`; break;
      case 'mod': e = `ост(${e}; ${n})`; break;
      case 'quot': e = `ряд(${e}; ${n})`; break;
      case 'sqrt': e = `√${wrap}`; break;
      case 'cbrt': e = `∛${wrap}`; break;
      case 'abs': e = `|${e}|`; break;
    }
  }
  return e;
}

/**
 * Каноническая форма действия инструмента: разные молотки с одинаковым
 * эффектом сводятся к одному виду — «клин клином вышибают»:
 * ×(−1) ≡ ÷(−1), +0 ≡ −0, ÷n ≡ ×(1/n), x³ ≡ pow(3), √x ≡ pow(1/2).
 */
function actionKey(op: PrimitiveOp, n: Rational): string {
  switch (op) {
    case 'add': return `add:${n.num}/${n.den}`;
    case 'sub': return `add:${n.neg().num}/${n.neg().den}`;
    case 'mul': return `mul:${n.num}/${n.den}`;
    case 'div': { const inv = Rational.of(n.den, n.num); return `mul:${inv.num}/${inv.den}`; }
    case 'sq': return 'pow:2/1';
    case 'cube': return 'pow:3/1';
    case 'sqrt': return 'pow:1/2';
    case 'cbrt': return 'pow:1/3';
    case 'pow': return `pow:${n.num}/${n.den}`;
    case 'abs': return 'abs';
    case 'round': return `round:${n.num}/${n.den}`;
    case 'mod': return `mod:${n.num}/${n.den}`;
    case 'quot': return `quot:${n.num}/${n.den}`;
  }
}

/** Нейтральное действие: +0, −0, ×1, ÷1, x¹ — ничего не меняет. */
export function isNeutralAction(op: ToolOp, n: Rational): boolean {
  if (op === 'seq' || op === 'addx' || op === 'subx' || isUnaryOp(op)) return false;
  const key = actionKey(op, n);
  return key === 'add:0/1' || key === 'mul:1/1' || key === 'pow:1/1';
}

/**
 * Является ли инструмент точным обратным к наклейке (для снятия верхней).
 * Сравниваются ДЕЙСТВИЯ, а не имена: наклейку ×(−1) снимает и ÷(−1),
 * и повторный ×(−1) — потому что это один и тот же разворот.
 */
export function toolInvertsSticker(tool: Tool, sticker: { op: PrimitiveOp; n: Rational }): boolean {
  if (tool.op === 'seq' || tool.op === 'addx' || tool.op === 'subx') return false; // комбо и ±x — не про наклейки
  const inv = makeTool(sticker.op, sticker.n).inverseSpec();
  if (!inv) return false;
  return actionKey(tool.op, tool.n) === actionKey(inv.op, inv.n);
}

export type BinaryOp = 'add' | 'sub' | 'mul' | 'div' | 'pow'
  /** Огрубитель: округлить до ближайшего кратного n (спорные — вверх). Необратим. */
  | 'round'
  /** Остаток от деления на n («что не влезло в полные ряды»). Необратим. */
  | 'mod'
  /** Число полных рядов по n (целая часть от деления). Необратим. */
  | 'quot';
/** Молотки «±x» — применимы только к уравнению (весы v2), по числам отказывают. */
export type VarOp = 'addx' | 'subx';
export type UnaryOp = 'sq' | 'cube' | 'sqrt' | 'cbrt' | 'abs';
/** 'seq' — составной инструмент (комбо): последовательность примитивных шагов. */
export type ToolOp = BinaryOp | UnaryOp | VarOp | 'seq';
export type PrimitiveOp = BinaryOp | UnaryOp;

export const UNARY_OPS: readonly UnaryOp[] = ['sq', 'cube', 'sqrt', 'cbrt', 'abs'];
export function isUnaryOp(op: ToolOp): op is UnaryOp {
  return (UNARY_OPS as readonly string[]).includes(op);
}

/**
 * Инструмент («молоток»): операция с фиксированным модификатором.
 * У инструмента есть сигнатура (кого можно бить), применение и, если существует,
 * обратный инструмент.
 */
export interface Tool {
  readonly id: string;
  readonly op: ToolOp;
  readonly n: Rational;
  /** Подпись на бойке: «+5», «×(−1)», у комбо — имя или «+4∘+55». */
  readonly label: string;
  /** Шаги комбо (только у op === 'seq'). */
  readonly steps?: readonly { op: PrimitiveOp; n: Rational }[];
  /** Режим «чёрный ящик»: подпись скрыта, субтитры показывают только «вход → выход». */
  hidden: boolean;
  /** null — применим ко всем; иначе текст причины отказа. */
  canApply(v: Rational): string | null;
  apply(v: Rational): Rational;
  /** Спецификация обратного инструмента, если он существует. */
  inverseSpec(): { op: PrimitiveOp; n: Rational } | null;
}

const OP_SYMBOL: Record<BinaryOp, string> = {
  add: '+', sub: '−', mul: '×', div: '÷', pow: '^', round: '≈', mod: 'ост', quot: 'ряд',
};
const UNARY_LABEL: Record<UnaryOp, string> = {
  sq: 'x²', cube: 'x³', sqrt: '√x', cbrt: '∛x', abs: '|x|',
};

const SUP_DIGIT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

/** Хвост степени: целый показатель — надстрочный («⁵», «⁻³»), дробный — «^0,25», «^(1/3)». */
export function powSuffix(n: Rational): string {
  if (n.isInteger()) return [...n.num.toString()].map((c) => SUP_DIGIT[c] ?? c).join('');
  const d = n.toDisplay();
  return d.includes('/') || n.sign() < 0 ? `^(${d})` : `^${d}`;
}

export function toolLabel(op: ToolOp, n: Rational): string {
  if (op === 'seq') return '∘'; // подпись комбо задаёт makeCompositeTool
  if (isUnaryOp(op)) return UNARY_LABEL[op];
  if (op === 'pow') return `x${powSuffix(n)}`;
  if (op === 'round') return `≈${n.toDisplay()}`;
  if (op === 'mod') return `ост${n.toDisplay()}`;
  if (op === 'quot') return `ряд${n.toDisplay()}`;
  if (op === 'addx' || op === 'subx') {
    const sign = op === 'addx' ? '+' : '−';
    const coef = n.equals(Rational.of(1)) ? '' : n.toDisplay();
    return `${sign}${coef}x`;
  }
  const nStr = n.sign() < 0 ? `(${n.toDisplay()})` : n.toDisplay();
  return `${OP_SYMBOL[op]}${nStr}`;
}

/**
 * Молоток «±x» (весы v2): прибавить/убрать n иксов с обеих чаш уравнения.
 * По обычным объектам отказывает — сигнатура «мне нужен x».
 */
export function makeVarTool(op: VarOp, n: Rational, id?: string): Tool {
  if (n.sign() <= 0) throw new Error('Коэффициент у молотка ±x должен быть положительным (знак — в самом молотке).');
  return {
    id: id ?? `tool-${op}-${n.num}_${n.den}`,
    op,
    n,
    label: toolLabel(op, n),
    hidden: false,
    canApply: () => 'этому молотку нужен x — бей по уравнению',
    apply: (v: Rational) => v, // не вызывается: canApply всегда отказывает
    inverseSpec: () => null,   // в механике v1 (реверс, наклейки) не участвует
  };
}

export function makeTool(op: PrimitiveOp, n: Rational, id?: string): Tool {
  if ((op as string) === 'seq') throw new Error('makeTool не собирает комбо — используй makeCompositeTool');
  if (op === 'div' && n.isZero()) {
    // Сигнатура инструмента: делителя-ноль не существует в принципе.
    throw new Error('Деление на ноль не входит в курс школьной математики!');
  }
  if (op === 'pow' && ((n.num < -100n || n.num > 100n) || n.den > 100n)) {
    throw new Error('Такой показатель степени не унесёт ни один молоток (до ±100, корень до 100-й степени).');
  }
  if ((op === 'round' || op === 'mod' || op === 'quot') && n.sign() <= 0) {
    throw new Error('Разряд округления и размер ряда должны быть положительными.');
  }
  return {
    id: id ?? `tool-${op}-${n.num}_${n.den}`,
    op,
    n,
    label: toolLabel(op, n),
    hidden: false,
    canApply(v: Rational): string | null {
      if (op === 'sqrt' && v.sign() < 0) return 'корень из отрицательного числа не существует';
      if (op === 'pow') {
        if (v.isZero() && n.sign() < 0) return 'ноль в отрицательной степени — это деление на ноль';
        if (v.isZero() && n.isZero()) return '0⁰ не определён';
        if (v.sign() < 0 && n.den % 2n === 0n) {
          return 'дробная степень с чётным знаменателем — корень чётной степени, из отрицательного числа он не существует';
        }
      }
      return null;
    },
    apply(v: Rational): Rational {
      switch (op) {
        case 'add': return v.add(n);
        case 'sub': return v.sub(n);
        case 'mul': return v.mul(n);
        case 'div': return v.div(n);
        case 'sq': return v.mul(v);
        case 'cube': return v.mul(v).mul(v);
        // Иррациональный результат не «не существует», а приближается до 3 знаков —
        // иначе дети решат, что корень есть только у 9, 16, 25…
        case 'sqrt': return sqrtExact(v) ?? sqrtApprox(v);
        case 'cbrt': return cbrtExact(v) ?? cbrtApprox(v);
        case 'abs': return v.sign() < 0 ? v.neg() : v;
        case 'pow': {
          // x^(a/b): отрицательный показатель — переворот дроби ДО корня,
          // чтобы приближение (если случится) было последним шагом
          const base = n.sign() < 0 ? powInt(v, -1n) : v;
          const e = n.num < 0n ? -n.num : n.num;
          const powered = powInt(base, e);
          if (n.den === 1n) return powered;
          return rootExact(powered, n.den) ?? rootApprox(powered, n.den);
        }
        // ближайшее кратное n; ровно посередине — вверх: floor(v/n + 1/2) · n
        case 'round': return floorRational(v.div(n).add(Rational.of(1, 2))).mul(n);
        // остаток и полные ряды: v = ряды·n + остаток, 0 ≤ остаток < n
        case 'mod': return v.sub(floorRational(v.div(n)).mul(n));
        case 'quot': return floorRational(v.div(n));
      }
    },
    inverseSpec() {
      switch (op) {
        case 'add': return { op: 'sub', n };
        case 'sub': return { op: 'add', n };
        case 'mul': return n.isZero() ? null : { op: 'div', n }; // ×0 необратим — склеивает всё в ноль
        case 'div': return { op: 'mul', n };
        case 'sq': return null;   // два прообраза: x и −x
        case 'abs': return null;  // склеивает x и −x
        case 'cube': return { op: 'cbrt', n }; // нечётная степень обратима
        case 'cbrt': return { op: 'cube', n };
        case 'sqrt': return { op: 'sq', n };   // на области √ (x ≥ 0) квадрат — честный обратный
        case 'pow': {
          if (n.isZero()) return null; // x⁰ склеивает всё в единицу — как ×0
          const numAbs = n.num < 0n ? -n.num : n.num;
          // чётный числитель при нечётном знаменателе склеивает x и −x — как x²;
          // при чётном знаменателе область x ≥ 0, там обратный честен — как у √
          if (numAbs % 2n === 0n && n.den % 2n === 1n) return null;
          return { op: 'pow', n: powInt(n, -1n) };
        }
        // огрубитель и остатки склеивают соседей — прошлое не восстановить
        case 'round': return null;
        case 'mod': return null;
        case 'quot': return null;
      }
    },
  };
}

/**
 * Комбо: последовательность примитивных шагов с общим именем.
 * Применение — свёртка шагов; отказ любого шага — отказ всего комбо
 * с указанием виновника.
 */
export function makeCompositeTool(
  steps: { op: PrimitiveOp; n: Rational }[],
  name?: string,
  id?: string,
): Tool {
  if (!steps.length) throw new Error('комбо без шагов не бывает');
  const prims = steps.map((s) => makeTool(s.op, s.n));
  const label = (name ?? '').trim() || prims.map((p) => p.label).join('∘');
  return {
    id: id ?? `combo-${label}`,
    op: 'seq',
    n: Rational.of(0),
    steps: steps.map((s) => ({ op: s.op, n: s.n })),
    label,
    hidden: false,
    canApply(v: Rational): string | null {
      let cur = v;
      for (const p of prims) {
        const refusal = p.canApply(cur);
        if (refusal !== null) return `шаг «${p.label}»: ${refusal}`;
        cur = p.apply(cur);
      }
      return null;
    },
    apply(v: Rational): Rational {
      let cur = v;
      for (const p of prims) cur = p.apply(cur);
      return cur;
    },
    inverseSpec() {
      return null; // обратный комбо строится целиком в Session.applyInverse
    },
  };
}

/**
 * Формула для субтитров: «13 + 10 = 23», «(−5)² = 25»; приближение честно
 * помечается: «√8 ≈ 2,828». У скрытого инструмента — протокол «13 → 23».
 */
export function subtitleFor(before: Rational, tool: Tool, after: Rational): string {
  // приближение распознаётся проверкой: обратная степень не возвращает исходное
  const approx =
    (tool.op === 'sqrt' && !after.mul(after).equals(before)) ||
    (tool.op === 'cbrt' && !after.mul(after).mul(after).equals(before)) ||
    (tool.op === 'pow' && tool.n.den > 1n &&
      !powInt(after, tool.n.den).equals(powInt(
        tool.n.sign() < 0 ? powInt(before, -1n) : before,
        tool.n.num < 0n ? -tool.n.num : tool.n.num,
      )));
  const eq = approx ? '≈' : '=';

  if (tool.hidden) return `${before.toDisplay()} → ${approx ? '≈' : ''}${after.toDisplay()}`;

  // Комбо: цепочка с промежуточными значениями — «+59!: 199 → 203 → 258»
  if (tool.steps) {
    const parts = [before.toDisplay()];
    let v = before;
    for (const s of tool.steps) {
      v = makeTool(s.op, s.n).apply(v);
      parts.push(v.toDisplay());
    }
    return `${tool.label}: ${parts.join(' → ')}`;
  }

  const b = before.sign() < 0 ? `(${before.toDisplay()})` : before.toDisplay();
  const a = after.toDisplay();
  if (isUnaryOp(tool.op)) {
    switch (tool.op) {
      case 'sq': return `${b}² = ${a}`;
      case 'cube': return `${b}³ = ${a}`;
      case 'sqrt': return `√${b} ${eq} ${a}`;
      case 'cbrt': return `∛${b} ${eq} ${a}`;
      case 'abs': return `|${before.toDisplay()}| = ${a}`;
    }
  }
  if (tool.op === 'pow') return `${b}${powSuffix(tool.n)} ${eq} ${a}`;
  if (tool.op === 'round') return `${b} ≈ ${a} (до ${tool.n.toDisplay()})`;
  if (tool.op === 'mod') return `${b}: остаток от ÷${tool.n.toDisplay()} = ${a}`;
  if (tool.op === 'quot') return `${b}: полных рядов по ${tool.n.toDisplay()} = ${a}`;
  const n = tool.n.sign() < 0 ? `(${tool.n.toDisplay()})` : tool.n.toDisplay();
  return `${b} ${OP_SYMBOL[tool.op as BinaryOp]} ${n} = ${a}`;
}

/** Подпись инструмента с учётом «чёрного ящика». */
export function visibleLabel(tool: Tool): string {
  return tool.hidden ? '?' : tool.label;
}
