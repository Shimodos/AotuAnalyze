/**
 * Разведка: приходят ли комментарии клиента через журнал событий команды.
 *
 * Запуск:
 *   set VIARDE_DROPBOX_TOKEN=<team access token>
 *   npx tsx scripts/probe-comments.ts [дней=90]
 *
 * Токен нужен от team app со скоупами events.read и team_info.read.
 * Скрипт только читает и ничего не меняет.
 *
 * Зачем скрипт, а не вывод из документации: спецификация API содержит события
 * file_add_comment с полем comment_text, а справка Dropbox утверждает, что
 * комментарии в журнал не пишутся. Противоречие разрешается только проверкой
 * на конкретном аккаунте и тарифе.
 */

const TOKEN = process.env.VIARDE_DROPBOX_TOKEN;
const DAYS = Number(process.argv[2] ?? 90);

if (!TOKEN) {
  console.error('Нет токена. Задай VIARDE_DROPBOX_TOKEN — team access token.');
  process.exit(1);
}

const API = 'https://api.dropboxapi.com/2';

async function call(route: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/** Из ассетов события достаём файл, к которому относится комментарий */
function targetFile(event: any): { path: string; id: string } | null {
  for (const asset of event.assets ?? []) {
    if (asset['.tag'] === 'file') {
      return {
        path: asset.path?.contextual ?? asset.path?.namespace_relative?.relative_path ?? '—',
        id: asset.file_id ?? '—',
      };
    }
  }
  return null;
}

async function main() {
  console.log(`Окно поиска: последние ${DAYS} дней\n`);

  // 1. Включены ли файловые события на тарифе
  try {
    const features = await call('team/features/get_values', {
      features: [{ '.tag': 'has_team_file_events' }],
    });
    const value = features.values?.[0]?.has_team_file_events;
    console.log('has_team_file_events:', value?.enabled === true ? 'включено' : 'ВЫКЛЮЧЕНО');
  } catch (error) {
    console.log('features/get_values не отвечает:', (error as Error).message);
  }

  // 2. Тянем категорию comments за окно
  const startTime = new Date(Date.now() - DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');

  let page = await call('team_log/get_events', {
    limit: 1000,
    category: { '.tag': 'comments' },
    time: { start_time: startTime },
  });

  const events: any[] = [...(page.events ?? [])];
  let guard = 0;
  while (page.has_more && guard++ < 20) {
    page = await call('team_log/get_events/continue', { cursor: page.cursor });
    events.push(...(page.events ?? []));
  }

  console.log(`\nСобытий в категории comments: ${events.length}`);
  if (events.length === 0) {
    console.log('\nПусто. Возможные причины:');
    console.log('  — комментарии действительно не логируются на этом тарифе');
    console.log('  — за выбранный период клиент ничего не комментировал');
    console.log('  — комментарии внешних людей не попадают в журнал команды');
    console.log('Проверь: оставь тестовый комментарий на файле и запусти скрипт снова.');
    return;
  }

  // 3. Что именно пришло
  const byType = new Map<string, number>();
  for (const e of events) {
    const tag = e.event_type?.['.tag'] ?? '?';
    byType.set(tag, (byType.get(tag) ?? 0) + 1);
  }
  console.log('\nПо типам:');
  for (const [tag, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${tag.padEnd(34)} ${n}`);

  console.log('\nПримеры (до 15):');
  let shown = 0;
  let withText = 0;
  let withFile = 0;
  let external = 0;

  for (const e of events) {
    const text = e.details?.comment_text;
    const file = targetFile(e);
    if (text) withText++;
    if (file) withFile++;
    if (e.involve_non_team_member) external++;

    if (shown++ < 15) {
      const actor =
        e.actor?.user?.display_name ??
        e.actor?.user?.email ??
        e.actor?.['.tag'] ??
        '—';
      console.log(`  ${e.timestamp}  ${e.event_type?.['.tag']}`);
      console.log(`     кто:    ${actor}${e.involve_non_team_member ? ' (вне команды)' : ''}`);
      console.log(`     файл:   ${file ? file.path : 'НЕ УКАЗАН'}`);
      console.log(`     текст:  ${text ? JSON.stringify(String(text).slice(0, 120)) : 'НЕТ'}`);
    }
  }

  console.log('\nИтог:');
  console.log(`  событий с текстом комментария: ${withText} из ${events.length}`);
  console.log(`  событий с привязкой к файлу:   ${withFile} из ${events.length}`);
  console.log(`  событий от людей вне команды:  ${external} из ${events.length}`);
  console.log('\nЕсли все три числа заметно больше нуля — путь рабочий,');
  console.log('комментарии можно подтягивать в трекер и показывать на карточках.');
}

main().catch((error) => {
  console.error('\nОшибка:', error instanceof Error ? error.message : error);
  process.exit(1);
});

export {};
