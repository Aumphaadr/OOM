import { Rational } from './rational';
import { Session } from './session';
import { MathObject, VariableSpec } from './model';

/**
 * Внутренний буфер обмена: сквозной между сценами. Хранит математическую
 * суть объекта (не id и не позиции сцен), поэтому вставка всегда рождает
 * свежий объект. dx/dy — смещение от якоря скопированной группы, чтобы
 * группа вставлялась с сохранением взаимного расположения.
 */
export type ClipItem =
  | { kind: 'number'; value: Rational;
      variable?: VariableSpec;
      dx: number; dy: number }
  | { kind: 'tape'; whole: Rational; mode: number | null; cuts: Rational[];
      strictGrid: boolean; unitLen: Rational | null; dx: number; dy: number }
  | { kind: 'rect'; w: Rational; h: Rational; cutsX: Rational[]; cutsY: Rational[];
      showW: boolean; showH: boolean; showArea: boolean;
      dx: number; dy: number }
  | { kind: 'polygon'; vertices: { x: Rational; y: Rational }[];
      showArea: boolean; showPerimeter: boolean; showAngles: boolean;
      dx: number; dy: number }
  | { kind: 'circle'; cx: Rational; cy: Rational; r: Rational;
      showRadius: boolean; showArea: boolean; showCircumference: boolean;
      dx: number; dy: number };

export interface Clipboard {
  items: ClipItem[];
}

/** Снимок объекта для буфера (уравнения-весы не копируются). */
export function clipFromObject(obj: MathObject, dx: number, dy: number): ClipItem | null {
  switch (obj.kind) {
    case 'number':
      return {
        kind: 'number', value: obj.value,
        ...(obj.variable && {
          variable: {
            ...obj.variable,
            ...(obj.variable.format && { format: { ...obj.variable.format } }),
          },
        }),
        dx, dy,
      };
    case 'tape':
      return {
        kind: 'tape', whole: obj.whole, mode: obj.mode, cuts: [...obj.cuts],
        strictGrid: obj.strictGrid, unitLen: obj.unitLen, dx, dy,
      };
    case 'rect':
      return {
        kind: 'rect', w: obj.w, h: obj.h, cutsX: [...obj.cutsX], cutsY: [...obj.cutsY],
        showW: obj.showW, showH: obj.showH, showArea: obj.showArea, dx, dy,
      };
    case 'polygon':
      return {
        kind: 'polygon', vertices: obj.vertices.map((v) => ({ x: v.x, y: v.y })),
        showArea: obj.showArea, showPerimeter: obj.showPerimeter, showAngles: obj.showAngles,
        dx, dy,
      };
    case 'circle':
      return {
        kind: 'circle', cx: obj.cx, cy: obj.cy, r: obj.r,
        showRadius: obj.showRadius, showArea: obj.showArea,
        showCircumference: obj.showCircumference, dx, dy,
      };
    default:
      return null;
  }
}

/** Вставка: свежий объект из снимка (позицию в сцене задаёт сама сцена). */
export function spawnFromClip(session: Session, item: ClipItem): MathObject {
  switch (item.kind) {
    case 'number': {
      const o = session.spawnObject(item.value);
      if (item.variable) {
        o.variable = {
          ...item.variable,
          ...(item.variable.format && { format: { ...item.variable.format } }),
        };
      }
      return o;
    }
    case 'tape': {
      const t = session.spawnTape(item.whole, item.mode);
      t.cuts = [...item.cuts];
      t.strictGrid = item.strictGrid;
      t.unitLen = item.unitLen;
      return t;
    }
    case 'rect': {
      const r = session.spawnRect(item.w, item.h);
      r.cutsX = [...item.cutsX];
      r.cutsY = [...item.cutsY];
      r.showW = item.showW;
      r.showH = item.showH;
      r.showArea = item.showArea;
      return r;
    }
    case 'polygon': {
      // снимок валиден по построению (≥3 вершин) — spawn не откажет
      const p = session.spawnPolygon(item.vertices)!;
      p.showArea = item.showArea;
      p.showPerimeter = item.showPerimeter;
      p.showAngles = item.showAngles;
      return p;
    }
    case 'circle': {
      const c = session.spawnCircle(item.cx, item.cy, item.r)!;
      c.showRadius = item.showRadius;
      c.showArea = item.showArea;
      c.showCircumference = item.showCircumference;
      return c;
    }
  }
}
