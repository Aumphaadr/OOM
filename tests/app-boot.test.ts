/**
 * Бут-смоук приложения: настоящий index.html + main.ts в happy-dom.
 * Цикл отрисовки остановлен (rAF-заглушка), canvas-контекст — прокси-пустышка:
 * проверяется не картинка, а то, что оболочка, сцены и панели живут и кликаются.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');

beforeAll(() => {
  // остановить цикл отрисовки до импорта приложения
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;

  // canvas 2d: вызываемая прокси-пустышка (любое свойство/вызов → она же, число → 0)
  const ctx: unknown = new Proxy(function () {} as unknown as object, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : ctx),
    set: () => true,
    apply: () => ctx,
  });
  (HTMLCanvasElement.prototype as unknown as { getContext(): unknown }).getContext = () => ctx;

  window.confirm = () => true;

  // fetch учебника — с диска, из public/
  globalThis.fetch = (async (url: unknown) => {
    const file = path.join(ROOT, 'public', String(url));
    return {
      json: async () => JSON.parse(fs.readFileSync(file, 'utf8')),
      text: async () => fs.readFileSync(file, 'utf8'),
    };
  }) as typeof fetch;

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const body = html
    .match(/<body>([\s\S]*)<\/body>/)![1]!
    .replace(/<script[\s\S]*?<\/script>/, '');
  document.body.innerHTML = body;
});

describe('приложение', () => {
  it('загружается, сцены переключаются, панели кликаются', async () => {
    await import('../src/main');

    // шесть вкладок сцен; каждая переключается без падений
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('#scene-tabs button')];
    expect(tabs.length).toBe(6);
    for (const tab of tabs) tab.click();

    // кузница: молоток с дробным модификатором из текстового поля
    (document.getElementById('forge-n') as HTMLInputElement).value = '1/3';
    document.getElementById('forge-btn')!.click();
    expect(document.getElementById('tool-list')!.textContent).toContain('+1/3');

    // спавн числа с запятой
    (document.getElementById('spawn-value') as HTMLInputElement).value = '2,5';
    document.getElementById('spawn-btn')!.click();

    // комбо-конструктор: шаг + сборка
    document.getElementById('combo-toggle')!.click();
    expect(document.getElementById('combo-forge')!.hidden).toBe(false);
    document.getElementById('combo-add')!.click();
    expect(document.querySelectorAll('#combo-steps .tool-chip').length).toBe(1);
    document.getElementById('combo-btn')!.click();
    expect(document.querySelectorAll('#combo-steps .tool-chip').length).toBe(0);

    // история и отмена
    document.getElementById('btn-undo')!.click();
    document.getElementById('btn-history')!.click();
    expect(document.getElementById('history-dropdown')!.hidden).toBe(false);
  });

  it('читалка: оглавление из манифеста, глава с кнопками упражнений', async () => {
    document.getElementById('btn-reader')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const links = [...document.querySelectorAll<HTMLButtonElement>('.chapter-link')];
    expect(links.length).toBe(23);

    links[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('[data-exercise]').length).toBeGreaterThan(0);
  });
});
