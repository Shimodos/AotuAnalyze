/**
 * Проверка предохранителя записи и формата файла правок.
 *
 * Работает ТОЛЬКО на фикстуре во временной папке: настоящий Dropbox этот
 * скрипт не открывает. Корень подменяется через VIARDE_ROOT до импорта
 * модулей, потому что CONFIG читает переменные один раз при загрузке.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'viarde-rev-'));
process.env.VIARDE_ROOT = FIXTURE;

const PROJECT = path.join(FIXTURE, 'Kraus_999_Fixture');
const SCENE = 'KSF-1616BB_KPF-1610BB_Scene_1';
fs.mkdirSync(path.join(PROJECT, '04_JPG', SCENE), { recursive: true });

async function main() {
const { revisionsFilePath, writeRevisionsFile, REVISIONS_FILE } = await import(
  '../src/checklist/file'
);

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '  — ' + detail : ''));
  if (!ok) failed++;
}

console.log('фикстура:', FIXTURE);
console.log('\n1. Куда разрешено писать');
const good = revisionsFilePath(PROJECT, SCENE);
check('обычная сцена', good === path.join(PROJECT, '04_JPG', SCENE, REVISIONS_FILE), String(good));

console.log('\n2. Куда писать запрещено');
check('обход вверх через ..', revisionsFilePath(PROJECT, '..') === null);
check('обход в Outbox', revisionsFilePath(PROJECT, '../05_Outbox') === null);
check('слэш в имени сцены', revisionsFilePath(PROJECT, 'Scene/../../..') === null);
check('обратный слэш', revisionsFilePath(PROJECT, 'Scene\\..\\..') === null);
check('пустое имя сцены', revisionsFilePath(PROJECT, '') === null);
check('проект вне корня', revisionsFilePath('C:/Windows/System32', SCENE) === null);

console.log('\n3. Запись файла');
const DOC = {
  projectFolder: 'Kraus_999_Fixture',
  sceneName: SCENE,
  round: 3,
  items: [
    { fileName: 'KSF-1616BB_Angle01.jpg', isDone: true, note: 'замінив змішувач,\nприбрав відблиск' },
    { fileName: 'KSF-1616BB_Angle01B.jpg', isDone: false, note: null },
    { fileName: 'KSF-1616BB_Angle02.jpg', isDone: true, note: null },
    { fileName: 'старое_имя.jpg', isDone: true, note: 'кадр перейменували', isOrphan: true },
  ],
};
const res = writeRevisionsFile(PROJECT, DOC);
check('файл записан', res.ok, res.path ?? res.reason ?? '');

const raw = fs.readFileSync(good!);
check('BOM на месте (Блокнот покажет кириллицу)', raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf);
const text = raw.toString('utf8').replace(/^\uFEFF/, '');
check('переводы строк CRLF', text.includes('\r\n') && !/[^\r]\n/.test(text));
check('счётчик посчитан', text.includes('внесено 3 из 4'), text.split('\r\n')[2]);
check('многострочная заметка выровнена', text.includes('\r\n    прибрав відблиск'));
check('потерянный кадр помечен', text.includes('(файла нет на диске)'));

console.log('\n3а. Повторные записи — файл лежит в Dropbox, лишние ревизии нам не нужны');
const same = writeRevisionsFile(PROJECT, DOC);
check('тот же чеклист — файл не переписан', same.ok && same.unchanged === true, JSON.stringify(same));

const mtimeBefore = fs.statSync(good!).mtimeMs;
const changed = writeRevisionsFile(PROJECT, {
  ...DOC,
  items: DOC.items.map((i) => (i.fileName === 'KSF-1616BB_Angle01B.jpg' ? { ...i, isDone: true } : i)),
});
check('изменение сразу после записи — отложено', changed.ok && changed.deferred === true, JSON.stringify(changed));
check('файл пока не тронут', fs.statSync(good!).mtimeMs === mtimeBefore);

console.log('   ждём 5.5 с, пока сработает отложенная запись…');
await new Promise((r) => setTimeout(r, 5_500));
const after = fs.readFileSync(good!, 'utf8');
check('последняя версия дописана сама', after.includes('внесено 4 из 4'), after.split('\r\n')[2]);

console.log('\n--- получившийся файл ---');
console.log(after.replace(/^﻿/, ''));

console.log('4. Запись в несуществующую сцену');
const missing = writeRevisionsFile(PROJECT, {
  projectFolder: 'Kraus_999_Fixture',
  sceneName: 'Сцены_такой_нет',
  round: 1,
  items: [],
});
check('папку не создаём, отказ', !missing.ok && missing.reason === 'no-scene-folder', missing.reason ?? '');

console.log('\n5. Проверка, что в фикстуре нет ничего лишнего');
const created = fs.readdirSync(path.join(PROJECT, '04_JPG', SCENE));
check('в папке сцены ровно один наш файл', created.length === 1 && created[0] === REVISIONS_FILE, created.join(', '));

fs.rmSync(FIXTURE, { recursive: true, force: true });
console.log('\nфикстура удалена');
console.log(failed === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : 'ПРОВАЛОВ: ' + failed);
process.exit(failed === 0 ? 0 : 1);
}

main();
