import { describe, it, expect } from 'vitest';
import { R, Rational } from '../src/core/rational';
import { makeTool, makeCompositeTool, subtitleFor, toolLabel } from '../src/core/model';
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

  it('весы: наклейки снимаются строго с верхней', () => {
    const s = new Session();
    const u = s.spawnUnknown('y', R(5));
    const mul3 = s.addTool('mul', R(3));
    const sub4 = s.addTool('sub', R(4));
    const add4 = s.addTool('add', R(4));
    const div3 = s.addTool('div', R(3));
    s.scalesApply(u.id, mul3.id); // y×3 = 15
    s.scalesApply(u.id, sub4.id); // y×3−4 = 11
    // не тот порядок: стопка растёт, а не снимается
    s.scalesApply(u.id, div3.id);
    expect(u.ops.length).toBe(3);
    s.undo();
    // правильный порядок: +4 против −4, потом ÷3
    s.scalesApply(u.id, add4.id);
    s.scalesApply(u.id, div3.id);
    expect(u.revealed).toBe(true);
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

  it('цель values-include: все перечисленные значения на доске', () => {
    const s = new Session();
    s.spawnObject(R(49));
    s.spawnObject(R(64));
    expect(checkGoal(s, { kind: 'values-include', values: ['49', '64'] })).toBe(true);
    expect(checkGoal(s, { kind: 'values-include', values: ['49', '81'] })).toBe(false);
  });
});
