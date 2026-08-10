import { describe, it, expect, beforeEach } from 'vitest';
import { recordDiagnosis, diagnosisSummary, diagnosisReport, clearDiagnoses } from '../src/ui/diagnoses';

describe('копилка диагнозов', () => {
  beforeEach(() => localStorage.clear());

  it('записывает, группирует, выгружает и стирает', () => {
    expect(diagnosisSummary()).toEqual([]);
    expect(diagnosisReport()).toBe('Карта диагнозов пуста.');

    recordDiagnosis('sq-01', 'подменяет x² на ×10');
    recordDiagnosis('sq-01', 'подменяет x² на ×10');
    recordDiagnosis('fa-02', 'складывает числители и знаменатели по отдельности');

    const summary = diagnosisSummary();
    expect(summary.length).toBe(2);
    expect(summary[0]).toContain('2 раз(а)');
    expect(summary[0]).toContain('sq-01');

    const report = diagnosisReport();
    expect(report).toContain('Сводка:');
    expect(report).toContain('Журнал:');
    expect(report).toContain('fa-02: складывает числители');

    clearDiagnoses();
    expect(diagnosisSummary()).toEqual([]);
  });

  it('переживает битый localStorage', () => {
    localStorage.setItem('oom-diagnoses-v1', 'не json');
    expect(diagnosisSummary()).toEqual([]);
    recordDiagnosis('x', 'y'); // не бросает
  });
});
