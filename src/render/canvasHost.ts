/**
 * Хост канваса: devicePixelRatio, цикл с dt, нормализация указателя в CSS-пикселях.
 * Все анимации в сценах — от dt/длительности, не «за кадр» (урок из style-notes §7).
 */
export interface PointerInfo {
  x: number;
  y: number;
  button: number; // 0 — левая, 2 — правая
  /** Зажат Shift (или Ctrl/Cmd) — аддитивное выделение. */
  shift: boolean;
}

export interface CanvasClient {
  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void;
  onPointerDown?(p: PointerInfo): void;
  onPointerMove?(p: PointerInfo): void;
  onPointerUp?(p: PointerInfo): void;
  onWheel?(x: number, y: number, deltaY: number): void;
}

export class CanvasHost {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private client: CanvasClient | null = null;
  private lastTime = 0;
  private cssW = 0;
  private cssH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas 2D недоступен');
    this.g = g;

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.client?.onPointerDown?.(this.pointerInfo(e));
    });
    canvas.addEventListener('pointermove', (e) => this.client?.onPointerMove?.(this.pointerInfo(e)));
    canvas.addEventListener('pointerup', (e) => this.client?.onPointerUp?.(this.pointerInfo(e)));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // СКМ — пан сцен: браузерный авто-скролл по средней кнопке не нужен
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.client?.onWheel) return;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.client.onWheel(e.clientX - r.left, e.clientY - r.top, e.deltaY);
    }, { passive: false });

    requestAnimationFrame((t) => this.tick(t));
  }

  setClient(client: CanvasClient): void {
    this.client = client;
  }

  private pointerInfo(e: PointerEvent): PointerInfo {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      button: e.button,
      shift: e.shiftKey || e.ctrlKey || e.metaKey,
    };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width;
    this.cssH = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private tick(t: number): void {
    const dt = this.lastTime ? Math.min(t - this.lastTime, 100) : 16;
    this.lastTime = t;
    this.g.clearRect(0, 0, this.cssW, this.cssH);
    this.client?.render(this.g, this.cssW, this.cssH, dt, t);
    requestAnimationFrame((tt) => this.tick(tt));
  }
}
