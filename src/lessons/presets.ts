import { LessonSpec } from './lesson';

/**
 * Пресеты уроков — заготовки досок. Первые конверсии стенограмм 001–004
 * из idea/стенограммы/ и демо из idea/OOM.txt.
 */
export const PRESETS: LessonSpec[] = [
  {
    id: 'negative-numbers',
    title: 'Отрицательные числа',
    scene: 'boxes',
    objects: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    tools: [
      { op: 'sub', n: '5' },
      { op: 'add', n: '7' },
      { op: 'mul', n: '-1' },
    ],
  },
  {
    id: 'fraction-tapes',
    title: 'Дроби: ленточки',
    scene: 'tapes',
    // стенограмма 003: одинаковые целые, разные доли — сравнение «на просвет»
    tapes: [
      { len: '10', mode: 2 },
      { len: '10', mode: 3 },
      { len: '10', mode: 4 },
      { len: '10', mode: 6 },
      { len: '10', mode: 12 },
    ],
  },
  {
    id: 'black-box',
    title: 'Чёрный ящик (угадай правило)',
    scene: 'conveyor',
    objects: ['1', '2', '3', '4', '5'],
    tools: [
      { op: 'mul', n: '2' },
      { op: 'add', n: '7' },
      { op: 'sq' },
      { op: 'abs' },
    ],
  },
  {
    id: 'equation-detective',
    title: 'Уравнение-детектив',
    scene: 'scales',
    tools: [
      { op: 'mul', n: '2' },
      { op: 'div', n: '2' },
      { op: 'add', n: '3' },
      { op: 'sub', n: '3' },
      { op: 'mul', n: '3' },
      { op: 'div', n: '3' },
    ],
  },
];
