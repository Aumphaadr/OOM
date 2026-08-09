import { Rational } from './rational';
import { Session } from './session';
import { tapePieceLabels } from './model';

/**
 * Цель упражнения — декларативный предикат над состоянием сессии.
 * Проверяется подписчиком журнала после каждого события: никакой логики в сценах.
 */
export type GoalSpec =
  | { kind: 'unknown-revealed' }                                  // уравнение решено
  | { kind: 'any-object-value'; value: string }                   // получить число N
  | { kind: 'all-values'; check: 'positive' | 'negative' | 'zero' }
  | { kind: 'tape-pieces'; pieces: string[] };                    // лента порезана как надо

export function checkGoal(session: Session, goal: GoalSpec): boolean {
  const objects = [...session.objects.values()];
  switch (goal.kind) {
    case 'unknown-revealed':
      return objects.some((o) => o.kind === 'unknown' && o.revealed);

    case 'any-object-value': {
      const target = Rational.parse(goal.value);
      if (!target) return false;
      return objects.some((o) => o.kind === 'number' && o.value.equals(target));
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
  }
}
