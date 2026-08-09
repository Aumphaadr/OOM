import { Scene, SceneContext } from './scene';
import { theme } from '../render/theme';
import { drawHammer } from '../render/hammer';
import { FlyingLabels, ShakeAnim, SwingAnim, wobbleAngle } from '../render/motion';
import { UnknownObject, exprFor, toolLabel, visibleLabel } from '../core/model';
import { Rational } from '../core/rational';
import { icon } from '../ui/icons';

const BOX_W = 116;
const BOX_H = 88;
const STICKER_H = 22;
const STICKERS_SHOWN = 4;

/**
 * Сцена «Весы»: уравнение как равновесие. Молоток бьёт ТОЛЬКО по обеим чашам
 * сразу — принцип «одинаковые инструменты по одинаковым объектам» зашит в физику.
 * Левая чаша — запертая коробка со стопкой наклеек-операций, правая — число.
 * Снятие всех наклеек открывает замок: x равен правой чаше.
 */
export class ScalesScene implements Scene {
  readonly id = 'scales';
  readonly title = 'Весы';
  readonly sidebar: { tools?: boolean; objects?: boolean } = { objects: false };

  private ctx: SceneContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  private widthPx = 800;
  private heightPx = 600;

  /** Текущее уравнение (одно за раз). */
  private eqId: string | null = null;

  private readonly swing = new SwingAnim();
  private readonly shakeL = new ShakeAnim();
  private readonly shakeR = new ShakeAnim();
  private readonly labels = new FlyingLabels();

