/** Как парсер разберёт то или иное имя папки в 05_Outbox */
import { parseDelivery } from '../src/scanner/parse';

const project = 'Kraus_211_Gold_Finish_Refresh';
const names = process.argv.slice(2);

for (const name of names) {
  const r = parseDelivery(name, project);
  const verdict = r.isJunk
    ? 'ИГНОР (мусорный маркер)'
    : r.kind
      ? `-> колонка ${r.kind}${r.round ? `, круг ${r.round}` : ''}`
      : 'НЕ РАСПОЗНАНО';
  console.log('  ' + name.padEnd(48) + verdict);
}
