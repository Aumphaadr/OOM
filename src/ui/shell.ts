import { Session } from '../core/session';
import { Rational } from '../core/rational';
import { subtitleFor, visibleLabel, isUnaryOp, toolLabel, PrimitiveOp } from '../core/model';
import { exportBoard, importBoard } from '../core/serialize';
import { CanvasHost } from '../render/canvasHost';
import { Scene, HandState, Restrictions, SceneContext } from '../scenes/scene';
import { LessonSpec, loadLesson } from '../lessons/lesson';
import { Reader } from './reader';
import { icon } from './icons';
import { diagnosisSummary, diagnosisReport, clearDiagnoses } from './diagnoses';

const BOARD_STORAGE_KEY = 'oom-board-v1';

const OP_FROM_SELECT: Record<string, PrimitiveOp> = {
  add: 'add', sub: 'sub', mul: 'mul', div: 'div', pow: 'pow',
  sq: 'sq', cube: 'cube', sqrt: 'sqrt', cbrt: 'cbrt', abs: 'abs',
};

/**
 * Оболочка режима «Доска»: панели, рука, вкладки сцен, субтитры.
 * Всё, что меняет модель, идёт через Session; сцены и субтитры
 * узнают о происходящем из журнала.
 */
export class Shell {
  private readonly hand: HandState = { toolId: null };
  private readonly restrictions: Restrictions = { construct: true };
  private activeScene: Scene | null = null;
  private reader: Reader | null = null;
  private readonly sceneCtx: SceneContext;

