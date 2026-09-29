/**
 * Значки: копии набора и список имён не разъехались, всякое имя из разметки
 * существует, лишних файлов нет, сноска считает значки верно, а пиктограммы
 * в текстах — только метки из таблицы (или математическая запись).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KLAARHEID_NAMES } from '../src/icons/names';
import {
  PICTOGRAMS, isIconName, icon, pictogramRuns, decoratePictograms, watchPictograms,
} from '../src/icons';

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'src/icons/klaarheid');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return walk(rel, ext);
    return ext.test(e.name) ? [rel] : [];
  });
}

const SOURCES = [...walk('src', /\.ts$/), 'index.html'];
const TEXTBOOK = walk('public/textbook', /\.(html|json)$/);

describe('значки Klaarheid', () => {
  it('names.ts совпадает с файлами (иначе — npm run icons:sync)', () => {
    const files = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
    expect([...KLAARHEID_NAMES]).toEqual(files);
  });

  it('копии — «контур заливкой»: только пути с currentColor', () => {
    for (const name of KLAARHEID_NAMES) {
      const svg = fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8');
      expect(svg, name).toMatch(/viewBox="0 0 24 24"/);
      const tags = [...svg.matchAll(/<([a-zA-Z]+)\b/g)].map((m) => m[1]);
      expect(tags.filter((t) => t !== 'svg' && t !== 'path'), name).toEqual([]);
      for (const m of svg.matchAll(/fill="([^"]*)"/g)) expect(m[1], name).toBe('currentColor');
    }
  });

  it('каждое data-icon в разметке и учебнике — существующий значок', () => {
    for (const file of [...SOURCES, ...TEXTBOOK]) {
      for (const m of read(file).matchAll(/data-icon="([a-z0-9-]+)"/g)) {
        expect(isIconName(m[1]!), `${file}: data-icon="${m[1]}"`).toBe(true);
      }
    }
  });

  it('лишних значков нет: каждый где-то используется', () => {
    const code = SOURCES.filter((f) => !f.endsWith('names.ts')).map(read).join('\n')
      + TEXTBOOK.map(read).join('\n');
    for (const name of KLAARHEID_NAMES) {
      expect(code.includes(`'${name}'`) || code.includes(`"${name}"`), `значок ${name} не используется`).toBe(true);
    }
  });

  it('сноска в THIRD-PARTY-NOTICES.md считает значки верно', () => {
    const notices = read('THIRD-PARTY-NOTICES.md');
    const m = /В ООМ вход(?:и|я)т ([0-9]+) значк/.exec(notices);
    expect(m, 'в разделе «Значки» нет числа — запустите npm run icons:sync').not.toBeNull();
    expect(Number(m![1])).toBe(KLAARHEID_NAMES.length);
  });

  it('разметка значка: currentColor у набора, свои цвета у молотка', () => {
    expect(icon('plus', 20)).toMatch(/^<svg class="icon" width="20" height="20" viewBox="0 0 24 24"/);
    expect(icon('plus')).toContain('fill="currentColor"');
    expect(icon('hammer')).toContain('viewBox="0 0 1052 985"');
    expect(icon('hammer')).toContain('#c89a3d');
  });
});

describe('пиктограммы-метки', () => {
  it('каждая метка ведёт к существующему значку', () => {
    for (const [mark, name] of Object.entries(PICTOGRAMS)) {
      expect(isIconName(name), `${mark} → ${name}`).toBe(true);
    }
  });

  it('разбивка текста на текст и значки', () => {
    expect(pictogramRuns('без меток')).toEqual([{ text: 'без меток' }]);
    expect(pictogramRuns('✂ ×2')).toEqual([{ icon: 'scissors' }, { text: ' ×2' }]);
    expect(pictogramRuns('⭐️ Два ⭐')).toEqual([{ icon: 'star-fill' }, { text: ' Два ' }, { icon: 'star-fill' }]);
    // отмена и поворот — разные метки, зеркала различают ось
    expect(pictogramRuns('↶↺↻↕↔').map((r) => ('icon' in r ? r.icon : r.text)))
      .toEqual(['undo', 'rotate-ccw', 'rotate-cw', 'flip-vertical', 'flip-horizontal']);
  });

  it('метки в DOM меняются на значки, текст и <option> не трогаются', () => {
    document.body.innerHTML = '<p id="p">🎯 Задание: ⭐ зеркало ↕ от X</p><select><option id="o">⭐</option></select>';
    decoratePictograms(document.body);
    const p = document.getElementById('p')!;
    expect([...p.querySelectorAll('.pic')].map((e) => (e as HTMLElement).dataset.pic))
      .toEqual(['target', 'star-fill', 'flip-vertical']);
    expect(p.textContent).toBe(' Задание:  зеркало  от X');
    expect(document.getElementById('o')!.textContent).toBe('⭐');
  });

  it('наблюдатель украшает новый текст', async () => {
    document.body.innerHTML = '<ol id="log"></ol>';
    const observer = watchPictograms(document.body);
    const li = document.createElement('li');
    li.textContent = '📍 Т1 → (3; 2)';
    document.getElementById('log')!.appendChild(li);
    await new Promise((r) => setTimeout(r, 0));
    expect(li.querySelector('.pic')?.getAttribute('data-pic')).toBe('map-pin');
    observer.disconnect();
  });

  it('в текстах нет пиктограмм мимо таблицы: только метки или запись', () => {
    // символы-пиктограммы: стрелки, технические знаки, геометрические фигуры,
    // разные символы и дингбаты, дополнительные стрелки, эмодзи
    const PICTO = /[←-⇿⌀-⏿■-➿⟰-⟿⤀-⥿⬀-⯿\u{1F000}-\u{1FAFF}]/gu;
    // стрелки как математическая запись: «вход → выход», «x ⟷ 1/x»
    const NOTATION = new Set(['→', '←', '↑', '↓', '⟷']);
    const stray: string[] = [];
    for (const file of [...SOURCES, ...TEXTBOOK]) {
      if (file.endsWith(path.join('icons', 'index.ts'))) continue; // сама таблица меток
      read(file).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(PICTO)) {
          if (!(m[0] in PICTOGRAMS) && !NOTATION.has(m[0])) stray.push(`${file}:${i + 1}: ${m[0]}`);
        }
      });
    }
    expect(stray).toEqual([]);
  });
});
