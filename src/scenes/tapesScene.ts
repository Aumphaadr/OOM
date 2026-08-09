import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer, hammerHeadPoint } from '../render/hammer';
import { FlyingLabels, SwingAnim, wobbleAngle } from '../render/motion';
import { TapeObject, tapePieceLabels, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { icon } from '../ui/icons';
import { clipFromObject, spawnFromClip } from '../core/clipboard';

const LEFT = 74; // левая кромка лент по умолчанию (новые встают стопкой)
const TOP = 72;
const ROW_H = 82;
const TAPE_H = 36;
const PX_PER_UNIT = 130;
const SEAM_HIT = 7;
const DRAG_THRESHOLD = 5; // px: меньше — клик, больше — перетаскивание

interface Pos { x: number; y: number }

/**
 * Сцена «Ленты»: дробь как длина. Хватание за полотно перемещает ленту;
 * клик по полотну мимо шва открывает карточку настроек (режим /n, длина,
 * удаление) — прибамбасы показываются только по запросу.
 * Клик по шву — рез, по резу — склейка.
 */
export class TapesScene implements Scene {
  readonly id = 'tapes';
  readonly title = 'Ленты';
  /** Молотки и спавн чисел в сцене лент не играют роли — панели скрываем. */
  readonly sidebar = { tools: false, objects: false };

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private pointer = { x: 0, y: 0, inside: false };

  /** Незавершённый жест по ленте: станет перетаскиванием или кликом. */
  private pending: { tape: TapeObject; dx: number; dy: number; startX: number; startY: number; moved: boolean } | null = null;

  private popup: HTMLElement | null = null;
  private popupTapeId: string | null = null;
  private canvasEl: HTMLElement | null = null;
  /** Итог последнего применения настроек (заполняется подпиской на журнал). */
  private popupFeedback: string | null = null;
  private readonly outsideClick = (e: PointerEvent): void => {
    if (this.popup && !this.popup.hidden && !this.popup.contains(e.target as Node)) {
      // клики по канвасу сами управляют карточкой; прячем только по чужим кликам
      if ((e.target as HTMLElement).id !== 'stage') this.hidePopup();
    }
  };

  private readonly swing = new SwingAnim();
  private readonly labels = new FlyingLabels();

  /** У лент нет выделения: Ctrl+C/X работают с лентой под курсором. */
  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!(e.ctrlKey || e.metaKey) || !this.ctx) return;
    const k = e.code; // физический код: работает на любой раскладке
    if (k === 'KeyC' || k === 'KeyX') {
      const t = this.pointer.inside ? this.tapeAt(this.pointer.x, this.pointer.y) : null;
      if (!t) return;
      e.preventDefault();
      const item = clipFromObject(t, 0, 0);
      if (item) this.ctx.clipboard.items = [item];
      if (k === 'KeyX' && this.ctx.restrictions.construct) this.ctx.session.removeObject(t.id);
    }
    if (k === 'KeyV' && this.ctx.restrictions.construct && this.ctx.clipboard.items.length) {
      e.preventDefault();
      const ax = this.pointer.inside ? this.pointer.x : LEFT;
      const ay = this.pointer.inside ? this.pointer.y : TOP;
      for (const item of this.ctx.clipboard.items) {
        const obj = spawnFromClip(this.ctx.session, item);
        if (obj.kind === 'tape') {
          obj.scenePos.set(this.id, { x: ax + item.dx, y: ay + item.dy });
        }
      }
    }
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    this.buildPopup();
    window.addEventListener('keydown', this.keyHandler);
    document.addEventListener('pointerdown', this.outsideClick);
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'tool-rejected') {
        const obj = ctx.session.objects.get(e.objectId);
        if (obj?.kind === 'tape') this.labels.spawn('⛔', this.pointer.x, this.pointer.y - 30);
      }
      if (e.kind === 'object-removed' && e.objectId === this.popupTapeId) this.hidePopup();
      if (e.kind === 'tape-changed' && e.object.id === this.popupTapeId) {
        this.popupFeedback = '✓ применено';
        this.syncPopup();
      }
      if (e.kind === 'tape-refused' && e.object.id === this.popupTapeId) {
        this.popupFeedback = `✗ ${e.reason}`;
      }
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('pointerdown', this.outsideClick);
    if (this.canvasEl) this.canvasEl.style.cursor = '';
    this.popup?.remove();
    this.popup = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.pending = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Новая лента</h3>
      <div class="series-row">
        <label class="field">длина<input id="tape-len" value="7" /></label>
        <label class="field">режим /n<input id="tape-mode" type="number" value="6" min="1" max="100" /></label>
      </div>
      <button id="tape-create" class="btn primary"><span class="ic">${icon('plus', 13)}</span>Создать ленту</button>
      <p class="hint">Наведи на ленту — проступят швы. Клик по шву — рез, по резу — склейка.
        Клик по полотну мимо швов — настройки ленты (режим, длина, удаление).
        Полотно можно таскать. Длина понимает дроби: «7», «2,5», «1/2».</p>
    `;
    root.querySelector<HTMLButtonElement>('#tape-create')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const len = Rational.parse(root.querySelector<HTMLInputElement>('#tape-len')!.value);
      if (!len || len.sign() <= 0) return;
      const mode = Number(root.querySelector<HTMLInputElement>('#tape-mode')!.value) || 6;
      this.ctx.session.spawnTape(len, mode);
    });
    return root;
  }

  // ---------- карточка настроек ----------

  private buildPopup(): void {
    const host = document.querySelector('.stage-wrap');
    if (!host) return;
    this.popup = document.createElement('div');
    this.popup.className = 'tape-popup';
    this.popup.hidden = true;
    this.popup.innerHTML = `
      <div class="task-head"><b id="tp-title">Лента</b>
        <span class="task-actions"><button id="tp-close" class="btn ghost" title="Закрыть">${icon('close', 12)}</button></span>
      </div>
      <div class="series-row">
        <label class="field">режим /n<input id="tp-mode" type="number" min="1" max="100" /></label>
        <label class="field">длина ленты<input id="tp-len" /></label>
      </div>
      <div class="series-row">
        <label class="field" title="Эталон: /n делит ЕДИНИЦУ, а не всю ленту. Лента длиннее единицы даёт дроби больше 1 (7/4). Пусто — единица равна всей ленте.">длина единицы (1 = …)<input id="tp-unit" placeholder="= длине ленты" /></label>
      </div>
      <label class="field tp-check"><input type="checkbox" id="tp-strict" /> целые обозначения</label>
      <button id="tp-apply" class="btn primary">Применить</button>
      <p id="tp-status" class="hint" hidden></p>
      <button id="tp-del" class="btn ghost"><span class="ic">${icon('trash', 13)}</span>Удалить ленту</button>
    `;
    host.appendChild(this.popup);

    const q = <T extends HTMLElement>(sel: string) => this.popup!.querySelector<T>(sel)!;
    q('#tp-close').addEventListener('click', () => this.hidePopup());
    q('#tp-apply').addEventListener('click', () => this.applyPopup());
    for (const sel of ['#tp-mode', '#tp-len']) {
      q<HTMLInputElement>(sel).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.applyPopup();
      });
    }
    q('#tp-del').addEventListener('click', () => {
      if (!this.ctx || !this.popupTapeId || !this.ctx.restrictions.construct) return;
      this.ctx.session.removeObject(this.popupTapeId);
    });
  }

  /** Явное применение настроек: статус — успех или причина отказа ядра. */
  private applyPopup(): void {
    if (!this.ctx || !this.popup || !this.popupTapeId) return;
    const t = this.ctx.session.objects.get(this.popupTapeId);
    if (!t || t.kind !== 'tape') return;
    const q = <T extends HTMLElement>(sel: string) => this.popup!.querySelector<T>(sel)!;

    // ВАЖНО: сначала читаем ВСЕ поля, потом применяем. Каждая успешная операция
    // синхронно рождает tape-changed → syncPopup, который перезаписывает инпуты
    // значениями модели — чтение вперемешку с применением теряло ввод.
    const strictWanted = q<HTMLInputElement>('#tp-strict').checked;
    const modeRaw = q<HTMLInputElement>('#tp-mode').value.trim();
    const lenRaw = q<HTMLInputElement>('#tp-len').value;
    const unitRaw = q<HTMLInputElement>('#tp-unit').value.trim();

    this.popupFeedback = null; // подписка на журнал заполнит успехом или отказом

    // Галка — первой: она решает, примет ли линейка резы
    if (strictWanted !== t.strictGrid) this.ctx.session.setTapeStrict(t.id, strictWanted);

    // Эталонная единица: пусто = вся лента
    if (unitRaw === '') {
      if (t.unitLen !== null) this.ctx.session.setTapeUnitLen(t.id, null);
    } else {
      const u = Rational.parse(unitRaw);
      if (u) this.ctx.session.setTapeUnitLen(t.id, u);
      else this.popupFeedback = `✗ не понимаю единицу «${unitRaw}»`;
    }

    // Режим: пустое поле = целая лента (без швов)
    const mode = modeRaw === '' ? null : Math.round(Number(modeRaw));
    if (modeRaw === '' || (Number.isFinite(mode!) && mode! >= 1)) {
      if (mode !== t.mode) this.ctx.session.setTapeMode(t.id, mode);
    } else {
      this.popupFeedback = `✗ не понимаю режим «${modeRaw}»`;
    }

    // Длина (в запертом упражнении поле заблокировано)
    if (this.ctx.restrictions.construct) {
      const len = Rational.parse(lenRaw);
      if (!len) {
        this.popupFeedback = this.popupFeedback ?? `✗ не понимаю длину «${lenRaw}»`;
      } else if (!len.equals(t.whole)) {
        this.ctx.session.setTapeLength(t.id, len);
      }
    }

    const status = q('#tp-status');
    status.textContent = this.popupFeedback ?? 'без изменений';
    status.hidden = false;
    this.syncPopup();
  }

  private openPopup(t: TapeObject, x: number, y: number): void {
    if (!this.popup) return;
    this.popupTapeId = t.id;
    this.popupFeedback = null;
    const status = this.popup.querySelector<HTMLElement>('#tp-status')!;
    status.hidden = true;
    this.syncPopup();
    const host = this.popup.parentElement!;
    this.popup.hidden = false;
    const px = Math.min(Math.max(x, 10), host.clientWidth - 250);
    const py = Math.min(Math.max(y + 14, 10), host.clientHeight - 170);
    this.popup.style.left = `${px}px`;
    this.popup.style.top = `${py}px`;
  }

  private hidePopup(): void {
    if (this.popup) this.popup.hidden = true;
    this.popupTapeId = null;
  }

  private syncPopup(): void {
    if (!this.popup || !this.popupTapeId || !this.ctx) return;
    const t = this.ctx.session.objects.get(this.popupTapeId);
    if (!t || t.kind !== 'tape') return;
    const q = <T extends HTMLElement>(sel: string) => this.popup!.querySelector<T>(sel)!;
    q('#tp-title').textContent = t.label;
    q<HTMLInputElement>('#tp-mode').value = t.mode === null ? '' : String(t.mode);
    q<HTMLInputElement>('#tp-len').value = t.whole.toDisplay();
    q<HTMLInputElement>('#tp-unit').value = t.unitLen ? t.unitLen.toDisplay() : '';
    q<HTMLInputElement>('#tp-strict').checked = t.strictGrid;
    // в запертом упражнении менять длину и удалять нельзя (режим — можно)
    const construct = this.ctx.restrictions.construct;
    q<HTMLInputElement>('#tp-len').disabled = !construct;
    q('#tp-del').hidden = !construct;
  }

  // ---------- геометрия ----------

  private tapes(): TapeObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is TapeObject => o.kind === 'tape');
  }

  private tapeW(t: TapeObject): number { return Math.max(t.whole.toNumber() * PX_PER_UNIT, 24); }

  /** Позиция ленты; новые встают стопкой у левой кромки в первый свободный ряд. */
  private ensurePos(t: TapeObject): Pos {
    let pos = t.scenePos.get(this.id);
    if (!pos) {
      const taken = this.tapes()
        .map((o) => o.scenePos.get(this.id))
        .filter((p): p is Pos => !!p);
      for (let k = 0; k < 100; k++) {
        const y = TOP + k * ROW_H;
        if (!taken.some((p) => Math.abs(p.y - y) < ROW_H * 0.6)) {
          pos = { x: LEFT, y };
          break;
        }
      }
      pos = pos ?? { x: LEFT, y: TOP };
      t.scenePos.set(this.id, pos);
    }
    return pos;
  }

  private tapeAt(x: number, y: number): TapeObject | null {
    const list = this.tapes();
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i]!;
      const p = t.scenePos.get(this.id);
      if (p && x >= p.x && x <= p.x + this.tapeW(t) && y >= p.y && y <= p.y + TAPE_H) return t;
    }
    return null;
  }

  /** Шаг шва в пикселях: доля ЕДИНИЦЫ (или всей ленты, если единица не задана). */
  private seamStepPx(t: TapeObject): number {
    const unit = (t.unitLen ?? t.whole).toNumber();
    return (unit / (t.mode ?? 1)) * PX_PER_UNIT;
  }

  /** Ближайший шов линейки к точке x (или null, если мимо). */
  private seamNear(t: TapeObject, x: number): number | null {
    if (t.mode === null) return null;
    const p = t.scenePos.get(this.id);
    if (!p) return null;
    const w = this.tapeW(t);
    const step = this.seamStepPx(t);
    const seam = Math.round((x - p.x) / step);
    const seamX = p.x + seam * step;
    if (seam < 1 || seamX > p.x + w - 2) return null;
    return Math.abs(x - seamX) <= SEAM_HIT ? seam : null;
  }

  /** Существующий рез рядом с точкой x (резы могут стоять и мимо швов линейки). */
  private cutNear(t: TapeObject, x: number): Rational | null {
    const p = t.scenePos.get(this.id);
    if (!p) return null;
    const w = this.tapeW(t);
    for (const c of t.cuts) {
      if (Math.abs(x - (p.x + c.toNumber() * w)) <= SEAM_HIT) return c;
    }
    return null;
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number }): void {
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };
    this.hidePopup();

    if (p.button === 2) {
      this.ctx.dropHand();
      return;
    }
    if (p.button !== 0) return;

    // Молоток в руке: удар по ленте — честный отказ сигнатуры
    if (this.ctx.hand.toolId) {
      const head = hammerHeadPoint(p.x, p.y);
      const hit = this.tapeAt(head.x, head.y) ?? this.tapeAt(p.x, p.y);
      if (hit) {
        this.swing.start();
        this.ctx.hit(hit.id);
      }
      return;
    }

    const t = this.tapeAt(p.x, p.y);
    if (t) {
      const pos = t.scenePos.get(this.id)!;
      this.pending = { tape: t, dx: p.x - pos.x, dy: p.y - pos.y, startX: p.x, startY: p.y, moved: false };
    }
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (this.pending) {
      const d = this.pending;
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > DRAG_THRESHOLD) d.moved = true;
      if (d.moved) {
        d.tape.scenePos.set(this.id, { x: p.x - d.dx, y: p.y - d.dy });
      }
    }
  }

  onPointerUp(p: { x: number; y: number; button: number }): void {
    if (!this.ctx || !this.pending) return;
    const d = this.pending;
    this.pending = null;
    if (d.moved) return; // это было перетаскивание

    // Клик: по резу — склейка, по шву — рез, мимо — карточка настроек
    const cut = this.cutNear(d.tape, p.x);
    if (cut !== null) {
      if (this.ctx.session.mergeTape(d.tape.id, cut)) this.labels.spawn('∪', p.x, p.y - 24);
      return;
    }
    const seam = this.seamNear(d.tape, p.x);
    if (seam !== null) {
      if (this.ctx.session.cutTape(d.tape.id, seam)) this.labels.spawn('✂', p.x, p.y - 24);
    } else {
      this.openPopup(d.tape, p.x, p.y);
    }
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;

    const list = this.tapes();
    if (!list.length) {
      g.fillStyle = theme.textSecondary;
      g.globalAlpha = 0.6;
      g.font = '14px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText('Создай первую ленту в панели слева', w / 2, h * 0.4);
      g.globalAlpha = 1;
    }

    const hovered = this.pointer.inside ? this.tapeAt(this.pointer.x, this.pointer.y) : null;
    for (const t of list) {
      this.drawTape(g, t, hovered === t);
    }

    // Курсор: над швом/резом — «палец» (клик режет/клеит), над полотном — «рука»
    this.canvasEl ??= document.getElementById('stage');
    if (this.canvasEl) {
      let cursor = '';
      if (this.pending?.moved) {
        cursor = 'grabbing';
      } else if (!this.ctx.hand.toolId && hovered) {
        const onSeam =
          this.cutNear(hovered, this.pointer.x) !== null ||
          this.seamNear(hovered, this.pointer.x) !== null;
        cursor = onSeam ? 'pointer' : 'grab';
      }
      this.canvasEl.style.cursor = cursor;
    }

    // Вертикальная линейка-просвет для сравнения лент
    if (this.pointer.inside && list.length > 1) {
      const ys = list.map((t) => this.ensurePos(t).y);
      g.save();
      g.strokeStyle = theme.textSecondary;
      g.globalAlpha = 0.3;
      g.lineWidth = 1;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(this.pointer.x, Math.min(...ys) - 18);
      g.lineTo(this.pointer.x, Math.max(...ys) + TAPE_H + 18);
      g.stroke();
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

  private drawTape(g: CanvasRenderingContext2D, t: TapeObject, hovered: boolean): void {
    const pos = this.ensurePos(t);
    const { x, y } = pos;
    const w = this.tapeW(t);

    g.fillStyle = theme.boxFill(1);
    g.strokeStyle = hovered ? theme.accentBorder : theme.boxStroke(1);
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x, y, w, TAPE_H, 6);
    g.fill();
    g.stroke();

    if (t.mode !== null) {
      // Потенциальные швы линейки — еле заметны, только при наведении
      if (hovered) {
        g.strokeStyle = theme.textSecondary;
        g.globalAlpha = 0.25;
        g.lineWidth = 1;
        const step = this.seamStepPx(t);
        for (let k = 1; ; k++) {
          const sx = x + k * step;
          if (sx > x + w - 2) break;
          const pos = (k * step) / w;
          if (t.cuts.some((c) => Math.abs(c.toNumber() - pos) < 1e-9)) continue;
          g.beginPath();
          g.moveTo(sx, y + 3);
          g.lineTo(sx, y + TAPE_H - 3);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
    }

    // Границы эталонных единиц: отметки «0», «1», «2»… под лентой
    if (t.unitLen && t.unitLen.compare(t.whole) < 0) {
      const uPx = t.unitLen.toNumber() * PX_PER_UNIT;
      g.strokeStyle = theme.accentBorder;
      g.fillStyle = theme.accentBorder;
      g.lineWidth = 2;
      g.font = 'bold 11px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'top';
      for (let j = 0; j * uPx <= w + 1; j++) {
        const ux = x + j * uPx;
        g.beginPath();
        g.moveTo(ux, y + TAPE_H + 2);
        g.lineTo(ux, y + TAPE_H + 10);
        g.stroke();
        g.fillText(String(j), ux, y + TAPE_H + 12);
      }
    }

    // Резы — точки на ленте, живут независимо от линейки
    g.strokeStyle = theme.bgPrimary;
    g.lineWidth = 3;
    for (const c of t.cuts) {
      const sx = x + c.toNumber() * w;
      g.beginPath();
      g.moveTo(sx, y - 4);
      g.lineTo(sx, y + TAPE_H + 4);
      g.stroke();
    }

    // Подписи кусков в текущей линейке
    if (t.mode !== null) {
      const labels = tapePieceLabels(t);
      const bounds = [0, ...t.cuts.map((c) => c.toNumber()), 1];
      g.fillStyle = theme.textPrimary;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i < labels.length; i++) {
        const pieceW = (bounds[i + 1]! - bounds[i]!) * w;
        if (pieceW < 34) continue;
        const cx = x + ((bounds[i]! + bounds[i + 1]!) / 2) * w;
        g.font = `bold ${pieceW < 56 ? 11 : 14}px Inter, sans-serif`;
        g.fillText(labels[i]!, cx, y + TAPE_H / 2);
      }
    }

  }
}
