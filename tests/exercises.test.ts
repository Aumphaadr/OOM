/**
 * Смоук-тест задачника: каждая глава ссылается на существующие упражнения,
 * каждое упражнение импортируется, не самовыполняется и решается предписанными
 * ходами — включая контрпримеры и обстрелы чекпоинтов (методика 999).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { R } from '../src/core/rational';
import { Session } from '../src/core/session';
import { importBoardData, BoardJson } from '../src/core/serialize';
import { checkGoal, GoalSpec } from '../src/core/goal';
import { ExerciseSpec } from '../src/ui/reader';

const TB = path.join(__dirname, '../public/textbook');
const manifest = JSON.parse(fs.readFileSync(path.join(TB, 'manifest.json'), 'utf8')) as {
  chapters: { id: string; title: string; file: string }[];
};
const exerciseFiles = fs.readdirSync(path.join(TB, 'exercises')).filter((f) => f.endsWith('.json'));
const specs = new Map<string, ExerciseSpec>(
  exerciseFiles.map((f) => {
    const s = JSON.parse(fs.readFileSync(path.join(TB, 'exercises', f), 'utf8')) as ExerciseSpec;
    return [s.id, s];
  }),
);

function fresh(board: BoardJson): Session {
  const s = new Session();
  expect(importBoardData(s, board)).toBe(true);
  return s;
}
const objs = (s: Session) => [...s.objects.values()];
const tool = (s: Session, op: string, i = 0) =>
  [...s.tools.values()].filter((t) => t.op === op)[i]!;

/** Ударить инструментом по всем числам. */
function hammer(s: Session, op: string): void {
  const t = tool(s, op);
  for (const o of objs(s)) if (o.kind === 'number') s.applyTool(t.id, o.id);
}
const tapeByMode = (s: Session, mode: number) =>
  objs(s).find((o) => o.kind === 'tape' && o.mode === mode)!;

