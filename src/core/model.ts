import { Rational, sqrtExact, cbrtExact, sqrtApprox, cbrtApprox } from './rational';

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

export type MathObject = NumberObject | TapeObject | UnknownObject;

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
      case 'sqrt': e = `√${wrap}`; break;
      case 'cbrt': e = `∛${wrap}`; break;
      case 'abs': e = `|${e}|`; break;
    }
  }
  return e;
}

/** Является ли инструмент точным обратным к наклейке (для снятия верхней). */
export function toolInvertsSticker(tool: Tool, sticker: { op: PrimitiveOp; n: Rational }): boolean {
  const inv = makeTool(sticker.op, sticker.n).inverseSpec();
  if (!inv) return false;
  return inv.op === tool.op && (isUnaryOp(tool.op) || inv.n.equals(tool.n));
}

export type BinaryOp = 'add' | 'sub' | 'mul' | 'div';
export type UnaryOp = 'sq' | 'cube' | 'sqrt' | 'cbrt' | 'abs';
/** 'seq' — составной инструмент (комбо): последовательность примитивных шагов. */
export type ToolOp = BinaryOp | UnaryOp | 'seq';
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

const OP_SYMBOL: Record<BinaryOp, string> = { add: '+', sub: '−', mul: '×', div: '÷' };
const UNARY_LABEL: Record<UnaryOp, string> = {
  sq: 'x²', cube: 'x³', sqrt: '√x', cbrt: '∛x', abs: '|x|',
};

export function toolLabel(op: ToolOp, n: Rational): string {
  if (op === 'seq') return '∘'; // подпись комбо задаёт makeCompositeTool
  if (isUnaryOp(op)) return UNARY_LABEL[op];
  const nStr = n.sign() < 0 ? `(${n.toDisplay()})` : n.toDisplay();
  return `${OP_SYMBOL[op]}${nStr}`;
}

export function makeTool(op: PrimitiveOp, n: Rational, id?: string): Tool {
  if ((op as string) === 'seq') throw new Error('makeTool не собирает комбо — используй makeCompositeTool');
  if (op === 'div' && n.isZero()) {
    // Сигнатура инструмента: делителя-ноль не существует в принципе.
    throw new Error('Деление на ноль не входит в курс школьной математики!');
  }
  return {
    id: id ?? `tool-${op}-${n.num}_${n.den}`,
    op,
    n,
    label: toolLabel(op, n),
    hidden: false,
    canApply(v: Rational): string | null {
      if (op === 'sqrt' && v.sign() < 0) return 'корень из отрицательного числа не существует';
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
    (tool.op === 'cbrt' && !after.mul(after).mul(after).equals(before));
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
  const n = tool.n.sign() < 0 ? `(${tool.n.toDisplay()})` : tool.n.toDisplay();
  return `${b} ${OP_SYMBOL[tool.op as BinaryOp]} ${n} = ${a}`;
}

/** Подпись инструмента с учётом «чёрного ящика». */
export function visibleLabel(tool: Tool): string {
  return tool.hidden ? '?' : tool.label;
}
