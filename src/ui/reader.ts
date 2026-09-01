import { Session } from '../core/session';
import { BoardJson, importBoardData } from '../core/serialize';
import { GoalSpec, checkGoal } from '../core/goal';
import { Rational } from '../core/rational';
import { icon } from './icons';
import { recordDiagnosis } from './diagnoses';

/** Вариант вывода в чекпоинте (методика 999, docs/design-checkpoints.md). */
export interface CheckpointOption {
  text: string;              // «возвести в квадрат — умножить число на само себя»
  correct?: boolean;         // ровно один вариант — true
  /** Диагноз для карты пробелов: каким ложным инструментом бьёт ученик. */
  diagnosis?: string;        // «подменяет x² на ×2»
  /** Контрпример: доска, на которой ложный вывод даёт расхождение. */
  counter?: {
    prompt: string;          // «Если x² — это ×2, то 7² = 14. Проверь ударом»
    board: BoardJson;
    goal?: GoalSpec;         // без цели — засчитывается первый же ход
  };
}

export interface CheckpointSpec {
  question: string;          // «Что ты заметил?»
  options: CheckpointOption[];
}

/** Обстрел границ: опасные объекты (0, 1, отрицательные, дроби 0..1). */
export interface BoundarySpec {
  prompt: string;
  board: BoardJson;
  goal: GoalSpec;
}

/** Упражнение: заготовленная доска + задание + цель. */
export interface ExerciseSpec {
  id: string;
  task: string;
  scene: string;
  board: BoardJson;
  goal: GoalSpec;
  hints?: string[];
  maxSteps?: number;
  /**
   * Разрешить конструирование (создание/удаление молотков и объектов).
   * По умолчанию false: упражнение — головоломка из данных блоков,
   * иначе «Точно в ноль» решается созданием молотка «+3» или числа 0.
   */
  allowConstruct?: boolean;
  /** Чекпоинт-вывод после цели: без него поведение прежнее (сразу «готово»). */
  checkpoint?: CheckpointSpec;
  /** Обстрел границ после верного вывода. */
  boundary?: BoundarySpec;
}

/** Фазы цикла 999: эксперимент → чекпоинт → (контрпример) → обстрел → готово. */
type Phase = 'experiment' | 'checkpoint' | 'counter' | 'boundary' | 'done';

interface Manifest {
  chapters: { id: string; title: string; file: string }[];
}

interface ReaderDeps {
  session: Session;
  openScene(id: string): void;
  say(text: string): void;
  setConstruct(on: boolean): void;
}

/**
 * Читалка учебника (колонка текста) + плеер упражнений (панель «Задание»).
 * Контент — статика в /textbook: manifest.json, главы HTML, упражнения JSON.
 * Цель проверяется по журналу сессии после каждого события.
 */
export class Reader {
  private manifest: Manifest | null = null;
  private active: ExerciseSpec | null = null;
  private phase: Phase = 'experiment';
  /** Индексы дистракторов, проверенных контрпримером и погашенных. */
  private readonly broken = new Set<number>();
  /** Какой вариант сейчас проверяется контрпримером. */
  private counterOf: number | null = null;
  /** Идёт importBoardData: события журнала не считаем и цели не проверяем. */
  private loading = false;
  /** Пристрелка: «перелёт»/«недолёт» после хода мимо числовой цели. */
  private aim: 'over' | 'under' | null = null;
  private steps = 0;
  private hintIndex = 0;

  private readonly aside = document.getElementById('reader')!;
  private readonly body = document.getElementById('reader-body')!;
  private readonly panel = document.getElementById('task-panel')!;

