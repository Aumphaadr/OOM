import { Rational } from './rational';
import {
  MathObject, NumberObject, TapeObject, UnknownObject, RectObject, Tool,
  makeTool, makeCompositeTool, toolInvertsSticker, exprFor, toolLabel,
  tapePieceLabels, tapeNumerator, rectPieceAreas, PrimitiveOp,
} from './model';

/**
 * Журнал событий — единственный канал изменений модели.
 * Сцены, субтитры и будущие режимы (лаборатория, домашка, диагностика)
 * подписываются на него, а не лезут в состояние напрямую.
 */
export type SessionEvent =
  | { kind: 'object-spawned'; object: MathObject }
  | { kind: 'object-removed'; objectId: string; note: string }
  | { kind: 'tool-added'; tool: Tool }
  | { kind: 'tool-changed'; tool: Tool }
  | { kind: 'tool-removed'; toolId: string; note: string }
  | { kind: 'tool-applied'; objectId: string; tool: Tool; before: Rational; after: Rational }
  | { kind: 'tool-rejected'; objectId: string; tool: Tool; reason: string }
  | { kind: 'tape-changed'; object: TapeObject; note: string }
  | { kind: 'tape-refused'; object: TapeObject; reason: string }
  | { kind: 'scales-step'; object: UnknownObject; tool: Tool; snip: boolean; note: string }
  | { kind: 'var-set'; object: NumberObject; note: string }
  | { kind: 'rect-changed'; object: RectObject; note: string }
  | { kind: 'undo'; objectId: string; note: string };

export type SessionListener = (e: SessionEvent) => void;

interface TapeState {
  mode: number | null;
  cuts: Rational[];
  whole: Rational;
  strictGrid: boolean;
  unitLen: Rational | null;
}
interface UnknownState { ops: { op: PrimitiveOp; n: Rational }[]; rhs: Rational; revealed: boolean }

interface RectState { w: Rational; h: Rational; cutsX: Rational[]; cutsY: Rational[] }

type LogEntry =
  | { objectId: string; kind: 'number'; before: Rational; after: Rational }
  | { objectId: string; kind: 'tape'; before: TapeState; after: TapeState }
  | { objectId: string; kind: 'unknown'; before: UnknownState; after: UnknownState }
  | { objectId: string; kind: 'rect'; before: RectState; after: RectState };