/** Решатели: id упражнения (и id#cN / id#b для контрпримеров и обстрелов) → ходы. */
const SOLVERS: Record<string, (s: Session) => void> = {
  'neg-01': (s) => hammer(s, 'sub'),
  'neg-01#c0': (s) => hammer(s, 'sub'),
  'neg-01#c2': (s) => hammer(s, 'sub'),
  'neg-01#b': (s) => hammer(s, 'sub'),
  'neg-02': (s) => { hammer(s, 'add'); hammer(s, 'sub'); },
  'neg-03': (s) => hammer(s, 'mul'),

  'tape-01': (s) => s.cutTape(objs(s)[0]!.id, 1),
  'tape-02': (s) => s.cutTape(objs(s)[0]!.id, 3),
  'cmp-01': (s) => s.cutTape(tapeByMode(s, 5).id, 2),
  'cmp-02': (s) => s.cutTape(tapeByMode(s, 4).id, 2),
  'cmp-03': (s) => s.cutTape(tapeByMode(s, 4).id, 3),
  'cmp-03#c0': (s) => s.cutTape(tapeByMode(s, 4).id, 1),
  'cmp-03#c1': (s) => s.cutTape(tapeByMode(s, 8).id, 2),
  'cmp-03#b': (s) => s.cutTape(tapeByMode(s, 5).id, 3),

  'cd-01': (s) => s.setTapeMode(objs(s)[0]!.id, 12),
  'cd-02': (s) => { for (const o of objs(s)) s.setTapeMode(o.id, 12); },
  'cd-02#c2': (s) => { for (const o of objs(s)) s.setTapeMode(o.id, 12); },
  'cd-02#b': (s) => s.setTapeMode(tapeByMode(s, 3).id, 6),
  'cd-03': (s) => {
    const t = objs(s)[0]!;
    s.setTapeStrict(t.id, false);
    s.setTapeMode(t.id, 7);
  },

  'imp-01': (s) => s.cutTape(objs(s)[0]!.id, 7),
  'imp-02': (s) => s.cutTape(objs(s)[0]!.id, 5),
  'imp-02#c1': (s) => s.cutTape(objs(s)[0]!.id, 7),
  'imp-02#b': (s) => s.cutTape(objs(s)[0]!.id, 3),

  'conv-01': (s) => { hammer(s, 'mul'); hammer(s, 'add'); },
  'conv-02': (s) => { hammer(s, 'add'); hammer(s, 'mul'); },
  'conv-02#b': (s) => { hammer(s, 'mul'); s.applyTool(tool(s, 'mul', 1).id, objs(s)[0]!.id); },
  // вернуть исходную восьмёрку после ×0 можно только отменой — реверс заклинил
  'conv-03': (s) => { hammer(s, 'mul'); s.undo(); },

  'fn-01': (s) => { const o = s.spawnObject(R(5)); s.applyTool(tool(s, 'mul').id, o.id); },
  'fn-02': (s) => s.applyInverse(tool(s, 'mul').id, objs(s)[0]!.id),
  'fn-02#c0': (s) => hammer(s, 'mul'),
  'fn-02#c2': (s) => hammer(s, 'mul'),
  'fn-02#b': (s) => hammer(s, 'div'),

  'pow-01': (s) => hammer(s, 'sq'),
  'pow-02': (s) => hammer(s, 'sq'),
  'pow-03': (s) => hammer(s, 'sqrt'),
  'pow-03#c0': (s) => hammer(s, 'sqrt'),
  'pow-03#b': (s) => hammer(s, 'sqrt'),

  'percent-01': (s) => hammer(s, 'mul'),
  'percent-01#c0': (s) => hammer(s, 'sub'),
  'percent-01#c1': (s) => hammer(s, 'div'),
  'percent-01#b': (s) => hammer(s, 'mul'),
  'percent-02': (s) => { hammer(s, 'mul'); s.applyTool(tool(s, 'mul', 1).id, objs(s)[0]!.id); },

  'eq-01': (s) => {
    const u = objs(s).find((o) => o.kind === 'unknown')!;
    for (const op of ['sub', 'div'] as const) {
      s.scalesApply(u.id, tool(s, op).id, 'left');
      s.scalesApply(u.id, tool(s, op).id, 'right');
    }
  },
  'eq-02': (s) => {
    const u = objs(s).find((o) => o.kind === 'unknown')!;
    for (const op of ['add', 'div'] as const) {
      s.scalesApply(u.id, tool(s, op).id, 'left');
      s.scalesApply(u.id, tool(s, op).id, 'right');
    }
  },
  'eq-03': (s) => {
    const u = objs(s).find((o) => o.kind === 'unknown')!;
    s.scalesApply(u.id, tool(s, 'div').id, 'left');
    s.scalesApply(u.id, tool(s, 'div').id, 'right');
  },

  'ar-01': (s) => s.setRectSize(objs(s)[0]!.id, R(5), R(4), true),
  'ar-02': (s) => s.setRectSize(objs(s)[0]!.id, R(6), R(2), true),
  'ar-03': (s) => s.cutRect(objs(s)[0]!.id, 'x', R(3)),
  'ar-04': (s) => s.cutRect(objs(s)[0]!.id, 'x', R(5)),
  'ar-05': (s) => { const r = objs(s)[0]!; s.cutRect(r.id, 'x', R(4)); s.cutRect(r.id, 'y', R(4)); },
  'ar-05#c0': (s) => { const r = objs(s)[0]!; s.mergeRect(r.id, 'x', R(4)); s.mergeRect(r.id, 'y', R(4)); },
  'ar-05#c2': (s) => { const r = objs(s)[0]!; s.mergeRect(r.id, 'x', R(4)); s.mergeRect(r.id, 'y', R(4)); },
  'ar-06': (s) => { const r = objs(s)[0]!; s.cutRect(r.id, 'x', R(10)); s.cutRect(r.id, 'y', R(10)); },

  'sq-01': (s) => hammer(s, 'sq'),
  'sq-01#c0': (s) => hammer(s, 'sq'),
  'sq-01#c2': (s) => hammer(s, 'sq'),
  'sq-01#c3': (s) => hammer(s, 'sq'),
  'sq-01#b': (s) => hammer(s, 'sq'),

  'fa-01': (s) => { const t = objs(s)[0]!; s.cutTape(t.id, 3); s.cutTape(t.id, 5); },
  'fa-02': (s) => { const t = objs(s)[0]!; s.cutTape(t.id, 3); s.cutTape(t.id, 5); },
  'fa-02#c0': (s) => s.cutTape(tapeByMode(s, 5).id, 2),
  'fa-02#b': (s) => { const t = objs(s)[0]!; s.cutTape(t.id, 3); s.cutTape(t.id, 7); },

  'abs-01': (s) => hammer(s, 'abs'),
  'abs-01#b': (s) => hammer(s, 'abs'),
  'abs-02': (s) => hammer(s, 'abs'),

  'var-01': (s) => s.setVariableValue(objs(s)[0]!.id, R(-3), true),
  'var-01#b': (s) => s.setVariableValue(objs(s)[0]!.id, R(1, 2), true),
  'var-02': (s) => {
    s.setVariableValue(objs(s)[0]!.id, R(4), true);
    hammer(s, 'mul');
  },

  'cmb-01': (s) => {
    const combo = s.addComposite([{ op: 'add', n: R(60) }, { op: 'sub', n: R(1) }], '+59');
    s.applyTool(combo.id, objs(s)[0]!.id);
  },
  'cmb-02': (s) => {
    const combo = s.addComposite([{ op: 'mul', n: R(17, 20) }, { op: 'mul', n: R(23, 20) }], '');
    s.applyTool(combo.id, objs(s)[0]!.id);
  },
  'cmb-02#c2': (s) => { hammer(s, 'mul'); s.applyTool(tool(s, 'mul', 1).id, objs(s)[0]!.id); },

  'pz-01': (s) => hammer(s, 'pow'),
  'pz-01#c0': (s) => hammer(s, 'pow'),
  'pz-01#c1': (s) => hammer(s, 'pow'),
  // обстрел: перевернуть двойку молотком x⁻¹ (второй pow), ноль не трогать
  'pz-01#b': (s) => {
    const two = objs(s).find((o) => o.kind === 'number' && o.value.equals(R(2)))!;
    s.applyTool(tool(s, 'pow', 1).id, two.id);
  },
  'pz-02': (s) => hammer(s, 'pow'),

  'mn-01': (s) => hammer(s, 'mul'),
  'mn-02': (s) => hammer(s, 'mul'),
  'mn-02#c0': (s) => hammer(s, 'mul'),
  'mn-02#c1': (s) => hammer(s, 'mul'),
  'mn-02#b': (s) => hammer(s, 'mul'),

  'md-01': (s) => hammer(s, 'mul'),
  'md-02': (s) => hammer(s, 'div'),
  'md-02#c0': (s) => hammer(s, 'mul'),
  'md-02#c2': (s) => hammer(s, 'div'),
  // обстрел: ×1 и ÷1 нейтральны, капкан — второй mul (×0)
  'md-02#b': (s) => { hammer(s, 'mul'); s.applyTool(tool(s, 'mul', 1).id, objs(s)[0]!.id); },

  'bb-01': (s) => hammer(s, 'mul'),
  'bb-02': (s) => { hammer(s, 'add'); hammer(s, 'mul'); },
  'bb-02#c0': (s) => hammer(s, 'add'),
  'bb-02#c2': (s) => hammer(s, 'mul'),

  'pr-01': (s) => s.applyInverse(tool(s, 'mul').id, objs(s)[0]!.id),
  'pr-01#c0': (s) => hammer(s, 'mul'),
  'pr-01#c2': (s) => s.applyInverse(tool(s, 'mul').id, objs(s)[0]!.id),
  'pr-02': (s) => { hammer(s, 'div'); hammer(s, 'mul'); },

  'eq2-01': (s) => eqBoth(s, 'subx'),
  'eq2-02': (s) => { eqBoth(s, 'subx'); eqBoth(s, 'sub'); },
  'eq2-02#c0': (s) => eqBoth(s, 'add'),
  'eq2-02#c2': (s) => eqBoth(s, 'subx'),
  'eq2-02#b': (s) => eqBoth(s, 'subx'),
  'eq2-03': (s) => eqBoth(s, 'mul'),
  'eq2-04': (s) => eqBoth(s, 'mul'),
};

