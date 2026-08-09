import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer, hammerHeadPoint } from '../render/hammer';
import { FlyingLabels, ShakeAnim, SwingAnim, wobbleAngle } from '../render/motion';
import { NumberObject, visibleLabel } from '../core/model';
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
  private unsubscribe: (() => void) | null = null;

  private pointer = { x: 0, y: 0, inside: false };
  private readonly selection = new Set<string>();
  /** Рамка выделения (drag по пустому месту); additive — с зажатым Shift. */
  private band: { x0: number; y0: number; x1: number; y1: number; additive: boolean } | null = null;
  /** Групповое перетаскивание: смещение каждой выделенной коробки от курсора. */
  private groupDrag: Map<string, { dx: number; dy: number }> | null = null;

  private readonly shakes = new Map<string, ShakeAnim>();
  private readonly swing = new SwingAnim();
  private readonly labels = new FlyingLabels();

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      this.deleteSelection();
    }
    if (e.key === 'Escape') this.selection.clear();
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
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

  private deleteSelection(): void {
    if (!this.ctx) return;
    for (const id of [...this.selection]) this.ctx.session.removeObject(id);
    this.selection.clear();
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number; shift?: boolean }): void {
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

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
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

  onPointerUp(_p: { x: number; y: number; button: number }): void {
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
      g.fillText(trailText, pos.x + BOX_W / 2, pos.y + BOX_H + 16);
      g.globalAlpha = 1;
    }

    g.restore();
  }
}
