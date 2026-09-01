import { Rational } from './rational';
import { Tool, makeTool } from './model';

/**
 * Формулы функций (панель «Функции» сцены «Плоскость»): разбор строк вида
 * «x^2 - 2(x+5) + 10» в AST с ДВУМЯ вычислителями:
 *
 *  - evalNum  — плавающий, только для отрисовки следа (как traceEval);
 *  - evalRat  — точный (Rational), для жеста «прогони вход»: точка на
 *    следе получает честный адрес; корни и дробные степени идут через
 *    ≈-политику ядра (makeTool), деление на ноль и √ отрицательного — null.
 *
 * Грамматика (рекурсивный спуск):
 *   expr   := term (('+'|'-') term)*
 *   term   := unary (('*'|'/') unary | unary_без_знака)*    ← неявное умножение
 *   unary  := '-' unary | power                              ← −x² = −(x²)
 *   power  := primary ('^' unary)?                           ← правоассоциативно
 *   primary:= число | 'x' | func '(' expr ')' | '(' expr ')'
 * Функции: sqrt, cbrt, abs. Кириллическая «х» принимается как x
 * (классическая путаница раскладки — ловим, а не наказываем).
 */

export type FormulaNode =
  | { k: 'num'; v: Rational }
  | { k: 'x' }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: FormulaNode; b: FormulaNode }
  | { k: 'neg'; a: FormulaNode }
  | { k: 'fn'; name: 'sqrt' | 'cbrt' | 'abs'; a: FormulaNode };

type Token =
  | { t: 'num'; v: Rational }
  | { t: 'x' }
  | { t: 'func'; name: 'sqrt' | 'cbrt' | 'abs' }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '^' }
  | { t: '(' } | { t: ')' };

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  const s = src.replace(/х/g, 'x').replace(/Х/g, 'x'); // кириллица → латиница
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c >= '0' && c <= '9') {
      let j = i;
      let dot = false;
      while (j < s.length) {
        const d = s[j]!;
        if (d >= '0' && d <= '9') { j++; continue; }
        if ((d === '.' || d === ',') && !dot) { dot = true; j++; continue; }
        break;
      }
      const v = Rational.parse(s.slice(i, j).replace('.', ','));
      if (!v) return null;
      out.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j]!)) j++;
      const word = s.slice(i, j).toLowerCase();
      if (word === 'x') out.push({ t: 'x' });
      else if (word === 'sqrt' || word === 'cbrt' || word === 'abs') out.push({ t: 'func', name: word });
      else return null; // неизвестное имя
      i = j;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^') {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '−') { out.push({ t: 'op', v: '-' }); i++; continue; } // длинный минус
    if (c === '·' || c === '×') { out.push({ t: 'op', v: '*' }); i++; continue; }
    if (c === '(') { out.push({ t: '(' }); i++; continue; }
    if (c === ')') { out.push({ t: ')' }); i++; continue; }
    return null;
  }
  return out;
}

