/**
 * Анимационные примитивы. Все параметры — из idea/style-notes.md §3,
 * пересчитанные из «прогресс за кадр» в миллисекунды.
 */

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Замах молотка: −35° · sin(easeOut(t)·π), полный цикл ~200 мс. */
export class SwingAnim {
  private elapsed = Infinity;
  static readonly DURATION = 200;

  start(): void { this.elapsed = 0; }

  /** Возвращает угол в радианах (0, когда неактивна). */
  update(dt: number): number {
    if (this.elapsed >= SwingAnim.DURATION) return 0;
    this.elapsed += dt;
    const t = Math.min(this.elapsed / SwingAnim.DURATION, 1);
    return ((-35 * Math.PI) / 180) * Math.sin(easeOutCubic(t) * Math.PI);
  }
}

/** Тряска коробки от удара: 0 → +10° → −20° → 0 за ~220 мс (асимметрия = отдача). */
export class ShakeAnim {
  private elapsed = Infinity;
  static readonly DURATION = 220;

  start(): void { this.elapsed = 0; }

  update(dt: number): number {
    if (this.elapsed >= ShakeAnim.DURATION) return 0;
    this.elapsed += dt;
    const p = Math.min(this.elapsed / ShakeAnim.DURATION, 1);
    const deg =
      p < 0.33 ? 10 * Math.sin(((p / 0.33) * Math.PI) / 2)
      : p < 0.66 ? 10 - 30 * Math.sin((((p - 0.33) / 0.33) * Math.PI) / 2)
      : -20 + 20 * Math.sin((((p - 0.66) / 0.34) * Math.PI) / 2);
    return (deg * Math.PI) / 180;
  }
}

/** Покачивание инструмента в руке: ±1,15°, период ~1,3 с, ось — рукоятка. */
export function wobbleAngle(now: number): number {
  return Math.sin(now * 0.005) * 0.02;
}

/** Разлетающиеся подписи операций — золотые «субтитры удара». */
export interface FlyingLabel {
  text: string;
  x: number;
  y: number;
  vx: number; // px/с
  vy: number;
  life: number; // 1 → 0
}

export class FlyingLabels {
  private labels: FlyingLabel[] = [];

  spawn(text: string, x: number, y: number): void {
    this.labels.push({
      text, x, y,
      vx: (Math.random() - 0.5) * 180,
      vy: -180 - Math.random() * 300,
      life: 1,
    });
  }

  update(dt: number): void {
    const s = dt / 1000;
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const f = this.labels[i]!;
      f.x += f.vx * s;
      f.y += f.vy * s;
      f.vy += 720 * s; // гравитация
      f.vx *= Math.pow(0.55, s); // трение
      f.life -= s / 2; // ~2 секунды жизни
      if (f.life <= 0) this.labels.splice(i, 1);
    }
  }

  draw(g: CanvasRenderingContext2D, gold: string): void {
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const f of this.labels) {
      g.globalAlpha = Math.max(f.life, 0);
      g.font = `bold ${Math.round(20 * (0.8 + f.life * 0.2))}px Inter, sans-serif`;
      g.fillStyle = gold;
      g.shadowColor = 'rgba(255, 215, 0, 0.5)';
      g.shadowBlur = 10;
      g.fillText(f.text, f.x, f.y);
    }
    g.restore();
  }
}

/** Баллистический прыжок фишки: из a в b по параболе за duration мс. */
export class BallisticJump {
  private elapsed = Infinity;

  constructor(
    private from = 0,
    private to = 0,
    private duration = 450,
    private arcHeight = 46,
  ) {}

  start(from: number, to: number): void {
    this.from = from;
    this.to = to;
    this.elapsed = 0;
    // дальний прыжок — чуть дольше и выше, но в разумных пределах
    const dist = Math.abs(to - from);
    this.duration = Math.min(340 + dist * 0.35, 700);
    this.arcHeight = Math.min(28 + dist * 0.12, 80);
  }

  get active(): boolean { return this.elapsed < this.duration; }

  /** Возвращает {x, lift}: x — позиция, lift — подъём вверх (в px, ≥ 0). */
  update(dt: number): { x: number; lift: number } {
    if (!this.active) return { x: this.to, lift: 0 };
    this.elapsed += dt;
    const t = Math.min(this.elapsed / this.duration, 1);
    return {
      x: this.from + (this.to - this.from) * t,
      lift: this.arcHeight * 4 * t * (1 - t), // парабола, максимум в середине
    };
  }
}
