import { describe, it, expect } from 'vitest';
import { R, Rational } from '../src/core/rational';
import { makeTool, makeCompositeTool, makeVarTool, subtitleFor, toolLabel, parseLinForm, linFormText, sinDeg, cosDeg, radText, polygonArea, polygonPerimeter, polygonIsSimple, polygonVertexAngle, circleAreaText, circleCircumferenceText, formatVarValue } from '../src/core/model';
import { clipFromObject, spawnFromClip } from '../src/core/clipboard';
import { Session } from '../src/core/session';
import { checkGoal } from '../src/core/goal';
import { importBoardData, exportBoard } from '../src/core/serialize';
import { traceEval } from '../src/scenes/planeScene';
import { parseFormula, evalNum, evalRat, toolToFormula, evalConstFormula } from '../src/core/formula';

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

  it('точки на плоскости: спавн, перенос с транзиентом, undo, цели', () => {
    const s = new Session();
    const pt = s.spawnPoint(R(3), R(2));
    expect(pt.label).toBe('Т1');
    expect(checkGoal(s, { kind: 'point-at', x: '3', y: '2' })).toBe(true);

    // транзиент не пишет в журнал, коммит — одна запись
    s.setPointPos(pt.id, R(4), R(2), false);
    s.setPointPos(pt.id, R(5), R(1), true);
    expect(checkGoal(s, { kind: 'point-at', x: '5', y: '1' })).toBe(true);
    expect(s.undo()).toBe(true);
    expect(pt.x.toDisplay()).toBe('3'); // откат к началу перетаскивания
    expect(pt.y.toDisplay()).toBe('2');
    expect(s.undo()).toBe(true); // следующий undo отменяет САМО создание точки
    expect(s.objects.size).toBe(0);
    s.spawnPoint(R(3), R(2)); // вернём точку для проверки целей

    // points-at: каждый адрес занят
    s.spawnPoint(R(2), R(3));
    expect(checkGoal(s, { kind: 'points-at', points: [
      { x: '3', y: '2' }, { x: '2', y: '3' },
    ] })).toBe(true);
    expect(checkGoal(s, { kind: 'points-at', points: [
      { x: '3', y: '2' }, { x: '7', y: '7' },
    ] })).toBe(false);
  });

  it('прогони вход: молоток по оси X рождает пару (вход; выход), отказ честен', () => {
    const s = new Session();
    const mul2 = s.addTool('mul', R(2));
    const events: string[] = [];
    s.on((e) => events.push(e.kind));
    const pt = s.tracePoint(mul2.id, R(3))!;
    expect(pt.x.toDisplay()).toBe('3');
    expect(pt.y.toDisplay()).toBe('6');
    expect(events).toContain('point-moved'); // прогон — полноценный ход
    expect(checkGoal(s, { kind: 'point-at', x: '3', y: '6' })).toBe(true);

    // отказ сигнатуры: √ от −4 — точки не будет, только честный отказ
    const sqrt = s.addTool('sqrt', R(0));
    events.length = 0;
    expect(s.tracePoint(sqrt.id, R(-4))).toBeNull();
    expect(events).toContain('tool-rejected');
    expect([...s.objects.values()].filter((o) => o.kind === 'point').length).toBe(1);
  });

  it('след инструмента: float-вычислитель для отрисовки честен к отказам', () => {
    const f = traceEval(makeTool('sqrt', R(0)))!;
    expect(f(9)).toBe(3);
    expect(f(-4)).toBeNull(); // дыра следа левее нуля
    const combo = traceEval(makeCompositeTool([{ op: 'add', n: R(1) }, { op: 'pow', n: R(2) }], ''))!;
    expect(combo(4)).toBe(25);
    const cbrtLike = traceEval(makeTool('pow', R(1, 3)))!;
    expect(cbrtLike(-8)).toBeCloseTo(-2); // нечётный корень живёт и слева
    expect(traceEval(makeTool('pow', R(1, 2)))!(-4)).toBeNull(); // чётный — нет
    expect(traceEval(makeVarTool('addx', R(1)))).toBeNull(); // у ±x следа нет вовсе
  });

  it('стрелки: спавн, транзиент головы, молотки, отказ, сумма, undo', () => {
    const s = new Session();
    const v = s.spawnVector(R(2), R(1));
    expect(v.label).toBe('В1');
    expect(checkGoal(s, { kind: 'vector-at', dx: '2', dy: '1' })).toBe(true);

    // голова: транзиент не пишет в журнал, возврат к той же команде — не ход
    let moves = 0;
    const off = s.on((e) => { if (e.kind === 'vector-changed') moves++; });
    s.setVectorData(v.id, R(5), R(5), false);
    s.setVectorData(v.id, R(2), R(1), true);
    off();
    expect(moves).toBe(0);

    const mul3 = s.addTool('mul', R(3));
    const add2 = s.addTool('add', R(2));
    expect(s.vectorApply(v.id, mul3.id)).toBe(true); // растяжка обеих цифр разом
    expect(v.dx.toDisplay()).toBe('6');
    expect(v.dy.toDisplay()).toBe('3');
    expect(s.vectorApply(v.id, add2.id)).toBe(false); // по стрелке — только ×k и ÷k
    expect(v.dx.toDisplay()).toBe('6');

    // сумма покомпонентная: противоположки гасятся в «стой на месте»
    const w = s.spawnVector(R(-6), R(-3));
    const sum = s.sumVectors(v.id, w.id)!;
    expect(sum.dx.isZero() && sum.dy.isZero()).toBe(true);
    expect(checkGoal(s, { kind: 'vectors-at', vectors: [
      { dx: '0', dy: '0' }, { dx: '6', dy: '3' },
    ] })).toBe(true);

    expect(s.undo()).toBe(true); // снялась сумма (undo отменяет создание)
    expect(s.undo()).toBe(true); // снялась вторая стрелка
    expect(s.undo()).toBe(true); // откатился удар ×3
    expect(v.dx.toDisplay()).toBe('2');
    expect(v.dy.toDisplay()).toBe('1');
  });

  it('кубоид: лесенка экструзии, молоток-масштаб k/k²/k³, отказы, undo', () => {
    const s = new Session();
    const c = s.spawnCuboid(R(3), R(0), R(0)); // отрезок
    expect(c.label).toBe('К1');

    // экструзия: транзиент не пишет в журнал, коммит — одна запись
    s.setCuboidSize(c.id, R(3), R(2), R(0), false);
    s.setCuboidSize(c.id, R(3), R(2), R(2), true);
    expect(checkGoal(s, { kind: 'cuboid-size', w: '3', d: '2', h: '2' })).toBe(true);

    // молоток ×2: рёбра ×2, объём ×8
    const mul2 = s.addTool('mul', R(2));
    expect(s.applyTool(mul2.id, c.id)).toBe(true);
    expect(c.w.toDisplay()).toBe('6');
    expect(checkGoal(s, { kind: 'cuboids-size', sizes: [{ w: '6', d: '4', h: '4' }] })).toBe(true);

    // отказы: не масштаб, не поместится, кубики не половинятся
    const add2 = s.addTool('add', R(2));
    expect(s.applyTool(add2.id, c.id)).toBe(false);
    const mul3 = s.addTool('mul', R(3));
    expect(s.applyTool(mul3.id, c.id)).toBe(false); // 18×12×12 — не поместится
    const div4 = s.addTool('div', R(4));
    expect(s.applyTool(div4.id, c.id)).toBe(false); // 6/4 не целое — кубики не половинятся
    expect(c.w.toDisplay()).toBe('6');

    // undo откатывает удар ×2, потом экструзию
    expect(s.undo()).toBe(true);
    expect(c.w.toDisplay()).toBe('3');
    expect(c.h.toDisplay()).toBe('2');
    expect(s.undo()).toBe(true);
    expect(c.d.isZero() && c.h.isZero()).toBe(true); // снова отрезок
  });

  it('перенос точки командой: путь прибавляется, стрелка не расходуется, undo', () => {
    const s = new Session();
    const pt = s.spawnPoint(R(1), R(1));
    const v = s.spawnVector(R(3), R(1));
    expect(s.movePointBy(pt.id, v.id)).toBe(true);
    expect(checkGoal(s, { kind: 'point-at', x: '4', y: '2' })).toBe(true);
    expect(v.dx.toDisplay()).toBe('3'); // команда многоразовая

    // нулевая команда — «стой на месте», не ход
    const zero = s.spawnVector(R(0), R(0));
    expect(s.movePointBy(pt.id, zero.id)).toBe(true);
    expect(s.undo()).toBe(true); // снялась нулевая стрелка (её перенос не ход)
    expect(s.undo()).toBe(true); // откатился перенос
    expect(pt.x.toDisplay()).toBe('1');
    expect(pt.y.toDisplay()).toBe('1');
  });

  it('движения точки: молоток ×k (гомотетия/разворот), зеркала осей, undo', () => {
    const s = new Session();
    const pt = s.spawnPoint(R(3), R(2));

    // ×(−1) — центральная симметрия: разворот вокруг нуля
    const mulNeg = s.addTool('mul', R(-1));
    expect(s.pointApply(pt.id, mulNeg.id)).toBe(true);
    expect(checkGoal(s, { kind: 'point-at', x: '-3', y: '-2' })).toBe(true);

    // прочие молотки отказывают, адрес цел
    const add2 = s.addTool('add', R(2));
    expect(s.pointApply(pt.id, add2.id)).toBe(false);
    expect(pt.x.toDisplay()).toBe('-3');

    // зеркало оси X: y меняет знак, x не трогает
    expect(s.flipPoint(pt.id, 'x')).toBe(true);
    expect(checkGoal(s, { kind: 'point-at', x: '-3', y: '2' })).toBe(true);
    expect(s.flipPoint(pt.id, 'y')).toBe(true);
    expect(checkGoal(s, { kind: 'point-at', x: '3', y: '2' })).toBe(true);

    // точка на зеркале отражается в себя — не ход
    const onAxis = s.spawnPoint(R(5), R(0));
    expect(s.flipPoint(onAxis.id, 'x')).toBe(true);
    expect(s.undo()).toBe(true); // снялось создание onAxis, а не «отражение»
    expect(s.objects.has(onAxis.id)).toBe(false);

    expect(s.undo()).toBe(true); // откат зеркала Y
    expect(pt.x.toDisplay()).toBe('-3');
  });

  it('переливание: сумма-инвариант, атомарный undo, отказы', () => {
    const s = new Session();
    const a = s.spawnObject(R(7));
    const b = s.spawnObject(R(3));
    expect(s.transfer(a.id, b.id, R(2))).toBe(true);
    expect(a.value.toDisplay()).toBe('5');
    expect(b.value.toDisplay()).toBe('5');
    expect(checkGoal(s, { kind: 'values-equal', value: '5' })).toBe(true);
    expect(a.value.add(b.value).toDisplay()).toBe('10'); // сумма цела

    // один undo откатывает ОБА столбика разом
    expect(s.undo()).toBe(true);
    expect(a.value.toDisplay()).toBe('7');
    expect(b.value.toDisplay()).toBe('3');
    expect(checkGoal(s, { kind: 'values-equal', value: '5' })).toBe(false);

    // отказы: сам в себя, ноль/минус, переменная
    expect(s.transfer(a.id, a.id)).toBe(false);
    expect(s.transfer(a.id, b.id, R(0))).toBe(false);
    const v = s.spawnVariable('t', R(-10), R(10), R(1));
    expect(s.transfer(a.id, v.id)).toBe(false);

    // в минус переливать можно: числа — не вода
    expect(s.transfer(b.id, a.id, R(5))).toBe(true);
    expect(b.value.toDisplay()).toBe('-2');
  });

  it('углы: табличный синус точен, прочий с ≈; молотки-повороты; намотка и остаток; undo', () => {
    const s = new Session();
    const a = s.spawnAngle(R(30));
    expect(a.label).toBe('α1');
    expect(sinDeg(a.deg)).toEqual({ v: R(1, 2), exact: true });   // sin 30° = 1/2 точно
    expect(cosDeg(R(60)).v.toDisplay()).toBe('0,5');              // cos 60° = sin 30°
    expect(sinDeg(R(45)).exact).toBe(false);                      // sin 45° иррационален
    expect(sinDeg(R(45)).v.toDisplay()).toBe('0,707');
    expect(sinDeg(R(-30)).v.toDisplay()).toBe('-0,5');            // минус-угол — под полом
    expect(sinDeg(R(390)).v.toDisplay()).toBe('0,5');             // намотка не мешает месту

    // молоток +120 — поворот; цель angle-at
    const add120 = s.addTool('add', R(120));
    expect(s.applyTool(add120.id, a.id)).toBe(true);
    expect(a.deg.toDisplay()).toBe('150');
    expect(checkGoal(s, { kind: 'angle-at', deg: '150' })).toBe(true);

    // x² по углу отказывает: угол крутят, а не возводят
    const sq = s.addTool('sq', R(0));
    expect(s.applyTool(sq.id, a.id)).toBe(false);
    expect(a.deg.toDisplay()).toBe('150');

    // намотка: 150 + 240 = 390; место = 30 (anyTurn), остаток ост360 снимает круг
    expect(s.applyTool(s.addTool('add', R(240)).id, a.id)).toBe(true);
    expect(checkGoal(s, { kind: 'angle-at', deg: '390' })).toBe(true);
    expect(checkGoal(s, { kind: 'angle-at', deg: '30', anyTurn: true })).toBe(true);
    expect(checkGoal(s, { kind: 'angle-at', deg: '30' })).toBe(false);
    expect(s.applyTool(s.addTool('mod', R(360)).id, a.id)).toBe(true);
    expect(a.deg.toDisplay()).toBe('30');

    expect(s.undo()).toBe(true); // откат остатка
    expect(a.deg.toDisplay()).toBe('390');

    // семейство углов: цель angles-at (и с точностью до оборотов)
    s.spawnAngle(R(150));
    expect(checkGoal(s, { kind: 'angles-at', degs: ['390', '150'] })).toBe(true);
    expect(checkGoal(s, { kind: 'angles-at', degs: ['30', '150'], anyTurn: true })).toBe(true);
    expect(checkGoal(s, { kind: 'angles-at', degs: ['30', '150'] })).toBe(false);

    // вращение рукой: транзиент + один коммит
    s.setAngleDeg(a.id, R(400), false);
    s.setAngleDeg(a.id, R(420), true);
    expect(s.undo()).toBe(true);
    expect(a.deg.toDisplay()).toBe('390');
  });

  it('радианы: точное переодевание deg/180 долей π', () => {
    expect(radText(R(180))).toBe('π');
    expect(radText(R(90))).toBe('π/2');
    expect(radText(R(30))).toBe('π/6');
    expect(radText(R(360))).toBe('2π');
    expect(radText(R(270))).toBe('3π/2');
    expect(radText(R(-30))).toBe('−π/6');
    expect(radText(R(0))).toBe('0');
    expect(radText(R(450))).toBe('5π/2');
  });

  it('поворот точки на 90°: против/по часовой, ось дыбом, нуль-центр, undo', () => {
    const s = new Session();
    const pt = s.spawnPoint(R(3), R(1));
    expect(s.rotatePoint(pt.id, 'ccw')).toBe(true);
    expect(checkGoal(s, { kind: 'point-at', x: '-1', y: '3' })).toBe(true);
    expect(s.rotatePoint(pt.id, 'cw')).toBe(true); // обратно
    expect(checkGoal(s, { kind: 'point-at', x: '3', y: '1' })).toBe(true);

    // четыре поворота — кругом
    for (let i = 0; i < 4; i++) s.rotatePoint(pt.id, 'ccw');
    expect(checkGoal(s, { kind: 'point-at', x: '3', y: '1' })).toBe(true);

    // нуль — неподвижный центр: не ход
    const zero = s.spawnPoint(R(0), R(0));
    expect(s.rotatePoint(zero.id, 'ccw')).toBe(true);
    expect(s.undo()).toBe(true); // снялось создание нуля, а не «поворот»
    expect(s.objects.has(zero.id)).toBe(false);

    expect(s.undo()).toBe(true); // откат последнего поворота
    expect(checkGoal(s, { kind: 'point-at', x: '1', y: '-3' })).toBe(true);
  });

  it('счётчик ударов молотка: считает состоявшиеся, нейтральные и отказы — нет', () => {
    const s = new Session();
    const o = s.spawnObject(R(5));
    const mulNeg = s.addTool('mul', R(-1));
    expect(mulNeg.hits).toBe(0);
    s.applyTool(mulNeg.id, o.id);
    s.applyTool(mulNeg.id, o.id);
    expect(mulNeg.hits).toBe(2); // чётный — знак вернулся: (−1)²

    // отказ не считается ударом
    const sqrt = s.addTool('sqrt', R(0));
    s.applyTool(s.addTool('sub', R(6)).id, o.id); // 5 → −1
    expect(s.applyTool(sqrt.id, o.id)).toBe(false);
    expect(sqrt.hits).toBe(0);

    // нейтральный удар по весам не считается
    const u = s.spawnUnknown('x', R(3));
    const mul1 = s.addTool('mul', R(1));
    s.scalesApply(u.id, mul1.id, 'left');
    expect(mul1.hits).toBe(0);
  });

  it('формулы: приоритеты, неявное умножение, дыры, точный вычислитель', () => {
    const at = (src: string, x: number): number | null => {
      const ast = parseFormula(src);
      return ast ? evalNum(ast, x) : null;
    };
    expect(at('x^2 - 2(x+5) + 10', 3)).toBe(3);   // 9 − 16 + 10
    expect(at('2x', 4)).toBe(8);                   // неявное умножение
    expect(at('(x+1)(x-1)', 5)).toBe(24);
    expect(at('-x^2', 2)).toBe(-4);                // унарный минус за степенью
    expect(at('x^2^3', 2)).toBe(256);              // правоассоциативность: 2^8
    expect(at('sqrt(x)', -4)).toBe(null);          // дыра
    expect(at('1/x', 0)).toBe(null);               // деление на ноль
    expect(at('abs(х)', -7)).toBe(7);              // кириллическая «х» принимается
    expect(at('3,5 + x', 0)).toBe(3.5);            // запятая в числе
    expect(parseFormula('2 +')).toBe(null);        // огрызок — ошибка
    expect(parseFormula('y + 1')).toBe(null);      // чужие буквы — ошибка

    // точный вычислитель: Rational без потерь, ≈-политика на корнях
    const ast = parseFormula('x/3')!;
    expect(evalRat(ast, R(1))!.toDisplay()).toBe('1/3');
    expect(evalRat(parseFormula('sqrt(x)')!, R(8))!.toDisplay()).toBe('2,828');
    expect(evalRat(parseFormula('sqrt(x)')!, R(-1))).toBe(null);

    // молоток → формула (мост «жест → запись»)
    expect(toolToFormula(makeTool('mul', R(2)))).toBe('2x');
    expect(toolToFormula(makeCompositeTool([{ op: 'mul', n: R(2) }, { op: 'add', n: R(3) }], ''))).toBe('(2x) + 3');
    expect(toolToFormula(makeTool('div', R(1, 3)))).toBe('x / (1/3)');
    expect(toolToFormula(makeTool('mod', R(5)))).toBe(null);
  });

  it('функции-машины: спавн, правка формулы — ход, probe с точным адресом, отказ', () => {
    const s = new Session();
    const f = s.spawnFunction('x^2');
    expect(f.label).toBe('f');

    const events: string[] = [];
    const off = s.on((e) => events.push(e.kind));
    const pt = s.probeFunction(f.id, R(3))!;
    expect(pt.x.toDisplay()).toBe('3');
    expect(pt.y.toDisplay()).toBe('9');
    expect(events).toContain('point-moved'); // probe — полноценный ход
    expect(checkGoal(s, { kind: 'point-at', x: '3', y: '9' })).toBe(true);

    // дыра — честный отказ, точки нет
    s.setFunctionFormula(f.id, 'sqrt(x)');
    events.length = 0;
    expect(s.probeFunction(f.id, R(-4))).toBeNull();
    expect(events).toContain('function-refused');

    // правка формулы — ход с undo
    expect(s.undo()).toBe(true); // откат формулы к x^2
    expect(f.formula).toBe('x^2');
  });

  it('фигуры: рост влево/вниз с якорем — резы остаются на месте', () => {
    const s = new Session();
    const r = s.spawnRect(R(6), R(4));
    s.cutRect(r.id, 'x', R(2));
    // тянем ЛЕВУЮ кромку: ширина 6 → 8, якорь справа — рез уезжает на +2
    s.setRectSize(r.id, R(8), R(4), true, { anchorX: 'right' });
    expect(r.cutsX.map((c) => c.toDisplay())).toEqual(['4']);
    // обычный рост вправо резы не трогает
    s.setRectSize(r.id, R(10), R(4), true);
    expect(r.cutsX.map((c) => c.toDisplay())).toEqual(['4']);
  });

  it('структурный undo: создание отменяется, удалённое воскресает, импорт — не ходы', () => {
    const s = new Session();
    const o = s.spawnObject(R(7));
    const t = s.addTool('add', R(3));
    s.applyTool(t.id, o.id); // 10

    // удаление → undo воскрешает ТОТ ЖЕ экземпляр со всей историей значений
    s.removeObject(o.id);
    expect(s.objects.size).toBe(0);
    expect(s.undo()).toBe(true);
    expect(s.objects.get(o.id)).toBe(o);
    expect(o.value.toDisplay()).toBe('10');

    expect(s.undo()).toBe(true); // откат удара
    expect(o.value.toDisplay()).toBe('7');
    expect(s.undo()).toBe(true); // откат создания
    expect(s.objects.size).toBe(0);
    expect(s.undo()).toBe(false); // история пуста

    // свежая доска = свежая история: после импорта отменять нечего
    const s2 = new Session();
    expect(importBoardData(s2, {
      v: 1, tools: [], objects: [{ kind: 'point', x: '1', y: '2' }],
    })).toBe(true);
    expect(s2.objects.size).toBe(1);
    expect(s2.undo()).toBe(false);
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
    // следов в логе нет: единственный undo отменяет САМО создание коробки
    expect(s.undo()).toBe(true);
    expect(s.objects.size).toBe(0);
    expect(s.undo()).toBe(false);
    const u2 = s.spawnUnknown('x', R(7));

    // на уравнении v2 — так же
    const eq = s.spawnEquation('x', R(5), { k: R(2), b: R(3) }, { k: R(1), b: R(8) });
    const mul1 = s.addTool('mul', R(1));
    expect(s.equationApply(eq.id, mul1.id, 'left')).toBe(true);
    expect(linFormText(eq.left, 'x')).toBe('2x + 3');
    expect(s.undo()).toBe(true); // снялось создание уравнения, а не нейтральный удар
    expect(s.objects.has(eq.id)).toBe(false);

    // а ненейтральный ×(−1) наклейку вешает как раньше
    const mulNeg = s.addTool('mul', R(-1));
    s.scalesApply(u2.id, mulNeg.id, 'left');
    expect(u2.ops.length).toBe(1);
  });
});

