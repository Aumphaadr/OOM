/**
 * Интеграционный прогон автомата чекпоинтов (методика 999) через настоящий DOM:
 * эксперимент → чекпоинт → контрпример → возврат с погашенным вариантом →
 * верный ответ → обстрел границ → готово. Плюс копилка диагнозов.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { R } from '../src/core/rational';
import { Session } from '../src/core/session';
import { Reader, ExerciseSpec } from '../src/ui/reader';

const sqSpec = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../public/textbook/exercises/sq-01.json'), 'utf8'),
) as ExerciseSpec;

/** Куски index.html, которые трогает Reader. */
const DOM = `
  <button id="btn-reader"></button>
  <button id="edge-reader"></button>
  <aside id="reader" hidden><div id="reader-body"></div></aside>
  <div id="task-panel" class="task-panel" hidden>
    <span id="task-status"></span>
    <span id="task-steps"></span>
    <button id="task-hint"></button>
    <button id="task-reset"></button>
    <button id="task-close"></button>
    <p id="task-text"></p>
    <div id="task-options" hidden></div>
    <p id="task-hint-text" hidden></p>
  </div>`;

function setup() {
  document.body.innerHTML = DOM;
  localStorage.clear();
  const session = new Session();
  const said: string[] = [];
  const reader = new Reader({
    session,
    openScene: () => {},
    say: (t) => said.push(t),
    setConstruct: () => {},
  });
  return { session, reader, said };
}

const options = () =>
  [...document.querySelectorAll<HTMLButtonElement>('#task-options button')];
const taskText = () => document.getElementById('task-text')!.textContent ?? '';
const panelDone = () => document.getElementById('task-panel')!.classList.contains('done');

/** Ударить единственным молотком по всем числам. */
function hammerAll(session: Session): void {
  const tool = [...session.tools.values()][0]!;
  for (const o of [...session.objects.values()]) {
    if (o.kind === 'number') session.applyTool(tool.id, o.id);
  }
}

describe('автомат чекпоинтов', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('полный цикл 999 на sq-01', async () => {
    const { session, reader } = setup();
    await (reader as unknown as { start(s: ExerciseSpec): Promise<void> }).start(sqSpec);

    // эксперимент: панель видна, варианты спрятаны
    expect(document.getElementById('task-panel')!.hidden).toBe(false);
    expect(document.getElementById('task-options')!.hidden).toBe(true);
    expect(taskText()).toBe(sqSpec.task);

    // цель достигнута → чекпоинт с четырьмя вариантами
    hammerAll(session);
    expect(taskText()).toBe(sqSpec.checkpoint!.question);
    expect(options().length).toBe(4);
    expect(panelDone()).toBe(false);

    // дистрактор «×2» → контрпример: доска заменилась на фишку 7
    options()[0]!.click();
    expect(taskText()).toContain('7²');
    const nums = [...session.objects.values()].filter((o) => o.kind === 'number');
    expect(nums.length).toBe(1);
    expect(nums[0]!.value.toDisplay()).toBe('7');

    // удар ломает вывод → возврат к вопросу, вариант погашен
    hammerAll(session);
    expect(taskText()).toBe(sqSpec.checkpoint!.question);
    expect(options()[0]!.disabled).toBe(true);
    expect(options()[0]!.textContent).toContain('✗');
    expect(options()[1]!.disabled).toBe(false);

    // диагноз записан в копилку
    const diags = JSON.parse(localStorage.getItem('oom-diagnoses-v1')!) as {
      exerciseId: string; diagnosis: string;
    }[];
    expect(diags.length).toBe(1);
    expect(diags[0]!.exerciseId).toBe('sq-01');
    expect(diags[0]!.diagnosis).toContain('×2');

    // верный ответ → обстрел границ (0, 1, −3, 1/2)
    options()[1]!.click();
    expect(taskText()).toBe(sqSpec.boundary!.prompt);
    expect([...session.objects.values()].length).toBe(4);
    expect(panelDone()).toBe(false);

    // обстрел пережит → готово
    hammerAll(session);
    expect(panelDone()).toBe(true);
  });

  it('загрузка контрпримера не гасит вариант сама (защита от самосчёта)', async () => {
    const { session, reader } = setup();
    await (reader as unknown as { start(s: ExerciseSpec): Promise<void> }).start(sqSpec);
    hammerAll(session);
    options()[3]!.click(); // «приписывает 2 слева» — контрпример с фишкой 13
    // сразу после загрузки вариант ещё не погашен и панель не «готово»
    expect(panelDone()).toBe(false);
    // вернуться нельзя без действия: варианты скрыты, идёт контрпример
    expect(document.getElementById('task-options')!.hidden).toBe(true);
  });

  it('упражнение без чекпоинта завершается по-старому', async () => {
    const { session, reader } = setup();
    const plain: ExerciseSpec = {
      id: 'plain',
      task: 'Получи 10',
      scene: 'boxes',
      board: {
        v: 1,
        tools: [{ op: 'add', n: '3/1', hidden: false }],
        objects: [{ kind: 'number', trail: ['7/1'], scenePos: {} }],
      } as ExerciseSpec['board'],
      goal: { kind: 'any-object-value', value: '10' },
    };
    await (reader as unknown as { start(s: ExerciseSpec): Promise<void> }).start(plain);
    hammerAll(session);
    expect(panelDone()).toBe(true);
    expect(document.getElementById('task-options')!.hidden).toBe(true);
  });

  it('«Начать заново» перезапускает цепочку с эксперимента', async () => {
    const { session, reader } = setup();
    await (reader as unknown as { start(s: ExerciseSpec): Promise<void> }).start(sqSpec);
    hammerAll(session);
    options()[0]!.click();
    hammerAll(session); // вариант 0 погашен
    expect(options()[0]!.disabled).toBe(true);

    document.getElementById('task-reset')!.click();
    expect(taskText()).toBe(sqSpec.task);
    // после перезапуска доска снова стартовая, погашенных вариантов нет
    hammerAll(session);
    expect(options().every((b) => !b.disabled)).toBe(true);
  });

  it('неудар (отказ инструмента) тоже гасит контрпример', async () => {
    const { session, reader } = setup();
    const spec: ExerciseSpec = {
      id: 'ref',
      task: 'Ударь √ по 49',
      scene: 'boxes',
      board: {
        v: 1,
        tools: [{ op: 'sqrt', n: '0/1', hidden: false }],
        objects: [{ kind: 'number', trail: ['49/1'], scenePos: {} }],
      } as ExerciseSpec['board'],
      goal: { kind: 'any-object-value', value: '7' },
      checkpoint: {
        question: 'Из чего берётся корень?',
        options: [
          { text: 'Из чего угодно', diagnosis: 'не знает области √',
            counter: {
              prompt: 'Проверь на −9',
              board: {
                v: 1,
                tools: [{ op: 'sqrt', n: '0/1', hidden: false }],
                objects: [{ kind: 'number', trail: ['-9/1'], scenePos: {} }],
              } as ExerciseSpec['board'],
            } },
          { text: 'Только из неотрицательных', correct: true },
        ],
      },
    };
    await (reader as unknown as { start(s: ExerciseSpec): Promise<void> }).start(spec);
    hammerAll(session);
    options()[0]!.click();
    hammerAll(session); // √(−9) — отказ, но контрпример предъявлен
    expect(options()[0]!.disabled).toBe(true);
    // и значение фишки не изменилось — отказ честный
    const n = [...session.objects.values()].find((o) => o.kind === 'number')!;
    expect(n.value.equals(R(-9))).toBe(true);
  });
});
