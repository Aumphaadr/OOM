import { Session } from '../core/session';
import { Rational } from '../core/rational';
import { PrimitiveOp } from '../core/model';

/**
 * Урок — декларативные данные, не код: с чем доска начинается и какая сцена
 * открывается. Дальше сюда добавятся чекпоинты лаборатории и последовательности
 * домашки (безопасные → опасные).
 */
export interface LessonSpec {
  id: string;
  title: string;
  /** Сцена, которую открыть при загрузке урока. */
  scene?: string;
  objects?: string[]; // числа в записи, понятной Rational.parse
  tapes?: { len: string; mode: number | null }[];
  tools?: { op: PrimitiveOp; n?: string }[];
}

/** Загрузка урока: доска очищается и наполняется заново. */
export function loadLesson(session: Session, spec: LessonSpec): void {
  session.clearAll();
  for (const t of spec.tools ?? []) {
    const n = t.n ? Rational.parse(t.n) : Rational.of(0);
    if (n) session.addTool(t.op, n);
  }
  for (const v of spec.objects ?? []) {
    const r = Rational.parse(v);
    if (r) session.spawnObject(r);
  }
  for (const t of spec.tapes ?? []) {
    const len = Rational.parse(t.len);
    if (len) session.spawnTape(len, t.mode);
  }
  session.resetHistory(); // пресет — не ходы
}
