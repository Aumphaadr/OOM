import { CanvasClient } from '../render/canvasHost';
import { Session } from '../core/session';

/** Рука преподавателя: взятый инструмент (или пустая). Живёт в оболочке, сцены её читают. */
export interface HandState {
  toolId: string | null;
}

/**
 * Ограничения доски. construct=false (запертое упражнение): нельзя создавать
 * и удалять объекты/инструменты — только действовать данными блоками.
 */
export interface Restrictions {
  construct: boolean;
}

/** Контекст, который оболочка выдаёт сцене при подключении. */
export interface SceneContext {
  session: Session;
  hand: HandState;
  restrictions: Restrictions;
  /** Удар по объекту: инструментом в руке или явно указанным (напр., участком конвейера).
   *  Оболочка применяет через сессию — сцена узнаёт результат из журнала, как все. */
  hit(objectId: string, toolId?: string): void;
  /** Положить инструмент (ПКМ). */
  dropHand(): void;
  /** Взять указанный инструмент в руку (сцена возвращает его из своего слота). */
  takeHand(toolId: string): void;
}

/**
 * Сцена — плагин: способ нарисовать объекты сессии и принять жесты.
 * Новая сцена (координатная плоскость, экструзия, весы) = новая реализация
 * этого интерфейса; ядро и существующие сцены не трогаются.
 */
export interface Scene extends CanvasClient {
  readonly id: string;
  readonly title: string;
  attach(ctx: SceneContext): void;
  detach(): void;
  /** Необязательная панель сцены для сайдбара (вызывается после attach). */
  buildPanel?(): HTMLElement | null;
  /**
   * Какие общие панели сайдбара нужны сцене (по умолчанию — все).
   * tools: false прячет молотки (и выбивает инструмент из руки при входе).
   */
  readonly sidebar?: { tools?: boolean; objects?: boolean };
}
