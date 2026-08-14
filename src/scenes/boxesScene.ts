import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer, hammerHeadPoint } from '../render/hammer';
import { FlyingLabels, ShakeAnim, SwingAnim, wobbleAngle } from '../render/motion';
import { NumberObject, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { clipFromObject, spawnFromClip } from '../core/clipboard';
import { drawDeleteBadge, DELETE_R } from '../render/widgets';

const BOX_W = 104;
const BOX_H = 80;
const BOX_R = 15;
const TRAIL_MAX = 5;
const BAND_MIN = 6; // px — меньший прямоугольник считается кликом по пустому месту

interface BoxPos { x: number; y: number }

/**
 * Сцена «Коробки»: значение и его изменение.
 * Модель выделения как в проводнике: клик — выделить, рамка — выделить группу,
 * перетаскивание любого выделенного двигает всю группу, ✕/Delete удаляет группу.
 * Выделенная коробка показывает белую обводку, шлейф истории и крестик удаления.
 */
export class BoxesScene implements Scene {
  readonly id = 'boxes';
  readonly title = 'Коробки';

  private ctx: SceneContext | null = null;
  /** Пан полотна (СКМ, как в GeoGebra): чистая презентация, мир бесконечен. */
  private readonly pan = { x: 0, y: 0 };
  private panDrag: { sx: number; sy: number; bx: number; by: number } | null = null;
  private unsubscribe: (() => void) | null = null;

  private pointer = { x: 0, y: 0, inside: false };
  private readonly selection = new Set<string>();
  /** Рамка выделения (drag по пустому месту); additive — с зажатым Shift. */
  private band: { x0: number; y0: number; x1: number; y1: number; additive: boolean } | null = null;
  /** Групповое перетаскивание: смещение каждой выделенной коробки от курсора. */
  private groupDrag: Map<string, { dx: number; dy: number }> | null = null;
  /** Протяжка ползунка переменной. */
  private sliderDrag: NumberObject | null = null;

  private readonly shakes = new Map<string, ShakeAnim>();
  private readonly swing = new SwingAnim();
  private readonly labels = new FlyingLabels();

  private varCard: HTMLElement | null = null;
  private varCardId: string | null = null;
  private readonly outsideClick = (e: PointerEvent): void => {
    if (this.varCard && !this.varCard.hidden && !this.varCard.contains(e.target as Node)) {
      if ((e.target as HTMLElement).id !== 'stage') this.hideVarCard();
    }
  };

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
        // копия: снимки выделенных со смещениями от якоря группы
        const positions = [...this.selection]
          .map((id) => ({ id, pos: this.posOf(id) }))
          .filter((p): p is { id: string; pos: BoxPos } => !!p.pos);
        if (!positions.length) return;
        e.preventDefault();
        const ax = Math.min(...positions.map((p) => p.pos.x));
        const ay = Math.min(...positions.map((p) => p.pos.y));
        this.ctx.clipboard.items = positions.flatMap(({ id, pos }) => {
          const obj = this.ctx!.session.objects.get(id);
          const item = obj && clipFromObject(obj, pos.x - ax, pos.y - ay);
          return item ? [item] : [];
        });
        if (k === 'KeyX' && this.ctx.restrictions.construct) this.deleteSelection();
      }
      if (k === 'KeyV' && this.ctx.restrictions.construct && this.ctx.clipboard.items.length) {
        e.preventDefault();
        const ax = this.pointer.inside ? this.pointer.x : 120;
        const ay = this.pointer.inside ? this.pointer.y : 120;
        this.selection.clear();
        for (const item of this.ctx.clipboard.items) {
          const obj = spawnFromClip(this.ctx.session, item);
          if (obj.kind === 'number') {
            obj.scenePos.set(this.id, { x: ax + item.dx, y: ay + item.dy });
            this.selection.add(obj.id);
          }
        }
      }
    }
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
    document.addEventListener('pointerdown', this.outsideClick);
    this.buildVarCard();
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'tool-applied') {
        const pos = this.posOf(e.objectId);
        if (pos) {
          // Нейтральные удары (+0, ×1) не трясут коробку: удар был, объект не дрогнул
          if (!e.before.equals(e.after)) this.shakeFor(e.objectId).start();
          this.labels.spawn(visibleLabel(e.tool), pos.x + BOX_W / 2, pos.y);
        }
      }
      if (e.kind === 'tool-rejected') {
        const pos = this.posOf(e.objectId);
        if (pos) this.labels.spawn('✕', pos.x + BOX_W / 2, pos.y);
      }
      if (e.kind === 'object-removed') {
        this.shakes.delete(e.objectId);
        this.selection.delete(e.objectId);
      }
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('pointerdown', this.outsideClick);
    this.varCard?.remove();
    this.varCard = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.band = null;
    this.groupDrag = null;
  }

  private shakeFor(id: string): ShakeAnim {
    let s = this.shakes.get(id);
    if (!s) { s = new ShakeAnim(); this.shakes.set(id, s); }
    return s;
  }

  /** Позиция коробки в этой сцене; новичкам — первое свободное место сетки. */
  private ensurePos(obj: NumberObject, w: number): BoxPos {
    let pos = obj.scenePos.get(this.id);
    if (!pos) {
      pos = this.firstFreeSlot(w);
      obj.scenePos.set(this.id, pos);
    }
    return pos;
  }

  /** Дырки от удалённых коробок занимаются заново. */
  private firstFreeSlot(w: number): BoxPos {
    const perRow = Math.max(1, Math.floor((w - 40) / (BOX_W + 26)));
    const taken: BoxPos[] = [];
    if (this.ctx) {
      for (const o of this.ctx.session.objects.values()) {
        if (o.kind !== 'number') continue;
        const p = o.scenePos.get(this.id);
        if (p) taken.push(p);
      }
    }
    for (let i = 0; i < 500; i++) {
      const x = 30 + (i % perRow) * (BOX_W + 26);
      const y = 96 + Math.floor(i / perRow) * (BOX_H + 58);
      if (!taken.some((t) => Math.abs(t.x - x) < BOX_W * 0.8 && Math.abs(t.y - y) < BOX_H * 0.8)) {
        return { x, y };
      }
    }
    return { x: 30, y: 96 };
  }

  private posOf(objectId: string): BoxPos | null {
    const obj = this.ctx?.session.objects.get(objectId);
    return obj ? (obj.scenePos.get(this.id) ?? null) : null;
  }

  private boxAt(x: number, y: number): NumberObject | null {
    if (!this.ctx) return null;
    const list = [...this.ctx.session.objects.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const obj = list[i]!;
      if (obj.kind !== 'number') continue;
      const p = obj.scenePos.get(this.id);
      if (p && x >= p.x && x <= p.x + BOX_W && y >= p.y && y <= p.y + BOX_H) return obj;
    }
    return null;
  }

  private deleteBadgePos(pos: BoxPos): { x: number; y: number } {
    return { x: pos.x + BOX_W - 4, y: pos.y + 4 };
  }

  /** Протяжка ползунка: позиция курсора → значение в границах переменной. */
  private slideTo(obj: NumberObject, px: number, commit = false): void {
    if (!this.ctx || !obj.variable) return;
    const pos = obj.scenePos.get(this.id);
    if (!pos) return;
    const t = Math.min(Math.max((px - pos.x) / BOX_W, 0), 1);
    const minF = obj.variable.min.toNumber();
    const maxF = obj.variable.max.toNumber();
    const raw = minF + t * (maxF - minF);
    this.ctx.session.setVariableValue(obj.id, Rational.of(Math.round(raw * 1e6), 1e6), commit);
  }

  private buildVarCard(): void {
    const host = document.querySelector('.stage-wrap');
    if (!host) return;
    this.varCard = document.createElement('div');
    this.varCard.className = 'tape-popup';
    this.varCard.hidden = true;
    this.varCard.innerHTML = `
      <div class="task-head"><b>Переменная</b>
        <span class="task-actions"><button id="vc-close" class="btn ghost" title="Закрыть">✕</button></span>
      </div>
      <div class="series-row">
        <label class="field">имя<input id="vc-name" maxlength="2" /></label>
        <label class="field">шаг<input id="vc-step" /></label>
      </div>
      <div class="series-row">
        <label class="field">от<input id="vc-min" /></label>
        <label class="field">до<input id="vc-max" /></label>
      </div>
      <button id="vc-apply" class="btn primary">Применить</button>
      <p id="vc-status" class="hint" hidden></p>
    `;
    host.appendChild(this.varCard);
    this.varCard.querySelector('#vc-close')!.addEventListener('click', () => this.hideVarCard());
    this.varCard.querySelector('#vc-apply')!.addEventListener('click', () => this.applyVarCard());
  }

  private openVarCard(obj: NumberObject, x: number, y: number): void {
    if (!this.varCard || !obj.variable) return;
    this.varCardId = obj.id;
    const q = <T extends HTMLElement>(sel: string) => this.varCard!.querySelector<T>(sel)!;
    q<HTMLInputElement>('#vc-name').value = obj.variable.name;
    q<HTMLInputElement>('#vc-min').value = obj.variable.min.toDisplay();
    q<HTMLInputElement>('#vc-max').value = obj.variable.max.toDisplay();
    q<HTMLInputElement>('#vc-step').value = obj.variable.step.toDisplay();
    q('#vc-status').hidden = true;
    const host = this.varCard.parentElement!;
    this.varCard.hidden = false;
    this.varCard.style.left = `${Math.min(Math.max(x, 10), host.clientWidth - 280)}px`;
    this.varCard.style.top = `${Math.min(Math.max(y + 12, 10), host.clientHeight - 190)}px`;
  }

  private hideVarCard(): void {
    if (this.varCard) this.varCard.hidden = true;
    this.varCardId = null;
  }

  private applyVarCard(): void {
    if (!this.ctx || !this.varCard || !this.varCardId) return;
    const q = <T extends HTMLElement>(sel: string) => this.varCard!.querySelector<T>(sel)!;
    const status = q('#vc-status');
    const name = q<HTMLInputElement>('#vc-name').value.trim() || 'a';
    const min = Rational.parse(q<HTMLInputElement>('#vc-min').value);
    const max = Rational.parse(q<HTMLInputElement>('#vc-max').value);
    const step = Rational.parse(q<HTMLInputElement>('#vc-step').value);
    if (!min || !max || !step) {
      status.textContent = '✗ не понимаю границы или шаг';
      status.hidden = false;
      return;
    }
    if (min.compare(max) >= 0 || step.sign() <= 0) {
      status.textContent = '✗ нужно: от < до, шаг > 0';
      status.hidden = false;
      return;
    }
    this.ctx.session.setVariableDef(this.varCardId, { name, min, max, step });
    this.hideVarCard();
  }

  private deleteSelection(): void {
    if (!this.ctx) return;
    for (const id of [...this.selection]) this.ctx.session.removeObject(id);
    this.selection.clear();
  }

  // ---------- ввод ----------

  onPointerDown(raw: { x: number; y: number; button: number; shift?: boolean }): void {
    if (raw.button === 1) {
      this.panDrag = { sx: raw.x, sy: raw.y, bx: this.pan.x, by: this.pan.y };
      return;
    }
    const p = { ...raw, x: raw.x - this.pan.x, y: raw.y - this.pan.y };
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };

    if (p.button === 2) {
      this.ctx.dropHand();
      return;
    }
    if (p.button !== 0) return;

    if (this.ctx.hand.toolId) {
      this.swing.start();
      const head = hammerHeadPoint(p.x, p.y);
      const target = this.boxAt(head.x, head.y) ?? this.boxAt(p.x, p.y);
      if (target) this.ctx.hit(target.id);
      return;
    }

    this.hideVarCard();

    // Бейдж имени переменной — карточка настроек (имя, границы, шаг)
    for (const obj of this.ctx.session.objects.values()) {
      if (obj.kind !== 'number' || !obj.variable) continue;
      const pos = obj.scenePos.get(this.id);
      if (!pos) continue;
      if (p.x >= pos.x && p.x <= pos.x + 30 && p.y >= pos.y && p.y <= pos.y + 22) {
        this.openVarCard(obj, p.x, p.y);
        return;
      }
    }

    // Ползунок переменной — зона под коробкой (крутить можно и в запертых заданиях)
    for (const obj of this.ctx.session.objects.values()) {
      if (obj.kind !== 'number' || !obj.variable) continue;
      const pos = obj.scenePos.get(this.id);
      if (!pos) continue;
      if (p.x >= pos.x - 6 && p.x <= pos.x + BOX_W + 6 && p.y >= pos.y + BOX_H + 2 && p.y <= pos.y + BOX_H + 18) {
        this.sliderDrag = obj;
        this.slideTo(obj, p.x);
        return;
      }
    }

    const box = this.boxAt(p.x, p.y);
    if (box) {
      // Shift+клик: добавить/убрать из выделения, без перетаскивания
      if (p.shift) {
        if (this.selection.has(box.id)) this.selection.delete(box.id);
        else this.selection.add(box.id);
        return;
      }
      const pos = box.scenePos.get(this.id)!;
      // Крестик на выделенной коробке удаляет всю группу
      if (this.selection.has(box.id)) {
        const b = this.deleteBadgePos(pos);
        if (this.ctx.restrictions.construct && Math.hypot(p.x - b.x, p.y - b.y) <= DELETE_R) {
          this.deleteSelection();
          return;
        }
      } else {
        // Клик по невыделенной — выделяет только её
        this.selection.clear();
        this.selection.add(box.id);
      }
      // Хватание любого выделенного двигает всю группу с теми же оффсетами
      this.groupDrag = new Map();
      for (const id of this.selection) {
        const sp = this.posOf(id);
        if (sp) this.groupDrag.set(id, { dx: p.x - sp.x, dy: p.y - sp.y });
      }
    } else {
      // Пустое место: рамка выделения (с Shift — добавляет к текущему)
      this.band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: !!p.shift };
    }
  }

  onPointerMove(raw: { x: number; y: number; button: number }): void {
    if (this.panDrag) {
      this.pan.x = this.panDrag.bx + (raw.x - this.panDrag.sx);
      this.pan.y = this.panDrag.by + (raw.y - this.panDrag.sy);
      return;
    }
    const p = { ...raw, x: raw.x - this.pan.x, y: raw.y - this.pan.y };
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (this.sliderDrag) {
      this.slideTo(this.sliderDrag, p.x);
      return;
    }
    if (this.groupDrag && this.ctx) {
      for (const [id, off] of this.groupDrag) {
        const obj = this.ctx.session.objects.get(id);
        obj?.scenePos.set(this.id, { x: p.x - off.dx, y: p.y - off.dy });
      }
    }
    if (this.band) {
      this.band.x1 = p.x;
      this.band.y1 = p.y;
    }
  }

  onPointerUp(raw: { x: number; y: number; button: number }): void {
    if (this.panDrag) {
      this.panDrag = null;
      return;
    }
    const p = { ...raw, x: raw.x - this.pan.x, y: raw.y - this.pan.y };
    if (this.sliderDrag) {
      this.slideTo(this.sliderDrag, p.x, true); // фиксация: журнал + субтитр
      this.sliderDrag = null;
      return;
    }
    this.groupDrag = null;
    if (this.band && this.ctx) {
      const x0 = Math.min(this.band.x0, this.band.x1);
      const x1 = Math.max(this.band.x0, this.band.x1);
      const y0 = Math.min(this.band.y0, this.band.y1);
      const y1 = Math.max(this.band.y0, this.band.y1);
      if (!this.band.additive) this.selection.clear();
      if (x1 - x0 > BAND_MIN || y1 - y0 > BAND_MIN) {
        for (const obj of this.ctx.session.objects.values()) {
          if (obj.kind !== 'number') continue;
          const p = obj.scenePos.get(this.id);
          if (p && p.x + BOX_W >= x0 && p.x <= x1 && p.y + BOX_H >= y0 && p.y <= y1) {
            this.selection.add(obj.id);
          }
        }
      }
      this.band = null;
    }
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    g.save();
    g.translate(this.pan.x, this.pan.y);
    this.renderWorld(g, w, h, dt, now);
    g.restore();
  }

  private renderWorld(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;

    this.drawGrid(g, w, h);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    const head = hand ? hammerHeadPoint(this.pointer.x, this.pointer.y) : null;
    const targeted = head ? (this.boxAt(head.x, head.y) ?? this.boxAt(this.pointer.x, this.pointer.y)) : null;

    for (const obj of this.ctx.session.objects.values()) {
      if (obj.kind !== 'number') continue;
      const pos = this.ensurePos(obj, w);
      const shake = this.shakes.get(obj.id)?.update(dt) ?? 0;
      const selected = this.selection.has(obj.id);
      this.drawBox(g, obj, pos, shake, obj === targeted, selected, selected);
    }

    // Крестики на выделенных коробках (рука пуста, конструирование открыто)
    if (!hand && this.ctx.restrictions.construct) {
      for (const id of this.selection) {
        const pos = this.posOf(id);
        if (!pos) continue;
        const b = this.deleteBadgePos(pos);
        drawDeleteBadge(g, b.x, b.y, Math.hypot(this.pointer.x - b.x, this.pointer.y - b.y) <= DELETE_R);
      }
    }

    // Рамка выделения
    if (this.band) {
      const x = Math.min(this.band.x0, this.band.x1);
      const y = Math.min(this.band.y0, this.band.y1);
      const bw = Math.abs(this.band.x1 - this.band.x0);
      const bh = Math.abs(this.band.y1 - this.band.y0);
      g.save();
      g.fillStyle = 'rgba(40, 220, 120, 0.08)';
      g.strokeStyle = theme.accentBorder;
      g.lineWidth = 1;
      g.setLineDash([5, 5]);
      g.fillRect(x, y, bw, bh);
      g.strokeRect(x, y, bw, bh);
      g.restore();
    }

    this.labels.update(dt);
    this.labels.draw(g, theme.gold);

    if (hand && this.pointer.inside) {
      const swingAngle = this.swing.update(dt);
      const angle = swingAngle !== 0 ? swingAngle : wobbleAngle(now);
      drawHammer(g, this.pointer.x, this.pointer.y, angle, visibleLabel(hand));
    }
  }

  private drawGrid(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.strokeStyle = theme.grid;
    g.lineWidth = 1;
    for (let x = 0; x < w; x += theme.gridStep) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    for (let y = 0; y < h; y += theme.gridStep) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
  }

  private drawBox(
    g: CanvasRenderingContext2D,
    obj: NumberObject,
    pos: BoxPos,
    shake: number,
    targeted: boolean,
    selected: boolean,
    showTrail: boolean,
  ): void {
    g.save();
    if (shake !== 0) {
      const cx = pos.x + BOX_W / 2;
      const cy = pos.y + BOX_H / 2;
      g.translate(cx, cy);
      g.rotate(shake);
      g.translate(-cx, -cy);
    }

    const sign = obj.value.sign();
    g.fillStyle = theme.boxFill(sign);
    g.beginPath();
    g.roundRect(pos.x, pos.y, BOX_W, BOX_H, BOX_R);
    g.fill();

    // Грамматика обводок: сплошное — факт, пунктир — прицел, белое — выделено/взято
    if (selected) {
      g.strokeStyle = theme.textPrimary;
      g.lineWidth = 4;
      g.shadowColor = theme.textPrimary;
      g.shadowBlur = 15;
      g.setLineDash([]);
      g.beginPath();
      g.roundRect(pos.x - 3, pos.y - 3, BOX_W + 6, BOX_H + 6, BOX_R + 3);
      g.stroke();
    } else if (targeted) {
      g.strokeStyle = theme.canvasGreen;
      g.lineWidth = 3;
      g.shadowColor = theme.canvasGreen;
      g.shadowBlur = 15;
      g.setLineDash([5, 5]);
      g.beginPath();
      g.roundRect(pos.x - 4, pos.y - 4, BOX_W + 8, BOX_H + 8, BOX_R + 2);
      g.stroke();
    } else {
      g.strokeStyle = theme.boxStroke(sign);
      g.lineWidth = 2;
      g.shadowBlur = 0;
      g.setLineDash([]);
      g.beginPath();
      g.roundRect(pos.x, pos.y, BOX_W, BOX_H, BOX_R);
      g.stroke();
    }
    g.shadowBlur = 0;
    g.setLineDash([]);

    // Значение
    const text = obj.value.toDisplay();
    g.fillStyle = theme.textPrimary;
    g.font = `bold ${text.length > 6 ? 18 : 24}px Inter, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, pos.x + BOX_W / 2, pos.y + BOX_H / 2);

    // Переменная: имя-бейдж и ползунок под коробкой
    if (obj.variable) {
      g.fillStyle = theme.accent;
      g.font = 'bold 13px Inter, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(obj.variable.name, pos.x + 7, pos.y + 5);

      const trackY = pos.y + BOX_H + 10;
      g.strokeStyle = theme.border;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(pos.x, trackY);
      g.lineTo(pos.x + BOX_W, trackY);
      g.stroke();

      const minF = obj.variable.min.toNumber();
      const maxF = obj.variable.max.toNumber();
      const t = maxF > minF ? (obj.value.toNumber() - minF) / (maxF - minF) : 0;
      g.fillStyle = theme.accent;
      g.strokeStyle = theme.accentBorder;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(pos.x + Math.min(Math.max(t, 0), 1) * BOX_W, trackY, 6, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // Шлейф истории — у выделенных, длинный хвост прячем за «…»
    const past = obj.trail.slice(0, -1);
    if (showTrail && past.length) {
      const shown = past.slice(-TRAIL_MAX);
      const prefix = past.length > TRAIL_MAX ? '… → ' : '';
      g.font = '12px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillStyle = theme.textSecondary;
      g.globalAlpha = 0.7;
      const trailText = prefix + shown.map((v) => v.toDisplay()).join(' → ') + ' →';
      g.fillText(trailText, pos.x + BOX_W / 2, pos.y + BOX_H + (obj.variable ? 28 : 16));
      g.globalAlpha = 1;
    }

    g.restore();
  }
}
