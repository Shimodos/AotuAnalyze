/**
 * CLI-скан.
 *   npm run scan          — быстрый скан для доски (~1 с)
 *   npm run scan:sizes    — полный обход с подсчётом веса проектов (медленно)
 *   --quiet               — только скан, без отчёта: так его запускает сервер
 */

import { COLUMNS, CONFIG, type Column } from '../src/config';
import { getDb, schema } from '../src/db';
import { interpolate } from '../src/i18n/interpolate';
import uk from '../src/i18n/locales/uk.json';
import { syncOnce } from '../src/sync/sync';

const withSizes = process.argv.includes('--sizes');
const quiet = process.argv.includes('--quiet');
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const root = rootArg ? rootArg.slice('--root='.length) : CONFIG.root;
// --run=ID: запись в scan_runs уже создал сервер, который нас запустил
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runId = runArg ? Number(runArg.slice('--run='.length)) : undefined;

if (!quiet) {
  console.log(`Корінь: ${root}`);
  console.log(withSizes ? 'Режим: повний обхід з розмірами\n' : 'Режим: швидкий скан дошки\n');
}

const result = syncOnce({ root, withSizes, runId: Number.isFinite(runId) ? runId : undefined });

if (quiet) process.exit(0);

/** CLI печатает по-украински — переключателя языка в консоли нет */
const dict = uk as Record<string, string>;
const tr = (key: string, params?: Record<string, string | number>) => interpolate(dict[key] ?? key, params);
const COLUMN_LABEL = Object.fromEntries(
  COLUMNS.map((c) => [c, tr(`column.${c}`)]),
) as Record<Column, string>;

const db = getDb();
const rows = db.select().from(schema.projects).all();
rows.sort((a, b) => (b.jobNumber ?? 0) - (a.jobNumber ?? 0));

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

console.log(
  pad('Джоб', 6) + pad('Проєкт', 30) + pad('Колонка', 24) + pad('Коло', 6) + pad('Сцени', 8) + 'Підстава',
);
console.log('─'.repeat(120));
for (const r of rows) {
  console.log(
    pad(String(r.jobNumber ?? '?'), 6) +
      pad(r.title, 30) +
      pad(COLUMN_LABEL[r.column as Column] ?? r.column, 24) +
      pad(r.round !== null && r.round > 1 ? `#${r.round}` : '—', 6) +
      pad(r.scenesTotal > 0 ? `${r.scenesRendered}/${r.scenesTotal}` : '—', 8) +
      tr(r.evidence ?? '', (r.evidenceParams as Record<string, string | number>) ?? undefined),
  );
}
console.log('─'.repeat(120));

console.log('\nКолонки дошки:');
for (const c of COLUMNS) {
  const n = rows.filter((r) => r.column === c).length;
  if (n) console.log(`  ${COLUMN_LABEL[c].padEnd(24)} ${n}`);
}

const anomalies = rows.flatMap((r) =>
  (r.anomalies ?? []).map((a) => `[${r.folderName}] ${tr(a.code, a.params)}`),
);
console.log(`\nВідхилень від конвенції: ${anomalies.length}`);
for (const a of anomalies.slice(0, 25)) console.log(`  ${a}`);
if (anomalies.length > 25) console.log(`  … ще ${anomalies.length - 25}`);

if (result.transitions.length) {
  console.log('\nПереходи за цей скан:');
  for (const t of result.transitions) {
    const from = t.from ? COLUMN_LABEL[t.from] : '—';
    console.log(`  ${t.title}: ${from} → ${COLUMN_LABEL[t.to]}`);
  }
}
if (result.released.length) {
  console.log('\nПін знято автоматично (прийшло нове відвантаження):');
  for (const r of result.released) console.log(`  ${r.title} → ${COLUMN_LABEL[r.to]}`);
}
if (result.settling.length) {
  console.log(`\nУ роботі просто зараз (перехід не зафіксовано): ${result.settling.join(', ')}`);
}

if (withSizes) {
  const sized = rows.filter((r) => r.sizeBytes !== null);
  const total = sized.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
  console.log(`\nВага проєктів: ${(total / 1024 ** 4).toFixed(2)} ТБ`);
  console.log('Топ-10 за обсягом:');
  for (const r of [...sized].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 10)) {
    console.log(`  ${pad(r.title, 34)} ${((r.sizeBytes ?? 0) / 1024 ** 3).toFixed(0)} ГБ`);
  }
}

console.log(`\nГотово за ${result.durationMs} мс, проєктів: ${result.projectCount}`);
