import { theme } from './theme';
import { drawIcon } from '../icons';

/** Радиус попадания в кнопку удаления. */
export const DELETE_R = 11;

/** Кнопка-крестик: появляется у объекта под курсором, краснеет при наведении. */
export function drawDeleteBadge(g: CanvasRenderingContext2D, x: number, y: number, hot: boolean): void {
  g.save();
  g.fillStyle = theme.bgTertiary;
  g.strokeStyle = hot ? theme.danger : theme.border;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, 9, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  drawIcon(g, 'x', x, y, 11, hot ? theme.danger : theme.textSecondary);
  g.restore();
}
