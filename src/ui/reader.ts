import { Session } from '../core/session';
import { BoardJson, importBoardData } from '../core/serialize';
import { GoalSpec, checkGoal } from '../core/goal';
import { icon } from './icons';

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
}

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
  private done = false;
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
      if (!this.active || this.done) return;
      if (e.kind === 'tool-applied' || e.kind === 'scales-step' || e.kind === 'tape-changed') {
        this.steps++;
      }
      if (checkGoal(deps.session, this.active.goal)) {
        this.done = true;
        deps.say(`🎉 Задание «${this.active.id}» выполнено за ${this.steps} ход(а)!`);
      }
      this.renderPanel();
    });
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
      this.manifest = (await (await fetch('/textbook/manifest.json')).json()) as Manifest;
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
      const html = await (await fetch(`/textbook/${file}`)).text();
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
      const spec = (await (await fetch(`/textbook/exercises/${id}.json`)).json()) as ExerciseSpec;
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
    this.done = false;
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
    const status = document.getElementById('task-status')!;
    status.innerHTML = icon(this.done ? 'check' : 'target', 17);
    status.style.color = this.done ? 'var(--accent)' : 'var(--text-secondary)';
    document.getElementById('task-text')!.textContent = this.active.task;
    const stepsEl = document.getElementById('task-steps')!;
    const limit = this.active.maxSteps ? ` из ${this.active.maxSteps}` : '';
    stepsEl.textContent = this.steps > 0 || this.active.maxSteps ? `ходы: ${this.steps}${limit}` : '';
    this.panel.classList.toggle('done', this.done);
  }
}
