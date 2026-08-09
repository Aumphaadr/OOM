import { theme } from './theme';

/**
 * Молоток у курсора. Пластика из style-notes §4: рукоятка-трапеция,
 * боёк со скруглением и муфтой, подпись с гало. Ось вращения — рукоятка.
 */
export const HAMMER = {
  headW: 64,
  headH: 40,
  handleW: 14,
  handleLen: 74,
} as const;

/**
 * Рисует молоток так, чтобы точка (x, y) была центром рукоятки —
 * за неё «держат» (курсор прилипает к рукоятке, как в прототипе).
 * angle — поворот вокруг этой точки (покачивание или замах).
 */
export function drawHammer(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  label: string,
): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);

  const headY = -HAMMER.handleLen / 2 - HAMMER.headH; // боёк над рукояткой
  const hw = HAMMER.handleW;

  // Рукоятка-трапеция (сверху уже, снизу шире срез)
  g.fillStyle = theme.wood;
  g.shadowColor = 'rgba(0, 0, 0, 0.3)';
  g.shadowBlur = 10;
  g.beginPath();
  g.moveTo(-hw / 2 + 2, -HAMMER.handleLen / 2);
  g.lineTo(hw / 2 - 2, -HAMMER.handleLen / 2);
  g.lineTo(hw / 2 - 4, HAMMER.handleLen / 2);
  g.lineTo(-hw / 2 + 4, HAMMER.handleLen / 2);
  g.closePath();
  g.fill();

  // Боёк
  g.fillStyle = theme.metal;
  g.shadowColor = 'rgba(0, 0, 0, 0.5)';
  g.shadowBlur = 15;
  g.beginPath();
  g.roundRect(-HAMMER.headW / 2, headY, HAMMER.headW, HAMMER.headH, 8);
  g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = theme.metalStroke;
  g.lineWidth = 2;
  g.stroke();

  // Муфта между бойком и рукояткой
  g.fillStyle = theme.ferrule;
  g.beginPath();
  g.ellipse(0, headY + HAMMER.headH, 10, 5, 0, 0, Math.PI * 2);
  g.fill();

  // Подпись операции на бойке, с чёрным гало для читаемости
  g.fillStyle = theme.textPrimary;
  g.font = 'bold 18px Inter, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'black';
  g.shadowBlur = 4;
  g.fillText(label, 0, headY + HAMMER.headH / 2);

  g.restore();
}

/** Точка бойка в мировых координатах (для проверки «по кому попадём»). */
export function hammerHeadPoint(x: number, y: number): { x: number; y: number } {
  return { x, y: y - HAMMER.handleLen / 2 - HAMMER.headH / 2 };
}