/** Удар молотком по обеим чашам уравнения (весы качаются — равновесие держим сами). */
function eqBoth(s: Session, op: string): void {
  const eq = objs(s).find((o) => o.kind === 'equation')!;
  s.equationApply(eq.id, tool(s, op).id, 'left');
  s.equationApply(eq.id, tool(s, op).id, 'right');
}

/** Цели, совпадающие со стартом сознательно (conv-03: «верни как было»). */
const SELF_SATISFIED_OK = new Set(['conv-03']);

describe('учебник: главы и ссылки', () => {
  it('файлы всех глав существуют', () => {
    for (const ch of manifest.chapters) {
      expect(fs.existsSync(path.join(TB, ch.file)), ch.file).toBe(true);
    }
  });

  it('каждая кнопка data-exercise ведёт на существующий JSON, сирот нет', () => {
    const referenced = new Set<string>();
    for (const ch of manifest.chapters) {
      const html = fs.readFileSync(path.join(TB, ch.file), 'utf8');
      for (const m of html.matchAll(/data-exercise="([^"]+)"/g)) referenced.add(m[1]!);
    }
    for (const id of referenced) expect(specs.has(id), `нет файла ${id}.json`).toBe(true);
    for (const id of specs.keys()) expect(referenced.has(id), `упражнение-сирота ${id}`).toBe(true);
  });
});

