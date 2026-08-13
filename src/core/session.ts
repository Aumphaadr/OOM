import { Rational, floorRational } from './rational';
import {
  MathObject, NumberObject, TapeObject, UnknownObject, RectObject, EquationObject, PointObject, VectorObject,
  CuboidObject, cuboidVolume, cuboidDims, AngleObject, sinDeg, degMod360, Tool,
  makeTool, makeCompositeTool, makeVarTool, toolInvertsSticker, exprFor, toolLabel, subtitleFor,
  tapePieceLabels, tapeNumerator, rectPieceAreas, unknownValue, isNeutralAction, PrimitiveOp, VarOp,
  LinForm, linFormEval, linFormText,
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
  | { kind: 'scales-step'; object: UnknownObject; tool: Tool; snip: boolean; side: 'left' | 'right'; neutral?: boolean; note: string }
  | { kind: 'equation-step'; object: EquationObject; tool: Tool; side: 'left' | 'right'; neutral?: boolean; note: string }
  | { kind: 'var-set'; object: NumberObject; note: string }
  | { kind: 'rect-changed'; object: RectObject; note: string }
  | { kind: 'point-moved'; object: PointObject; note: string }
  | { kind: 'vector-changed'; object: VectorObject; note: string }
  | { kind: 'cuboid-changed'; object: CuboidObject; note: string }
  | { kind: 'transfer'; from: NumberObject; to: NumberObject; note: string }
  | { kind: 'angle-set'; object: AngleObject; note: string }
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

interface EquationState { left: LinForm; right: LinForm; solved: boolean }

interface PointState { x: Rational; y: Rational }

interface VectorState { dx: Rational; dy: Rational }

interface CuboidState { w: Rational; d: Rational; h: Rational }

interface AngleState { deg: Rational }

type LogEntry =
  | { objectId: string; kind: 'number'; before: Rational; after: Rational }
  | { objectId: string; kind: 'tape'; before: TapeState; after: TapeState }
  | { objectId: string; kind: 'unknown'; before: UnknownState; after: UnknownState }
  | { objectId: string; kind: 'rect'; before: RectState; after: RectState }
  | { objectId: string; kind: 'equation'; before: EquationState; after: EquationState }
  | { objectId: string; kind: 'point'; before: PointState; after: PointState }
  | { objectId: string; kind: 'vector'; before: VectorState; after: VectorState }
  | { objectId: string; kind: 'cuboid'; before: CuboidState; after: CuboidState }
  | { objectId: string; kind: 'spawn' }
  | { objectId: string; kind: 'removal'; object: MathObject }
  | { kind: 'transfer'; fromId: string; toId: string; amount: Rational }
  | { objectId: string; kind: 'angle'; before: AngleState; after: AngleState };

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
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
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
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
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
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
    return obj;
  }

  removeObject(id: string, quiet = false): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    const note = quiet ? ''
      : obj.kind === 'tape' ? `${this.tapeName(obj)} удалена`
      : obj.kind === 'unknown' ? `уравнение с «${obj.name}» убрано`
      : obj.kind === 'rect' ? `${obj.label} удалён`
      : obj.kind === 'equation' ? `уравнение с «${obj.name}» снято с весов`
      : obj.kind === 'point' ? `точка ${obj.label} снята с плоскости`
      : obj.kind === 'vector' ? `стрелка ${obj.label} убрана`
      : obj.kind === 'cuboid' ? `тело ${obj.label} убрано`
      : obj.kind === 'angle' ? `угол ${obj.label} снят с окружности`
      : `число ${obj.value.toDisplay()} удалено`;
    if (!quiet) this.applyLog.push({ objectId: id, kind: 'removal', object: obj });
    this.objects.delete(id);
    this.emit({ kind: 'object-removed', objectId: id, note });
  }

  /** Сброс истории отмен: свежезагруженная доска начинает с чистого листа. */
  resetHistory(): void {
    this.applyLog.length = 0;
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

  /** Молоток «±x» (весы v2): применим только к уравнению. */
  addVarTool(op: VarOp, n: Rational): Tool {
    const tool = makeVarTool(op, n, nextId('tool'));
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
    if (obj.kind === 'rect') return this.scaleRect(obj, tool);
    if (obj.kind === 'cuboid') return this.scaleCuboid(obj, tool);
    if (obj.kind === 'angle') return this.angleApplyTool(obj, tool);
    if (obj.kind !== 'number') {
      // Сигнатура по типам: числовой молоток не бьёт по лентам
      this.emit({ kind: 'tool-rejected', objectId, tool, reason: 'этот инструмент бьёт только по числам' });
      return false;
    }
    return this.applyWith(tool, obj);
  }

  /**
   * Молоток по фигуре: ×k и ÷k масштабируют ОБА размера (и резы) —
   * стороны в k раз, площадь в k² (живое демо подобия). Остальные операции
   * по фигурам отказывают: у прямоугольника нет «плюс пять».
   */
  private scaleRect(r: RectObject, tool: Tool): boolean {
    if (tool.op !== 'mul' && tool.op !== 'div') {
      this.emit({ kind: 'tool-rejected', objectId: r.id, tool, reason: 'фигуры понимают только ×N и ÷N — масштаб' });
      return false;
    }
    if (tool.n.sign() <= 0) {
      this.emit({ kind: 'tool-rejected', objectId: r.id, tool, reason: 'масштаб фигуры должен быть положительным' });
      return false;
    }
    const k = tool.op === 'mul' ? tool.n : Rational.of(tool.n.den, tool.n.num);
    const nw = r.w.mul(k);
    const nh = r.h.mul(k);
    if (nw.compare(Rational.of(60)) > 0 || nh.compare(Rational.of(40)) > 0) {
      this.emit({ kind: 'tool-rejected', objectId: r.id, tool, reason: 'такая фигура не поместится на поле' });
      return false;
    }
    if (nw.compare(Rational.of(1, 4)) < 0) {
      this.emit({ kind: 'tool-rejected', objectId: r.id, tool, reason: 'фигура сожмётся в невидимую точку' });
      return false;
    }
    const before = this.rectState(r);
    r.w = nw;
    r.h = nh;
    r.cutsX = r.cutsX.map((c) => c.mul(k));
    r.cutsY = r.cutsY.map((c) => c.mul(k));
    this.applyLog.push({ objectId: r.id, kind: 'rect', before, after: this.rectState(r) });
    this.emit({
      kind: 'rect-changed',
      object: r,
      note: `${r.label} ${tool.label}: стороны ×${k.toDisplay()}, площадь ×${k.mul(k).toDisplay()} — ${this.rectNote(r).split(': ')[1] ?? this.rectNote(r)}`,
    });
    return true;
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
      showPerimeter: false,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
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
  /**
   * Удар по ОДНОЙ чаше весов. Равновесие — работа ученика: тот же молоток
   * надо приложить и ко второй чаше, иначе весы перекосит.
   */
  scalesApply(unknownId: string, toolId: string, side: 'left' | 'right'): boolean {
    const u = this.objects.get(unknownId);
    const tool = this.tools.get(toolId);
    if (!u || u.kind !== 'unknown' || !tool) return false;

    // Комбо на весах раскладывается на примитивные наклейки: макрос прозрачен,
    // снимать всё равно по одной
    if (tool.steps) {
      for (const s of tool.steps) {
        if (!this.scalesStep(u, makeTool(s.op, s.n), side)) return false;
      }
      return true;
    }
    return this.scalesStep(u, tool, side);
  }

  private scalesStep(u: UnknownObject, tool: Tool, side: 'left' | 'right'): boolean {
    if (u.revealed) {
      this.emit({ kind: 'tool-rejected', objectId: u.id, tool, reason: 'уравнение решено — создай новое' });
      return false;
    }
    const target = side === 'left' ? unknownValue(u) : u.rhs;
    const refusal = tool.canApply(target);
    if (refusal !== null) {
      this.emit({ kind: 'tool-rejected', objectId: u.id, tool, reason: refusal });
      return false;
    }
    if (isNeutralAction(tool.op, tool.n)) {
      // Нейтральный удар: наклейка не надевается, состояние и лог не трогаются
      this.emit({
        kind: 'scales-step', object: u, tool, snip: false, side, neutral: true,
        note: `⚖ ${tool.label} — нейтральный удар: весы его даже не заметили`,
      });
      return true;
    }

    const before: UnknownState = { ops: [...u.ops], rhs: u.rhs, revealed: u.revealed };
    let snip = false;
    let snipped: { op: PrimitiveOp; n: Rational } | undefined;

    if (side === 'left') {
      const top = u.ops[u.ops.length - 1];
      snip = top !== undefined && toolInvertsSticker(tool, top);
      if (snip) { snipped = top; u.ops.pop(); }
      else u.ops.push({ op: tool.op as PrimitiveOp, n: tool.n }); // сюда попадают только примитивы
    } else {
      u.rhs = tool.apply(u.rhs);
    }

    // Решено = коробка голая И весы в равновесии
    const balanced = unknownValue(u).equals(u.rhs);
    if (u.ops.length === 0 && balanced) u.revealed = true;

    this.applyLog.push({
      objectId: u.id,
      kind: 'unknown',
      before,
      after: { ops: [...u.ops], rhs: u.rhs, revealed: u.revealed },
    });

    const state = `${exprFor(u)} ${balanced ? '=' : '≠'} ${u.rhs.toDisplay()}`;
    const pan = side === 'left' ? 'левая чаша' : 'правая чаша';
    const note = u.revealed
      ? `🔓 коробка открыта: ${u.name} = ${u.secret.toDisplay()}, правая чаша ${u.rhs.toDisplay()} — сходится!`
      : snip
        ? `⚖ наклейка ${toolLabel(snipped!.op, snipped!.n)} снята: ${state}${balanced ? '' : ' — правая ждёт того же'}`
        : `⚖ ${pan} ${tool.label}: ${state}${balanced ? '' : ' — теперь та же операция по другой чаше'}`;
    this.emit({ kind: 'scales-step', object: u, tool, snip, side, note });
    return true;
  }

  // ---------- точки на плоскости ----------

  private pointCounter = 0;

  spawnPoint(x: Rational, y: Rational): PointObject {
    const obj: PointObject = {
      kind: 'point',
      id: nextId('pt'),
      label: `Т${++this.pointCounter}`,
      x,
      y,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
    return obj;
  }

  private readonly pointDragBase = new Map<string, PointState>();

  /**
   * Перенос точки: транзиент во время перетаскивания, одна запись в журнал
   * на коммит (как у ползунка переменной и кромок фигур).
   */
  setPointPos(objectId: string, x: Rational, y: Rational, commit = true): boolean {
    const pt = this.objects.get(objectId);
    if (!pt || pt.kind !== 'point') return false;
    if (!this.pointDragBase.has(objectId)) this.pointDragBase.set(objectId, { x: pt.x, y: pt.y });

    pt.x = x;
    pt.y = y;
    if (!commit) return true;

    const before = this.pointDragBase.get(objectId)!;
    this.pointDragBase.delete(objectId);
    if (before.x.equals(pt.x) && before.y.equals(pt.y)) return true; // вернулась на место — не ход

    this.applyLog.push({ objectId, kind: 'point', before, after: { x: pt.x, y: pt.y } });
    this.emit({
      kind: 'point-moved',
      object: pt,
      note: `📍 ${pt.label} → (${pt.x.toDisplay()}; ${pt.y.toDisplay()})`,
    });
    return true;
  }

  /**
   * Перенос точки командой-стрелкой (жест «прицепи хвост к месту», серия 35):
   * точка проходит путь (dx; dy) и оказывается на носу стрелки. Команда
   * многоразовая — стрелка не расходуется. Нулевая команда ничего не меняет
   * (и ходом не считается).
   */
  movePointBy(pointId: string, vectorId: string): boolean {
    const pt = this.objects.get(pointId);
    const vec = this.objects.get(vectorId);
    if (!pt || pt.kind !== 'point' || !vec || vec.kind !== 'vector') return false;
    if (vec.dx.isZero() && vec.dy.isZero()) return true; // «стой на месте» — не ход

    const before: PointState = { x: pt.x, y: pt.y };
    pt.x = pt.x.add(vec.dx);
    pt.y = pt.y.add(vec.dy);
    this.applyLog.push({ objectId: pointId, kind: 'point', before, after: { x: pt.x, y: pt.y } });
    this.emit({
      kind: 'point-moved',
      object: pt,
      note: `📍 ${pt.label} прошла по ${vec.label} (${vec.dx.toDisplay()}; ${vec.dy.toDisplay()}): → (${pt.x.toDisplay()}; ${pt.y.toDisplay()})`,
    });
    return true;
  }

  /**
   * Переливание (серия 31, статистика): amount единиц уходит из одного
   * столбика-числа в другой. Сумма набора НЕ меняется — это главный
   * инвариант; среднее — «перелить поровну». Один атомарный ход
   * (одна запись в журнал, один undo). Переменные-ползунки не переливаются.
   */
  transfer(fromId: string, toId: string, amount: Rational = Rational.of(1)): boolean {
    const from = this.objects.get(fromId);
    const to = this.objects.get(toId);
    if (!from || from.kind !== 'number' || !to || to.kind !== 'number') return false;
    if (fromId === toId || amount.sign() <= 0) return false;
    if (from.variable || to.variable) return false;

    from.value = from.value.sub(amount);
    to.value = to.value.add(amount);
    from.trail.push(from.value);
    to.trail.push(to.value);
    this.applyLog.push({ kind: 'transfer', fromId, toId, amount });
    this.emit({
      kind: 'transfer',
      from,
      to,
      note: `⇄ перелито ${amount.toDisplay()}: столбики теперь ${from.value.toDisplay()} и ${to.value.toDisplay()} (сумма не изменилась)`,
    });
    return true;
  }

  /**
   * Молоток по точке: ×k и ÷k тянут ОБЕ координаты — растяжение от начала
   * координат (гомотетия), ×(−1) — разворот вокруг нуля (центральная
   * симметрия), ×0 — склейка всех точек в начало. Прочие молотки отказывают.
   */
  pointApply(pointId: string, toolId: string): boolean {
    const pt = this.objects.get(pointId);
    const tool = this.tools.get(toolId);
    if (!pt || pt.kind !== 'point' || !tool) return false;
    if (tool.op !== 'mul' && tool.op !== 'div') {
      this.emit({
        kind: 'tool-rejected', objectId: pointId, tool,
        reason: 'по точке бьют только ×k и ÷k — растяжение от нуля и разворот; у адреса две цифры сразу',
      });
      return false;
    }
    const before: PointState = { x: pt.x, y: pt.y };
    pt.x = tool.apply(pt.x);
    pt.y = tool.apply(pt.y);
    if (before.x.equals(pt.x) && before.y.equals(pt.y)) return true; // ×1 и точка в нуле — не ход
    this.applyLog.push({ objectId: pointId, kind: 'point', before, after: { x: pt.x, y: pt.y } });

    const k = tool.op === 'mul' ? tool.n : Rational.of(tool.n.den, tool.n.num);
    const tail = pt.x.isZero() && pt.y.isZero() ? ' — склейка в начало координат'
      : k.sign() < 0 ? ' — разворот вокруг нуля' : '';
    this.emit({
      kind: 'point-moved',
      object: pt,
      note: `⚒ ${pt.label} ${tool.label}: (${before.x.toDisplay()}; ${before.y.toDisplay()}) → (${pt.x.toDisplay()}; ${pt.y.toDisplay()})${tail}`,
    });
    return true;
  }

  /**
   * Поворот точки на 90° вокруг нуля (серия 35 «движения»): против часовой
   * (x; y) → (−y; x), по часовой — наоборот. Только прямые углы: поворот
   * на «кривой» градус увёл бы рациональный адрес в иррациональность.
   * Точка в нуле вращается в себя — не ход.
   */
  rotatePoint(pointId: string, dir: 'ccw' | 'cw'): boolean {
    const pt = this.objects.get(pointId);
    if (!pt || pt.kind !== 'point') return false;
    const before: PointState = { x: pt.x, y: pt.y };
    if (dir === 'ccw') {
      const nx = pt.y.neg();
      pt.y = before.x;
      pt.x = nx;
    } else {
      const nx = pt.y;
      pt.y = before.x.neg();
      pt.x = nx;
    }
    if (before.x.equals(pt.x) && before.y.equals(pt.y)) return true; // нуль — центр
    this.applyLog.push({ objectId: pointId, kind: 'point', before, after: { x: pt.x, y: pt.y } });
    this.emit({
      kind: 'point-moved',
      object: pt,
      note: `⟳ ${pt.label} повернулась на 90° ${dir === 'ccw' ? 'против' : 'по'} часовой: → (${pt.x.toDisplay()}; ${pt.y.toDisplay()})`,
    });
    return true;
  }

  /**
   * Зеркало (серия 35 «движения»): отражение точки от оси X (y → −y)
   * или от оси Y (x → −x). Точка НА оси отражается в себя — не ход.
   */
  flipPoint(pointId: string, axis: 'x' | 'y'): boolean {
    const pt = this.objects.get(pointId);
    if (!pt || pt.kind !== 'point') return false;
    const before: PointState = { x: pt.x, y: pt.y };
    if (axis === 'x') pt.y = pt.y.neg();
    else pt.x = pt.x.neg();
    if (before.x.equals(pt.x) && before.y.equals(pt.y)) return true; // лежит на зеркале
    this.applyLog.push({ objectId: pointId, kind: 'point', before, after: { x: pt.x, y: pt.y } });
    this.emit({
      kind: 'point-moved',
      object: pt,
      note: `🪞 ${pt.label} отразилась от оси ${axis === 'x' ? 'X' : 'Y'}: → (${pt.x.toDisplay()}; ${pt.y.toDisplay()})`,
    });
    return true;
  }

  /**
   * Жест «прогони вход» (плоскость, этап B): молоток бьёт по оси X в точке a —
   * рождается точка (a; инструмент(a)). Пара «вход; выход» и есть адрес,
   * след инструмента проходит ровно через такие точки. Отказ сигнатуры честен:
   * точки не будет, только событие tool-rejected (√ левее нуля молчит).
   */
  tracePoint(toolId: string, input: Rational): PointObject | null {
    const tool = this.tools.get(toolId);
    if (!tool) return null;
    const refusal = tool.canApply(input);
    if (refusal !== null) {
      this.emit({ kind: 'tool-rejected', objectId: '', tool, reason: refusal });
      return null;
    }
    const out = tool.apply(input);
    const pt = this.spawnPoint(input, out);
    this.emit({
      kind: 'point-moved',
      object: pt,
      note: `⚒ ${subtitleFor(input, tool, out)} — точка ${pt.label} в (${pt.x.toDisplay()}; ${pt.y.toDisplay()})`,
    });
    return pt;
  }

  // ---------- кубоиды (сцена «Объёмы») ----------

  private cuboidCounter = 0;

  private static readonly CUBOID_MAX_W = Rational.of(12);
  private static readonly CUBOID_MAX_DH = Rational.of(10);

  spawnCuboid(w: Rational, d: Rational, h: Rational): CuboidObject {
    const obj: CuboidObject = {
      kind: 'cuboid',
      id: nextId('cub'),
      label: `К${++this.cuboidCounter}`,
      w, d, h,
      showW: true, showD: true, showH: true, showVolume: false,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
    return obj;
  }

  private cuboidNote(c: CuboidObject): string {
    const dims = cuboidDims(c);
    if (dims === 1) return `${c.label}: отрезок длины ${c.w.toDisplay()}`;
    if (dims === 2) return `${c.label}: площадка ${c.w.toDisplay()}×${c.d.toDisplay()} — ${c.w.mul(c.d).toDisplay()} клеток`;
    return `${c.label}: ${c.w.toDisplay()}×${c.d.toDisplay()}×${c.h.toDisplay()} — этаж ${c.w.mul(c.d).toDisplay()}, этажей ${c.h.toDisplay()}, объём ${cuboidVolume(c).toDisplay()}`;
  }

  private readonly cuboidDragBase = new Map<string, CuboidState>();

  /**
   * Экструзия/усушка кромками: транзиент + один коммит в журнал.
   * Размеры — целые клетки (кубики не половинятся); d и h могут быть нулём —
   * лесенка «отрезок → площадка → кубоид» честно живёт в одном объекте.
   */
  setCuboidSize(objectId: string, w: Rational, d: Rational, h: Rational, commit = true): boolean {
    const c = this.objects.get(objectId);
    if (!c || c.kind !== 'cuboid') return false;
    if (!this.cuboidDragBase.has(objectId)) {
      this.cuboidDragBase.set(objectId, { w: c.w, d: c.d, h: c.h });
    }

    const clampInt = (v: Rational, min: Rational, max: Rational): Rational => {
      const snapped = floorRational(v.add(Rational.of(1, 2)));
      if (snapped.compare(min) < 0) return min;
      if (snapped.compare(max) > 0) return max;
      return snapped;
    };
    c.w = clampInt(w, Rational.of(1), Session.CUBOID_MAX_W);
    c.d = clampInt(d, Rational.of(0), Session.CUBOID_MAX_DH);
    c.h = clampInt(h, Rational.of(0), Session.CUBOID_MAX_DH);
    if (!commit) return true;

    const before = this.cuboidDragBase.get(objectId)!;
    this.cuboidDragBase.delete(objectId);
    if (before.w.equals(c.w) && before.d.equals(c.d) && before.h.equals(c.h)) return true; // не ход

    this.applyLog.push({ objectId, kind: 'cuboid', before, after: { w: c.w, d: c.d, h: c.h } });
    this.emit({ kind: 'cuboid-changed', object: c, note: `📦 ${this.cuboidNote(c)}` });
    return true;
  }

  /**
   * Молоток по телу: ×k и ÷k масштабируют все РЁБРА. Заметка называет
   * множитель по числу живых измерений — длина ×k, площадь ×k², объём ×k³:
   * лесенка подобия живьём. Остальные молотки отказывают.
   */
  private scaleCuboid(c: CuboidObject, tool: Tool): boolean {
    if (tool.op !== 'mul' && tool.op !== 'div') {
      this.emit({ kind: 'tool-rejected', objectId: c.id, tool, reason: 'тела понимают только ×N и ÷N — масштаб' });
      return false;
    }
    if (tool.n.sign() <= 0) {
      this.emit({ kind: 'tool-rejected', objectId: c.id, tool, reason: 'масштаб тела должен быть положительным' });
      return false;
    }
    const k = tool.op === 'mul' ? tool.n : Rational.of(tool.n.den, tool.n.num);
    const nw = c.w.mul(k);
    const nd = c.d.mul(k);
    const nh = c.h.mul(k);
    if (nw.compare(Session.CUBOID_MAX_W) > 0 || nd.compare(Session.CUBOID_MAX_DH) > 0 ||
        nh.compare(Session.CUBOID_MAX_DH) > 0) {
      this.emit({ kind: 'tool-rejected', objectId: c.id, tool, reason: 'такое тело не поместится на поле' });
      return false;
    }
    if (!nw.isInteger() || !nd.isInteger() || !nh.isInteger() || nw.sign() <= 0) {
      this.emit({ kind: 'tool-rejected', objectId: c.id, tool, reason: 'кубики не половинятся — рёбра должны остаться целыми' });
      return false;
    }
    const before: CuboidState = { w: c.w, d: c.d, h: c.h };
    c.w = nw;
    c.d = nd;
    c.h = nh;
    this.applyLog.push({ objectId: c.id, kind: 'cuboid', before, after: { w: c.w, d: c.d, h: c.h } });

    const dims = cuboidDims(c);
    const factor = dims === 3 ? `объём ×${k.mul(k).mul(k).toDisplay()}`
      : dims === 2 ? `площадь ×${k.mul(k).toDisplay()}`
      : `длина ×${k.toDisplay()}`;
    this.emit({
      kind: 'cuboid-changed',
      object: c,
      note: `⚒ ${c.label} ${tool.label}: рёбра ×${k.toDisplay()}, ${factor} — ${this.cuboidNote(c).split(': ')[1]}`,
    });
    return true;
  }

  // ---------- углы на единичной окружности ----------

  private angleCounter = 0;

  spawnAngle(deg: Rational): AngleObject {
    const obj: AngleObject = {
      kind: 'angle',
      id: nextId('ang'),
      label: `α${++this.angleCounter}`,
      deg,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
    return obj;
  }

  private angleNote(a: AngleObject): string {
    const sin = sinDeg(a.deg);
    const place = degMod360(a.deg);
    const laps = a.deg.sub(place).div(Rational.of(360));
    const lapsTxt = laps.isZero() ? '' : `, намотка: ${laps.toDisplay()} круг(а) + ${place.toDisplay()}°`;
    return `∠ ${a.label} = ${a.deg.toDisplay()}°${lapsTxt}, высота ${sin.exact ? '' : '≈ '}${sin.v.toDisplay()}`;
  }

  private readonly angleDragBase = new Map<string, AngleState>();

  /** Вращение луча рукой: транзиент + один коммит в журнал (как точка). */
  setAngleDeg(objectId: string, deg: Rational, commit = true): boolean {
    const a = this.objects.get(objectId);
    if (!a || a.kind !== 'angle') return false;
    if (!this.angleDragBase.has(objectId)) this.angleDragBase.set(objectId, { deg: a.deg });

    a.deg = deg;
    if (!commit) return true;

    const before = this.angleDragBase.get(objectId)!;
    this.angleDragBase.delete(objectId);
    if (before.deg.equals(a.deg)) return true; // вернулся в тот же раствор — не ход

    this.applyLog.push({ objectId, kind: 'angle', before, after: { deg: a.deg } });
    this.emit({ kind: 'angle-set', object: a, note: this.angleNote(a) });
    return true;
  }

  /**
   * Молоток по углу: ±n — поворот, ×k/÷k — растяжение раствора,
   * ост360 — «где я на окружности», ряд360 — счётчик полных оборотов.
   * Квадраты и корни отказывают: угол крутят, а не возводят.
   */
  private angleApplyTool(a: AngleObject, tool: Tool): boolean {
    const allowed = ['add', 'sub', 'mul', 'div', 'round', 'mod', 'quot'];
    if (!allowed.includes(tool.op)) {
      this.emit({
        kind: 'tool-rejected', objectId: a.id, tool,
        reason: 'угол крутят и делят, а не возводят в степень',
      });
      return false;
    }
    const before: AngleState = { deg: a.deg };
    a.deg = tool.apply(a.deg);
    if (before.deg.equals(a.deg)) return true; // +0 и прочие нейтральные — не ход
    this.applyLog.push({ objectId: a.id, kind: 'angle', before, after: { deg: a.deg } });
    this.emit({
      kind: 'angle-set',
      object: a,
      note: `⚒ ${a.label} ${tool.label}: ${before.deg.toDisplay()}° → ${a.deg.toDisplay()}° — ${this.angleNote(a).split(' = ')[1]}`,
    });
    return true;
  }

  // ---------- стрелки-векторы ----------

  private vectorCounter = 0;

  spawnVector(dx: Rational, dy: Rational): VectorObject {
    const obj: VectorObject = {
      kind: 'vector',
      id: nextId('vec'),
      label: `В${++this.vectorCounter}`,
      dx,
      dy,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
    return obj;
  }

  private readonly vecDragBase = new Map<string, VectorState>();

  /**
   * Смена команды стрелки (перетаскивание её головы): транзиент + один
   * коммит в журнал, как у точки. Хвост — презентация, его переносы
   * в журнал не попадают вовсе: команда не изменилась.
   */
  setVectorData(objectId: string, dx: Rational, dy: Rational, commit = true): boolean {
    const v = this.objects.get(objectId);
    if (!v || v.kind !== 'vector') return false;
    if (!this.vecDragBase.has(objectId)) this.vecDragBase.set(objectId, { dx: v.dx, dy: v.dy });

    v.dx = dx;
    v.dy = dy;
    if (!commit) return true;

    const before = this.vecDragBase.get(objectId)!;
    this.vecDragBase.delete(objectId);
    if (before.dx.equals(v.dx) && before.dy.equals(v.dy)) return true; // та же команда — не ход

    this.applyLog.push({ objectId, kind: 'vector', before, after: { dx: v.dx, dy: v.dy } });
    this.emit({
      kind: 'vector-changed',
      object: v,
      note: `↗ ${v.label} → (${v.dx.toDisplay()}; ${v.dy.toDisplay()})`,
    });
    return true;
  }

  /**
   * Молоток по стрелке: только ×k и ÷k — растяжка, сжатие, разворот
   * (обе компоненты разом, направление сохраняется или переворачивается).
   * Остальные молотки честно отказывают: у команды две цифры сразу.
   */
  vectorApply(objectId: string, toolId: string): boolean {
    const v = this.objects.get(objectId);
    const tool = this.tools.get(toolId);
    if (!v || v.kind !== 'vector' || !tool) return false;

    if (tool.op !== 'mul' && tool.op !== 'div') {
      this.emit({
        kind: 'tool-rejected', objectId, tool,
        reason: 'по стрелке бьют только ×k и ÷k — растяжка и разворот; у команды две цифры сразу',
      });
      return false;
    }
    const before: VectorState = { dx: v.dx, dy: v.dy };
    v.dx = tool.apply(v.dx);
    v.dy = tool.apply(v.dy);
    this.applyLog.push({ objectId, kind: 'vector', before, after: { dx: v.dx, dy: v.dy } });

    const flipped = tool.n.sign() < 0;
    const zeroed = v.dx.isZero() && v.dy.isZero() && !(before.dx.isZero() && before.dy.isZero());
    const tail = zeroed ? ' — команда «стой на месте»' : flipped ? ' — тот же путь задом наперёд' : '';
    this.emit({
      kind: 'vector-changed',
      object: v,
      note: `⚒ ${v.label} ${tool.label}: (${before.dx.toDisplay()}; ${before.dy.toDisplay()}) → (${v.dx.toDisplay()}; ${v.dy.toDisplay()})${tail}`,
    });
    return true;
  }

  /**
   * Сумма двух стрелок — жест «хвост к носу»: пройди первую команду,
   * потом вторую; итог — новая стрелка. Работает и в запертых упражнениях
   * (это операция над данными блоками, не создание с нуля).
   */
  sumVectors(aId: string, bId: string): VectorObject | null {
    const a = this.objects.get(aId);
    const b = this.objects.get(bId);
    if (!a || a.kind !== 'vector' || !b || b.kind !== 'vector' || aId === bId) return null;
    const sum = this.spawnVector(a.dx.add(b.dx), a.dy.add(b.dy));
    this.emit({
      kind: 'vector-changed',
      object: sum,
      note: `➕ ${a.label} ⊕ ${b.label} = ${sum.label} (${sum.dx.toDisplay()}; ${sum.dy.toDisplay()})`,
    });
    return sum;
  }

  // ---------- весы v2: уравнение с x на обеих чашах ----------

  /**
   * Уравнение ax + b = cx + d (docs/design-scales-v2.md). Инвариант: секрет
   * обязан удовлетворять уравнению — противоречивые заготовки не существуют.
   */
  spawnEquation(name: string, secret: Rational, left: LinForm, right: LinForm): EquationObject {
    if (!linFormEval(left, secret).equals(linFormEval(right, secret))) {
      throw new Error(`Секрет ${secret.toDisplay()} не удовлетворяет уравнению — весы не встанут в равновесие.`);
    }
    const obj: EquationObject = {
      kind: 'equation',
      id: nextId('eq2'),
      name,
      secret,
      left: { ...left },
      right: { ...right },
      solved: false,
      scenePos: new Map(),
    };
    this.objects.set(obj.id, obj);
    this.emit({ kind: 'object-spawned', object: obj });
    this.applyLog.push({ objectId: obj.id, kind: 'spawn' });
    return obj;
  }

  /** Удар по ОДНОЙ чаше уравнения: равновесие держит ученик. */
  equationApply(equationId: string, toolId: string, side: 'left' | 'right'): boolean {
    const eq = this.objects.get(equationId);
    const tool = this.tools.get(toolId);
    if (!eq || eq.kind !== 'equation' || !tool) return false;

    // Комбо раскладывается на шаги, как на весах v1
    if (tool.steps) {
      for (const st of tool.steps) {
        if (!this.equationStep(eq, makeTool(st.op, st.n), side)) return false;
      }
      return true;
    }
    return this.equationStep(eq, tool, side);
  }

  private equationStep(eq: EquationObject, tool: Tool, side: 'left' | 'right'): boolean {
    if (eq.solved) {
      this.emit({ kind: 'tool-rejected', objectId: eq.id, tool, reason: 'уравнение уже решено' });
      return false;
    }
    const n = tool.n;
    const applyForm = (f: LinForm): LinForm | null => {
      switch (tool.op) {
        case 'add': return { k: f.k, b: f.b.add(n) };
        case 'sub': return { k: f.k, b: f.b.sub(n) };
        case 'mul': return { k: f.k.mul(n), b: f.b.mul(n) };
        case 'div': return { k: f.k.div(n), b: f.b.div(n) }; // n ≠ 0 гарантирует кузница
        case 'addx': return { k: f.k.add(n), b: f.b };
        case 'subx': return { k: f.k.sub(n), b: f.b };
        default: return null;
      }
    };
    const hit = applyForm(side === 'left' ? eq.left : eq.right);
    if (!hit) {
      this.emit({ kind: 'tool-rejected', objectId: eq.id, tool, reason: 'по уравнению бьют только ±N, ×N, ÷N и ±x' });
      return false;
    }
    if (isNeutralAction(tool.op, tool.n)) {
      this.emit({
        kind: 'equation-step', object: eq, tool, side, neutral: true,
        note: `⚖ ${tool.label} — нейтральный удар: весы его даже не заметили`,
      });
      return true;
    }

    const before: EquationState = { left: { ...eq.left }, right: { ...eq.right }, solved: eq.solved };
    if (side === 'left') eq.left = hit;
    else eq.right = hit;

    // Решено = форма «x = c» И честное равновесие (обе чаши равны при секрете)
    const one = Rational.of(1);
    const isX = (f: LinForm) => f.k.equals(one) && f.b.isZero();
    const isConst = (f: LinForm) => f.k.isZero();
    const balanced = linFormEval(eq.left, eq.secret).equals(linFormEval(eq.right, eq.secret));
    if (balanced && ((isX(eq.left) && isConst(eq.right)) || (isConst(eq.left) && isX(eq.right)))) {
      eq.solved = true;
    }

    this.applyLog.push({
      objectId: eq.id,
      kind: 'equation',
      before,
      after: { left: { ...eq.left }, right: { ...eq.right }, solved: eq.solved },
    });

    const burnedAll = eq.left.k.isZero() && eq.left.b.isZero() && eq.right.k.isZero() && eq.right.b.isZero();
    const state = `${linFormText(eq.left, eq.name)} ${balanced ? '=' : '≠'} ${linFormText(eq.right, eq.name)}`;
    const answer = isConst(eq.right) ? eq.right.b : eq.left.b;
    const pan = side === 'left' ? 'левая чаша' : 'правая чаша';
    const note = burnedAll
      ? `⚖ ×0: уравнение сгорело — 0 = 0 верно для любого ${eq.name}. Информация потеряна`
      : eq.solved
        ? `🔓 решено: ${state} — ${eq.name} = ${answer.toDisplay()}`
        : `⚖ ${pan} ${tool.label}: ${state}${balanced ? '' : ' — теперь тот же удар по другой чаше'}`;
    this.emit({ kind: 'equation-step', object: eq, tool, side, note });
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

    if (last.kind === 'removal') {
      // воскрешение: тот же экземпляр возвращается на доску
      this.objects.set(last.object.id, last.object);
      this.emit({ kind: 'object-spawned', object: last.object });
      this.emit({ kind: 'undo', objectId: last.object.id, note: '⟲ удаление отменено' });
      return true;
    }
    if (last.kind === 'transfer') {
      const from = this.objects.get(last.fromId);
      const to = this.objects.get(last.toId);
      if (!from || from.kind !== 'number' || !to || to.kind !== 'number') return this.undo();
      from.value = from.value.add(last.amount);
      to.value = to.value.sub(last.amount);
      from.trail.pop();
      to.trail.pop();
      this.emit({
        kind: 'undo',
        objectId: last.fromId,
        note: `⟲ переливание отменено: снова ${from.value.toDisplay()} и ${to.value.toDisplay()}`,
      });
      return true;
    }
    const obj = this.objects.get(last.objectId);
    if (!obj) return this.undo(); // объект уже удалён — отматываем дальше
    if (last.kind === 'spawn') {
      this.removeObject(last.objectId, true); // тихо: без встречной записи в журнал
      this.emit({ kind: 'undo', objectId: last.objectId, note: '⟲ создание отменено' });
      return true;
    }

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
    if (last.kind === 'point' && obj.kind === 'point') {
      obj.x = last.before.x;
      obj.y = last.before.y;
      this.emit({
        kind: 'undo',
        objectId: obj.id,
        note: `⟲ ${obj.label} вернулась в (${obj.x.toDisplay()}; ${obj.y.toDisplay()})`,
      });
      return true;
    }
    if (last.kind === 'vector' && obj.kind === 'vector') {
      obj.dx = last.before.dx;
      obj.dy = last.before.dy;
      this.emit({
        kind: 'undo',
        objectId: obj.id,
        note: `⟲ ${obj.label} снова (${obj.dx.toDisplay()}; ${obj.dy.toDisplay()})`,
      });
      return true;
    }
    if (last.kind === 'cuboid' && obj.kind === 'cuboid') {
      obj.w = last.before.w;
      obj.d = last.before.d;
      obj.h = last.before.h;
      this.emit({ kind: 'undo', objectId: obj.id, note: `⟲ ${this.cuboidNote(obj)}` });
      return true;
    }
    if (last.kind === 'angle' && obj.kind === 'angle') {
      obj.deg = last.before.deg;
      this.emit({ kind: 'undo', objectId: obj.id, note: `⟲ ${obj.label} снова ${obj.deg.toDisplay()}°` });
      return true;
    }
    if (last.kind === 'equation' && obj.kind === 'equation') {
      obj.left = { ...last.before.left };
      obj.right = { ...last.before.right };
      obj.solved = last.before.solved;
      this.emit({
        kind: 'undo',
        objectId: obj.id,
        note: `⟲ ${linFormText(obj.left, obj.name)} = ${linFormText(obj.right, obj.name)}`,
      });
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
