import { describe, it, expect } from 'vitest';
import { R, Rational } from '../src/core/rational';
import { makeTool, makeCompositeTool, makeVarTool, subtitleFor, toolLabel, parseLinForm, linFormText } from '../src/core/model';
import { Session } from '../src/core/session';
import { checkGoal } from '../src/core/goal';

describe('Rational', () => {
  it('парсит целые, десятичные (точка и запятая), дроби', () => {
    expect(Rational.parse('5')!.toDisplay()).toBe('5');
    expect(Rational.parse('-2.75')!.toDisplay()).toBe('-2,75');
    expect(Rational.parse('2,5')!.toDisplay()).toBe('2,5');
    expect(Rational.parse('1/3')!.toDisplay()).toBe('1/3');
    expect(Rational.parse('7/0')).toBeNull();
    expect(Rational.parse('abc')).toBeNull();
  });

  it('показывает конечные десятичные запятой, прочие — дробью', () => {
    expect(R(1, 2).toDisplay()).toBe('0,5');
    expect(R(1, 4).toDisplay()).toBe('0,25');
    expect(R(1, 3).toDisplay()).toBe('1/3');
    expect(R(-5, 2).toDisplay()).toBe('-2,5');
  });
});

describe('инструменты', () => {
  it('корни: точные без ≈, иррациональные с ≈ до 3 знаков', () => {
    const sqrt = makeTool('sqrt', R(0));
    expect(sqrt.apply(R(49)).toDisplay()).toBe('7');
    expect(sqrt.apply(R(8)).toDisplay()).toBe('2,828');
    expect(subtitleFor(R(8), sqrt, sqrt.apply(R(8)))).toContain('≈');
    expect(subtitleFor(R(49), sqrt, sqrt.apply(R(49)))).not.toContain('≈');
    expect(sqrt.canApply(R(-9))).not.toBeNull();
  });

  it('произвольная степень: целая, дробная, отрицательная', () => {
    const pow = (n: number, d = 1) => makeTool('pow', R(n, d));
    expect(pow(5).apply(R(2)).toDisplay()).toBe('32');
    expect(pow(-3).apply(R(2)).toDisplay()).toBe('0,125');
    expect(pow(1, 4).apply(R(16)).toDisplay()).toBe('2');
    expect(pow(3, 2).apply(R(4)).toDisplay()).toBe('8');
    expect(pow(1, 3).apply(R(-8)).toDisplay()).toBe('-2');
    expect(pow(1, 2).apply(R(2)).toDisplay()).toBe('1,414');
    expect(pow(5).label).toBe('x⁵');
    expect(pow(-3).label).toBe('x⁻³');
    expect(pow(1, 4).label).toBe('x^0,25');
    // отказы сигнатуры
    expect(pow(1, 2).canApply(R(-4))).not.toBeNull();
    expect(pow(0).canApply(R(0))).not.toBeNull();
    expect(pow(-2).canApply(R(0))).not.toBeNull();
    // обратимость: рифма с ×0, x², √
    expect(pow(0).inverseSpec()).toBeNull();
    expect(pow(2).inverseSpec()).toBeNull();
    expect(pow(1, 2).inverseSpec()!.n.toDisplay()).toBe('2');
    expect(pow(5).inverseSpec()!.n.toDisplay()).toBe('0,2');
  });

  it('×0 и деление на ноль', () => {
    expect(makeTool('mul', R(0)).inverseSpec()).toBeNull();
    expect(() => makeTool('div', R(0))).toThrow();
  });

  it('комбо: свёртка шагов, подпись, обращение', () => {
    const combo = makeCompositeTool([{ op: 'add', n: R(1) }, { op: 'pow', n: R(2) }], '');
    expect(combo.label).toBe('+1∘x²');
    expect(combo.apply(R(4)).toDisplay()).toBe('25');
    expect(toolLabel('seq', R(0))).toBe('∘');
  });
});