const TAPE_MODE_MIN = 1; // «/1» — целая лента без швов, резать нечего
const TAPE_MODE_MAX = 100;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export class Session {
  readonly objects = new Map<string, MathObject>();
  readonly tools = new Map<string, Tool>();
  /** Лог применений — источник для undo и для будущего воспроизведения. */
  private readonly applyLog: LogEntry[] = [];
  private readonly listeners = new Set<SessionListener>();
  private tapeCounter = 0;

  on(fn: SessionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent): void {
    this.listeners.forEach((fn) => fn(e));
  }

  // ---------- объекты ----------

  spawnObject(value: Rational): NumberObject {
    const obj: NumberObject = {
      kind: 'number',
      id: nextId('obj'),
      value,
      trail: [value],
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    return obj;
  }

  spawnVariable(name: string, min: Rational, max: Rational, step: Rational): NumberObject {
    const obj = this.spawnObject(Rational.of(0));
    obj.variable = { name, min, max, step };
    // стартовое значение — ноль, зажатый в границы
    obj.value = this.clampToVariable(obj, Rational.of(0));
    obj.trail.splice(0, obj.trail.length, obj.value);
    return obj;
  }

  private clampToVariable(obj: NumberObject, v: Rational): Rational {
    const vr = obj.variable!;
    if (v.compare(vr.min) < 0) return vr.min;
    if (v.compare(vr.max) > 0) return vr.max;
    // прищёлкиваем к сетке min + k·step
    const k = v.sub(vr.min).div(vr.step);
    const snapped = Rational.of((k.num * 2n + k.den) / (k.den * 2n)); // округление к ближайшему
    return vr.min.add(snapped.mul(vr.step));
  }

  /** База значения на время протяжки ползунка (для одной записи в журнал). */
  private readonly varDragBase = new Map<string, Rational>();

  /**
   * Установка значения переменной. commit=false — тихая протяжка ползунка;
   * commit=true (отпускание) — одна запись в журнал и один субтитр.
   */
  setVariableValue(objectId: string, v: Rational, commit = true): boolean {
    const obj = this.objects.get(objectId);
    if (!obj || obj.kind !== 'number' || !obj.variable) return false;
    if (!this.varDragBase.has(objectId)) this.varDragBase.set(objectId, obj.value);
    obj.value = this.clampToVariable(obj, v);

    if (commit) {
      const before = this.varDragBase.get(objectId)!;
      this.varDragBase.delete(objectId);
      if (!before.equals(obj.value)) {
        obj.trail.push(obj.value);
        this.applyLog.push({ objectId, kind: 'number', before, after: obj.value });
        this.emit({ kind: 'var-set', object: obj, note: `${obj.variable.name} = ${obj.value.toDisplay()}` });
      }
    }
    return true;
  }

  /**
   * Настройка переменной: имя, границы, шаг. Значение перезажимается
   * в новые рамки (с записью в журнал, если оно изменилось).
   */
  setVariableDef(objectId: string, def: { name: string; min: Rational; max: Rational; step: Rational }): boolean {
    const obj = this.objects.get(objectId);
    if (!obj || obj.kind !== 'number' || !obj.variable) return false;
    if (def.min.compare(def.max) >= 0 || def.step.sign() <= 0) return false;
    obj.variable = { ...def };
    const before = obj.value;
    const clamped = this.clampToVariable(obj, obj.value);
    if (!clamped.equals(before)) {
      obj.value = clamped;
      obj.trail.push(clamped);
      this.applyLog.push({ objectId, kind: 'number', before, after: clamped });
    }
    this.emit({
      kind: 'var-set',
      object: obj,
      note: `${def.name}: диапазон ${def.min.toDisplay()}…${def.max.toDisplay()}, шаг ${def.step.toDisplay()}`,
    });
    return true;
  }

  spawnTape(whole: Rational, mode: number | null, label?: string): TapeObject {
    if (label) {
      // восстановление из сохранения: не даём счётчику выдать дубль
      const m = label.match(/^Л(\d+)$/);
      if (m) this.tapeCounter = Math.max(this.tapeCounter, Number(m[1]));
    }
    const obj: TapeObject = {
      kind: 'tape',
      id: nextId('tape'),
      label: label ?? `Л${++this.tapeCounter}`,
      whole,
      mode: mode !== null ? Math.min(Math.max(Math.round(mode), TAPE_MODE_MIN), TAPE_MODE_MAX) : null,
      unitLen: null,
      cuts: [],
      strictGrid: true,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    return obj;
  }

  spawnUnknown(name: string, secret: Rational): UnknownObject {
    const obj: UnknownObject = {
      kind: 'unknown',
      id: nextId('unk'),
      name,
      secret,
      ops: [],
      rhs: secret,
      revealed: false,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    return obj;
  }

  removeObject(id: string, quiet = false): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    const note = quiet ? ''
      : obj.kind === 'tape' ? `${this.tapeName(obj)} удалена`
      : obj.kind === 'unknown' ? `уравнение с «${obj.name}» убрано`
      : obj.kind === 'rect' ? `${obj.label} удалён`
      : `число ${obj.value.toDisplay()} удалено`;
    this.objects.delete(id);
    this.emit({ kind: 'object-removed', objectId: id, note });
  }

  /** Полная очистка доски (для загрузки урока/сохранения): события тихие. */
  clearAll(): void {
    for (const id of [...this.objects.keys()]) this.removeObject(id, true);
    for (const id of [...this.tools.keys()]) this.removeTool(id, true);
    this.applyLog.length = 0;
  }

  // ---------- инструменты ----------

  addTool(op: PrimitiveOp, n: Rational): Tool {
    const tool = makeTool(op, n, nextId('tool'));
    this.tools.set(tool.id, tool);
    this.emit({ kind: 'tool-added', tool });
    return tool;
  }

  /** Комбо: последовательность примитивных шагов под одним именем. */
  addComposite(steps: { op: PrimitiveOp; n: Rational }[], name?: string): Tool {
    const tool = makeCompositeTool(steps, name, nextId('combo'));
    this.tools.set(tool.id, tool);
    this.emit({ kind: 'tool-added', tool });
    return tool;
  }

  removeTool(toolId: string, quiet = false): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    this.tools.delete(toolId);
    this.emit({ kind: 'tool-removed', toolId, note: quiet ? '' : `молоток ${tool.label} выброшен` });
  }

  /** Включить/выключить «чёрный ящик» у инструмента (с оповещением подписчиков). */
  setToolHidden(toolId: string, hidden: boolean): void {
    const tool = this.tools.get(toolId);
    if (!tool || tool.hidden === hidden) return;
    tool.hidden = hidden;
    this.emit({ kind: 'tool-changed', tool });
  }

  applyTool(toolId: string, objectId: string): boolean {
    const tool = this.tools.get(toolId);
    const obj = this.objects.get(objectId);
    if (!tool || !obj) return false;
    if (obj.kind !== 'number') {
      // Сигнатура по типам: числовой молоток не бьёт по лентам
      this.emit({ kind: 'tool-rejected', objectId, tool, reason: 'этот инструмент бьёт только по числам' });
      return false;
    }
    return this.applyWith(tool, obj);
  }

  /**
   * Применить инструмент задом наперёд (реверс конвейера, «отмотка» руками).
   * Если обратного инструмента не существует (например, ×0) — честный отказ.
   */
  applyInverse(toolId: string, objectId: string): boolean {
    const tool = this.tools.get(toolId);
    const obj = this.objects.get(objectId);
    if (!tool || !obj) return false;
    if (obj.kind !== 'number') {
      this.emit({ kind: 'tool-rejected', objectId, tool, reason: 'этот инструмент бьёт только по числам' });
      return false;
    }

    // Обратный комбо: обращённые шаги в обратном порядке — (f∘g)⁻¹ = g⁻¹∘f⁻¹
    if (tool.steps) {
      const invSteps: { op: PrimitiveOp; n: Rational }[] = [];
      for (const s of [...tool.steps].reverse()) {
        const spec = makeTool(s.op, s.n).inverseSpec();
        if (!spec) {
          this.emit({
            kind: 'tool-rejected',
            objectId,
            tool,
            reason: `в комбо есть необратимый шаг «${toolLabel(s.op, s.n)}»`,
          });
          return false;
        }
        invSteps.push(spec);
      }
      const inverse = makeCompositeTool(invSteps);
      inverse.hidden = tool.hidden;
      return this.applyWith(inverse, obj);
    }

    const spec = tool.inverseSpec();
    if (!spec) {
      this.emit({
        kind: 'tool-rejected',
        objectId,
        tool,
        reason: 'задним ходом не работает — обратного инструмента не существует',
      });
      return false;
    }
    const inverse = makeTool(spec.op, spec.n);
    inverse.hidden = tool.hidden;
    return this.applyWith(inverse, obj);
  }

  private applyWith(tool: Tool, obj: NumberObject): boolean {
    const refusal = tool.canApply(obj.value);
    if (refusal !== null) {
      this.emit({ kind: 'tool-rejected', objectId: obj.id, tool, reason: refusal });
      return false;
    }

    const before = obj.value;
    const after = tool.apply(before);
    obj.value = after;
    obj.trail.push(after);
    this.applyLog.push({ objectId: obj.id, kind: 'number', before, after });
    this.emit({ kind: 'tool-applied', objectId: obj.id, tool, before, after });
    return true;
  }

  // ---------- прямоугольники ----------

  private rectCounter = 0;

  spawnRect(w: Rational, h: Rational): RectObject {
    const obj: RectObject = {
      kind: 'rect',
      id: nextId('rect'),
      label: `П${++this.rectCounter}`,
      w,
      h,
      cutsX: [],
      cutsY: [],
      showW: true,
      showH: true,
      showArea: true,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    return obj;
  }

  private rectState(r: RectObject): RectState {
    return { w: r.w, h: r.h, cutsX: [...r.cutsX], cutsY: [...r.cutsY] };
  }

  private rectNote(r: RectObject): string {
    if (r.h.isZero()) return `${r.label}: отрезок длины ${r.w.toDisplay()}`;
    const areas = rectPieceAreas(r);
    const body = `${r.label}: ${r.w.toDisplay()}×${r.h.toDisplay()}, площадь ${r.w.mul(r.h).toDisplay()}`;
    return areas.length > 1 ? `${body} = ${areas.map((a) => a.toDisplay()).join(' + ')}` : body;
  }

  private commitRect(r: RectObject, before: RectState, note: string): true {
    this.applyLog.push({ objectId: r.id, kind: 'rect', before, after: this.rectState(r) });
    this.emit({ kind: 'rect-changed', object: r, note });
    return true;
  }

  /** База размеров на время протяжки кромки (одна запись в журнал на жест). */
  private readonly rectDragBase = new Map<string, RectState>();

  /**
   * Размеры: транзиентная протяжка кромок + один коммит на отпускании.
   * Резы, выпавшие за новые границы, исчезают при коммите (точка на стороне
   * не переживает укорочение стороны).
   */
  setRectSize(objectId: string, w: Rational, h: Rational, commit = true): boolean {
    const r = this.objects.get(objectId);
    if (!r || r.kind !== 'rect') return false;
    if (!this.rectDragBase.has(objectId)) this.rectDragBase.set(objectId, this.rectState(r));

    const half = Rational.of(1, 2);
    const clampSnap = (v: Rational, min: Rational, max: Rational): Rational => {
      // прищёлкиваем к сетке половинок
      const k = v.div(half);
      const snapped = half.mul(Rational.of((k.num * 2n + (k.num < 0n ? -k.den : k.den)) / (k.den * 2n)));
      if (snapped.compare(min) < 0) return min;
      if (snapped.compare(max) > 0) return max;
      return snapped;
    };
    r.w = clampSnap(w, half, Rational.of(60));
    r.h = clampSnap(h, Rational.of(0), Rational.of(40));

    if (commit) {
      const before = this.rectDragBase.get(objectId)!;
      this.rectDragBase.delete(objectId);
      r.cutsX = r.cutsX.filter((c) => c.compare(r.w) < 0);
      r.cutsY = r.cutsY.filter((c) => c.compare(r.h) < 0);
      const changed = !before.w.equals(r.w) || !before.h.equals(r.h);
      if (changed) {
        const grew = before.h.isZero() && !r.h.isZero();
        return this.commitRect(r, before, grew
          ? `${r.label}: экструзия ${before.w.toDisplay()}×0 → ${this.rectNote(r).split(': ')[1]}`
          : this.rectNote(r));
      }
    }
    return true;
  }

  cutRect(objectId: string, axis: 'x' | 'y', pos: Rational): boolean {
    const r = this.objects.get(objectId);
    if (!r || r.kind !== 'rect') return false;
    const limit = axis === 'x' ? r.w : r.h;
    if (pos.sign() <= 0 || pos.compare(limit) >= 0) return false;
    const cuts = axis === 'x' ? r.cutsX : r.cutsY;
    if (cuts.some((c) => c.equals(pos))) return false;
    const before = this.rectState(r);
    const next = [...cuts, pos].sort((a, b) => a.compare(b));
    if (axis === 'x') r.cutsX = next;
    else r.cutsY = next;
    return this.commitRect(r, before, `${r.label}: рез ${axis} = ${pos.toDisplay()} → ${rectPieceAreas(r).map((a) => a.toDisplay()).join(' | ')}`);
  }

  mergeRect(objectId: string, axis: 'x' | 'y', pos: Rational): boolean {
    const r = this.objects.get(objectId);
    if (!r || r.kind !== 'rect') return false;
    const cuts = axis === 'x' ? r.cutsX : r.cutsY;
    if (!cuts.some((c) => c.equals(pos))) return false;
    const before = this.rectState(r);
    const next = cuts.filter((c) => !c.equals(pos));
    if (axis === 'x') r.cutsX = next;
    else r.cutsY = next;
    return this.commitRect(r, before, `${r.label}: склейка → ${this.rectNote(r)}`);
  }

  /** Поворот на 90°: стороны и резы меняются осями, площади кусков сохраняются. */
  rotateRect(objectId: string): boolean {
    const r = this.objects.get(objectId);
    if (!r || r.kind !== 'rect' || r.h.isZero()) return false; // отрезку вертеться некуда
    const before = this.rectState(r);
    [r.w, r.h] = [before.h, before.w];
    [r.cutsX, r.cutsY] = [before.cutsY.slice(), before.cutsX.slice()];
    return this.commitRect(r, before, `${r.label}: поворот → ${this.rectNote(r).split(': ')[1] ?? ''}`);
  }

  // ---------- весы ----------

  /**
   * Удар по обеим чашам сразу. Правая чаша меняется числом; на левой либо
   * снимается верхняя наклейка (если инструмент — её точный обратный),
   * либо навешивается новая. Одна транзакция в журнале.
   */
  scalesApply(unknownId: string, toolId: string): boolean {
    const u = this.objects.get(unknownId);
    const tool = this.tools.get(toolId);
    if (!u || u.kind !== 'unknown' || !tool) return false;

    // Комбо на весах раскладывается на примитивные наклейки: макрос прозрачен,
    // снимать всё равно по одной
    if (tool.steps) {
      for (const s of tool.steps) {
        if (!this.scalesStep(u, makeTool(s.op, s.n))) return false;
      }
      return true;
    }
    return this.scalesStep(u, tool);
  }

  private scalesStep(u: UnknownObject, tool: Tool): boolean {
    if (u.revealed) {
      this.emit({ kind: 'tool-rejected', objectId: u.id, tool, reason: 'уравнение решено — создай новое' });
      return false;
    }
    const refusal = tool.canApply(u.rhs);
    if (refusal !== null) {
      this.emit({ kind: 'tool-rejected', objectId: u.id, tool, reason: `к обеим чашам нельзя: ${refusal}` });
      return false;
    }

    const before: UnknownState = { ops: [...u.ops], rhs: u.rhs, revealed: u.revealed };
    const top = u.ops[u.ops.length - 1];
    const snip = top !== undefined && toolInvertsSticker(tool, top);

    u.rhs = tool.apply(u.rhs);
    if (snip) u.ops.pop();
    else u.ops.push({ op: tool.op as PrimitiveOp, n: tool.n }); // сюда попадают только примитивы
    if (snip && u.ops.length === 0) u.revealed = true;

    this.applyLog.push({
      objectId: u.id,
      kind: 'unknown',
      before,
      after: { ops: [...u.ops], rhs: u.rhs, revealed: u.revealed },
    });

    const state = `${exprFor(u)} = ${u.rhs.toDisplay()}`;
    const note = u.revealed
      ? `🔓 коробка открыта: ${u.name} = ${u.secret.toDisplay()}, правая чаша ${u.rhs.toDisplay()} — сходится!`
      : snip
        ? `⚖ наклейка ${toolLabel(top!.op, top!.n)} снята: ${state}`
        : `⚖ обе чаши ${tool.label}: ${state}`;
    this.emit({ kind: 'scales-step', object: u, tool, snip, note });
    return true;
  }

  // ---------- операции над лентами ----------

  private tapeState(t: TapeObject): TapeState {
    return { mode: t.mode, cuts: [...t.cuts], whole: t.whole, strictGrid: t.strictGrid, unitLen: t.unitLen };
  }

  /** Первый рез, не представимый целым числителем в линейке ленты. */
  private tapeMisfit(t: TapeObject): Rational | undefined {
    if (t.mode === null) return undefined;
    return t.cuts.find((c) => !tapeNumerator(t, c).isInteger());
  }

  /** Изменение длины целого: резы и режим относительны, они сохраняются. */
  setTapeLength(objectId: string, len: Rational): boolean {
    const t = this.objects.get(objectId);
    if (!t || t.kind !== 'tape') return false;
    if (len.sign() <= 0) return this.refuseTape(t, 'длина должна быть положительной');
    if (len.equals(t.whole)) return false;
    const before = this.tapeState(t);
    const old = t.whole.toDisplay();
    t.whole = len;
    return this.commitTape(t, before, `${this.tapeName(t)}: длина ${old} → ${len.toDisplay()}`);
  }

  /** «2/6 | 4/6» — куски между резами; «целая», если резов нет. */
  private tapePieces(t: TapeObject): string {
    if (t.mode === null || t.cuts.length === 0) return 'целая';
    return tapePieceLabels(t).join(' | ');
  }

  private tapeName(t: TapeObject): string {
    return `${t.label} (${t.whole.toDisplay()})`;
  }

  private commitTape(t: TapeObject, before: TapeState, note: string): true {
    this.applyLog.push({ objectId: t.id, kind: 'tape', before, after: this.tapeState(t) });
    this.emit({ kind: 'tape-changed', object: t, note });
    return true;
  }

  private refuseTape(t: TapeObject, reason: string): false {
    this.emit({ kind: 'tape-refused', object: t, reason });
    return false;
  }

  cutTape(objectId: string, seam: number): boolean {
    const t = this.objects.get(objectId);
    if (!t || t.kind !== 'tape') return false;
    if (t.mode === null || seam < 1) return false;
    // позиция шва как доля целого: seam/mode · unit/whole
    const unit = t.unitLen ?? t.whole;
    const pos = Rational.of(seam, t.mode).mul(unit).div(t.whole);
    if (pos.compare(Rational.of(1)) >= 0) return false;
    if (t.cuts.some((c) => c.equals(pos))) return false;
    const before = this.tapeState(t);
    t.cuts = [...t.cuts, pos].sort((a, b) => a.compare(b));
    return this.commitTape(t, before, `${this.tapeName(t)} /${t.mode}: рез на ${seam}/${t.mode} → ${this.tapePieces(t)}`);
  }

  mergeTape(objectId: string, cut: Rational): boolean {
    const t = this.objects.get(objectId);
    if (!t || t.kind !== 'tape') return false;
    if (!t.cuts.some((c) => c.equals(cut))) return false;
    const before = this.tapeState(t);
    t.cuts = t.cuts.filter((c) => !c.equals(cut));
    return this.commitTape(t, before, `${this.tapeName(t)}: склейка → ${this.tapePieces(t)}`);
  }

  /**
   * Смена режима-линейки. Резы — точки, они не двигаются; с «целыми обозначениями»
   * линейка принимается, только если каждый рез попадает на её шов (p·n — целое).
   * Без них — любая линейка, куски подписываются дробными числителями.
   */
  setTapeMode(objectId: string, n: number | null): boolean {
    const t = this.objects.get(objectId);
    if (!t || t.kind !== 'tape') return false;
    if (n === t.mode) return false;

    if (n === null) {
      if (t.cuts.length) return this.refuseTape(t, 'сначала склей все резы');
      const before = this.tapeState(t);
      t.mode = null;
      return this.commitTape(t, before, `${this.tapeName(t)}: снова целая, без швов`);
    }

    if (!Number.isInteger(n) || n < TAPE_MODE_MIN || n > TAPE_MODE_MAX) {
      return this.refuseTape(t, `режим /${n} не поддерживается (от /${TAPE_MODE_MIN} до /${TAPE_MODE_MAX})`);
    }

    if (t.strictGrid) {
      const probe: TapeObject = { ...t, mode: n };
      const misfit = t.cuts.find((c) => !tapeNumerator(probe, c).isInteger());
      if (misfit) {
        return this.refuseTape(t, `рез на ${misfit.num}/${misfit.den} не попадает на швы /${n}`);
      }
    }

    const before = this.tapeState(t);
    const old = t.mode;
    t.mode = n;
    return this.commitTape(
      t,
      before,
      old === null ? `${this.tapeName(t)}: режим /${n}` : `${this.tapeName(t)}: линейка /${old} → /${n} (${this.tapePieces(t)})`,
    );
  }

  /** Галка «целые обозначения»: включить можно, лишь когда все резы на швах. */
  setTapeStrict(objectId: string, on: boolean): boolean {
    const t = this.objects.get(objectId);
    if (!t || t.kind !== 'tape' || t.strictGrid === on) return false;
    if (on) {
      const misfit = this.tapeMisfit(t);
      if (misfit) {
        return this.refuseTape(t, `рез на ${misfit.num}/${misfit.den} мимо швов /${t.mode} — сначала склей его или подбери режим`);
      }
    }
    const before = this.tapeState(t);
    t.strictGrid = on;
    return this.commitTape(t, before, `${this.tapeName(t)}: целые обозначения ${on ? 'включены' : 'выключены'}`);
  }

  /**
   * Эталонная единица: /n начинает делить единицу, а не всю ленту.
   * null — единица равна ленте (обычное поведение).
   */
  setTapeUnitLen(objectId: string, u: Rational | null): boolean {
    const t = this.objects.get(objectId);
    if (!t || t.kind !== 'tape') return false;
    const same = (u === null && t.unitLen === null) || (u !== null && t.unitLen !== null && u.equals(t.unitLen));
    if (same) return false;
    if (u !== null && u.sign() <= 0) return this.refuseTape(t, 'единица должна быть положительной');

    if (t.strictGrid && t.mode !== null) {
      const probe: TapeObject = { ...t, unitLen: u };
      const misfit = t.cuts.find((c) => !tapeNumerator(probe, c).isInteger());
      if (misfit) {
        return this.refuseTape(t, `рез на ${misfit.num}/${misfit.den} не попадает на швы такой единицы`);
      }
    }

    const before = this.tapeState(t);
    t.unitLen = u;
    const note = u === null
      ? `${this.tapeName(t)}: единица — вся лента`
      : `${this.tapeName(t)}: единица ${u.toDisplay()} (лента = ${t.whole.div(u).toDisplay()} единиц)`;
    return this.commitTape(t, before, note);
  }

  // ---------- undo ----------

  /** Отмена последнего изменения (числового или ленточного) из общего лога. */
  undo(): boolean {
    const last = this.applyLog.pop();
    if (!last) return false;
    const obj = this.objects.get(last.objectId);
    if (!obj) return this.undo(); // объект уже удалён — отматываем дальше

    if (last.kind === 'number' && obj.kind === 'number') {
      obj.value = last.before;
      obj.trail.pop();
      this.emit({ kind: 'undo', objectId: obj.id, note: `⟲ вернулись к ${last.before.toDisplay()}` });
      return true;
    }
    if (last.kind === 'tape' && obj.kind === 'tape') {
      obj.mode = last.before.mode;
      obj.cuts = [...last.before.cuts];
      obj.whole = last.before.whole;
      obj.strictGrid = last.before.strictGrid;
      obj.unitLen = last.before.unitLen;
      this.emit({ kind: 'undo', objectId: obj.id, note: `⟲ ${obj.label}: ${this.tapePieces(obj)}` });
      return true;
    }
    if (last.kind === 'rect' && obj.kind === 'rect') {
      obj.w = last.before.w;
      obj.h = last.before.h;
      obj.cutsX = [...last.before.cutsX];
      obj.cutsY = [...last.before.cutsY];
      this.emit({ kind: 'undo', objectId: obj.id, note: `⟲ ${this.rectNote(obj)}` });
      return true;
    }
    if (last.kind === 'unknown' && obj.kind === 'unknown') {
      obj.ops = [...last.before.ops];
      obj.rhs = last.before.rhs;
      obj.revealed = last.before.revealed;
      this.emit({ kind: 'undo', objectId: obj.id, note: `⟲ весы: ${exprFor(obj)} = ${obj.rhs.toDisplay()}` });
      return true;
    }
    return this.undo();
  }
}
