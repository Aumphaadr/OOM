import { Rational } from './rational';
import { Session } from './session';
import { tapePieceLabels, rectPieceAreas, rectPerimeter, linFormText, degMod360, polygonArea, polygonIsSimple } from './model';

/**
 * Цель упражнения — декларативный предикат над состоянием сессии.
 * Проверяется подписчиком журнала после каждого события: никакой логики в сценах.
 */
export type GoalSpec =
  | { kind: 'unknown-revealed' }                                  // уравнение решено
  | { kind: 'any-object-value'; value: string }                   // получить число N
  | { kind: 'values-include'; values: string[] }                  // все перечисленные значения присутствуют
  | { kind: 'all-values'; check: 'positive' | 'negative' | 'zero' }
  | { kind: 'tape-pieces'; pieces: string[] }                     // лента порезана как надо
  | { kind: 'rect-pieces'; areas: string[] }                      // площади кусков (снизу-слева направо)
  | { kind: 'rect-size'; w: string; h: string }                   // фигура доведена до размеров
  | { kind: 'rect-perimeter'; value: string }                     // периметр («забор») равен N
  | { kind: 'point-at'; x: string; y: string }                    // точка стоит по адресу (x; y)
  | { kind: 'points-at'; points: { x: string; y: string }[] }     // каждый адрес занят точкой
  | { kind: 'vector-at'; dx: string; dy: string }                 // есть стрелка с командой (dx; dy)
  | { kind: 'vectors-at'; vectors: { dx: string; dy: string }[] } // каждая команда представлена стрелкой
  | { kind: 'values-equal'; value: string }                       // ВСЕ числа доски сравнялись на N
  | { kind: 'angle-at'; deg: string; anyTurn?: boolean }          // угол доведён до N° (anyTurn — с точностью до оборотов)
  | { kind: 'angles-at'; degs: string[]; anyTurn?: boolean }      // каждый из перечисленных углов представлен
  | { kind: 'cuboid-size'; w: string; d: string; h: string }      // тело доведено до размеров
  | { kind: 'cuboids-size'; sizes: { w: string; d: string; h: string }[] } // каждый размер представлен телом
  | { kind: 'equation-solved' }                                   // весы v2: достигнута форма x = c
  | { kind: 'equation-form'; left: string; right: string }        // весы v2: промежуточная форма
  | { kind: 'polygon-area'; area: string; verts?: number }        // есть ПРОСТАЯ фигура с площадью N (и, если задано, числом вершин)
  | { kind: 'circle-size'; r: string };                           // есть окружность радиуса r