describe('многоугольники (построения на плоскости)', () => {
  const verts = (...xy: [number, number][]) => xy.map(([x, y]) => ({ x: R(x), y: R(y) }));

  it('площадь по шнуровке точная, периметр пифагоров — точный', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [4, 0], [0, 3]))!; // египетский треугольник
    expect(p).not.toBeNull();
    expect(polygonArea(p).toDisplay()).toBe('6');
    const per = polygonPerimeter(p);
    expect(per.exact).toBe(true);
    expect(per.v.toDisplay()).toBe('12'); // 3 + 4 + 5
  });

  it('непифагорова сторона — периметр честно приближается', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [1, 1], [2, 0], [1, -1]))!; // квадрат на уголке
    expect(polygonArea(p).toDisplay()).toBe('2');
    expect(polygonPerimeter(p).exact).toBe(false); // 4·√2
    expect(polygonIsSimple(p)).toBe(true);
  });

  it('самопересечение (бабочка) ловится точно', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [2, 2], [2, 0], [0, 2]))!;
    expect(polygonIsSimple(p)).toBe(false);
  });

  it('меньше трёх вершин — фигуры не бывает', () => {
    const s = new Session();
    expect(s.spawnPolygon(verts([0, 0], [1, 1]))).toBeNull();
  });

  it('перенос тела: транзиенты без записи, коммит — один ход, undo возвращает', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [2, 0], [0, 2]))!;
    let moves = 0;
    s.on((e) => { if (e.kind === 'polygon-changed') moves++; });
    s.movePolygon(p.id, R(1), R(0), false);
    s.movePolygon(p.id, R(2), R(1), false);
    expect(moves).toBe(0); // транзиенты молчат
    s.movePolygon(p.id, R(3), R(-1), true);
    expect(moves).toBe(1); // один ход на весь жест
    expect(p.vertices[0]!.x.toDisplay()).toBe('3');
    expect(p.vertices[0]!.y.toDisplay()).toBe('-1');
    expect(p.vertices[2]!.y.toDisplay()).toBe('1'); // смещение от БАЗЫ, не накопленное
    expect(s.undo()).toBe(true);
    expect(p.vertices[0]!.x.toDisplay()).toBe('0');
    expect(p.vertices[2]!.y.toDisplay()).toBe('2');
  });

  it('вершина тащится с коммитом; возврат на место — не ход', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [2, 0], [0, 2]))!;
    let moves = 0;
    s.on((e) => { if (e.kind === 'polygon-changed') moves++; });
    s.setPolygonVertex(p.id, 1, R(3), R(0), false);
    s.setPolygonVertex(p.id, 1, R(2), R(0), true); // вернулась
    expect(moves).toBe(0);
    s.setPolygonVertex(p.id, 1, R(4), R(0), true);
    expect(moves).toBe(1);
    expect(polygonArea(p).toDisplay()).toBe('4');
    expect(s.undo()).toBe(true);
    expect(polygonArea(p).toDisplay()).toBe('2');
  });

  it('зеркала и повороты двигают весь строй', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([1, 0], [3, 0], [1, 2]))!;
    expect(s.flipPolygon(p.id, 'y')).toBe(true);
    expect(p.vertices[0]!.x.toDisplay()).toBe('-1');
    expect(s.rotatePolygon(p.id, 'ccw')).toBe(true); // (x;y) → (−y;x)
    expect(p.vertices[0]!.x.toDisplay()).toBe('0');
    expect(p.vertices[0]!.y.toDisplay()).toBe('-1');
    expect(polygonArea(p).toDisplay()).toBe('2'); // движения площадь не меняют
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(p.vertices[0]!.x.toDisplay()).toBe('1');
  });

  it('молоток ×k — гомотетия (площадь ×k²), чужие молотки и ×0 отказывают', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [2, 0], [0, 2]))!;
    const rejected: string[] = [];
    s.on((e) => { if (e.kind === 'tool-rejected') rejected.push(e.reason); });

    const mul2 = s.addTool('mul', R(2));
    expect(s.polygonApply(p.id, mul2.id)).toBe(true);
    expect(polygonArea(p).toDisplay()).toBe('8'); // 2 → 8: ×2 даёт ×4 площади
    expect(mul2.hits).toBe(1);

    const add5 = s.addTool('add', R(5));
    expect(s.polygonApply(p.id, add5.id)).toBe(false);
    const mul0 = s.addTool('mul', R(0));
    expect(s.polygonApply(p.id, mul0.id)).toBe(false);
    expect(rejected.length).toBe(2);
    expect(polygonArea(p).toDisplay()).toBe('8'); // отказы ничего не меняют

    expect(s.undo()).toBe(true);
    expect(polygonArea(p).toDisplay()).toBe('2');
  });

  it('сериализация: фигура выживает в заготовке доски', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [3, 0], [3, 2], [0, 2]))!;
    p.showPerimeter = true;
    const json = JSON.parse(exportBoard(s));
    const s2 = new Session();
    expect(importBoardData(s2, json)).toBe(true);
    const p2 = [...s2.objects.values()].find((o) => o.kind === 'polygon')!;
    expect(p2.kind).toBe('polygon');
    if (p2.kind === 'polygon') {
      expect(p2.vertices.length).toBe(4);
      expect(polygonArea(p2).toDisplay()).toBe('6');
      expect(p2.showPerimeter).toBe(true);
    }
  });

  it('удаление и воскрешение фигуры через undo', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [1, 0], [0, 1]))!;
    s.removeObject(p.id);
    expect(s.objects.has(p.id)).toBe(false);
    expect(s.undo()).toBe(true);
    expect(s.objects.has(p.id)).toBe(true);
  });
});