describe('Session', () => {
  it('удар и сквозной undo', () => {
    const s = new Session();
    const o = s.spawnObject(R(7));
    const t = s.addTool('add', R(3));
    s.applyTool(t.id, o.id);
    expect(o.value.toDisplay()).toBe('10');
    expect(s.undo()).toBe(true);
    expect(o.value.toDisplay()).toBe('7');
  });

  it('весы: наклейки снимаются строго с верхней, удары по чашам раздельные', () => {
    const s = new Session();
    const u = s.spawnUnknown('y', R(5));
    const mul3 = s.addTool('mul', R(3));
    const sub4 = s.addTool('sub', R(4));
    const add4 = s.addTool('add', R(4));
    const div3 = s.addTool('div', R(3));
    // запутываем: каждый молоток по обеим чашам
    s.scalesApply(u.id, mul3.id, 'left');
    s.scalesApply(u.id, mul3.id, 'right'); // y×3 = 15
    s.scalesApply(u.id, sub4.id, 'left');
    s.scalesApply(u.id, sub4.id, 'right'); // y×3−4 = 11
    // не тот порядок: стопка растёт, а не снимается
    s.scalesApply(u.id, div3.id, 'left');
    expect(u.ops.length).toBe(3);
    s.undo();
    // правильный порядок: +4 против −4, потом ÷3 — по обеим чашам
    s.scalesApply(u.id, add4.id, 'left');
    expect(u.revealed).toBe(false); // перекос: правая ещё ждёт
    s.scalesApply(u.id, add4.id, 'right');
    s.scalesApply(u.id, div3.id, 'left');
    s.scalesApply(u.id, div3.id, 'right');
    expect(u.revealed).toBe(true);
    expect(u.rhs.toDisplay()).toBe('5');
  });

  it('весы: «клин клином» — эквивалентные действия снимают наклейку', () => {
    // свежая коробка на каждый случай: снятая в ноль стопка при равновесии
    // честно открывает замок, и дальше по ней уже не бьют
    const stack = (
      sticker: [op: string, n?: Rational],
      remover: [op: string, n?: Rational],
    ): number => {
      const s = new Session();
      const u = s.spawnUnknown('x', R(7));
      const put = s.addTool(sticker[0] as 'mul', sticker[1] ?? R(0));
      const take = s.addTool(remover[0] as 'mul', remover[1] ?? R(0));
      s.scalesApply(u.id, put.id, 'left');
      s.scalesApply(u.id, take.id, 'left');
      return u.ops.length;
    };
    expect(stack(['mul', R(-1)], ['mul', R(-1)])).toBe(0); // ×(−1) клином ×(−1)
    expect(stack(['mul', R(-1)], ['div', R(-1)])).toBe(0); // и ÷(−1) тоже
    expect(stack(['add', R(0)], ['add', R(0)])).toBe(0);   // +0 сам себе обратен
    expect(stack(['pow', R(-1)], ['pow', R(-1)])).toBe(0); // переворот клином переворота
    expect(stack(['cube'], ['pow', R(1, 3)])).toBe(0);     // x³ снимается pow(1/3), не только ∛
    expect(stack(['sqrt'], ['pow', R(2)])).toBe(0);        // √ снимается pow(2), не только x²
    expect(stack(['mul', R(3)], ['mul', R(2)])).toBe(2);   // а ×2 наклейку ×3 не снимает
  });

  it('ленты: рез, смена линейки, отказ несовместимой', () => {
    const s = new Session();
    const t = s.spawnTape(R(7), 4);
    expect(s.cutTape(t.id, 1)).toBe(true);
    expect(s.setTapeMode(t.id, 8)).toBe(true);   // 1/4 = 2/8 — встаёт на шов
    expect(s.setTapeMode(t.id, 10)).toBe(false); // 1/4 на шов /10 не встаёт
  });

  it('фигуры: экструзия, рез, склейка', () => {
    const s = new Session();
    const r = s.spawnRect(R(7), R(7));
    s.cutRect(r.id, 'x', R(4));
    s.cutRect(r.id, 'y', R(4));
    expect(checkGoal(s, { kind: 'rect-pieces', areas: ['16', '12', '12', '9'] })).toBe(true);
    s.mergeRect(r.id, 'x', R(4));
    s.mergeRect(r.id, 'y', R(4));
    expect(checkGoal(s, { kind: 'rect-pieces', areas: ['49'] })).toBe(true);
  });

  it('весы v2: разбор и печать линейных форм', () => {
    const f = parseLinForm('2x+3')!;
    expect(linFormText(f, 'x')).toBe('2x + 3');
    expect(linFormText(parseLinForm('x-4')!, 'x')).toBe('x − 4');
    expect(linFormText(parseLinForm('-x')!, 'x')).toBe('−x');
    expect(linFormText(parseLinForm('5')!, 'x')).toBe('5');
    expect(linFormText(parseLinForm('1/2x')!, 'x')).toBe('0,5x');
    expect(parseLinForm('2y+1', 'y')!.k.toDisplay()).toBe('2');
    expect(parseLinForm('')).toBeNull();
    expect(parseLinForm('abc')).toBeNull();
  });

  it('весы v2: перенос = пара ударов по чашам, решение, undo', () => {
    const s = new Session();
    const eq = s.spawnEquation('x', R(5), { k: R(2), b: R(3) }, { k: R(1), b: R(8) });
    const subx = s.addVarTool('subx', R(1));
    const sub3 = s.addTool('sub', R(3));

    expect(s.equationApply(eq.id, subx.id, 'left')).toBe(true);
    // перекос: слева x+3, справа всё ещё x+8 — форма-цель не достигнута
    expect(checkGoal(s, { kind: 'equation-form', left: 'x + 3', right: '8' })).toBe(false);
    expect(s.equationApply(eq.id, subx.id, 'right')).toBe(true);
    expect(linFormText(eq.left, 'x')).toBe('x + 3');
    expect(linFormText(eq.right, 'x')).toBe('8');
    expect(checkGoal(s, { kind: 'equation-form', left: 'x + 3', right: '8' })).toBe(true);

    s.equationApply(eq.id, sub3.id, 'left');
    expect(eq.solved).toBe(false); // x = 8?! перекос — правая ждёт −3
    s.equationApply(eq.id, sub3.id, 'right');
    expect(eq.solved).toBe(true);
    expect(eq.right.b.toDisplay()).toBe('5');
    expect(checkGoal(s, { kind: 'equation-solved' })).toBe(true);
    // решённое уравнение дальше не бьётся
    expect(s.equationApply(eq.id, sub3.id, 'left')).toBe(false);

    // undo откатывает и решённость
    expect(s.undo()).toBe(true);
    expect(eq.solved).toBe(false);
    expect(linFormText(eq.left, 'x')).toBe('x');
  });

  it('весы v2: ×0 сжигает уравнение, отказы сигнатур', () => {
    const s = new Session();
    const eq = s.spawnEquation('x', R(5), { k: R(1), b: R(2) }, { k: R(0), b: R(7) });
    const mul0 = s.addTool('mul', R(0));
    s.equationApply(eq.id, mul0.id, 'left');
    s.equationApply(eq.id, mul0.id, 'right');
    expect(linFormText(eq.left, 'x')).toBe('0');
    expect(linFormText(eq.right, 'x')).toBe('0');
    expect(eq.solved).toBe(false); // 0 = 0 — не решение

    // квадрат по уравнению не бьёт
    const eq2 = s.spawnEquation('x', R(2), { k: R(1), b: R(0) }, { k: R(0), b: R(2) });
    const sq = s.addTool('sq', R(0));
    expect(s.equationApply(eq2.id, sq.id, 'left')).toBe(false);

    // молоток −x по обычному числу отказывает
    const n = s.spawnObject(R(7));
    const subx = s.addVarTool('subx', R(1));
    expect(s.applyTool(subx.id, n.id)).toBe(false);
    expect(n.value.toDisplay()).toBe('7');

    // противоречивая заготовка не существует
    expect(() => s.spawnEquation('x', R(1), { k: R(2), b: R(3) }, { k: R(2), b: R(5) })).toThrow();

    // подписи молотков ±x
    expect(makeVarTool('subx', R(1)).label).toBe('−x');
    expect(makeVarTool('addx', R(2)).label).toBe('+2x');
  });

  it('огрубитель: ближайшее кратное, спорные вверх, необратим', () => {
    const round10 = makeTool('round', R(10));
    expect(round10.apply(R(47)).toDisplay()).toBe('50');
    expect(round10.apply(R(42)).toDisplay()).toBe('40');
    expect(round10.apply(R(45)).toDisplay()).toBe('50');   // спорные — вверх
    expect(round10.apply(R(-45)).toDisplay()).toBe('-40'); // вверх = к большему
    expect(makeTool('round', R(100)).apply(R(1283)).toDisplay()).toBe('1300');
    expect(round10.inverseSpec()).toBeNull(); // склейка соседей
    expect(() => makeTool('round', R(0))).toThrow();
  });

  it('остатки: полные ряды и что не влезло', () => {
    const mod5 = makeTool('mod', R(5));
    const quot5 = makeTool('quot', R(5));
    expect(quot5.apply(R(17)).toDisplay()).toBe('3');
    expect(mod5.apply(R(17)).toDisplay()).toBe('2');
    // проверка: ряды × длину + остаток = исходное
    expect(quot5.apply(R(17)).mul(R(5)).add(mod5.apply(R(17))).toDisplay()).toBe('17');
    // опасный случай 16/7: частное = остатку
    expect(makeTool('quot', R(7)).apply(R(16)).toDisplay()).toBe('2');
    expect(makeTool('mod', R(7)).apply(R(16)).toDisplay()).toBe('2');
    // чётность и дробные
    expect(makeTool('mod', R(2)).apply(R(9)).toDisplay()).toBe('1');
    expect(mod5.apply(R(35, 2)).toDisplay()).toBe('2,5'); // 17,5 = 3 ряда по 5 + 2,5
    // отрицательные: остаток всегда неотрицателен
    expect(mod5.apply(R(-3)).toDisplay()).toBe('2');
    expect(quot5.apply(R(-3)).toDisplay()).toBe('-1');
    expect(mod5.inverseSpec()).toBeNull();
    expect(quot5.inverseSpec()).toBeNull();
  });

  it('фигуры: молоток ×k масштабирует стороны, площадь растёт как k²', () => {
    const s = new Session();
    const r = s.spawnRect(R(5), R(3));
    s.cutRect(r.id, 'x', R(2));
    const mul2 = s.addTool('mul', R(2));
    expect(s.applyTool(mul2.id, r.id)).toBe(true);
    expect(r.w.toDisplay()).toBe('10');
    expect(r.h.toDisplay()).toBe('6');
    expect(r.cutsX[0]!.toDisplay()).toBe('4'); // рез уехал вместе с масштабом
    expect(checkGoal(s, { kind: 'rect-size', w: '10', h: '6' })).toBe(true);
    // площадь была 15, стала 60 — k² = 4
    const div2 = s.addTool('div', R(2));
    s.applyTool(div2.id, r.id);
    expect(r.w.toDisplay()).toBe('5'); // ÷2 отматывает ×2
    // не-масштабные молотки по фигуре отказывают
    const add3 = s.addTool('add', R(3));
    expect(s.applyTool(add3.id, r.id)).toBe(false);
    // слишком большой масштаб — отказ, фигура не тронута
    const mul100 = s.addTool('mul', R(100));
    expect(s.applyTool(mul100.id, r.id)).toBe(false);
    expect(r.w.toDisplay()).toBe('5');
    // undo откатывает масштаб
    s.applyTool(mul2.id, r.id);
    s.undo();
    expect(r.w.toDisplay()).toBe('5');
  });

  it('периметр: забор 2(w+h) и цель rect-perimeter', () => {
    const s = new Session();
    s.spawnRect(R(6), R(2));
    expect(checkGoal(s, { kind: 'rect-perimeter', value: '16' })).toBe(true);
    expect(checkGoal(s, { kind: 'rect-perimeter', value: '12' })).toBe(false);
    // одинаковый забор — разный газон: 4×4 тоже даёт 16
    const q = s.spawnRect(R(4), R(4));
    expect(checkGoal(s, { kind: 'rect-perimeter', value: '16' })).toBe(true);
    expect(q.showPerimeter).toBe(false); // по умолчанию скрыт
  });

  it('цель values-include: все перечисленные значения на доске', () => {
    const s = new Session();
    s.spawnObject(R(49));
    s.spawnObject(R(64));
    expect(checkGoal(s, { kind: 'values-include', values: ['49', '64'] })).toBe(true);
    expect(checkGoal(s, { kind: 'values-include', values: ['49', '81'] })).toBe(false);
  });
});