/** Разбор формулы в AST; null при синтаксической ошибке. */
export function parseFormula(src: string): FormulaNode | null {
  const parsed = tokenize(src);
  if (!parsed || parsed.length === 0) return null;
  const toks: Token[] = parsed;
  let pos = 0;
  const peek = (): Token | undefined => toks[pos];

  // «следующий токен способен НАЧАТЬ множитель» — точка неявного умножения
  const startsPrimary = (tk: Token | undefined): boolean =>
    !!tk && (tk.t === 'num' || tk.t === 'x' || tk.t === 'func' || tk.t === '(');

  function expr(): FormulaNode | null {
    let acc = term();
    if (!acc) return null;
    while (peek()?.t === 'op' && ((peek() as { v: string }).v === '+' || (peek() as { v: string }).v === '-')) {
      const op = (toks[pos++] as { v: '+' | '-' }).v;
      const right = term();
      if (!right) return null;
      acc = { k: 'bin', op, a: acc, b: right };
    }
    return acc;
  }

  function term(): FormulaNode | null {
    let acc = unary();
    if (!acc) return null;
    for (;;) {
      const tk = peek();
      let op: '*' | '/' | null = null;
      if (tk?.t === 'op' && (tk.v === '*' || tk.v === '/')) {
        op = tk.v;
        pos++;
      } else if (startsPrimary(tk)) {
        op = '*'; // неявное умножение: 2x, 2(x+5), (x+1)(x-1)
      } else {
        break;
      }
      const right = unary();
      if (!right) return null;
      acc = { k: 'bin', op, a: acc, b: right };
    }
    return acc;
  }

  function unary(): FormulaNode | null {
    const tk = peek();
    if (tk?.t === 'op' && tk.v === '-') {
      pos++;
      const inner = unary();
      if (!inner) return null;
      return { k: 'neg', a: inner }; // −x² = −(x²): степень сильнее минуса
    }
    return power();
  }

  function power(): FormulaNode | null {
    const base = primary();
    if (!base) return null;
    const tk = peek();
    if (tk?.t === 'op' && tk.v === '^') {
      pos++;
      const exp = unary(); // правоассоциативность и минус в показателе: 2^-3
      if (!exp) return null;
      return { k: 'bin', op: '^', a: base, b: exp };
    }
    return base;
  }

  function primary(): FormulaNode | null {
    const tk = toks[pos];
    if (!tk) return null;
    if (tk.t === 'num') { pos++; return { k: 'num', v: tk.v }; }
    if (tk.t === 'x') { pos++; return { k: 'x' }; }
    if (tk.t === '(') {
      pos++;
      const inner = expr();
      if (!inner || toks[pos]?.t !== ')') return null;
      pos++;
      return inner;
    }
    if (tk.t === 'func') {
      pos++;
      if (toks[pos]?.t !== '(') return null;
      pos++;
      const inner = expr();
      if (!inner || toks[pos]?.t !== ')') return null;
      pos++;
      return { k: 'fn', name: tk.name, a: inner };
    }
    return null;
  }

  const root = expr();
  if (!root || pos !== toks.length) return null;
  return root;
}

/** Плавающий вычислитель — ТОЛЬКО для отрисовки следа. */
export function evalNum(node: FormulaNode, x: number): number | null {
  switch (node.k) {
    case 'num': return node.v.toNumber();
    case 'x': return x;
    case 'neg': {
      const v = evalNum(node.a, x);
      return v === null ? null : -v;
    }
    case 'fn': {
      const v = evalNum(node.a, x);
      if (v === null) return null;
      if (node.name === 'sqrt') return v < 0 ? null : Math.sqrt(v);
      if (node.name === 'cbrt') return Math.cbrt(v);
      return Math.abs(v);
    }
    case 'bin': {
      const a = evalNum(node.a, x);
      const b = evalNum(node.b, x);
      if (a === null || b === null) return null;
      let r: number;
      switch (node.op) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': r = b === 0 ? NaN : a / b; break;
        case '^': {
          // отрицательное основание с дробной степенью честно даёт дыру,
          // но нечётные корни живут: (−8)^(1/3) = −2
          if (a < 0) {
            const rb = evalNum(node.b, x)!;
            const asFrac = approxFraction(rb);
            if (!asFrac || asFrac.den % 2 === 0) { r = NaN; break; }
            const mag = Math.pow(-a, rb);
            r = Math.abs(asFrac.num) % 2 === 0 ? mag : -mag;
            break;
          }
          r = Math.pow(a, b);
          break;
        }
      }
      return Number.isFinite(r) ? r : null;
    }
  }
}

/** Дробное приближение показателя для веток вида (−x)^(1/3). */
function approxFraction(v: number): { num: number; den: number } | null {
  for (let den = 1; den <= 12; den++) {
    const num = Math.round(v * den);
    if (Math.abs(num / den - v) < 1e-9) return { num, den };
  }
  return null;
}

