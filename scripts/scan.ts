/**
 * CLI-скан.
 *   npm run scan          — быстрый скан для доски (~1 с)
 *   npm run scan:sizes    — полный обход с подсчётом веса проектов (медленно)
 */

import { COLUMNS, CONFIG, type Column } from '../src/config';
import { getDb, schema } from '../src/db';
import uk from '../src/i18n/locales/uk.json';
import { syncOnce } from '../src/sync/sync';

/** CLI печатает по-украински — переключателя языка в консоли нет */
const dict = uk as Record<string, string>;
const tr = (key: string, params?: Record<string, string | number>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
    params && name in params ? String(params[name]) : match,
  );
const COLUMN_LABEL = Object.fromEntries(
  COLUMNS.map((c) => [c, tr(`column.${c}`)]),
) as Record<Column, string>;

const withSizes = process.argv.includes('--sizes');
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const root = rootArg ? rootArg.slice('--root='.length) : CONFIG.root;

console.log(`Корень: ${root}`);
console.log(withSizes ? 'Режим: полный обход с размерами\n' : 'Режим: быстрый скан доски\n');

const result = syncOnce({ root, withSizes });

const db = getDb();
const rows = db.select().from(schema.projects).all();
rows.sort((a, b) => (b.jobNumber ?? 0) - (a.jobNumber ?? 0));

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

console.log(
  pad('Джоб', 6) + pad('Проект', 30) + pad('Колонка', 24) + pad('Круг', 6) + pad('Сцены', 8) + 'Основание',
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

console.log('\nКолонки доски:');
for (const c of COLUMNS) {
  const n = rows.filter((r) => r.column === c).length;
  if (n) console.log(`  ${COLUMN_LABEL[c].padEnd(24)} ${n}`);
}

const anomalies = rows.flatMap((r) =>
  (r.anomalies ?? []).map((a) => `[${r.folderName}] ${tr(a.code, a.params)}`),
);
console.log(`\nОтклонений от конвенции: ${anomalies.length}`);
for (const a of anomalies.slice(0, 25)) console.log(`  ${a}`);
if (anomalies.length > 25) console.log(`  … ещё ${anomalies.length - 25}`);

if (result.transitions.length) {
  console.log('\nПереходы за этот скан:');
  for (const t of result.transitions) {
    const from = t.from ? COLUMN_LABEL[t.from] : '—';
    console.log(`  ${t.title}: ${from} → ${COLUMN_LABEL[t.to]}`);
  }
}
if (result.released.length) {
  console.log('\nПин снят автоматически (пришла новая отгрузка):');
  for (const r of result.released) console.log(`  ${r.title} → ${COLUMN_LABEL[r.to]}`);
}
if (result.settling.length) {
  console.log(`\nВ работе прямо сейчас (переход не зафиксирован): ${result.settling.join(', ')}`);
}

if (withSizes) {
  const sized = rows.filter((r) => r.sizeBytes !== null);
  const total = sized.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
  console.log(`\nВес проектов: ${(total / 1024 ** 4).toFixed(2)} ТБ`);
  console.log('Топ-10 по объёму:');
  for (const r of [...sized].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 10)) {
    console.log(`  ${pad(r.title, 34)} ${((r.sizeBytes ?? 0) / 1024 ** 3).toFixed(0)} ГБ`);
  }
}

console.log(`\nГотово за ${result.durationMs} мс, проектов: ${result.projectCount}`);
