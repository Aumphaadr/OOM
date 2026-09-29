#!/usr/bin/env node
// Синхронизация значков ООМ с набором Klaarheid Icons.
//
//   node tools/sync-icons.mjs <путь к Klaarheid-Icons> [имя …]
//   npm run icons:sync -- <путь к Klaarheid-Icons> [имя …]
//
// Берёт каждый значок, который уже лежит в src/icons/klaarheid/, и новые имена
// из командной строки — и копирует их байт в байт из svg/fill набора. Затем
// пересобирает src/icons/names.ts (имена для типов) и раздел «Значки»
// в THIRD-PARTY-NOTICES.md между метками klaarheid:start и klaarheid:end:
// число значков и лицензию набора — MIT-0.
//
// Убрать значок из ООМ: удалить его файл из src/icons/klaarheid/ и запустить
// синхронизацию. Черновики набора (имена на zz-) не берутся.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(ROOT, 'src', 'icons', 'klaarheid');
const NAMES_FILE = path.join(ROOT, 'src', 'icons', 'names.ts');
const NOTICES_FILE = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const START = /<!-- klaarheid:start[^>]*-->/u;
const END = '<!-- klaarheid:end -->';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const SET_URL = 'https://aumphaadr.github.io/Klaarheid-Icons/';
const REPO_URL = 'https://github.com/Aumphaadr/Klaarheid-Icons';

function fail(message) {
  console.error(`sync-icons: ${message}`);
  process.exit(1);
}

/** 1 значок, 2 значка, 5 значков. */
function plural(n, one, few, many) {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

// ---------- аргументы ----------

const [setDirArg, ...extra] = process.argv.slice(2);
if (!setDirArg) {
  fail('укажите путь к репозиторию Klaarheid-Icons: node tools/sync-icons.mjs <путь> [имя …]');
}
const setDir = path.resolve(setDirArg);
const fillDir = path.join(setDir, 'svg', 'fill');
if (!fs.existsSync(fillDir)) fail(`в «${setDir}» нет папки svg/fill — это точно Klaarheid-Icons?`);

fs.mkdirSync(ICON_DIR, { recursive: true });
const present = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
const names = [...new Set([...present, ...extra])].sort();
for (const name of names) {
  if (!NAME.test(name)) fail(`странное имя значка «${name}»`);
  if (name.startsWith('zz-')) fail(`«${name}» — черновик набора, в проекты он не идёт`);
}

// ---------- проверки до записи ----------

// Раздел «Значки» говорит, что на значки действует только MIT-0. Если набор
// снова заведёт список значков под другими лицензиями, это будет неправдой.
if (fs.existsSync(path.join(setDir, 'src', 'third-party.mjs'))) {
  fail('в наборе есть src/third-party.mjs — часть значков снова под другими лицензиями, '
    + 'а раздел «Значки» говорит только о MIT-0; синхронизация остановлена');
}

const sources = new Map();
for (const name of names) {
  const from = path.join(fillDir, `${name}.svg`);
  if (!fs.existsSync(from)) fail(`в наборе нет значка «${name}» (svg/fill/${name}.svg)`);
  const bytes = fs.readFileSync(from);
  const tags = [...bytes.toString('utf8').matchAll(/<([a-zA-Z]+)\b/gu)].map((m) => m[1]);
  const foreign = tags.filter((t) => t !== 'svg' && t !== 'path');
  if (foreign.length) fail(`${name}.svg: кроме <path> в нём есть <${foreign[0]}> — ООМ рисует только пути`);
  sources.set(name, bytes);
}

const notices = fs.readFileSync(NOTICES_FILE, 'utf8');
const start = START.exec(notices);
const endAt = notices.indexOf(END);
if (!start || endAt < start.index) fail('в THIRD-PARTY-NOTICES.md нет меток klaarheid:start и klaarheid:end');

// ---------- копии байт в байт ----------

let added = 0;
let changed = 0;
for (const [name, bytes] of sources) {
  const to = path.join(ICON_DIR, `${name}.svg`);
  const old = fs.existsSync(to) ? fs.readFileSync(to) : null;
  if (!old) added++;
  else if (!old.equals(bytes)) changed++;
  fs.writeFileSync(to, bytes);
}

// ---------- имена для типов ----------

const namesTs = [
  '// Имена значков Klaarheid Icons, которые лежат в ./klaarheid.',
  '// Файл пересобирает tools/sync-icons.mjs — руками не править.',
  'export const KLAARHEID_NAMES = [',
  ...names.map((n) => `  '${n}',`),
  '] as const;',
  '',
].join('\n');
fs.writeFileSync(NAMES_FILE, namesTs);

// ---------- раздел «Значки» ----------

const count = names.length;
const parts = [
  'Значки интерфейса, холста и учебника взяты из набора',
  `[Klaarheid Icons](${SET_URL}) ([репозиторий](${REPO_URL})),`,
  'который разработан автором ООМ и опубликован под лицензией **MIT-0**. Лицензия',
  'разрешает любое использование без условий и без упоминания автора.',
  `В ООМ ${plural(count, 'входит', 'входят', 'входят')} ${count} ${plural(count, 'значок', 'значка', 'значков')} набора`
    + ' в варианте «контур заливкой»; они лежат',
  'в `src/icons/klaarheid/` — это копии файлов набора байт в байт.',
  '',
  'Раздел пересобирается командой `npm run icons:sync`.',
];
const section = `${start[0]}\n${parts.join('\n')}\n${END}`;
fs.writeFileSync(NOTICES_FILE, notices.slice(0, start.index) + section + notices.slice(endAt + END.length));

// ---------- итог ----------

console.log(`значков: ${count} (новых ${added}, обновлено ${changed})`);

// Предупредить, если ООМ берёт ещё не опубликованные версии значков
// (сверка — по git набора, если он есть).
try {
  const files = names.map((n) => `svg/fill/${n}.svg`);
  const dirty = execFileSync('git', ['-C', setDir, 'status', '--porcelain', '--', ...files], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) {
    console.log(`внимание: в рабочей копии набора не закоммичены ${dirty.length} из взятых файлов — ${dirty.join(' ')}`);
  }
} catch {
  // набор без git — сверять нечего
}