  constructor(
    private readonly session: Session,
    private readonly host: CanvasHost,
    private readonly scenes: Scene[],
    private readonly presets: LessonSpec[] = [],
  ) {
    this.sceneCtx = {
      session,
      hand: this.hand,
      restrictions: this.restrictions,
      clipboard: { items: [] },
      hit: (objectId, toolId) => this.hit(objectId, toolId),
      dropHand: () => this.setHand(null),
      takeHand: (toolId) => this.setHand(toolId),
    };

    this.bindPanels();
    this.bindSubtitles();
    this.bindLessons();
    this.bindReader();
    this.renderTools();
    this.renderTabs();

    session.on((e) => {
      if (e.kind === 'tool-added' || e.kind === 'tool-changed') this.renderTools();
      if (e.kind === 'tool-removed') {
        if (this.hand.toolId === e.toolId) this.hand.toolId = null;
        this.renderTools();
      }
    });

    const edgeSidebar = document.getElementById('edge-sidebar')!;
    edgeSidebar.innerHTML = icon('chevron-left', 18);
    const toggleSidebar = () => {
      const sb = document.getElementById('sidebar')!;
      sb.hidden = !sb.hidden;
      edgeSidebar.innerHTML = icon(sb.hidden ? 'chevron-right' : 'chevron-left', 18);
    };
    document.getElementById('btn-sidebar')!.addEventListener('click', toggleSidebar);
    edgeSidebar.addEventListener('click', toggleSidebar);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setHand(null);
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        this.session.undo();
      }
    });

    const first = scenes[0];
    if (first) this.switchScene(first.id);
  }

  // ---------- рука ----------

  private setHand(toolId: string | null): void {
    this.hand.toolId = toolId;
    this.renderTools();
  }

  /** Запереть/открыть конструирование (кузница, спавн, удаление). */
  setConstruct(on: boolean): void {
    this.restrictions.construct = on;
    (document.querySelector('.tool-forge') as HTMLElement).hidden = !on;
    (document.getElementById('spawn-row') as HTMLElement).hidden = !on;
    (document.getElementById('var-row') as HTMLElement).hidden = !on;
    (document.getElementById('spawn-set-btn') as HTMLElement).hidden = !on;
    (document.getElementById('combo-toggle') as HTMLElement).hidden = !on;
    if (!on) (document.getElementById('combo-forge') as HTMLElement).hidden = true;
    this.renderTools();
  }

  private hit(objectId: string, toolId?: string): void {
    const tool = toolId ?? this.hand.toolId;
    if (!tool) return;
    const ok = this.session.applyTool(tool, objectId);
    if (ok && navigator.vibrate) navigator.vibrate(50);
  }

  // ---------- сцены ----------

  private switchScene(id: string): void {
    const next = this.scenes.find((s) => s.id === id);
    if (!next || next === this.activeScene) return;
    this.activeScene?.detach();
    this.activeScene = next;
    next.attach(this.sceneCtx);
    this.host.setClient(next);
    this.renderTabs();

    // Панель сцены в сайдбаре
    const holder = document.getElementById('panel-scene')!;
    holder.innerHTML = '';
    const panel = next.buildPanel?.();
    if (panel) {
      holder.appendChild(panel);
      holder.hidden = false;
    } else {
      holder.hidden = true;
    }

    // Общие панели — по заявке сцены (по умолчанию видны все)
    const showTools = next.sidebar?.tools !== false;
    const showObjects = next.sidebar?.objects !== false;
    document.getElementById('panel-tools')!.hidden = !showTools;
    document.getElementById('panel-objects')!.hidden = !showObjects;
    if (!showTools) this.setHand(null); // в сцене без молотков рука пуста
  }

  private renderTabs(): void {
    const nav = document.getElementById('scene-tabs')!;
    nav.innerHTML = '';
    for (const scene of this.scenes) {
      const b = document.createElement('button');
      b.className = 'scene-tab' + (scene === this.activeScene ? ' active' : '');
      b.textContent = scene.title;
      b.addEventListener('click', () => this.switchScene(scene.id));
      nav.appendChild(b);
    }
  }

  // ---------- панели ----------

  private renderTools(): void {
    const list = document.getElementById('tool-list')!;
    list.innerHTML = '';
    for (const tool of this.session.tools.values()) {
      const chip = document.createElement('button');
      chip.className = 'tool-chip' + (tool.id === this.hand.toolId ? ' in-hand' : '');
      chip.innerHTML = `<span class="ic">${icon('hammer', 13)}</span>${visibleLabel(tool)}`;
      const comboHint = tool.steps && !tool.hidden
        ? ` — комбо: ${tool.steps.map((s) => toolLabel(s.op, s.n)).join(' ∘ ')}`
        : '';
      chip.title = (tool.id === this.hand.toolId ? 'В руке. Клик — положить' : 'Взять в руку') + comboHint;
      chip.addEventListener('click', () => {
        this.setHand(this.hand.toolId === tool.id ? null : tool.id);
      });
      if (this.restrictions.construct) {
        const del = document.createElement('span');
        del.className = 'chip-del';
        del.innerHTML = icon('close', 9);
        del.title = 'Выбросить инструмент';
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.session.removeTool(tool.id);
        });
        chip.appendChild(del);
      }
      list.appendChild(chip);
    }
  }

  private bindPanels(): void {
    const forgeBtn = document.getElementById('forge-btn')!;
    const forgeOp = document.getElementById('forge-op') as HTMLSelectElement;
    const forgeN = document.getElementById('forge-n') as HTMLInputElement;

    // У функций (x², √x, |x|) нет модификатора — поле числа прячется
    const syncForgeN = () => {
      const op = OP_FROM_SELECT[forgeOp.value] ?? 'add';
      forgeN.style.display = isUnaryOp(op) ? 'none' : '';
    };
    forgeOp.addEventListener('change', syncForgeN);
    syncForgeN();

    forgeBtn.addEventListener('click', () => {
      const op = OP_FROM_SELECT[forgeOp.value] ?? 'add';
      let n = Rational.of(0);
      if (!isUnaryOp(op)) {
        const parsed = Rational.parse(forgeN.value);
        if (!parsed) return this.say('Не понимаю число: ' + forgeN.value);
        n = parsed;
      }
      try {
        this.session.addTool(op, n);
      } catch (err) {
        this.say(err instanceof Error ? err.message : String(err));
      }
    });

    // Конструктор комбо: копим шаги, собираем в один инструмент
    const comboSteps: { op: PrimitiveOp; n: Rational }[] = [];
    const comboForge = document.getElementById('combo-forge')!;
    const comboOp = document.getElementById('combo-op') as HTMLSelectElement;
    const comboN = document.getElementById('combo-n') as HTMLInputElement;
    const comboName = document.getElementById('combo-name') as HTMLInputElement;
    const comboStepsEl = document.getElementById('combo-steps')!;

    document.getElementById('combo-toggle')!.addEventListener('click', () => {
      comboForge.hidden = !comboForge.hidden;
    });
    const syncComboN = () => {
      const op = OP_FROM_SELECT[comboOp.value] ?? 'add';
      comboN.style.display = isUnaryOp(op) ? 'none' : '';
    };
    comboOp.addEventListener('change', syncComboN);
    syncComboN();

    const renderComboSteps = () => {
      comboStepsEl.innerHTML = '';
      comboSteps.forEach((s, i) => {
        const chip = document.createElement('button');
        chip.className = 'tool-chip';
        chip.textContent = `${i + 1}. ${toolLabel(s.op, s.n)}`;
        chip.title = 'Убрать шаг';
        chip.addEventListener('click', () => {
          comboSteps.splice(i, 1);
          renderComboSteps();
        });
        comboStepsEl.appendChild(chip);
      });
    };

    document.getElementById('combo-add')!.addEventListener('click', () => {
      if (comboSteps.length >= 6) return this.say('Комбо из шести шагов достаточно любому.');
      const op = OP_FROM_SELECT[comboOp.value] ?? 'add';
      let n = Rational.of(0);
      if (!isUnaryOp(op)) {
        const parsed = Rational.parse(comboN.value);
        if (!parsed) return this.say('Не понимаю число: ' + comboN.value);
        if (op === 'div' && parsed.isZero()) return this.say('Деление на ноль не входит в курс школьной математики!');
        n = parsed;
      }
      comboSteps.push({ op, n });
      renderComboSteps();
    });

    document.getElementById('combo-btn')!.addEventListener('click', () => {
      if (!comboSteps.length) return this.say('Сначала добавь хотя бы один шаг.');
      this.session.addComposite([...comboSteps], comboName.value);
      comboSteps.length = 0;
      comboName.value = '';
      renderComboSteps();
    });

    const spawnBtn = document.getElementById('spawn-btn')!;
    const spawnValue = document.getElementById('spawn-value') as HTMLInputElement;
    spawnBtn.addEventListener('click', () => {
      const v = Rational.parse(spawnValue.value);
      if (!v) return this.say('Не понимаю число: ' + spawnValue.value);
      this.session.spawnObject(v);
    });

    const varName = document.getElementById('var-name') as HTMLInputElement;
    document.getElementById('spawn-var-btn')!.addEventListener('click', () => {
      const name = varName.value.trim() || 'a';
      this.session.spawnVariable(name, Rational.of(-10), Rational.of(10), Rational.of(1));
      // следующая буква наготове: a → b → c…
      if (/^[a-z]$/i.test(name) && name.toLowerCase() !== 'z') {
        varName.value = String.fromCharCode(name.charCodeAt(0) + 1);
      }
    });

    document.getElementById('spawn-set-btn')!.addEventListener('click', () => {
      for (let i = 10; i >= 0; i--) this.session.spawnObject(Rational.of(i));
    });

    document.getElementById('hit-all-btn')!.addEventListener('click', () => {
      if (!this.hand.toolId) return this.say('Сначала возьми инструмент в руку.');
      // порядок стабильный: по убыванию значения — как в демо «10, 9, 8…»
      const ids = [...this.session.objects.values()]
        .filter((o) => o.kind === 'number')
        .sort((a, b) => b.value.compare(a.value))
        .map((o) => o.id);
      ids.forEach((id) => this.hit(id));
    });

    document.getElementById('btn-undo')!.addEventListener('click', () => {
      if (!this.session.undo()) this.say('Отматывать больше нечего.');
    });

    // История — по запросу: дропдаун у кнопки ↺, закрывается кликом мимо
    const historyBtn = document.getElementById('btn-history')!;
    const dropdown = document.getElementById('history-dropdown')!;
    historyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dropdown.hidden = !dropdown.hidden;
      if (!dropdown.hidden) {
        // Карта диагнозов (методика 999): ложные инструменты, пойманные чекпоинтами
        const map = document.getElementById('diagnosis-map')!;
        const lines = diagnosisSummary();
        map.hidden = !lines.length;
        map.innerHTML = lines.length
          ? '<b>Карта диагнозов</b>' + lines.map((l) => `<div>• ${l}</div>`).join('') +
            '<div class="diag-actions">' +
            '<button id="diag-save" class="btn ghost">Сохранить файлом</button>' +
            '<button id="diag-clear" class="btn ghost">Очистить</button></div>'
          : '';
        map.querySelector('#diag-save')?.addEventListener('click', () => {
          const blob = new Blob([diagnosisReport()], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `oom-диагнозы-${new Date().toISOString().slice(0, 10)}.txt`;
          a.click();
          URL.revokeObjectURL(a.href);
        });
        map.querySelector('#diag-clear')?.addEventListener('click', () => {
          if (window.confirm('Стереть карту диагнозов? (Например, перед новым учеником.)')) {
            clearDiagnoses();
            map.hidden = true;
          }
        });
        dropdown.scrollTop = dropdown.scrollHeight;
      }
    });
    document.addEventListener('click', (ev) => {
      if (!dropdown.hidden && !dropdown.contains(ev.target as Node)) dropdown.hidden = true;
    });
  }

  // ---------- уроки и сохранения ----------

  private bindLessons(): void {
    const select = document.getElementById('lesson-select') as HTMLSelectElement;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Уроки…';
    select.appendChild(placeholder);
    for (const p of this.presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.title;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const spec = this.presets.find((p) => p.id === select.value);
      select.value = '';
      if (!spec) return;
      if (!window.confirm(`Загрузить урок «${spec.title}»? Текущая доска будет очищена.`)) return;
      this.reader?.abandon();
      loadLesson(this.session, spec);
      if (spec.scene) this.switchScene(spec.scene);
      this.say(`📚 Урок «${spec.title}» загружен`);
    });

    document.getElementById('btn-save')!.addEventListener('click', () => {
      localStorage.setItem(BOARD_STORAGE_KEY, exportBoard(this.session));
      this.say('💾 Доска сохранена');
    });
    document.getElementById('btn-load')!.addEventListener('click', () => {
      const json = localStorage.getItem(BOARD_STORAGE_KEY);
      if (!json) return this.say('Сохранений пока нет.');
      if (!window.confirm('Загрузить сохранённую доску? Текущая будет очищена.')) return;
      this.reader?.abandon();
      this.say(importBoard(this.session, json) ? '📂 Доска загружена' : 'Не получилось прочитать сохранение.');
    });
  }

  private bindReader(): void {
    this.reader = new Reader({
      session: this.session,
      openScene: (id) => this.switchScene(id),
      say: (t) => this.say(t),
      setConstruct: (on) => this.setConstruct(on),
    });

    // 📤 текущая доска → заготовка упражнения в буфер обмена
    document.getElementById('btn-export-ex')!.addEventListener('click', () => {
      const skeleton = {
        id: 'new-exercise',
        task: 'Опиши задание здесь',
        scene: this.activeScene?.id ?? 'boxes',
        goal: { kind: 'any-object-value', value: '0' },
        hints: [],
        board: JSON.parse(exportBoard(this.session)) as unknown,
      };
      void navigator.clipboard.writeText(JSON.stringify(skeleton, null, 2));
      this.say('📤 Заготовка упражнения скопирована в буфер обмена');
    });
  }

  // ---------- субтитры ----------

  private bindSubtitles(): void {
    this.session.on((e) => {
      if (e.kind === 'tool-applied') {
        this.say(subtitleFor(e.before, e.tool, e.after), true);
      } else if (e.kind === 'tool-rejected') {
        this.say(`Инструмент ${e.tool.label} отказался: ${e.reason}`);
      } else if (e.kind === 'tape-changed' || e.kind === 'scales-step') {
        this.say(e.note);
      } else if (e.kind === 'var-set') {
        this.say(e.note, true);
      } else if (e.kind === 'rect-changed') {
        this.say(e.note);
      } else if (e.kind === 'tape-refused') {
        this.say(`${e.object.label} отказалась: ${e.reason}`);
      } else if (e.kind === 'object-removed' || e.kind === 'tool-removed' || e.kind === 'undo') {
        if (e.note) this.say(e.note); // тихие события очистки не шумят в истории
      }
    });
  }

  /** Строка в субтитры; formula=true подсвечивает знак операции золотом. */
  private say(text: string, formula = false): void {
    const ol = document.getElementById('subtitles')!;
    const li = document.createElement('li');
    if (formula) {
      const binary = text.match(/^(\S+) (\S+) (\S+) = (\S+)$/);
      const unary = text.match(/^(.+) = (\S+)$/);
      if (binary) {
        li.append(binary[1] + ' ');
        const op = document.createElement('span');
        op.className = 'op';
        op.textContent = `${binary[2]} ${binary[3]}`;
        li.append(op, ` = ${binary[4]}`);
      } else if (unary) {
        const op = document.createElement('span');
        op.className = 'op';
        op.textContent = unary[1]!;
        li.append(op, ` = ${unary[2]}`);
      } else {
        li.textContent = text;
      }
    } else {
      li.textContent = text;
    }
    ol.appendChild(li);
    while (ol.children.length > 200) ol.firstElementChild?.remove();
    const dropdown = document.getElementById('history-dropdown')!;
    if (!dropdown.hidden) dropdown.scrollTop = dropdown.scrollHeight;
  }
}