  constructor(private readonly deps: ReaderDeps) {
    document.getElementById('btn-reader')!.addEventListener('click', () => this.toggle());
    const edge = document.getElementById('edge-reader')!;
    edge.innerHTML = icon('chevron-left', 18);
    edge.addEventListener('click', () => this.toggle());
    document.getElementById('task-hint')!.addEventListener('click', () => this.showHint());
    document.getElementById('task-reset')!.addEventListener('click', () => {
      if (this.active) void this.start(this.active);
    });
    document.getElementById('task-close')!.addEventListener('click', () => this.closeExercise());

    deps.session.on((e) => {
      if (!this.active || this.loading || this.phase === 'done' || this.phase === 'checkpoint') return;
      const counted =
        (e.kind === 'tool-applied' || e.kind === 'scales-step' || e.kind === 'equation-step' ||
          e.kind === 'tape-changed' || e.kind === 'rect-changed' || e.kind === 'var-set' ||
          e.kind === 'point-moved' || e.kind === 'vector-changed' || e.kind === 'cuboid-changed' ||
          e.kind === 'transfer' || e.kind === 'angle-set' || e.kind === 'function-changed' ||
          e.kind === 'polygon-changed' || e.kind === 'circle-changed') &&
        !((e.kind === 'scales-step' || e.kind === 'equation-step') && e.neutral); // нейтральный удар — не ход

      if (this.phase === 'experiment') {
        if (counted) this.steps++;
        this.updateAim(e, this.active.goal);
        if (checkGoal(deps.session, this.active.goal)) {
          if (this.active.checkpoint) {
            this.phase = 'checkpoint';
            deps.say('🎯 Сделано. Теперь главный вопрос — что ты заметил?');
          } else {
            this.phase = 'done';
            deps.say(`🎉 Задание «${this.active.id}» выполнено за ${this.steps} ход(а)!`);
          }
        }
      } else if (this.phase === 'counter' && this.counterOf !== null &&
                 (counted || e.kind === 'tool-rejected' || e.kind === 'tape-refused' ||
                  e.kind === 'function-refused')) {
        // Контрпример считается предъявленным, когда его цель достигнута
        // (или после первого же хода/отказа, если цели нет): отказ инструмента
        // или линейки — тоже опровержение («√ из −9», «линейка /10 к резу 1/4»).
        const goal = this.active.checkpoint!.options[this.counterOf]!.counter?.goal;
        if (!goal || checkGoal(deps.session, goal)) {
          this.broken.add(this.counterOf);
          this.counterOf = null;
          this.phase = 'checkpoint';
          deps.say('💥 Молоток показал другое — вывод не подтвердился. Вернёмся к вопросу.');
        }
      } else if (this.phase === 'boundary') {
        this.updateAim(e, this.active.boundary!.goal);
        if (checkGoal(deps.session, this.active.boundary!.goal)) {
          this.phase = 'done';
          deps.say(`🎉 Вывод пережил обстрел границ — задание «${this.active.id}» выполнено!`);
        }
      }
      this.renderPanel();
    });
  }

  /**
   * Пристрелка: если цель — «получи число N», после удара честно докладываем
   * сторону промаха. Молчание панели превращается в «перелёт»/«недолёт» —
   * и любое числовое упражнение становится вилкой.
   */
  private updateAim(e: { kind: string }, goal: GoalSpec): void {
    if (goal.kind !== 'any-object-value') return;
    const target = Rational.parse(goal.value);
    if (!target) return;
    const ev = e as { kind: string; after?: Rational; object?: { kind: string; value?: Rational } };
    const value = ev.kind === 'tool-applied'
      ? ev.after
      : ev.kind === 'var-set' && ev.object?.kind === 'number'
        ? ev.object.value
        : undefined;
    if (!value) return;
    const cmp = value.compare(target);
    this.aim = cmp > 0 ? 'over' : cmp < 0 ? 'under' : null;
  }

  /** Загрузка доски посреди упражнения (контрпример, обстрел) без самосчёта цели. */
  private loadBoard(board: BoardJson): void {
    this.loading = true;
    importBoardData(this.deps.session, board);
    this.loading = false;
  }

  /** Клик по варианту вывода в чекпоинте. */
  private choose(i: number): void {
    const spec = this.active;
    const cp = spec?.checkpoint;
    if (!spec || !cp || this.phase !== 'checkpoint' || this.broken.has(i)) return;
    const opt = cp.options[i]!;

    this.aim = null;
    if (opt.correct) {
      if (spec.boundary) {
        this.phase = 'boundary';
        this.loadBoard(spec.boundary.board);
        this.deps.say('✅ Похоже на правду. Но выдержит ли вывод обстрел границ?');
      } else {
        this.phase = 'done';
        this.deps.say(`🎉 Вывод верный — задание «${spec.id}» выполнено!`);
      }
    } else {
      // Дистрактор не карается, а проверяется: диагноз — в копилку, вывод — на доску
      if (opt.diagnosis) recordDiagnosis(spec.id, opt.diagnosis);
      if (opt.counter) {
        this.counterOf = i;
        this.phase = 'counter';
        this.loadBoard(opt.counter.board);
        this.deps.say('🧪 Может показаться, что так. Проверим ударом.');
      } else {
        this.broken.add(i);
      }
    }
    this.renderPanel();
  }

  private toggle(): void {
    this.aside.hidden = !this.aside.hidden;
    document.getElementById('edge-reader')!.innerHTML =
      icon(this.aside.hidden ? 'chevron-left' : 'chevron-right', 18);
    if (!this.aside.hidden && !this.manifest) void this.loadManifest();
  }

  // ---------- учебник ----------

  private async loadManifest(): Promise<void> {
    try {
      this.manifest = (await (await fetch('textbook/manifest.json')).json()) as Manifest;
      this.renderToc();
    } catch {
      this.body.innerHTML = '<p class="hint">Не удалось загрузить учебник.</p>';
    }
  }

  private renderToc(): void {
    if (!this.manifest) return;
    this.body.innerHTML = `<h2><span class="ic">${icon('book', 18)}</span>Учебник</h2>`;
    for (const ch of this.manifest.chapters) {
      const b = document.createElement('button');
      b.className = 'chapter-link';
      b.textContent = ch.title;
      b.addEventListener('click', () => void this.openChapter(ch.file));
      this.body.appendChild(b);
    }
  }

