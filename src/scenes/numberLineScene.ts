import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer, hammerHeadPoint } from '../render/hammer';
import { FlyingLabels, SwingAnim, wobbleAngle } from '../render/motion';
import { NumberObject, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { drawDeleteBadge, DELETE_R } from '../render/widgets';
import { icon } from '../ui/icons';
import { clipFromObject, spawnFromClip } from '../core/clipboard';

const CHIP_R = 18;
const LINE_HIT = 14; // px — зона захвата прямой
const DRAG_THRESHOLD = 5;
const MIN_TICK_PX = 70;

/** Прыжок фишки в координатах значений (пан/зум во время полёта не ломают траекторию). */
interface Jump {
  fromV: number;
  toV: number;
  elapsed: number;
  duration: number;
  arcH: number;
}

/**
 * Числовая прямая сцены: общий ноль и масштаб у всех, но у каждой — свой
 * способ подписывать деления. Это настройка вида (как пан и зум), не объект.
 */
interface NLine {
  id: number;
  yFrac: number; // доля высоты сцены
  format: 'dec' | 'frac';
  /** dec: число знаков (null = авто); frac: знаменатель (null = авто). */
  param: number | null;
}

type Gesture =
  | { type: 'chip'; obj: NumberObject; startX: number; startY: number; grabDy: number; moved: boolean;
      /** value — переменная скользит вдоль прямой; transfer — перенос между прямыми */
      axis: 'none' | 'value' | 'transfer' }
  | { type: 'band'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { type: 'line'; line: NLine; startX: number; startY: number; startCenter: number; startYFrac: number; axis: 'none' | 'pan' | 'move' }
  | { type: 'pan'; startX: number; startCenter: number };

/**
 * Сцена «Числовая прямая»: положение, порядок, расстояние — и несколько
 * синхронных прямых с разными записями одних и тех же чисел (0,25 = 1/4 = 2/8).
 * Пан — горизонтальный драг, зум — колесо; прямые таскаются по вертикали,
 * фишки выделяются кликом (Shift — группа) и переносятся между прямыми
 * с сохранением значения.
 */
export class NumberLineScene implements Scene {
  readonly id = 'numberline';
  readonly title = 'Числовая прямая';

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;

  private centerValue = 2.5;
  private pxPerUnit = 70;
  private widthPx = 800;
  private heightPx = 600;

  private lines: NLine[] = [{ id: 0, yFrac: 0.55, format: 'dec', param: null }];
  private nextLineId = 1;

  private pointer = { x: 0, y: 0, inside: false };
  private gesture: Gesture | null = null;
  private readonly selection = new Set<string>();

  private readonly jumps = new Map<string, Jump>();
  /** Экранные позиции фишек последнего кадра (стопки учтены) — для попаданий. */
  private readonly chipLayout = new Map<string, { x: number; cy: number; lineId: number }>();
  private readonly swing = new SwingAnim();
  private readonly labels = new FlyingLabels();

  private card: HTMLElement | null = null;
  private cardLineId: number | null = null;
  private canvasEl: HTMLElement | null = null;

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      this.deleteSelection();
    }
    if (e.key === 'Escape') this.selection.clear();

    if ((e.ctrlKey || e.metaKey) && this.ctx) {
      const k = e.code; // физический код: работает на любой раскладке
      if (k === 'KeyC' || k === 'KeyX') {
        // позиция фишки определяется значением — смещения в буфере не нужны
        const items = [...this.selection].flatMap((id) => {
          const obj = this.ctx!.session.objects.get(id);
          const item = obj && clipFromObject(obj, 0, 0);
          return item ? [item] : [];
        });
        if (!items.length) return;
        e.preventDefault();
        this.ctx.clipboard.items = items;
        if (k === 'KeyX' && this.ctx.restrictions.construct) this.deleteSelection();
      }
      if (k === 'KeyV' && this.ctx.restrictions.construct && this.ctx.clipboard.items.length) {
        e.preventDefault();
        // «под курсором» на прямой = на ближайшую к курсору прямую
        let best = this.lines[0]!;
        let bestDist = Infinity;
        for (const l of this.lines) {
          const d = Math.abs((this.pointer.inside ? this.pointer.y : 0) - this.lineY(l));
          if (d < bestDist) { best = l; bestDist = d; }
        }
        this.selection.clear();
        for (const item of this.ctx.clipboard.items) {
          // фигуры плоскости здесь невидимы — не спавним их втихую
          if (item.kind === 'polygon' || item.kind === 'circle') continue;
          const obj = spawnFromClip(this.ctx.session, item);
          if (obj.kind === 'number') {
            obj.scenePos.set(this.id, { x: best.id, y: 0 });
            this.selection.add(obj.id);
          }
        }
      }
    }
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
    this.buildCard();
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'tool-applied') {
        const fromV = e.before.toNumber();
        const toV = e.after.toNumber();
        // Нейтральный удар (+0, ×1): подпись вылетает, но фишка честно не прыгает
        if (!e.before.equals(e.after)) {
          const distPx = Math.abs(toV - fromV) * this.pxPerUnit;
          this.jumps.set(e.objectId, {
            fromV,
            toV,
            elapsed: 0,
            duration: Math.min(340 + distPx * 0.35, 800),
            arcH: Math.min(28 + distPx * 0.12, 90),
          });
        }
        this.labels.spawn(visibleLabel(e.tool), this.xOf(fromV), this.lineY(this.lineOf(e.objectId)) - 60);
      }
      if (e.kind === 'object-removed') {
        this.jumps.delete(e.objectId);
        this.chipLayout.delete(e.objectId);
        this.selection.delete(e.objectId);
      }
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    if (this.canvasEl) this.canvasEl.style.cursor = '';
    this.card?.remove();
    this.card = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.gesture = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Прямые</h3>
      <button id="nl-add" class="btn ghost" style="margin-top:0"><span class="ic">${icon('plus', 12)}</span>Добавить прямую</button>
      <p class="hint">Все прямые смещаются и масштабируются синхронно — нули всегда
        друг под другом. Клик по прямой — её настройки (десятичные или дроби).
        Перетаскивай прямые по вертикали, а фишки — с прямой на прямую:
        значение сохранится, изменится только запись.</p>
    `;
    root.querySelector<HTMLButtonElement>('#nl-add')!.addEventListener('click', () => {
      const last = this.lines[this.lines.length - 1]!;
      this.lines.push({
        id: this.nextLineId++,
        yFrac: Math.min(last.yFrac + 0.18, 0.92),
        format: 'dec',
        param: null,
      });
    });
    return root;
  }

  // ---------- карточка настроек прямой ----------

  private buildCard(): void {
    const host = document.querySelector('.stage-wrap');
    if (!host) return;
    this.card = document.createElement('div');
    this.card.className = 'tape-popup';
    this.card.hidden = true;
    this.card.innerHTML = `
      <div class="task-head"><b>Прямая</b>
        <span class="task-actions"><button id="nl-close" class="btn ghost" title="Закрыть">${icon('close', 12)}</button></span>
      </div>
      <div class="series-row">
        <label class="field">формат<select id="nl-format">
          <option value="dec">десятичные</option>
          <option value="frac">натуральные (дроби)</option>
        </select></label>
        <label class="field" id="nl-param-label">знаки<input id="nl-param" placeholder="авто" /></label>
      </div>
      <button id="nl-apply" class="btn primary">Применить</button>
      <button id="nl-del" class="btn ghost"><span class="ic">${icon('trash', 13)}</span>Удалить прямую</button>
    `;
    host.appendChild(this.card);

    const q = <T extends HTMLElement>(sel: string) => this.card!.querySelector<T>(sel)!;
    q('#nl-close').addEventListener('click', () => this.hideCard());
    q<HTMLSelectElement>('#nl-format').addEventListener('change', () => {
      q('#nl-param-label').firstChild!.textContent =
        q<HTMLSelectElement>('#nl-format').value === 'dec' ? 'знаки' : 'знаменатель';
    });
    q('#nl-apply').addEventListener('click', () => this.applyCard());
    q<HTMLInputElement>('#nl-param').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyCard();
    });
    q('#nl-del').addEventListener('click', () => {
      const line = this.lines.find((l) => l.id === this.cardLineId);
      if (!line || this.lines.length <= 1 || !this.ctx) return;
      this.lines = this.lines.filter((l) => l !== line);
      // фишки удалённой прямой переезжают на первую оставшуюся
      const fallback = this.lines[0]!.id;
      for (const o of this.ctx.session.objects.values()) {
        if (o.kind === 'number' && this.lineIdOf(o) === line.id) {
          o.scenePos.set(this.id, { x: fallback, y: 0 });
        }
      }
      this.hideCard();
    });
  }

  private openCard(line: NLine, x: number, y: number): void {
    if (!this.card) return;
    this.cardLineId = line.id;
    const q = <T extends HTMLElement>(sel: string) => this.card!.querySelector<T>(sel)!;
    q<HTMLSelectElement>('#nl-format').value = line.format;
    q('#nl-param-label').firstChild!.textContent = line.format === 'dec' ? 'знаки' : 'знаменатель';
    q<HTMLInputElement>('#nl-param').value = line.param === null ? '' : String(line.param);
    (q('#nl-del') as HTMLButtonElement).hidden = this.lines.length <= 1;
    const host = this.card.parentElement!;
    this.card.hidden = false;
    this.card.style.left = `${Math.min(Math.max(x, 10), host.clientWidth - 260)}px`;
    this.card.style.top = `${Math.min(Math.max(y + 12, 10), host.clientHeight - 160)}px`;
  }

  private hideCard(): void {
    if (this.card) this.card.hidden = true;
    this.cardLineId = null;
  }

  private applyCard(): void {
    const line = this.lines.find((l) => l.id === this.cardLineId);
    if (!line || !this.card) return;
    const q = <T extends HTMLElement>(sel: string) => this.card!.querySelector<T>(sel)!;
    line.format = q<HTMLSelectElement>('#nl-format').value === 'frac' ? 'frac' : 'dec';
    const raw = q<HTMLInputElement>('#nl-param').value.trim();
    if (raw === '') {
      line.param = null;
    } else {
      const n = Math.round(Number(raw));
      line.param = Number.isFinite(n) && n >= (line.format === 'frac' ? 1 : 0) && n <= 100 ? n : null;
    }
    this.hideCard();
  }

  // ---------- геометрия ----------

  private lineY(line: NLine): number { return line.yFrac * this.heightPx; }
  private xOf(v: number): number { return this.widthPx / 2 + (v - this.centerValue) * this.pxPerUnit; }

  /**
   * Значение под курсором для ползунка переменной. Если у переменной нет
   * зашитого шага (по умолчанию), снап — к делениям, которые СЕЙЧАС нарисованы
   * на прямой этой фишки (tickPlan): видишь 0,05 — ходишь по 0,05.
   */
  private snappedValueAt(px: number, obj: NumberObject): Rational {
    const raw = this.valueAt(px);
    if (obj.variable?.step) return Rational.of(Math.round(raw * 1e6), 1e6); // снапнет ядро
    const lineId = this.lineIdOf(obj);
    const step = this.tickStepRat(this.lines.find((l) => l.id === lineId) ?? this.lines[0]!);
    return step.mul(Rational.of(Math.round(raw / step.toNumber())));
  }

  /** Точный (дробью) шаг делений прямой — та же лестница, что рисует tickPlan. */
  private tickStepRat(line: NLine): Rational {
    const plan = this.tickPlan(line);
    if (plan.den !== null) return Rational.of(plan.numStep, plan.den);
    const { m, k } = this.decStepParts();
    return k >= 0
      ? Rational.of(BigInt(m) * 10n ** BigInt(k))
      : Rational.of(BigInt(m), 10n ** BigInt(-k));
  }
  private valueAt(x: number): number { return this.centerValue + (x - this.widthPx / 2) / this.pxPerUnit; }

  private lineIdOf(obj: NumberObject): number {
    const pos = obj.scenePos.get(this.id);
    const id = pos ? pos.x : this.lines[0]!.id;
    return this.lines.some((l) => l.id === id) ? id : this.lines[0]!.id;
  }

  private lineOf(objectId: string): NLine {
    const obj = this.ctx?.session.objects.get(objectId);
    const id = obj?.kind === 'number' ? this.lineIdOf(obj) : this.lines[0]!.id;
    return this.lines.find((l) => l.id === id) ?? this.lines[0]!;
  }

  private chipAt(x: number, y: number): NumberObject | null {
    if (!this.ctx) return null;
    let best: NumberObject | null = null;
    let bestDist = Infinity;
    for (const obj of this.ctx.session.objects.values()) {
      if (obj.kind !== 'number') continue;
      const p = this.chipLayout.get(obj.id);
      if (!p) continue;
      const d = Math.hypot(x - p.x, y - p.cy);
      if (d < CHIP_R * 2 && d < bestDist) { best = obj; bestDist = d; }
    }
    return best;
  }

  private lineAt(y: number): NLine | null {
    let best: NLine | null = null;
    let bestDist = LINE_HIT;
    for (const l of this.lines) {
      const d = Math.abs(y - this.lineY(l));
      if (d <= bestDist) { best = l; bestDist = d; }
    }
    return best;
  }

  private deleteSelection(): void {
    if (!this.ctx) return;
    for (const id of [...this.selection]) this.ctx.session.removeObject(id);
    this.selection.clear();
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number; shift?: boolean }): void {
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };
    this.hideCard();

    if (p.button === 2) {
      this.ctx.dropHand();
      return;
    }
    if (p.button === 1) { // СКМ — пан, как в GeoGebra
      this.gesture = { type: 'pan', startX: p.x, startCenter: this.centerValue };
      return;
    }
    if (p.button !== 0) return;

    if (this.ctx.hand.toolId) {
      const head = hammerHeadPoint(p.x, p.y);
      const target = this.chipAt(head.x, head.y) ?? this.chipAt(p.x, p.y);
      if (target) {
        this.swing.start();
        this.ctx.hit(target.id);
        return;
      }
      // пан — только от драга по прямой, даже с молотком в руке
      if (this.lineAt(p.y)) {
        this.gesture = { type: 'pan', startX: p.x, startCenter: this.centerValue };
      }
      return;
    }

    const chip = this.chipAt(p.x, p.y);
    if (chip) {
      const lp = this.chipLayout.get(chip.id);
      // Крестик над выделенной фишкой — удаление группы
      if (lp && this.selection.has(chip.id) && this.ctx.restrictions.construct) {
        if (Math.hypot(p.x - lp.x, p.y - (lp.cy - CHIP_R - 13)) <= DELETE_R) {
          this.deleteSelection();
          return;
        }
      }
      if (p.shift) {
        if (this.selection.has(chip.id)) this.selection.delete(chip.id);
        else this.selection.add(chip.id);
        return;
      }
      if (!this.selection.has(chip.id)) {
        this.selection.clear();
        this.selection.add(chip.id);
      }
      this.gesture = { type: 'chip', obj: chip, startX: p.x, startY: p.y, grabDy: lp ? p.y - lp.cy : 0, moved: false, axis: 'none' };
      return;
    }

    const line = this.lineAt(p.y);
    if (line) {
      this.gesture = {
        type: 'line', line, startX: p.x, startY: p.y,
        startCenter: this.centerValue, startYFrac: line.yFrac, axis: 'none',
      };
      return;
    }

    // Пустое место: рамка выделения (мир двигается только за прямые)
    this.gesture = { type: 'band', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: !!p.shift };
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
    const g = this.gesture;
    if (!g) return;

    if (g.type === 'pan') {
      this.centerValue = g.startCenter - (p.x - g.startX) / this.pxPerUnit;
      return;
    }
    if (g.type === 'line') {
      if (g.axis === 'none') {
        const dx = Math.abs(p.x - g.startX);
        const dy = Math.abs(p.y - g.startY);
        if (Math.max(dx, dy) > DRAG_THRESHOLD) g.axis = dy > dx ? 'move' : 'pan';
      }
      if (g.axis === 'move') {
        g.line.yFrac = Math.min(Math.max((g.startYFrac * this.heightPx + (p.y - g.startY)) / this.heightPx, 0.08), 0.94);
      } else if (g.axis === 'pan') {
        this.centerValue = g.startCenter - (p.x - g.startX) / this.pxPerUnit;
      }
      return;
    }
    if (g.type === 'band') {
      g.x1 = p.x;
      g.y1 = p.y;
      return;
    }
    // chip
    if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) > DRAG_THRESHOLD) {
      g.moved = true;
      // Переменная: горизонталь — скольжение по значению, вертикаль — перенос.
      // Обычная фишка значение руками не меняет — только перенос.
      const horizontal = Math.abs(p.x - g.startX) >= Math.abs(p.y - g.startY);
      g.axis = g.obj.variable && horizontal ? 'value' : 'transfer';
    }
    if (g.moved && g.axis === 'value' && this.ctx) {
      this.ctx.session.setVariableValue(g.obj.id, this.snappedValueAt(p.x, g.obj), false);
    }
  }

  onPointerUp(p: { x: number; y: number; button: number }): void {
    const g = this.gesture;
    this.gesture = null;
    if (!this.ctx || !g) return;

    if (g.type === 'line') {
      if (g.axis === 'none') this.openCard(g.line, p.x, p.y);
      return;
    }
    if (g.type === 'band') {
      const x0 = Math.min(g.x0, g.x1);
      const x1 = Math.max(g.x0, g.x1);
      const y0 = Math.min(g.y0, g.y1);
      const y1 = Math.max(g.y0, g.y1);
      if (!g.additive) this.selection.clear();
      if (x1 - x0 > DRAG_THRESHOLD || y1 - y0 > DRAG_THRESHOLD) {
        for (const [id, lp] of this.chipLayout) {
          if (lp.x >= x0 - CHIP_R && lp.x <= x1 + CHIP_R && lp.cy >= y0 - CHIP_R && lp.cy <= y1 + CHIP_R) {
            this.selection.add(id);
          }
        }
      }
      return;
    }
    if (g.type === 'chip' && g.moved && g.axis === 'value') {
      // отпустили ползунок-переменную: одна запись в журнал
      this.ctx.session.setVariableValue(g.obj.id, g.obj.value, true);
      return;
    }
    if (g.type === 'chip' && g.moved) {
      // Бросили фишку (и всю выделенную группу) на ближайшую к курсору прямую:
      // значение сохраняется, меняется только запись
      let best = this.lines[0]!;
      let bestDist = Infinity;
      for (const l of this.lines) {
        const d = Math.abs(p.y - this.lineY(l));
        if (d < bestDist) { best = l; bestDist = d; }
      }
      for (const id of this.selection) {
        const obj = this.ctx.session.objects.get(id);
        if (obj?.kind === 'number') obj.scenePos.set(this.id, { x: best.id, y: 0 });
      }
    }
  }

  onWheel(x: number, _y: number, deltaY: number): void {
    const anchor = this.valueAt(x);
    const factor = Math.pow(1.0015, -deltaY);
    this.pxPerUnit = Math.min(Math.max(this.pxPerUnit * factor, 1e-3), 1e6);
    this.centerValue = anchor - (x - this.widthPx / 2) / this.pxPerUnit;
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;
    this.widthPx = w;
    this.heightPx = h;

    for (const [id, j] of this.jumps) {
      j.elapsed += dt;
      if (j.elapsed >= j.duration) this.jumps.delete(id);
    }

    for (const line of this.lines) this.drawAxis(g, line, w);
    this.drawChips(g);

    // Курсор-подсказка: над прямой — «рука», во время драга — «схваченная»
    this.canvasEl ??= document.getElementById('stage');
    if (this.canvasEl) {
      let cursor = '';
      const g2 = this.gesture;
      if (g2 && (g2.type === 'pan' || (g2.type === 'line' && g2.axis !== 'none'))) {
        cursor = 'grabbing';
      } else if (
        !this.ctx.hand.toolId &&
        !g2 &&
        this.pointer.inside &&
        !this.chipAt(this.pointer.x, this.pointer.y) &&
        this.lineAt(this.pointer.y)
      ) {
        cursor = 'grab';
      }
      this.canvasEl.style.cursor = cursor;
    }

    // Рамка выделения
    if (this.gesture?.type === 'band') {
      const b = this.gesture;
      g.save();
      g.fillStyle = 'rgba(40, 220, 120, 0.08)';
      g.strokeStyle = theme.accentBorder;
      g.lineWidth = 1;
      g.setLineDash([5, 5]);
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.restore();
    }

    this.labels.update(dt);
    this.labels.draw(g, theme.gold);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    if (hand && this.pointer.inside) {
      const swingAngle = this.swing.update(dt);
      const angle = swingAngle !== 0 ? swingAngle : wobbleAngle(now);
      drawHammer(g, this.pointer.x, this.pointer.y, angle, visibleLabel(hand));
    }
  }

  /** Шаг делений (в значениях) и знаменатель для дробного формата. */
  private tickPlan(line: NLine): { step: number; den: number | null; numStep: number } {
    if (line.format === 'frac') {
      if (line.param !== null) {
        const n = line.param;
        const numStep = Math.max(1, Math.ceil(MIN_TICK_PX / (this.pxPerUnit / n)));
        return { step: numStep / n, den: n, numStep };
      }
      // авто-дроби: половинки/четвертинки…, крупнее единицы — целые шаги
      if (this.pxPerUnit >= MIN_TICK_PX * 2) {
        const k = Math.floor(Math.log2(this.pxPerUnit / MIN_TICK_PX));
        const den = Math.pow(2, k);
        return { step: 1 / den, den, numStep: 1 };
      }
      return { step: this.decStep(), den: null, numStep: 0 };
    }
    return { step: this.decStep(), den: null, numStep: 0 };
  }

  /** Десятичная лестница шагов: 1, 2, 5 · 10^k. */
  private decStep(): number {
    const { m, k } = this.decStepParts();
    return m * Math.pow(10, k);
  }

  private decStepParts(): { m: number; k: number } {
    const k = Math.floor(Math.log10(MIN_TICK_PX / this.pxPerUnit));
    const base = Math.pow(10, k);
    for (const m of [1, 2, 5]) {
      if (base * m * this.pxPerUnit >= MIN_TICK_PX) return { m, k };
    }
    return { m: 1, k: k + 1 };
  }

  private tickLabel(line: NLine, index: number, plan: { step: number; den: number | null; numStep: number }): string {
    const v = index * plan.step;
    if (line.format === 'frac' && plan.den !== null) {
      const num = index * plan.numStep;
      if (line.param !== null) return `${num}/${plan.den}`; // без сокращения: 0/4, 2/4, 4/4
      // авто: сокращаем; целые — без знаменателя
      let a = num;
      let b = plan.den;
      const sign = a < 0 ? '-' : '';
      a = Math.abs(a);
      while (b % 2 === 0 && a % 2 === 0) { a /= 2; b /= 2; }
      return b === 1 ? `${sign}${a}` : `${sign}${a}/${b}`;
    }
    if (line.format === 'dec' && line.param !== null) {
      return v.toFixed(line.param).replace('.', ',');
    }
    // авто-десятичные
    if (plan.step >= 1) return String(Math.round(v));
    const digits = Math.min(Math.max(-Math.floor(Math.log10(plan.step)), 0), 10);
    return v.toFixed(digits).replace('.', ',').replace(/,?0+$/, '');
  }

  private drawAxis(g: CanvasRenderingContext2D, line: NLine, w: number): void {
    const y = this.lineY(line);

    g.strokeStyle = theme.textSecondary;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
    g.beginPath();
    g.moveTo(w - 14, y - 6);
    g.lineTo(w - 2, y);
    g.lineTo(w - 14, y + 6);
    g.stroke();

    const plan = this.tickPlan(line);
    const first = Math.ceil(this.valueAt(0) / plan.step - 1e-9);
    const last = Math.floor(this.valueAt(w) / plan.step + 1e-9);

    g.font = '13px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';

    for (let i = first; i <= last; i++) {
      const v = i * plan.step;
      const x = this.xOf(v);
      const isZero = i === 0;

      g.strokeStyle = isZero ? theme.accentBorder : theme.border;
      g.lineWidth = isZero ? 2 : 1;
      g.beginPath();
      g.moveTo(x, y - (isZero ? 14 : 9));
      g.lineTo(x, y + (isZero ? 14 : 9));
      g.stroke();

      g.fillStyle = isZero ? theme.accent : theme.textSecondary;
      g.fillText(this.tickLabel(line, i, plan), x, y + 18);
    }

    // Бейдж формата у левого края — видно, чем прямые отличаются
    g.fillStyle = theme.textSecondary;
    g.globalAlpha = 0.55;
    g.font = '11px Inter, sans-serif';
    g.textAlign = 'left';
    const tag = line.format === 'dec'
      ? `0,${'0'.repeat(Math.max(line.param ?? 2, 1))}${line.param === null ? '…' : ''}`
      : line.param === null ? 'a/b' : `n/${line.param}`;
    g.fillText(tag, 8, y - 24);
    g.globalAlpha = 1;
  }

  private drawChips(g: CanvasRenderingContext2D): void {
    if (!this.ctx) return;

    let targeted: NumberObject | null = null;
    if (this.ctx.hand.toolId && this.pointer.inside) {
      const head = hammerHeadPoint(this.pointer.x, this.pointer.y);
      targeted = this.chipAt(head.x, head.y) ?? this.chipAt(this.pointer.x, this.pointer.y);
    }

    const draggingChips =
      this.gesture?.type === 'chip' && this.gesture.moved && this.gesture.axis === 'transfer'
        ? this.selection
        : null;
    const stacks = new Map<string, number>();
    this.chipLayout.clear();

    for (const obj of this.ctx.session.objects.values()) {
      if (obj.kind !== 'number') continue;
      const line = this.lineOf(obj.id);
      const yBase = this.lineY(line);

      const jump = this.jumps.get(obj.id);
      let x: number;
      let lift = 0;
      if (jump && jump.elapsed < jump.duration) {
        const t = jump.elapsed / jump.duration;
        x = this.xOf(jump.fromV + (jump.toV - jump.fromV) * t);
        lift = jump.arcH * 4 * t * (1 - t);
      } else {
        x = this.xOf(obj.value.toNumber());
      }

      let cy: number;
      if (draggingChips?.has(obj.id) && this.gesture?.type === 'chip') {
        // перенос между прямыми: значение (x) заперто, тащится только вертикаль
        cy = this.pointer.y - this.gesture.grabDy;
      } else {
        // стопкой стоят ТОЛЬКО строго равные: слот — точное значение, не пиксели
        const slot = `${line.id}:${obj.value.num}/${obj.value.den}`;
        const level = stacks.get(slot) ?? 0;
        stacks.set(slot, level + 1);
        cy = yBase - CHIP_R - lift - level * (CHIP_R * 2 + 5);
        if (lift === 0 && level === 0) {
          g.strokeStyle = theme.border;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x, cy + CHIP_R);
          g.lineTo(x, yBase);
          g.stroke();
        }
      }
      this.chipLayout.set(obj.id, { x, cy, lineId: line.id });

      const sign = obj.value.sign();
      const selected = this.selection.has(obj.id);

      g.fillStyle = theme.boxFill(sign);
      g.beginPath();
      g.arc(x, cy, CHIP_R, 0, Math.PI * 2);
      g.fill();

      if (selected) {
        g.strokeStyle = theme.textPrimary;
        g.lineWidth = 3;
        g.shadowColor = theme.textPrimary;
        g.shadowBlur = 12;
        g.beginPath();
        g.arc(x, cy, CHIP_R + 4, 0, Math.PI * 2);
        g.stroke();
        g.shadowBlur = 0;
      } else if (obj === targeted) {
        g.strokeStyle = theme.canvasGreen;
        g.lineWidth = 3;
        g.shadowColor = theme.canvasGreen;
        g.shadowBlur = 15;
        g.setLineDash([5, 5]);
        g.beginPath();
        g.arc(x, cy, CHIP_R + 5, 0, Math.PI * 2);
        g.stroke();
        g.shadowBlur = 0;
        g.setLineDash([]);
      } else {
        g.strokeStyle = theme.boxStroke(sign);
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, cy, CHIP_R, 0, Math.PI * 2);
        g.stroke();
      }

      const text = obj.value.toDisplay();
      g.fillStyle = theme.textPrimary;
      g.font = `bold ${text.length > 3 ? 11 : 14}px Inter, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, x, cy);

      // Имя переменной — прямая и есть её ползунок
      if (obj.variable) {
        g.fillStyle = theme.accent;
        g.font = 'bold 11px Inter, sans-serif';
        g.textAlign = 'left';
        g.fillText(obj.variable.name, x + CHIP_R + 4, cy - CHIP_R + 4);
      }
    }

    // Крестики над выделенными фишками (рука пуста, конструирование открыто)
    if (!this.ctx.hand.toolId && this.ctx.restrictions.construct && !draggingChips) {
      for (const id of this.selection) {
        const lp = this.chipLayout.get(id);
        if (!lp) continue;
        const by = lp.cy - CHIP_R - 13;
        drawDeleteBadge(g, lp.x, by, Math.hypot(this.pointer.x - lp.x, this.pointer.y - by) <= DELETE_R);
      }
    }
  }
}