describe('углы, окружности, цели и копирование фигур', () => {
  const verts = (...xy: [number, number][]) => xy.map(([x, y]) => ({ x: R(x), y: R(y) }));

  it('углы при вершинах: табличные точно, прочие с ≈', () => {
    const s = new Session();
    const sq = s.spawnPolygon(verts([0, 0], [2, 0], [2, 2], [0, 2]))!; // квадрат
    for (let i = 0; i < 4; i++) {
      const a = polygonVertexAngle(sq, i);
      expect(a.exact).toBe(true);
      expect(a.v.toDisplay()).toBe('90');
    }
    const tri = s.spawnPolygon(verts([0, 0], [2, 0], [0, 2]))!; // равнобедренный прямоугольный
    expect(polygonVertexAngle(tri, 0).v.toDisplay()).toBe('90');
    expect(polygonVertexAngle(tri, 1).v.toDisplay()).toBe('45');
    expect(polygonVertexAngle(tri, 1).exact).toBe(true);
    const skew = s.spawnPolygon(verts([0, 0], [3, 0], [0, 1]))!; // atan(1/3) — не табличный
    const a = polygonVertexAngle(skew, 1);
    expect(a.exact).toBe(false);
    expect(a.v.toDisplay()).toBe('18,4'); // ≈18,43° до десятой
  });

  it('вогнутая вершина даёт рефлексный угол 360−θ', () => {
    const s = new Session();
    // «стрелка»: вершина (1;1) вдавлена внутрь
    const p = s.spawnPolygon(verts([0, 0], [4, 0], [1, 1], [0, 4]))!;
    const inner = polygonVertexAngle(p, 2);
    expect(inner.v.toNumber()).toBeGreaterThan(180);
    // сумма углов простого четырёхугольника — 360°
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += polygonVertexAngle(p, i).v.toNumber();
    expect(Math.round(sum)).toBe(360);
  });

  it('окружность: π остаётся именем — S и C точны', () => {
    const s = new Session();
    const c = s.spawnCircle(R(1), R(2), R(2))!;
    expect(circleAreaText(c)).toBe('4π');
    expect(circleCircumferenceText(c)).toBe('4π');
    c.r = R(1, 2);
    expect(circleAreaText(c)).toBe('π/4');
    expect(circleCircumferenceText(c)).toBe('π');
    expect(s.spawnCircle(R(0), R(0), R(0))).toBeNull(); // без радиуса не бывает
  });

  it('центр и радиус: транзиенты, коммит одним ходом, undo', () => {
    const s = new Session();
    const c = s.spawnCircle(R(0), R(0), R(2))!;
    let moves = 0;
    s.on((e) => { if (e.kind === 'circle-changed') moves++; });
    s.setCirclePos(c.id, R(1), R(0), false);
    s.setCirclePos(c.id, R(3), R(1), true);
    expect(moves).toBe(1);
    s.setCircleRadius(c.id, R(5), false);
    s.setCircleRadius(c.id, R(2), true); // вернулся — не ход
    expect(moves).toBe(1);
    expect(s.setCircleRadius(c.id, R(-1))).toBe(false); // отрицательный радиус — отказ
    expect(s.undo()).toBe(true);
    expect(c.cx.toDisplay()).toBe('0');
  });

  it('молоток по окружности: гомотетия, ×0 и +k отказывают', () => {
    const s = new Session();
    const c = s.spawnCircle(R(1), R(1), R(1))!;
    const mul2 = s.addTool('mul', R(2));
    expect(s.circleApply(c.id, mul2.id)).toBe(true);
    expect(c.cx.toDisplay()).toBe('2');
    expect(c.r.toDisplay()).toBe('2');
    const mulNeg = s.addTool('mul', R(-1));
    expect(s.circleApply(c.id, mulNeg.id)).toBe(true);
    expect(c.cx.toDisplay()).toBe('-2');
    expect(c.r.toDisplay()).toBe('2'); // радиус — длина, знак его не разворачивает
    const rejected: string[] = [];
    s.on((e) => { if (e.kind === 'tool-rejected') rejected.push(e.reason); });
    expect(s.circleApply(c.id, s.addTool('add', R(5)).id)).toBe(false);
    expect(s.circleApply(c.id, s.addTool('mul', R(0)).id)).toBe(false);
    expect(rejected.length).toBe(2);
  });

  it('зеркала и повороты возят центр, вектор ведёт фигуру и окружность', () => {
    const s = new Session();
    const c = s.spawnCircle(R(3), R(1), R(1))!;
    s.flipCircle(c.id, 'y');
    expect(c.cx.toDisplay()).toBe('-3');
    s.rotateCircle(c.id, 'ccw'); // (x;y) → (−y;x)
    expect(c.cx.toDisplay()).toBe('-1');
    expect(c.cy.toDisplay()).toBe('-3');

    const p = s.spawnPolygon(verts([0, 0], [1, 0], [0, 1]))!;
    const v = s.spawnVector(R(2), R(3));
    expect(s.movePolygonBy(p.id, v.id)).toBe(true);
    expect(p.vertices[0]!.x.toDisplay()).toBe('2');
    expect(p.vertices[0]!.y.toDisplay()).toBe('3');
    expect(s.moveCircleBy(c.id, v.id)).toBe(true);
    expect(c.cx.toDisplay()).toBe('1');
    expect(s.undo()).toBe(true); // отменился перенос окружности
    expect(c.cx.toDisplay()).toBe('-1');
  });

  it('цели polygon-area и circle-size', () => {
    const s = new Session();
    expect(checkGoal(s, { kind: 'polygon-area', area: '6' })).toBe(false);
    s.spawnPolygon(verts([0, 0], [4, 0], [0, 3]));
    expect(checkGoal(s, { kind: 'polygon-area', area: '6' })).toBe(true);
    expect(checkGoal(s, { kind: 'polygon-area', area: '6', verts: 4 })).toBe(false);
    expect(checkGoal(s, { kind: 'polygon-area', area: '6', verts: 3 })).toBe(true);
    // самопересекающаяся бабочка площадь не засчитывает
    const bow = new Session();
    bow.spawnPolygon(verts([0, 0], [2, 2], [2, 0], [0, 2]));
    expect(checkGoal(bow, { kind: 'polygon-area', area: '2' })).toBe(false);

    expect(checkGoal(s, { kind: 'circle-size', r: '3/2' })).toBe(false);
    s.spawnCircle(R(0), R(0), R(3, 2));
    expect(checkGoal(s, { kind: 'circle-size', r: '3/2' })).toBe(true);
  });

  it('сериализация окружности и флага углов', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [1, 0], [0, 1]))!;
    p.showAngles = true;
    const c = s.spawnCircle(R(1), R(-2), R(5, 2))!;
    c.showCircumference = true;
    const s2 = new Session();
    expect(importBoardData(s2, JSON.parse(exportBoard(s)))).toBe(true);
    const p2 = [...s2.objects.values()].find((o) => o.kind === 'polygon');
    const c2 = [...s2.objects.values()].find((o) => o.kind === 'circle');
    expect(p2?.kind === 'polygon' && p2.showAngles).toBe(true);
    expect(c2?.kind === 'circle' && c2.r.toDisplay()).toBe('2,5');
    expect(c2?.kind === 'circle' && c2.showCircumference).toBe(true);
  });

  it('буфер обмена: копия фигуры и окружности — свежие объекты', () => {
    const s = new Session();
    const p = s.spawnPolygon(verts([0, 0], [2, 0], [0, 2]))!;
    p.showAngles = true;
    const c = s.spawnCircle(R(1), R(1), R(2))!;
    const clipP = clipFromObject(p, 0, 0)!;
    const clipC = clipFromObject(c, 0, 0)!;
    const p2 = spawnFromClip(s, clipP);
    const c2 = spawnFromClip(s, clipC);
    expect(p2.kind === 'polygon' && p2.id !== p.id && polygonArea(p2).toDisplay()).toBe('2');
    expect(p2.kind === 'polygon' && p2.showAngles).toBe(true);
    expect(c2.kind === 'circle' && c2.r.toDisplay()).toBe('2');
    // копия независима: движение копии не трогает оригинал
    if (p2.kind === 'polygon') s.movePolygon(p2.id, R(1), R(1));
    expect(p.vertices[0]!.x.toDisplay()).toBe('0');
  });
});

