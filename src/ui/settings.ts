/**
 * Глобальные настройки доски: живут в localStorage, применяются сразу.
 * Настройка — это про ВИД и удобство, не про математику: ничего из этого
 * не влияет на модель, журнал и цели упражнений.
 */

export interface Settings {
  /** Бейдж-счётчик ударов на чипах молотков (методика (−1)ⁿ). */
  showHits: boolean;
  /** Секции сайдбара по умолчанию свёрнуты (разворачиваются кликом по заголовку). */
  panelsCollapsed: boolean;
  /**
   * Дефолтные подписи СВЕЖИХ фигур (прямоугольники, полигоны, круги):
   * у каждой фигуры флаги личные (ПКМ-карточка / галки сцены), настройка
   * задаёт только стартовое значение при создании.
   */
  showAreaDefault: boolean;
  showPerimeterDefault: boolean;
  showAnglesDefault: boolean;
  /** Шлейф истории значений под выделенной коробкой («7 → 10 → …»). */
  showTrail: boolean;
}

const KEY = 'oom-settings-v1';

const DEFAULTS: Settings = {
  showHits: false,
  panelsCollapsed: false,
  showAreaDefault: true,
  showPerimeterDefault: false,
  showAnglesDefault: false,
  showTrail: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // приватный режим без localStorage — настройки живут до перезагрузки
  }
}
