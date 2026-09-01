import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer, hammerHeadPoint } from '../render/hammer';
import { FlyingLabels, ShakeAnim, SwingAnim, wobbleAngle } from '../render/motion';
import { NumberObject, visibleLabel, formatVarValue } from '../core/model';
import { clipFromObject, spawnFromClip } from '../core/clipboard';
import { evalConstFormula } from '../core/formula';
import { loadSettings } from '../ui/settings';
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
  /** Зум колесом (к курсору); мир в «мировых пикселях». */
  private zoom = 1;
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
  /** ПКМ-карточка переменной: значение (выражением), запись, видимость. */
  private varCard: HTMLElement | null = null;
  private varCardFor: string | null = null;

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      this.deleteSelection();
    }
    if (e.key === 'Escape') {
      this.selection.clear();
      if (this.varCard) this.varCard.hidden = true;
    }

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
    document.removeEventListener('click', this.varCardOutside);
    this.varCard?.remove();
    this.varCard = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.band = null;
    this.groupDrag = null;
  }

  // ---------- карточка переменной ----------

  private readonly varCardOutside = (ev: MouseEvent): void => {
    if (this.varCard && !this.varCard.hidden && !this.varCard.contains(ev.target as Node)) {
      this.varCard.hidden = true;
    }
  };

  private ensureVarCard(): HTMLElement {
    if (!this.varCard) {
      this.varCard = document.createElement('div');
      this.varCard.className = 'fig-card';
      this.varCard.hidden = true;
      document.body.appendChild(this.varCard);
      document.addEventListener('click', this.varCardOutside);
    }
    return this.varCard;
  }

  private varCardObj(): NumberObject | null {
    const o = this.varCardFor ? this.ctx?.session.objects.get(this.varCardFor) : null;
    return o && o.kind === 'number' && o.variable ? o : null;
  }

  private openVarCard(obj: NumberObject, sx: number, sy: number): void {
    const card = this.ensureVarCard();
    const vr = obj.variable!;
    this.varCardFor = obj.id;
    const f = vr.format;
    card.innerHTML = `
      <div class="fig-card-title">${vr.name} — переменная</div>
      <label class="field" title="Число или выражение: «3+6», «3/8», «sqrt(9)» — считается точно и присваивается ходом (мимо молотков)">значение
        <input class="vc-value" spellcheck="false" /></label>
      <label class="field" title="Формат ЗАПИСИ значения — личная линейка коробки; само значение не меняется">запись
        <select class="vc-kind">
          <option value="dec"${!f || f.kind === 'dec' ? ' selected' : ''}>десятичная</option>
          <option value="frac"${f?.kind === 'frac' ? ' selected' : ''}>дробь /n</option>
        </select></label>
      <label class="field vc-param-label"><span class="vc-param-cap"></span><input class="vc-param" /></label>
      <label class="field tp-check" title="Спрятанное значение — полу-неизвестная: имя видно, содержимое восстанавливают по ударам"><input type="checkbox" class="vc-show"${vr.showValue !== false ? ' checked' : ''}/> показывать значение</label>
    `;
    const valueInp = card.querySelector<HTMLInputElement>('.vc-value')!;
    const kindSel = card.querySelector<HTMLSelectElement>('.vc-kind')!;
    const paramLabel = card.querySelector<HTMLElement>('.vc-param-label')!;
    const paramInp = card.querySelector<HTMLInputElement>('.vc-param')!;
    const showChk = card.querySelector<HTMLInputElement>('.vc-show')!;

    valueInp.value = obj.value.toDisplay();
    const paramCap = paramLabel.querySelector<HTMLElement>('.vc-param-cap')!;
    const syncParam = (): void => {
      const cur = this.varCardObj()?.variable?.format;
      if (kindSel.value === 'dec') {
        paramCap.textContent = 'знаков после запятой';
        paramInp.placeholder = 'авто';
        paramInp.value = cur?.kind === 'dec' && cur.digits !== null ? String(cur.digits) : '';
      } else {
        paramCap.textContent = 'знаменатель';
        paramInp.placeholder = '8';
        paramInp.value = cur?.kind === 'frac' ? String(cur.den) : '';
      }
    };
    syncParam();

    valueInp.addEventListener('change', () => {
      const o = this.varCardObj();
      if (!o) return;
      const v = evalConstFormula(valueInp.value.trim());
      valueInp.classList.toggle('bad', !v);
      if (!v) return;
      this.ctx?.session.setVariableValue(o.id, v, true); // ход мимо молотков
      valueInp.value = o.value.toDisplay(); // границы могли поджать
    });
    const applyFormat = (): void => {
      const o = this.varCardObj();
      if (!o?.variable) return;
      if (kindSel.value === 'dec') {
        const raw = paramInp.value.trim();
        const digits = raw === '' ? null : Math.max(0, Math.min(10, Math.floor(Number(raw)) || 0));
        o.variable.format = { kind: 'dec', digits };
        paramInp.classList.remove('bad');
      } else {
        const den = Math.floor(Number(paramInp.value));
        if (!Number.isFinite(den) || den < 2 || den > 1000) {
          paramInp.classList.add('bad'); // формат не трогаем, пока знаменатель не читается
          return;
        }
        paramInp.classList.remove('bad');
        o.variable.format = { kind: 'frac', den };
      }
    };
    kindSel.addEventListener('change', () => { syncParam(); applyFormat(); });
    paramInp.addEventListener('change', applyFormat);
    showChk.addEventListener('change', () => {
      const o = this.varCardObj();
      if (o?.variable) o.variable.showValue = showChk.checked;
    });

    const stage = document.getElementById('stage')?.getBoundingClientRect();
    card.style.left = `${(stage?.left ?? 0) + sx + 10}px`;
    card.style.top = `${(stage?.top ?? 0) + sy + 10}px`;
    card.hidden = false;
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

  onWheel(x: number, y: number, deltaY: number): void {
    const factor = deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(4, Math.max(0.25, this.zoom * factor));
    const wx = (x - this.pan.x) / this.zoom;
    const wy = (y - this.pan.y) / this.zoom;
    this.pan.x = x - wx * next;
    this.pan.y = y - wy * next;
    this.zoom = next;
  }

  onPointerDown(raw: { x: number; y: number; button: number; shift?: boolean }): void {
    if (raw.button === 1) {
      this.panDrag = { sx: raw.x, sy: raw.y, bx: this.pan.x, by: this.pan.y };
      return;
    }
    const p = { ...raw, x: (raw.x - this.pan.x) / this.zoom, y: (raw.y - this.pan.y) / this.zoom };
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };

    if (p.button === 2) {
      if (this.ctx.hand.toolId) {
        this.ctx.dropHand();
        return;
      }
      // ПКМ по переменной — карточка значения и записи
      const box = this.boxAt(p.x, p.y);
      if (box?.variable) this.openVarCard(box, raw.x, raw.y);
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

  onPointerMove(raw: { x: number; y: number; button: number }): void {
    if (this.panDrag) {
      this.pan.x = this.panDrag.bx + (raw.x - this.panDrag.sx);
      this.pan.y = this.panDrag.by + (raw.y - this.panDrag.sy);
      return;
    }
    const p = { ...raw, x: (raw.x - this.pan.x) / this.zoom, y: (raw.y - this.pan.y) / this.zoom };
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

  onPointerUp(_raw: { x: number; y: number; button: number }): void {
    if (this.panDrag) {
      this.panDrag = null;
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
    g.scale(this.zoom, this.zoom);
    this.renderWorld(g, w, h, dt, now);
    g.restore();
  }

  private renderWorld(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;

    this.drawGrid(g, w, h);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    const head = hand ? hammerHeadPoint(this.pointer.x, this.pointer.y) : null;
    const targeted = head ? (this.boxAt(head.x, head.y) ?? this.boxAt(this.pointer.x, this.pointer.y)) : null;

    // шлейф истории — глобальная настройка (⚙), по умолчанию выключен
    const trailOn = loadSettings().showTrail;
    for (const obj of this.ctx.session.objects.values()) {
      if (obj.kind !== 'number') continue;
      const pos = this.ensurePos(obj, w);
      const shake = this.shakes.get(obj.id)?.update(dt) ?? 0;
      const selected = this.selection.has(obj.id);
      this.drawBox(g, obj, pos, shake, obj === targeted, selected, selected && trailOn);
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
    // покрываем видимую область с учётом пана: полотно бесконечно
    const step = theme.gridStep;
    const left = -this.pan.x / this.zoom;
    const top = -this.pan.y / this.zoom;
    const spanW = w / this.zoom;
    const spanH = h / this.zoom;
    const x0 = Math.floor(left / step) * step;
    const y0 = Math.floor(top / step) * step;
    for (let x = x0; x < left + spanW + step; x += step) {
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + spanH); g.stroke();
    }
    for (let y = y0; y < top + spanH + step; y += step) {
      g.beginPath(); g.moveTo(left, y); g.lineTo(left + spanW, y); g.stroke();
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

    if (obj.variable) {
      // Переменная: лицо коробки — ИМЯ-гравировка, значение — строкой ниже
      // в личном формате записи (спрятанное значение честно не рисуем)
      const showVal = obj.variable.showValue !== false;
      g.fillStyle = theme.textPrimary;
      g.font = 'bold 26px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(obj.variable.name, pos.x + BOX_W / 2, pos.y + BOX_H / 2 - (showVal ? 12 : 0));
      if (showVal) {
        const valText = formatVarValue(obj.value, obj.variable.format);
        g.fillStyle = theme.textSecondary;
        g.font = `${valText.length > 9 ? 12 : 15}px Inter, sans-serif`;
        g.fillText(valText, pos.x + BOX_W / 2, pos.y + BOX_H / 2 + 18);
      }
    } else {
      // Значение
      const text = obj.value.toDisplay();
      g.fillStyle = theme.textPrimary;
      g.font = `bold ${text.length > 6 ? 18 : 24}px Inter, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, pos.x + BOX_W / 2, pos.y + BOX_H / 2);
    }

    // Шлейф истории — у выделенных, длинный хвост прячем за «…».
    // У переменной со спрятанным значением шлейфа нет: он выдал бы тайну.
    const past = obj.trail.slice(0, -1);
    if (showTrail && past.length && (!obj.variable || obj.variable.showValue !== false)) {
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
