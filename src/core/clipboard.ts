import { Rational } from './rational';
import { Session } from './session';
import { MathObject } from './model';

/**
 * Внутренний буфер обмена: сквозной между сценами. Хранит математическую
 * суть объекта (не id и не позиции сцен), поэтому вставка всегда рождает
 * свежий объект. dx/dy — смещение от якоря скопированной группы, чтобы
 * группа вставлялась с сохранением взаимного расположения.
 */
export type ClipItem =
  | { kind: 'number'; value: Rational;
      variable?: { name: string; min: Rational; max: Rational; step: Rational };
      dx: number; dy: number }
  | { kind: 'tape'; whole: Rational; mode: number | null; cuts: Rational[];
      strictGrid: boolean; unitLen: Rational | null; dx: number; dy: number }
  | { kind: 'rect'; w: Rational; h: Rational; cutsX: Rational[]; cutsY: Rational[];
      showW: boolean; showH: boolean; showArea: boolean;
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
        ...(obj.variable && { variable: { ...obj.variable } }),
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
    default:
      return null;
  }
}

/** Вставка: свежий объект из снимка (позицию в сцене задаёт сама сцена). */
export function spawnFromClip(session: Session, item: ClipItem): MathObject {
  switch (item.kind) {
    case 'number': {
      const o = session.spawnObject(item.value);
      if (item.variable) o.variable = { ...item.variable };
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
  }
}
