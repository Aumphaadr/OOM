/**
 * Копилка диагнозов (методика 999): каждый выбранный дистрактор — это
 * ложный инструмент, которым ученик бьёт на самом деле. Не отметка,
 * а план лечения. Хранение — localStorage, показ — карта в дропдауне истории.
 */

const KEY = 'oom-diagnoses-v1';

export interface DiagnosisEntry {
  when: string;        // ISO-дата
  exerciseId: string;
  diagnosis: string;   // «подменяет x² на ×10»
}

function loadAll(): DiagnosisEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DiagnosisEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordDiagnosis(exerciseId: string, diagnosis: string): void {
  const all = loadAll();
  all.push({ when: new Date().toISOString(), exerciseId, diagnosis });
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* переполненное хранилище не должно ронять занятие */
  }
}

/** Сводка для преподавателя: «подменяет x² на ×10 — 2 раза (sq-01)». */
export function diagnosisSummary(): string[] {
  const grouped = new Map<string, { count: number; exercises: Set<string> }>();
  for (const d of loadAll()) {
    const g = grouped.get(d.diagnosis) ?? { count: 0, exercises: new Set<string>() };
    g.count++;
    g.exercises.add(d.exerciseId);
    grouped.set(d.diagnosis, g);
  }
  return [...grouped.entries()].map(
    ([diag, g]) => `${diag} — ${g.count} раз(а) (${[...g.exercises].join(', ')})`,
  );
}
