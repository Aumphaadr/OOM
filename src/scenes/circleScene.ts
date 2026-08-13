import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer } from '../render/hammer';
import { FlyingLabels, wobbleAngle } from '../render/motion';
import { AngleObject, sinDeg, cosDeg, degMod360, radText, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { icon } from '../ui/icons';

const KNOB_R = 10;
const DRAG_THRESHOLD = 3;
const ANGLE_COLORS = ['#4fc3f7', '#ff9e64', '#9ece6a'];

/**
 * Сцена «Окружность» (серии 41/54): единичная окружность — дом всех углов.
 * Угол — раствор поворота от нулевого луча (против часовой). Точку крутят
 * рукой (транзиент, намотка через ноль честно копится) или молотками:
 * ±n — поворот, ×k — растяжение раствора, ост360 — «где я на окружности».
 * Высота точки — синус, тень на полу — косинус (≈-политика корней).
 */
export class CircleScene implements Scene {
  readonly id = 'circle';
  readonly title = 'Окружность';
  readonly sidebar: { tools?: boolean; objects?: boolean } = { objects: false };

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private widthPx = 800;
  private heightPx = 600;

  private readonly selection = new Set<string>();
  private gesture:
    | { type: 'spin'; id: string; startX: number; startY: number; moved: boolean; wasSelected: boolean }
    | null = null;
  private shiftDown = false;
  private pointer = { x: 0, y: 0, inside: false };
  private readonly labels = new FlyingLabels();

  private showSin = true;
  private showCos = false;
  private showWave = false;
  private showRad = false;

  private readonly keyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    this.shiftDown = e.shiftKey;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx?.restrictions.construct) {
      e.preventDefault();
      for (const id of [...this.selection]) this.ctx.session.removeObject(id);
      this.selection.clear();
    }
    if (e.key === 'Escape') this.selection.clear();
  };
  private readonly keyUpHandler = (e: KeyboardEvent): void => {
    this.shiftDown = e.shiftKey;
  };

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('keyup', this.keyUpHandler);
    this.unsubscribe = ctx.session.on((e) => {
      if (e.kind === 'object-removed') this.selection.delete(e.objectId);
    });
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('keyup', this.keyUpHandler);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
    this.gesture = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Углы</h3>
      <div class="series-row">
        <label class="field">°<input id="an-deg" value="30" /></label>
        <button id="an-spawn" class="btn primary"><span class="ic">${icon('plus', 12)}</span>Угол</button>
      </div>
      <label class="field tp-check"><input type="checkbox" id="an-sin" checked /> высота (синус)</label>
      <label class="field tp-check"><input type="checkbox" id="an-cos" /> тень (косинус)</label>
      <label class="field tp-check"><input type="checkbox" id="an-wave" /> размотать в волну</label>
      <label class="field tp-check"><input type="checkbox" id="an-rad" /> вторая линейка: радианы</label>
      <p class="hint">Крути точку за ручку — угол растёт против часовой,
        протащишь через ноль — намотка честно копится (370° ≠ 10°, хотя место
        одно). Снап к 1°, с Shift — к 15°. Молотки: ±n° — поворот, ×k —
        растяжение раствора, ост360 — «где я на окружности».</p>
    `;
    root.querySelector<HTMLButtonElement>('#an-spawn')!.addEventListener('click', () => {
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const deg = Rational.parse(root.querySelector<HTMLInputElement>('#an-deg')!.value);
      if (deg) this.ctx.session.spawnAngle(deg);
    });
    const bindCheck = (id: string, set: (v: boolean) => void): void => {
      root.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener('change', (e) => {
        set((e.target as HTMLInputElement).checked);
      });
    };
    bindCheck('an-sin', (v) => { this.showSin = v; });
    bindCheck('an-cos', (v) => { this.showCos = v; });
    bindCheck('an-wave', (v) => { this.showWave = v; });
    bindCheck('an-rad', (v) => { this.showRad = v; });
    return root;
  }

  // ---------- геометрия ----------

  private angles(): AngleObject[] {
    if (!this.ctx) return [];
    return [...this.ctx.session.objects.values()].filter((o): o is AngleObject => o.kind === 'angle');
  }

  private center(): { x: number; y: number; r: number } {
    // с волной окружность уезжает влево и ужимается — справа место размотке
    if (this.showWave) {
      return {
        x: this.widthPx * 0.18,
        y: this.heightPx * 0.5,
        r: Math.min(this.widthPx * 0.13, this.heightPx * 0.3),
      };
    }
    return {
      x: this.widthPx * 0.5,
      y: this.heightPx * 0.52,
      r: Math.min(this.widthPx, this.heightPx) * 0.36,
    };
  }

  private knobPos(a: AngleObject): { x: number; y: number } {
    const { x, y, r } = this.center();
    const rad = (a.deg.toNumber() * Math.PI) / 180;
    return { x: x + Math.cos(rad) * r, y: y - Math.sin(rad) * r };
  }

  private knobAt(sx: number, sy: number): AngleObject | null {
    for (const a of this.angles().reverse()) {
      const p = this.knobPos(a);
      if (Math.hypot(p.x - sx, p.y - sy) <= KNOB_R + 4) return a;
    }
    return null;
  }

  /** Курсор → градусы в [0; 360) со снапом (1°, с Shift — 15°). */
  private pointerDeg(sx: number, sy: number): number {
    const { x, y } = this.center();
    let deg = (Math.atan2(y - sy, sx - x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const step = this.shiftDown ? 15 : 1;
    return ((Math.round(deg / step) * step) % 360 + 360) % 360;
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number }): void {
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (p.button === 2) {
      if (this.ctx.hand.toolId) this.ctx.dropHand();
      return;
    }
    if (p.button !== 0) return;

    const knob = this.knobAt(p.x, p.y);
    if (this.ctx.hand.toolId) {
      if (knob) {
        const tool = this.ctx.session.tools.get(this.ctx.hand.toolId);
        this.ctx.hit(knob.id);
        this.labels.spawn(tool ? visibleLabel(tool) : '⚒', p.x, p.y - 10);
      }
      return;
    }
    if (knob) {
      this.gesture = {
        type: 'spin', id: knob.id, startX: p.x, startY: p.y, moved: false,
        wasSelected: this.selection.has(knob.id),
      };
    }
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (!this.ctx || !this.gesture) return;
    const g = this.gesture;
    if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) < DRAG_THRESHOLD) return;
    g.moved = true;
    const next = this.spunDeg(g.id, p.x, p.y);
    if (next) this.ctx.session.setAngleDeg(g.id, next, false); // транзиент
  }

  onPointerUp(p: { x: number; y: number; button: number }): void {
    if (!this.ctx || !this.gesture) return;
    const g = this.gesture;
    this.gesture = null;
    if (g.moved) {
      const next = this.spunDeg(g.id, p.x, p.y);
      if (next) this.ctx.session.setAngleDeg(g.id, next, true); // коммит
      return;
    }
    if (!g.wasSelected) {
      this.selection.clear();
      this.selection.add(g.id);
    } else {
      this.selection.delete(g.id);
    }
  }

  /**
   * Новый угол при вращении: к текущему значению добавляется КРАТЧАЙШИЙ
   * доворот до курсора — протаскивание по кругу честно наматывает обороты.
   */
  private spunDeg(id: string, sx: number, sy: number): Rational | null {
    const a = this.ctx?.session.objects.get(id);
    if (!a || a.kind !== 'angle') return null;
    const target = this.pointerDeg(sx, sy);
    const cur = degMod360(a.deg).toNumber();
    let delta = target - cur;
    if (delta > 180) delta -= 360;
    if (delta <= -180) delta += 360;
    return a.deg.add(Rational.of(Math.round(delta * 100), 100));
  }

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;
    this.widthPx = w;
    this.heightPx = h;
    this.labels.update(dt);
    const { x: cx, y: cy, r } = this.center();

    // Оси и окружность
    g.strokeStyle = theme.border;
    g.lineWidth = 1;
    g.globalAlpha = 0.7;
    for (let d = 0; d < 360; d += 30) {
      const rad = (d * Math.PI) / 180;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(rad) * r, cy - Math.sin(rad) * r);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.strokeStyle = theme.textSecondary;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - r - 30, cy); g.lineTo(cx + r + 30, cy); g.stroke();
    g.beginPath(); g.moveTo(cx, cy - r - 30); g.lineTo(cx, cy + r + 30); g.stroke();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();

    // Подписи осей: единичный размах
    g.fillStyle = theme.textSecondary;
    g.font = '11px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText('1', cx + r, cy + 6);
    g.fillText('−1', cx - r, cy + 6);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillText('1', cx - 6, cy - r);
    g.fillText('−1', cx - 6, cy + r);

    // Волна-размотка (до углов: их точки ложатся поверх)
    if (this.showWave) this.drawWave(g, w);

    // Углы
    const list = this.angles();
    for (let i = 0; i < list.length; i++) {
      this.drawAngle(g, list[i]!, ANGLE_COLORS[i % ANGLE_COLORS.length]!, i);
    }

    this.labels.draw(g, theme.gold);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    if (hand && this.pointer.inside) {
      drawHammer(g, this.pointer.x, this.pointer.y, wobbleAngle(now), visibleLabel(hand));
    }
  }

  /** Диапазон размотки и перевод «градусы → экран» для волны. */
  private waveGeom(w: number): { x0: number; x1: number; degMin: number; degMax: number;
    sx: (d: number) => number; sy: (v: number) => number } {
    const { x: cx, y: cy, r } = this.center();
    const x0 = cx + r + 46;
    const x1 = w - 30;
    const degMin = -90;
    const degMax = 750;
    return {
      x0, x1, degMin, degMax,
      sx: (d) => x0 + ((d - degMin) / (degMax - degMin)) * (x1 - x0),
      sy: (v) => cy - v * r, // амплитуда волны = радиус: окружность и волна одного роста
    };
  }

  /**
   * Размотка окружности в линию: по горизонтали — пройденный угол (намотка
   * честно уводит вправо за 360°), по вертикали — высота. Уровень высоты
   * выделенного угла пересекает волну бесконечно: семейство углов-двойников.
   */
  private drawWave(g: CanvasRenderingContext2D, w: number): void {
    const { y: cy } = this.center();
    const { x0, x1, degMin, degMax, sx, sy } = this.waveGeom(w);

    // Ось размотки с насечками каждые 90°
    g.strokeStyle = theme.textSecondary;
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x0 - 8, cy); g.lineTo(x1, cy); g.stroke();
    g.fillStyle = theme.textSecondary;
    g.font = '10px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let d = Math.ceil(degMin / 90) * 90; d <= degMax; d += 90) {
      const x = sx(d);
      g.beginPath(); g.moveTo(x, cy - 3); g.lineTo(x, cy + 3); g.stroke();
      g.fillText(`${d}°`, x, cy + 6);
      if (this.showRad) g.fillText(radText(Rational.of(d)), x, cy + 18);
      if (d % 360 === 0) { // граница круга — слабая вертикаль
        g.globalAlpha = 0.25;
        g.beginPath(); g.moveTo(x, sy(1)); g.lineTo(x, sy(-1)); g.stroke();
        g.globalAlpha = 1;
      }
    }

    // Сама волна (float только для отрисовки)
    g.strokeStyle = theme.textSecondary;
    g.lineWidth = 2;
    g.globalAlpha = 0.75;
    g.beginPath();
    for (let x = x0; x <= x1; x += 2) {
      const d = degMin + ((x - x0) / (x1 - x0)) * (degMax - degMin);
      const y = sy(Math.sin((d * Math.PI) / 180));
      if (x === x0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.globalAlpha = 1;

    // Точки углов на волне + связь с окружностью
    const list = this.angles();
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const d = a.deg.toNumber();
      if (d < degMin || d > degMax) continue;
      const color = ANGLE_COLORS[i % ANGLE_COLORS.length]!;
      const v = Math.sin((d * Math.PI) / 180);
      const px = sx(d);
      const py = sy(v);
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(px, cy); g.lineTo(px, py); g.stroke();
      if (this.selection.has(a.id)) {
        // горизонталь от точки на окружности к её двойнику на волне
        const knob = this.knobPos(a);
        g.beginPath(); g.moveTo(knob.x, knob.y); g.lineTo(px, py); g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = color;
      g.beginPath(); g.arc(px, py, 5.5, 0, Math.PI * 2); g.fill();
    }

    // Уровень высоты выделенного угла: все дома, где живёт эта высота
    const sel = list.find((a) => this.selection.has(a.id));
    if (sel) {
      const sin = sinDeg(sel.deg);
      const a = sin.v.toNumber();
      g.strokeStyle = theme.gold;
      g.lineWidth = 1.5;
      g.setLineDash([6, 5]);
      g.beginPath(); g.moveTo(x0, sy(a)); g.lineTo(x1, sy(a)); g.stroke();
      g.setLineDash([]);
      // пересечения уровня с волной: d = base + 360k и (180 − base) + 360k
      if (Math.abs(a) <= 1) {
        const base = (Math.asin(a) * 180) / Math.PI;
        g.strokeStyle = theme.gold;
        g.lineWidth = 2;
        for (let k = -3; k <= 3; k++) {
          for (const d of [base + 360 * k, 180 - base + 360 * k]) {
            if (d < degMin || d > degMax) continue;
            g.beginPath(); g.arc(sx(d), sy(a), 5, 0, Math.PI * 2); g.stroke();
          }
        }
      }
      g.fillStyle = theme.gold;
      g.font = 'bold 11px Inter, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText(
        `высота ${sin.exact ? '' : '≈ '}${sin.v.toDisplay()} — все дома этой высоты`,
        x0 + 4, sy(a) - 4,
      );
    }
  }

  private drawAngle(g: CanvasRenderingContext2D, a: AngleObject, color: string, index: number): void {
    const { x: cx, y: cy } = this.center();
    const selected = this.selection.has(a.id);
    const knob = this.knobPos(a);
    const place = degMod360(a.deg).toNumber();
    const rad = (place * Math.PI) / 180;

    // Дуга раствора (по месту) + луч
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.globalAlpha = 0.85;
    g.beginPath();
    g.arc(cx, cy, 26 + index * 8, 0, -rad, true);
    g.stroke();
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(knob.x, knob.y);
    g.stroke();
    g.globalAlpha = 1;

    // Высота (синус) — вертикаль от точки до пола
    if (this.showSin) {
      const sin = sinDeg(a.deg);
      g.strokeStyle = theme.gold;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(knob.x, knob.y);
      g.lineTo(knob.x, cy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = theme.gold;
      g.font = 'bold 12px Inter, sans-serif';
      g.textAlign = knob.x >= cx ? 'left' : 'right';
      g.textBaseline = 'middle';
      g.fillText(
        `высота ${sin.exact ? '=' : '≈'} ${sin.v.toDisplay()}`,
        knob.x + (knob.x >= cx ? 8 : -8), (knob.y + cy) / 2,
      );
    }

    // Тень (косинус) — горизонталь ИЗ ТОЧКИ до оси Y (зеркальный близнец высоты)
    if (this.showCos) {
      const cos = cosDeg(a.deg);
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(knob.x, knob.y);
      g.lineTo(cx, knob.y);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = color;
      g.font = 'bold 12px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = knob.y >= cy ? 'top' : 'bottom';
      g.fillText(
        `тень ${cos.exact ? '=' : '≈'} ${cos.v.toDisplay()}`,
        (cx + knob.x) / 2, knob.y + (knob.y >= cy ? 8 : -8),
      );
    }

    // Ручка-точка
    g.fillStyle = selected ? theme.accent : theme.bgTertiary;
    g.strokeStyle = selected ? theme.accentBorder : color;
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(knob.x, knob.y, KNOB_R, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    if (selected) {
      g.shadowColor = theme.accentGlow;
      g.shadowBlur = 10;
      g.stroke();
      g.shadowBlur = 0;
    }

    // Подпись: значение + намотка
    const laps = Math.trunc((a.deg.toNumber() - place) / 360);
    const lapsTxt = laps !== 0 ? ` (${laps} об. + ${degMod360(a.deg).toDisplay()}°)` : '';
    g.fillStyle = selected ? theme.accent : theme.textPrimary;
    g.font = 'bold 12px Inter, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    const off = knob.x >= cx ? 12 : -80;
    g.fillText(`${a.label} = ${a.deg.toDisplay()}°${lapsTxt}`, knob.x + off, knob.y - 12);
    if (this.showRad) {
      g.font = '11px Inter, sans-serif';
      g.fillText(`= ${radText(a.deg)} рад`, knob.x + off, knob.y + 2);
    }
  }
}