  attach(ctx: SceneContext): void {
    this.ctx = ctx;
    // при возвращении в сцену подхватываем существующее уравнение
    if (!this.eqId || !ctx.session.objects.has(this.eqId)) {
      this.eqId = null;
      for (const o of ctx.session.objects.values()) {
        if (o.kind === 'unknown') { this.eqId = o.id; break; }
      }
    }
    this.unsubscribe = ctx.session.on((e) => {
      // Новое уравнение (панель или загрузка упражнения) подхватывается сразу,
      // даже если сцена уже открыта и attach() не перезапускался
      if (e.kind === 'object-spawned' && e.object.kind === 'unknown') {
        this.eqId = e.object.id;
      }
      if (e.kind === 'scales-step' && e.object.id === this.eqId) {
        this.shakeL.start();
        this.shakeR.start();
        const L = this.panCenter(-1);
        const R = this.panCenter(1);
        this.labels.spawn(e.snip ? `✂ ${visibleLabel(e.tool)}` : visibleLabel(e.tool), L.x, L.y - BOX_H);
        this.labels.spawn(visibleLabel(e.tool), R.x, R.y - BOX_H);
      }
      if (e.kind === 'tool-rejected' && e.objectId === this.eqId) {
        this.labels.spawn('⛔', this.pointer.x, this.pointer.y - 30);
      }
      if (e.kind === 'object-removed' && e.objectId === this.eqId) this.eqId = null;
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx = null;
  }

  buildPanel(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>Уравнение</h3>
      <div class="series-row">
        <label class="field">буква<input id="eq-name" value="x" maxlength="2" /></label>
        <label class="field">секрет (значение)<input id="eq-secret" value="" placeholder="?" autocomplete="off" /></label>
      </div>
      <button id="eq-create" class="btn primary"><span class="ic">${icon('scales', 14)}</span>Создать уравнение</button>
      <p class="hint">Коробка запирает секрет; правая чаша уравновешивает его.
        Бей молотками — удар всегда по обеим чашам. «Запутай» уравнение ударами,
        а решение — подбор обратных: точный обратный инструмент снимает верхнюю
        наклейку. Снял все — замок открылся. Наклейку x² снять нельзя — у квадрата
        нет обратного.</p>
    `;
    root.querySelector<HTMLButtonElement>('#eq-create')!.addEventListener('click', () => {
      // в запертом упражнении пересоздание уравнения раскрыло бы секрет
      if (!this.ctx || !this.ctx.restrictions.construct) return;
      const name = (root.querySelector<HTMLInputElement>('#eq-name')!.value.trim() || 'x').slice(0, 2);
      const secretInput = root.querySelector<HTMLInputElement>('#eq-secret')!;
      const secret = Rational.parse(secretInput.value);
      if (!secret) return;
      if (this.eqId) this.ctx.session.removeObject(this.eqId);
      this.eqId = this.ctx.session.spawnUnknown(name, secret).id;
      // Секрет сразу стирается с экрана: ученик, повернувшись, не должен
      // увидеть значение неизвестной в забытом поле ввода
      secretInput.value = '';
    });
    return root;
  }

  private eq(): UnknownObject | null {
    if (!this.ctx || !this.eqId) return null;
    const o = this.ctx.session.objects.get(this.eqId);
    return o?.kind === 'unknown' ? o : null;
  }

  // ---------- геометрия ----------

  private beamY(): number { return this.heightPx * 0.27; }
  private panCenter(side: -1 | 1): { x: number; y: number } {
    const dx = Math.min(this.widthPx * 0.24, 300);
    return { x: this.widthPx / 2 + side * dx, y: this.beamY() + 150 };
  }

  // ---------- ввод ----------

  onPointerDown(p: { x: number; y: number; button: number }): void {
    if (!this.ctx) return;
    this.pointer = { x: p.x, y: p.y, inside: true };

    if (p.button === 2) {
      this.ctx.dropHand();
      return;
    }
    if (p.button !== 0) return;

    if (this.ctx.hand.toolId) {
      this.swing.start();
      const eq = this.eq();
      if (eq) {
        this.ctx.session.scalesApply(eq.id, this.ctx.hand.toolId);
      } else {
        this.labels.spawn('создай уравнение', this.pointer.x, this.pointer.y - 30);
      }
    }
  }

  onPointerMove(p: { x: number; y: number; button: number }): void {
    this.pointer = { x: p.x, y: p.y, inside: true };
  }

  onPointerUp(_p: { x: number; y: number; button: number }): void {}

  // ---------- отрисовка ----------

  render(g: CanvasRenderingContext2D, w: number, h: number, dt: number, now: number): void {
    if (!this.ctx) return;
    this.widthPx = w;
    this.heightPx = h;

    const eq = this.eq();
    if (!eq) {
      g.fillStyle = theme.textSecondary;
      g.globalAlpha = 0.6;
      g.font = '14px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText('Создай уравнение в панели слева', w / 2, h * 0.4);
      g.globalAlpha = 1;
    } else {
      this.drawScales(g, eq, dt);
    }

    this.labels.update(dt);
    this.labels.draw(g, theme.gold);

    const hand = this.ctx.hand.toolId ? this.ctx.session.tools.get(this.ctx.hand.toolId) : null;
    if (hand && this.pointer.inside) {
      const swingAngle = this.swing.update(dt);
      const angle = swingAngle !== 0 ? swingAngle : wobbleAngle(now);
      drawHammer(g, this.pointer.x, this.pointer.y, angle, visibleLabel(hand));
    }
  }

  private drawScales(g: CanvasRenderingContext2D, eq: UnknownObject, dt: number): void {
    const cx = this.widthPx / 2;
    const beamY = this.beamY();
    const L = this.panCenter(-1);
    const R = this.panCenter(1);

    // Стойка и коромысло (баланс — инвариант, коромысло всегда ровное)
    g.strokeStyle = theme.border;
    g.fillStyle = theme.bgTertiary;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 26, L.y + BOX_H / 2 + 42);
    g.lineTo(cx + 26, L.y + BOX_H / 2 + 42);
    g.lineTo(cx, beamY);
    g.closePath();
    g.fill();
    g.stroke();

    g.strokeStyle = theme.metal;
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(L.x, beamY);
    g.lineTo(R.x, beamY);
    g.stroke();
    g.fillStyle = theme.ferrule;
    g.beginPath();
    g.arc(cx, beamY, 7, 0, Math.PI * 2);
    g.fill();

    // Подвесы и чаши
    for (const P of [L, R]) {
      g.strokeStyle = theme.border;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(P.x, beamY);
      g.lineTo(P.x, P.y + BOX_H / 2 + 8);
      g.stroke();
      g.strokeStyle = theme.metal;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(P.x, P.y + BOX_H / 2 - 12, 58, 0.15 * Math.PI, 0.85 * Math.PI);
      g.stroke();
    }

    // Левая чаша: запертая коробка со стопкой наклеек
    this.drawBox(g, eq, L.x, L.y, this.shakeL.update(dt));
    // Правая чаша: число
    this.drawRhs(g, eq, R.x, R.y, this.shakeR.update(dt));

    // Уравнение текстом под основанием весов (вверху его перекрывала панель задания)
    g.fillStyle = eq.revealed ? theme.accent : theme.textSecondary;
    g.font = 'bold 18px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${exprFor(eq)} = ${eq.rhs.toDisplay()}`, cx, L.y + BOX_H / 2 + 74);
  }

  private drawBox(g: CanvasRenderingContext2D, eq: UnknownObject, cx: number, cy: number, shake: number): void {
    g.save();
    if (shake !== 0) {
      g.translate(cx, cy);
      g.rotate(shake);
      g.translate(-cx, -cy);
    }
    const x = cx - BOX_W / 2;
    const y = cy - BOX_H / 2;

    g.fillStyle = eq.revealed ? theme.boxFill(1) : '#3a3222';
    g.beginPath();
    g.roundRect(x, y, BOX_W, BOX_H, 12);
    g.fill();
    g.strokeStyle = eq.revealed ? theme.accentBorder : '#8a7a4a';
    g.lineWidth = 2;
    if (eq.revealed) { g.shadowColor = theme.accentGlow; g.shadowBlur = 16; }
    g.stroke();
    g.shadowBlur = 0;

    // Замок и содержимое
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '16px Inter, sans-serif';
    g.fillStyle = theme.textSecondary;
    g.fillText(eq.revealed ? '🔓' : '🔒', x + 18, y + 14);
    g.fillStyle = theme.textPrimary;
    g.font = 'bold 30px Inter, sans-serif';
    g.fillText(eq.revealed ? eq.secret.toDisplay() : eq.name, cx, cy + 4);

    // Стопка наклеек: последняя — верхняя; лишние прячутся за «+N»
    const shown = eq.ops.slice(-STICKERS_SHOWN);
    const extra = eq.ops.length - shown.length;
    shown.forEach((s, i) => {
      const sy = y - (i + 1) * (STICKER_H + 4) - 2;
      const label = toolLabel(s.op, s.n);
      const isTop = i === shown.length - 1;
      g.fillStyle = theme.bgSecondary;
      g.strokeStyle = isTop ? theme.accentBorder : theme.border;
      g.lineWidth = isTop ? 2 : 1;
      g.beginPath();
      g.roundRect(cx - 34, sy, 68, STICKER_H, 7);
      g.fill();
      g.stroke();
      g.fillStyle = isTop ? theme.accent : theme.textSecondary;
      g.font = 'bold 12px Inter, sans-serif';
      g.fillText(label, cx, sy + STICKER_H / 2 + 0.5);
    });
    if (extra > 0) {
      g.fillStyle = theme.textSecondary;
      g.globalAlpha = 0.6;
      g.font = '11px Inter, sans-serif';
      g.fillText(`ещё ${extra}…`, cx, y - STICKERS_SHOWN * (STICKER_H + 4) - 14);
      g.globalAlpha = 1;
    }
    g.restore();
  }

  private drawRhs(g: CanvasRenderingContext2D, eq: UnknownObject, cx: number, cy: number, shake: number): void {
    g.save();
    if (shake !== 0) {
      g.translate(cx, cy);
      g.rotate(shake);
      g.translate(-cx, -cy);
    }
    const text = eq.rhs.toDisplay();
    const x = cx - BOX_W / 2;
    const y = cy - BOX_H / 2;
    const sign = eq.rhs.sign();

    g.fillStyle = theme.boxFill(sign);
    g.beginPath();
    g.roundRect(x, y, BOX_W, BOX_H, 12);
    g.fill();
    g.strokeStyle = theme.boxStroke(sign);
    g.lineWidth = 2;
    g.stroke();

    g.fillStyle = theme.textPrimary;
    g.font = `bold ${text.length > 6 ? 20 : 28}px Inter, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cx, cy);
    g.restore();
  }
}
