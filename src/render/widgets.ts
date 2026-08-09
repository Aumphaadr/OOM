import { theme } from './theme';

/** Радиус попадания в кнопку удаления. */
export const DELETE_R = 11;

/** Кнопка «✕»: появляется у объекта под курсором, краснеет при наведении. */
export function drawDeleteBadge(g: CanvasRenderingContext2D, x: number, y: number, hot: boolean): void {
  g.save();
  g.fillStyle = theme.bgTertiary;
  g.strokeStyle = hot ? theme.danger : theme.border;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, 9, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = hot ? theme.danger : theme.textSecondary;
  g.font = 'bold 10px Inter, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('✕', x, y + 0.5);
  g.restore();
}
