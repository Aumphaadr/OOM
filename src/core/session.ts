import { Rational } from './rational';
import {
  MathObject, NumberObject, TapeObject, UnknownObject, Tool,
  makeTool, makeCompositeTool, toolInvertsSticker, exprFor, toolLabel,
  tapePieceLabels, tapeNumerator, PrimitiveOp,
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

type LogEntry =
  | { objectId: string; kind: 'number'; before: Rational; after: Rational }
  | { objectId: string; kind: 'tape'; before: TapeState; after: TapeState }
  | { objectId: string; kind: 'unknown'; before: UnknownState; after: UnknownState };

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