/**
 * Точный вычислитель для «прогони вход»: адрес точки на следе — Rational.
 * Степени и корни идут через инструменты ядра (та же ≈-политика, те же
 * отказы). null = значения не существует.
 */
export function evalRat(node: FormulaNode, x: Rational): Rational | null {
  switch (node.k) {
    case 'num': return node.v;
    case 'x': return x;
    case 'neg': {
      const v = evalRat(node.a, x);
      return v === null ? null : v.neg();
    }
    case 'fn': {
      const v = evalRat(node.a, x);
      if (v === null) return null;
      const tool = makeTool(node.name, Rational.of(0));
      if (tool.canApply(v) !== null) return null;
      return tool.apply(v);
    }
    case 'bin': {
      const a = evalRat(node.a, x);
      const b = evalRat(node.b, x);
      if (a === null || b === null) return null;
      switch (node.op) {
        case '+': return a.add(b);
        case '-': return a.sub(b);
        case '*': return a.mul(b);
        case '/': return b.isZero() ? null : a.div(b);
        case '^': {
          try {
            const tool = makeTool('pow', b);
            if (tool.canApply(a) !== null) return null;
            return tool.apply(a);
          } catch {
            return null; // показатель за пределами молотка (±100, знаменатель ≤100)
          }
        }
      }
    }
  }
}

/**
 * Молоток → формула: закрепление следа руки превращает инструмент в строку
 * панели «Функции» («×2 ∘ +3» → «(2x) + 3»). Мост «жест → запись».
 * null — для операций, не выразимых грамматикой (округлитель, остатки).
 */
export function toolToFormula(tool: Tool): string | null {
  const steps = tool.op === 'seq'
    ? (tool.steps ?? [])
    : [{ op: tool.op, n: tool.n }];
  let acc = 'x';
  for (const st of steps) {
    const raw = st.n.toDisplay().replace('−', '-');
    if (raw.includes('≈')) return null;
    // дробные и отрицательные модификаторы — в скобках, иначе «x / 1/3»
    // разберётся как (x/1)/3
    const n = raw.includes('/') || raw.startsWith('-') ? `(${raw})` : raw;
    const wrapped = acc === 'x' ? 'x' : `(${acc})`;
    switch (st.op) {
      case 'add': acc = `${wrapped} + ${n}`; break;
      case 'sub': acc = `${wrapped} - ${n}`; break;
      case 'mul': acc = `${n}${wrapped === 'x' ? 'x' : ` * ${wrapped}`}`; break;
      case 'div': acc = `${wrapped} / ${n}`; break;
      case 'pow': acc = `${wrapped}^${n}`; break;
      case 'sq': acc = `${wrapped}^2`; break;
      case 'cube': acc = `${wrapped}^3`; break;
      case 'sqrt': acc = `sqrt(${acc})`; break;
      case 'cbrt': acc = `cbrt(${acc})`; break;
      case 'abs': acc = `abs(${acc})`; break;
      default: return null; // round/mod/quot/±x — грамматика их не знает
    }
  }
  return acc;
}

/**
 * Числовое выражение без x: «3+6», «3/8», «2(1+4)», «sqrt(9)». Возвращает
 * точное значение или null — выражение не читается, содержит x или отказ
 * (√ из отрицательного). Для полей ввода значений (переменная в «Коробках»).
 */
export function evalConstFormula(text: string): Rational | null {
  const ast = parseFormula(text);
  if (!ast || hasX(ast)) return null;
  return evalRat(ast, Rational.of(0));
}

function hasX(n: FormulaNode): boolean {
  switch (n.k) {
    case 'num': return false;
    case 'x': return true;
    case 'bin': return hasX(n.a) || hasX(n.b);
    case 'neg':
    case 'fn': return hasX(n.a);
  }
}
