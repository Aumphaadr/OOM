import { Rational } from './rational';
import { Session } from './session';
import { PrimitiveOp, VarOp } from './model';

/**
 * Сериализация доски (формат v1). Сохраняются объекты всех типов, инструменты
 * и карманы сцен (позиции). Сценные настройки вне сессии (позиции участков
 * конвейера, зум прямой) пока не сохраняются — это состояние показа, не доски.
 */

const rStr = (r: Rational): string => `${r.num}/${r.den}`;
const rParse = (s: string): Rational => {
  const [a, b] = s.split('/');
  return Rational.of(BigInt(a!), BigInt(b ?? '1'));
};

export interface BoardJson {
  v: 1;
  tools: (
    | { op: PrimitiveOp | VarOp; n: string; hidden: boolean }
    | { op: 'seq'; name: string; steps: { op: PrimitiveOp; n: string }[]; hidden: boolean }
  )[];
  objects: (
    | { kind: 'number'; trail: string[]; scenePos: Record<string, { x: number; y: number }>;
        variable?: { name: string; min: string; max: string; step: string } }
    | { kind: 'tape'; label: string; whole: string; mode: number | null;
        /** новые сохранения — позиции-дроби ("1/6"); старые — индексы швов (числа) */
        cuts: (string | number)[]; strictGrid?: boolean; unitLen?: string | null;
        scenePos?: Record<string, { x: number; y: number }> }
    | { kind: 'unknown'; name: string; secret: string; rhs: string; revealed: boolean;
        ops: { op: PrimitiveOp; n: string }[] }
    | { kind: 'rect'; label: string; w: string; h: string; cutsX: string[]; cutsY: string[];
        showW?: boolean; showH?: boolean; showArea?: boolean; showPerimeter?: boolean;
        scenePos?: Record<string, { x: number; y: number }> }
    | { kind: 'equation'; name: string; secret: string;
        left: { k: string; b: string }; right: { k: string; b: string }; solved: boolean }
  )[];
}

export function exportBoard(session: Session): string {
  const data: BoardJson = { v: 1, tools: [], objects: [] };
  for (const t of session.tools.values()) {
    if (t.steps) {
      data.tools.push({
        op: 'seq', name: t.label, hidden: t.hidden,
        steps: t.steps.map((s) => ({ op: s.op, n: rStr(s.n) })),
      });
    } else {
      data.tools.push({ op: t.op as PrimitiveOp | VarOp, n: rStr(t.n), hidden: t.hidden });
    }
  }
  for (const o of session.objects.values()) {
    if (o.kind === 'number') {
      data.objects.push({
        kind: 'number',
        trail: o.trail.map(rStr),
        scenePos: Object.fromEntries(o.scenePos),
        ...(o.variable && {
          variable: {
            name: o.variable.name,
            min: rStr(o.variable.min),
            max: rStr(o.variable.max),
            step: rStr(o.variable.step),
          },
        }),
      });
    } else if (o.kind === 'tape') {
      data.objects.push({
        kind: 'tape', label: o.label, whole: rStr(o.whole),
        mode: o.mode, cuts: o.cuts.map(rStr), strictGrid: o.strictGrid,
        unitLen: o.unitLen ? rStr(o.unitLen) : null,
        scenePos: Object.fromEntries(o.scenePos),
      });
    } else if (o.kind === 'rect') {
      data.objects.push({
        kind: 'rect', label: o.label, w: rStr(o.w), h: rStr(o.h),
        cutsX: o.cutsX.map(rStr), cutsY: o.cutsY.map(rStr),
        showW: o.showW, showH: o.showH, showArea: o.showArea, showPerimeter: o.showPerimeter,
        scenePos: Object.fromEntries(o.scenePos),
      });
    } else if (o.kind === 'equation') {
      data.objects.push({
        kind: 'equation', name: o.name, secret: rStr(o.secret),
        left: { k: rStr(o.left.k), b: rStr(o.left.b) },
        right: { k: rStr(o.right.k), b: rStr(o.right.b) },
        solved: o.solved,
      });
    } else {
      data.objects.push({
        kind: 'unknown', name: o.name, secret: rStr(o.secret), rhs: rStr(o.rhs),
        revealed: o.revealed, ops: o.ops.map((s) => ({ op: s.op, n: rStr(s.n) })),
      });
    }
  }
  return JSON.stringify(data);
}

export function importBoard(session: Session, json: string): boolean {
  try {
    return importBoardData(session, JSON.parse(json) as BoardJson);
  } catch {
    return false;
  }
}

export function importBoardData(session: Session, data: BoardJson): boolean {
  if (data.v !== 1) return false;
  session.clearAll();
  try {
    for (const t of data.tools) {
      const tool = t.op === 'seq'
        ? session.addComposite(t.steps.map((s) => ({ op: s.op, n: rParse(s.n) })), t.name)
        : t.op === 'addx' || t.op === 'subx'
          ? session.addVarTool(t.op, rParse(t.n))
          : session.addTool(t.op, rParse(t.n));
      if (t.hidden) session.setToolHidden(tool.id, true);
    }
    for (const o of data.objects) {
      if (o.kind === 'number') {
        const trail = o.trail.map(rParse);
        const obj = session.spawnObject(trail[trail.length - 1] ?? Rational.of(0));
        obj.trail.splice(0, obj.trail.length, ...(trail.length ? trail : [obj.value]));
        for (const [sceneId, pos] of Object.entries(o.scenePos)) {
          obj.scenePos.set(sceneId, pos);
        }
        if (o.variable) {
          obj.variable = {
            name: o.variable.name,
            min: rParse(o.variable.min),
            max: rParse(o.variable.max),
            step: rParse(o.variable.step),
          };
        }
      } else if (o.kind === 'tape') {
        const tape = session.spawnTape(rParse(o.whole), o.mode, o.label);
        // совместимость: старые сохранения хранили индексы швов числами
        tape.cuts = o.cuts.map((c) =>
          typeof c === 'number' ? Rational.of(c, o.mode ?? 1) : rParse(c),
        );
        tape.strictGrid = o.strictGrid ?? true;
        tape.unitLen = o.unitLen ? rParse(o.unitLen) : null;
        for (const [sceneId, pos] of Object.entries(o.scenePos ?? {})) {
          tape.scenePos.set(sceneId, pos);
        }
      } else if (o.kind === 'rect') {
        const r = session.spawnRect(rParse(o.w), rParse(o.h));
        r.cutsX = o.cutsX.map(rParse);
        r.cutsY = o.cutsY.map(rParse);
        r.showW = o.showW ?? true;
        r.showH = o.showH ?? true;
        r.showArea = o.showArea ?? true;
        r.showPerimeter = o.showPerimeter ?? false;
        for (const [sceneId, pos] of Object.entries(o.scenePos ?? {})) {
          r.scenePos.set(sceneId, pos);
        }
      } else if (o.kind === 'equation') {
        const eq = session.spawnEquation(o.name, rParse(o.secret),
          { k: rParse(o.left.k), b: rParse(o.left.b) },
          { k: rParse(o.right.k), b: rParse(o.right.b) });
        eq.solved = o.solved;
      } else {
        const u = session.spawnUnknown(o.name, rParse(o.secret));
        u.ops = o.ops.map((s) => ({ op: s.op, n: rParse(s.n) }));
        u.rhs = rParse(o.rhs);
        u.revealed = o.revealed;
      }
    }
    return true;
  } catch {
    session.clearAll();
    return false;
  }
}