describe('упражнения: импорт, цели, решаемость', () => {
  for (const [id, spec] of specs) {
    it(id, () => {
      expect(spec.id).toBe(id);
      const s = fresh(spec.board);
      if (!SELF_SATISFIED_OK.has(id)) {
        expect(checkGoal(s, spec.goal), 'цель самовыполнена при загрузке').toBe(false);
      }
      const solve = SOLVERS[id];
      expect(solve, `нет решателя для ${id}`).toBeDefined();
      solve!(s);
      expect(checkGoal(s, spec.goal), 'решение не достигает цели').toBe(true);
    });
  }
});

describe('чекпоинты: структура, контрпримеры, обстрелы', () => {
  const withCheckpoints = [...specs.values()].filter((s) => s.checkpoint);

  it('чекпоинты есть (волны 999 не потерялись)', () => {
    expect(withCheckpoints.length).toBeGreaterThanOrEqual(11);
  });

  for (const spec of withCheckpoints) {
    const cp = spec.checkpoint!;
    it(`${spec.id}: один верный вариант, у дистракторов диагнозы`, () => {
      expect(cp.options.filter((o) => o.correct).length).toBe(1);
      for (const o of cp.options.filter((o) => !o.correct)) {
        expect(o.diagnosis, `дистрактор «${o.text}» без диагноза`).toBeTruthy();
      }
    });

    for (const [i, opt] of cp.options.entries()) {
      if (!opt.counter) continue;
      it(`${spec.id} контрпример №${i}`, () => {
        const s = fresh(opt.counter!.board);
        const goal = opt.counter!.goal as GoalSpec | undefined;
        if (!goal) return; // без цели гасится первым ходом/отказом — импорта достаточно
        expect(checkGoal(s, goal), 'самовыполнен').toBe(false);
        const solve = SOLVERS[`${spec.id}#c${i}`];
        expect(solve, `нет решателя ${spec.id}#c${i}`).toBeDefined();
        solve!(s);
        expect(checkGoal(s, goal), 'не решается').toBe(true);
      });
    }

    if (spec.boundary) {
      it(`${spec.id} обстрел границ`, () => {
        const s = fresh(spec.boundary!.board);
        expect(checkGoal(s, spec.boundary!.goal), 'самовыполнен').toBe(false);
        const solve = SOLVERS[`${spec.id}#b`];
        expect(solve, `нет решателя ${spec.id}#b`).toBeDefined();
        solve!(s);
        expect(checkGoal(s, spec.boundary!.goal), 'не решается').toBe(true);
      });
    }
  }
});