  private async openChapter(file: string): Promise<void> {
    try {
      const html = await (await fetch(`textbook/${file}`)).text();
      this.body.innerHTML = '';
      const back = document.createElement('button');
      back.className = 'chapter-link back';
      back.innerHTML = `<span class="ic">${icon('chevron-left', 12)}</span>Оглавление`;
      back.addEventListener('click', () => this.renderToc());
      this.body.appendChild(back);
      const content = document.createElement('div');
      content.innerHTML = html;
      this.body.appendChild(content);
      this.body.scrollTop = 0;

      content.querySelectorAll<HTMLElement>('[data-exercise]').forEach((el) => {
        el.insertAdjacentHTML('afterbegin', `<span class="ic">${icon('play', 12)}</span>`);
        el.addEventListener('click', () => void this.loadExercise(el.dataset.exercise!));
      });
    } catch {
      this.deps.say('Не удалось загрузить главу.');
    }
  }

  // ---------- упражнения ----------

  private async loadExercise(id: string): Promise<void> {
    try {
      const spec = (await (await fetch(`textbook/exercises/${id}.json`)).json()) as ExerciseSpec;
      await this.start(spec);
    } catch {
      this.deps.say(`Не удалось загрузить упражнение «${id}».`);
    }
  }

  private start(spec: ExerciseSpec): Promise<void> {
    // На время загрузки доски глушим слежение за целью: иначе задание,
    // чья цель совпадает со стартовым состоянием, «выполнится» само
    this.active = null;
    importBoardData(this.deps.session, spec.board);
    this.active = spec;
    this.phase = 'experiment';
    this.broken.clear();
    this.counterOf = null;
    this.aim = null;
    this.steps = 0;
    this.hintIndex = 0;
    this.deps.setConstruct(spec.allowConstruct ?? false);
    this.deps.openScene(spec.scene);
    this.panel.hidden = false;
    document.getElementById('task-hint-text')!.hidden = true;
    this.renderPanel();
    this.deps.say(`🎯 Задание: ${spec.task}`);
    return Promise.resolve();
  }

  private closeExercise(): void {
    this.active = null;
    this.panel.hidden = true;
    this.deps.setConstruct(true); // свободная доска снова открыта
  }

  /** Внешнее прерывание (загрузка урока/сохранения поверх упражнения). */
  abandon(): void {
    if (this.active) this.closeExercise();
  }

  private showHint(): void {
    const hints = this.active?.hints;
    const el = document.getElementById('task-hint-text')!;
    if (!hints?.length) {
      el.textContent = 'Подсказок к этому заданию нет.';
    } else {
      el.textContent = '💡 ' + hints[this.hintIndex % hints.length]!;
      this.hintIndex++;
    }
    el.hidden = false;
  }

  private renderPanel(): void {
    if (!this.active) return;
    const done = this.phase === 'done';
    const status = document.getElementById('task-status')!;
    status.innerHTML = icon(done ? 'check' : 'target', 17);
    status.style.color = done ? 'var(--accent)' : 'var(--text-secondary)';

    const text = document.getElementById('task-text')!;
    const cp = this.active.checkpoint;
    switch (this.phase) {
      case 'checkpoint': text.textContent = cp!.question; break;
      case 'counter': text.textContent = cp!.options[this.counterOf!]!.counter!.prompt; break;
      case 'boundary': text.textContent = this.active.boundary!.prompt; break;
      default: text.textContent = this.active.task;
    }

    const options = document.getElementById('task-options')!;
    options.hidden = this.phase !== 'checkpoint';
    if (this.phase === 'checkpoint' && cp) {
      options.innerHTML = '';
      cp.options.forEach((opt, i) => {
        const b = document.createElement('button');
        const isBroken = this.broken.has(i);
        b.className = 'opt' + (isBroken ? ' opt-broken' : '');
        b.textContent = isBroken ? `✗ ${opt.text}` : opt.text;
        b.disabled = isBroken;
        if (isBroken) b.title = 'Проверено ударом: не подтвердилось';
        else b.addEventListener('click', () => this.choose(i));
        options.appendChild(b);
      });
    }

    const stepsEl = document.getElementById('task-steps')!;
    if (this.phase === 'experiment' || done) {
      const limit = this.active.maxSteps ? ` из ${this.active.maxSteps}` : '';
      stepsEl.textContent = this.steps > 0 || this.active.maxSteps ? `ходы: ${this.steps}${limit}` : '';
    } else {
      stepsEl.textContent = '';
    }

    const aimEl = document.getElementById('task-aim')!;
    if (done || this.aim === null) {
      aimEl.hidden = true;
    } else {
      aimEl.hidden = false;
      aimEl.textContent = this.aim === 'over' ? '↑ перелёт' : '↓ недолёт';
    }
    this.panel.classList.toggle('done', done);
  }
}