describe('нейтральные удары по весам', () => {
  it('×1, ÷1, +0, −0 не надевают наклеек и не меняют состояние', () => {
    const s = new Session();
    const u = s.spawnUnknown('x', R(7));
    for (const [op, n] of [['mul', R(1)], ['div', R(1)], ['add', R(0)], ['sub', R(0)]] as const) {
      const t = s.addTool(op, n);
      expect(s.scalesApply(u.id, t.id, 'left')).toBe(true);
      expect(s.scalesApply(u.id, t.id, 'right')).toBe(true);
    }
    expect(u.ops.length).toBe(0);
    expect(u.rhs.toDisplay()).toBe('7');
    expect(u.revealed).toBe(false);   // нейтральный удар не вскрывает коробку
    expect(s.undo()).toBe(false);     // и не оставляет следов в логе

    // на уравнении v2 — так же
    const eq = s.spawnEquation('x', R(5), { k: R(2), b: R(3) }, { k: R(1), b: R(8) });
    const mul1 = s.addTool('mul', R(1));
    expect(s.equationApply(eq.id, mul1.id, 'left')).toBe(true);
    expect(linFormText(eq.left, 'x')).toBe('2x + 3');
    expect(s.undo()).toBe(false);

    // а ненейтральный ×(−1) наклейку вешает как раньше
    const mulNeg = s.addTool('mul', R(-1));
    s.scalesApply(u.id, mulNeg.id, 'left');
    expect(u.ops.length).toBe(1);
  });
});