export function checkGoal(session: Session, goal: GoalSpec): boolean {
  const objects = [...session.objects.values()];
  switch (goal.kind) {
    case 'unknown-revealed':
      return objects.some((o) => o.kind === 'unknown' && o.revealed);

    case 'point-at': {
      const x = Rational.parse(goal.x);
      const y = Rational.parse(goal.y);
      if (!x || !y) return false;
      return objects.some((o) => o.kind === 'point' && o.x.equals(x) && o.y.equals(y));
    }

    case 'points-at': {
      return goal.points.every((a) => {
        const x = Rational.parse(a.x);
        const y = Rational.parse(a.y);
        if (!x || !y) return false;
        return objects.some((o) => o.kind === 'point' && o.x.equals(x) && o.y.equals(y));
      });
    }

    case 'vector-at': {
      const dx = Rational.parse(goal.dx);
      const dy = Rational.parse(goal.dy);
      if (!dx || !dy) return false;
      return objects.some((o) => o.kind === 'vector' && o.dx.equals(dx) && o.dy.equals(dy));
    }

    case 'vectors-at': {
      return goal.vectors.every((c) => {
        const dx = Rational.parse(c.dx);
        const dy = Rational.parse(c.dy);
        if (!dx || !dy) return false;
        return objects.some((o) => o.kind === 'vector' && o.dx.equals(dx) && o.dy.equals(dy));
      });
    }

    case 'angle-at': {
      const target = Rational.parse(goal.deg);
      if (!target) return false;
      return objects.some((o) => {
        if (o.kind !== 'angle') return false;
        return goal.anyTurn ? degMod360(o.deg).equals(degMod360(target)) : o.deg.equals(target);
      });
    }

    case 'angles-at': {
      return goal.degs.every((d) => {
        const target = Rational.parse(d);
        if (!target) return false;
        return objects.some((o) => {
          if (o.kind !== 'angle') return false;
          return goal.anyTurn ? degMod360(o.deg).equals(degMod360(target)) : o.deg.equals(target);
        });
      });
    }

    case 'values-equal': {
      const target = Rational.parse(goal.value);
      if (!target) return false;
      const nums = objects.filter((o) => o.kind === 'number');
      return nums.length > 0 && nums.every((o) => o.value.equals(target));
    }

    case 'cuboid-size': {
      const w = Rational.parse(goal.w);
      const d = Rational.parse(goal.d);
      const h = Rational.parse(goal.h);
      if (!w || !d || !h) return false;
      return objects.some((o) => o.kind === 'cuboid' && o.w.equals(w) && o.d.equals(d) && o.h.equals(h));
    }

    case 'cuboids-size': {
      return goal.sizes.every((sz) => {
        const w = Rational.parse(sz.w);
        const d = Rational.parse(sz.d);
        const h = Rational.parse(sz.h);
        if (!w || !d || !h) return false;
        return objects.some((o) => o.kind === 'cuboid' && o.w.equals(w) && o.d.equals(d) && o.h.equals(h));
      });
    }

    case 'equation-solved':
      return objects.some((o) => o.kind === 'equation' && o.solved);

    case 'equation-form': {
      // минусы сравниваем без разницы «−»/«-»: авторы JSON пишут ASCII
      const norm = (s: string) => s.replace(/−/g, '-').replace(/\s+/g, ' ').trim();
      return objects.some((o) =>
        o.kind === 'equation' &&
        norm(linFormText(o.left, o.name)) === norm(goal.left) &&
        norm(linFormText(o.right, o.name)) === norm(goal.right));
    }

    case 'any-object-value': {
      const target = Rational.parse(goal.value);
      if (!target) return false;
      return objects.some((o) => o.kind === 'number' && o.value.equals(target));
    }

    case 'values-include': {
      // «Возведи каждую фишку»: цель — среди чисел есть 49, 64, 81 и 169.
      const targets = goal.values.map((v) => Rational.parse(v));
      if (targets.some((t) => !t)) return false;
      const numbers = objects.filter((o) => o.kind === 'number');
      return targets.every((t) => numbers.some((o) => o.value.equals(t!)));
    }

    case 'all-values': {
      const numbers = objects.filter((o) => o.kind === 'number');
      if (!numbers.length) return false;
      return numbers.every((o) => {
        const s = o.value.sign();
        return goal.check === 'positive' ? s > 0 : goal.check === 'negative' ? s < 0 : s === 0;
      });
    }

    case 'tape-pieces':
      return objects.some((o) => {
        if (o.kind !== 'tape' || o.mode === null) return false;
        const pieces = tapePieceLabels(o);
        return pieces.length === goal.pieces.length && pieces.every((p, i) => p === goal.pieces[i]);
      });

    case 'rect-pieces':
      return objects.some((o) => {
        if (o.kind !== 'rect') return false;
        const areas = rectPieceAreas(o).map((a) => a.toDisplay());
        return areas.length === goal.areas.length && areas.every((a, i) => a === goal.areas[i]);
      });

    case 'rect-perimeter': {
      const target = Rational.parse(goal.value);
      if (!target) return false;
      return objects.some((o) => o.kind === 'rect' && rectPerimeter(o).equals(target));
    }

    case 'polygon-area': {
      const target = Rational.parse(goal.area);
      if (!target) return false;
      return objects.some((o) =>
        o.kind === 'polygon' && polygonIsSimple(o) && polygonArea(o).equals(target) &&
        (goal.verts === undefined || o.vertices.length === goal.verts));
    }

    case 'circle-size': {
      const target = Rational.parse(goal.r);
      if (!target) return false;
      return objects.some((o) => o.kind === 'circle' && o.r.equals(target));
    }

    case 'rect-size': {
      const w = Rational.parse(goal.w);
      const h = Rational.parse(goal.h);
      if (!w || !h) return false;
      return objects.some((o) => o.kind === 'rect' && o.w.equals(w) && o.h.equals(h));
    }
  }
}