describe('переменная-коробка: формат записи, выражения, сериализация', () => {
  it('formatVarValue: десятичный авто и с числом знаков', () => {
    expect(formatVarValue(R(3, 8))).toBe('0,375');            // конечная — как есть
    expect(formatVarValue(R(1, 3))).toBe('≈0,333');           // бесконечная — честное ≈
    expect(formatVarValue(R(3, 8), { kind: 'dec', digits: 2 })).toBe('≈0,38');
    expect(formatVarValue(R(1, 2), { kind: 'dec', digits: 2 })).toBe('0,50'); // точно в 2 знака
    expect(formatVarValue(R(-1, 3), { kind: 'dec', digits: 1 })).toBe('≈-0,3');
  });

  it('formatVarValue: дробный формат с заданным знаменателем', () => {
    expect(formatVarValue(R(3, 8), { kind: 'frac', den: 8 })).toBe('3/8');
    expect(formatVarValue(R(3, 8), { kind: 'frac', den: 16 })).toBe('6/16'); // без сокращения — линейка
    expect(formatVarValue(R(1, 3), { kind: 'frac', den: 8 })).toBe('≈2,67/8'); // не влезает — честное ≈
    expect(formatVarValue(R(2), { kind: 'frac', den: 4 })).toBe('8/4'); // неправильная дробь честна
  });

  it('√ по дробной переменной: ≈-политика ядра + честная запись формата', () => {
    const v = makeTool('sqrt', R(0)).apply(R(3, 8)); // ≈0,612
    expect(formatVarValue(v, { kind: 'frac', den: 8 })).toMatch(/^≈/);
    expect(formatVarValue(v, { kind: 'dec', digits: 3 })).toBe('0,612');
  });

  it('evalConstFormula: выражения считаются точно, x и мусор — отказ', () => {
    expect(evalConstFormula('3+6')!.toDisplay()).toBe('9');
    expect(evalConstFormula('3/8')!.toDisplay()).toBe('0,375');
    expect(evalConstFormula('2(1+4)')!.toDisplay()).toBe('10');
    expect(evalConstFormula('sqrt(9)')!.toDisplay()).toBe('3');
    expect(evalConstFormula('-1/2')!.toDisplay()).toBe('-0,5');
    expect(evalConstFormula('x+1')).toBeNull();   // чужая буква в значении
    expect(evalConstFormula('abc')).toBeNull();
    expect(evalConstFormula('sqrt(-4)')).toBeNull(); // отказ честен и тут
  });

  it('ввод значения — ход var-set с undo; молотки бьют как по числу', () => {
    const s = new Session();
    const v = s.spawnVariable('a');
    let sets = 0;
    s.on((e) => { if (e.kind === 'var-set') sets++; });
    s.setVariableValue(v.id, R(9), true);
    expect(sets).toBe(1);
    expect(v.value.toDisplay()).toBe('9');
    const sq = s.addTool('sq', R(0));
    s.applyTool(sq.id, v.id);
    expect(v.value.toDisplay()).toBe('81');
    expect(s.undo()).toBe(true); // удар
    expect(s.undo()).toBe(true); // присваивание
    expect(v.value.toDisplay()).toBe('0');
  });

  it('формат и видимость переживают сериализацию и буфер обмена', () => {
    const s = new Session();
    const v = s.spawnVariable('k');
    s.setVariableValue(v.id, R(3, 8));
    v.variable!.format = { kind: 'frac', den: 8 };
    v.variable!.showValue = false;
    const s2 = new Session();
    expect(importBoardData(s2, JSON.parse(exportBoard(s)))).toBe(true);
    const v2 = [...s2.objects.values()].find((o) => o.kind === 'number' && o.variable);
    expect(v2?.kind === 'number' && v2.variable?.format?.kind).toBe('frac');
    expect(v2?.kind === 'number' && v2.variable?.showValue).toBe(false);

    const copy = spawnFromClip(s, clipFromObject(v, 0, 0)!);
    expect(copy.kind === 'number' && copy.variable?.format?.kind).toBe('frac');
    // формат копии независим от оригинала
    if (copy.kind === 'number' && copy.variable?.format?.kind === 'frac') copy.variable.format.den = 4;
    expect(v.variable!.format!.kind === 'frac' && v.variable!.format!.den).toBe(8);
  });
});
