/**
 * Единый словарь цветов для канваса — тот же, что в CSS (см. idea/style-notes.md).
 * Урок старого прототипа: палитра в :root, а на канвасе литералы — здесь не так.
 */
export const theme = {
  bgPrimary: '#070f09',
  bgSecondary: '#101f15',
  bgTertiary: '#192f21',
  border: '#28422c',
  textPrimary: '#ffffff',
  textSecondary: '#cce0d6',

  accent: '#28dc78',
  accentBorder: '#46f591',
  accentGlow: '#5affaa',

  canvasGreen: '#4a9e4a', // обводки покоя и прицела
  danger: '#e74c3c',
  gold: '#ffd700', // разлетающиеся подписи операций

  wood: '#8b6b4d',
  woodDark: '#6f5238',
  metal: '#4a4a4a',
  metalStroke: '#2a2a2a',
  ferrule: '#3a3a3a',

  grid: 'rgba(74, 158, 74, 0.1)',
  gridStep: 50,

  /** Цвет коробки: знак = оттенок, величина — не кодируем (урок из style-notes §7). */
  boxFill(sign: -1 | 0 | 1): string {
    if (sign > 0) return '#1e5c38';
    if (sign < 0) return '#1e3c5c';
    return '#3a3f3a';
  },
  boxStroke(sign: -1 | 0 | 1): string {
    if (sign > 0) return '#3caa5a';
    if (sign < 0) return '#3c7aaa';
    return '#7a7f7a';
  },
} as const;

export type Theme = typeof theme;
