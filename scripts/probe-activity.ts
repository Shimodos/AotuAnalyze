/**
 * Разведка: что попадает в журнал событий команды БЕЗ фильтра по категории.
 *
 * Зачем отдельный скрипт. probe-comments.ts запрашивал события с
 * `category: comments` — и вывод «действий клиента нет» относился только
 * к этой категории. В панели «Дії з файлом» в вебе видны ещё и просмотры
 * («Гість переглянув цей файл»), а это другие типы событий:
 * по спецификации team_log.stone — file_preview и shared_link_view.
 *
 * Спецификация также подтверждает, что актором события может быть человек
 * вне команды: UserLogInfo имеет подтип NonTeamMemberLogInfo, а ContextLogInfo —
 * вариант non_team_member. Значит проверять надо весь поток, а не одну категорию.
 *
 * Запуск:
 *   set VIARDE_DROPBOX_TOKEN=<team access token со скоупом events.read>
 *   npx tsx scripts/probe-activity.ts [дней=30] [подстрока пути]
 *
 * Скрипт только читает. Ничего не пишет ни в Dropbox, ни в базу.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * .env.local читает только Next.js — обычный tsx-скрипт про него не знает,
 * и dotenv в проекте нет. Поэтому разбираем файл сами: так токен можно
 * положить туда же, где лежат ключи приложения, и не светить его в консоли.
 * Уже заданная переменная окружения приоритетнее файла.
 */
function loadEnvLocal(): void {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[m[1]] && value) process.env[m[1]] = value;
  }
}

loadEnvLocal();

const TOKEN = process.env.VIARDE_DROPBOX_TOKEN;
const DAYS = Number(process.argv[2] ?? 30);
const NEEDLE = (process.argv[3] ?? '').toLowerCase();

if (!TOKEN) {
  console.error(
    'Нет токена. Добавь строку VIARDE_DROPBOX_TOKEN=... в .env.local ' +
      'или задай переменную окружения. Нужен team access token со скоупом events.read.',
  );
  process.exit(1);
}

const API = 'https://api.dropboxapi.com/2';

async function call(route: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} -> ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Имя актора и признак «вне команды» — ради этого всё и затевалось */
function actorOf(e: any): { name: string; outside: boolean } {
  const a = e.actor ?? {};
  const tag = a['.tag'] ?? '?';
  const info = a.user ?? a.admin ?? null;
  const name = info?.display_name ?? info?.email ?? tag;
  const kind = info?.['.tag'] ?? '';
  const outside =
    kind === 'non_team_member' ||
    kind === 'trusted_non_team_member' ||
    tag === 'anonymous' ||
    e.involve_non_team_member === true ||
    e.context?.['.tag'] === 'non_team_member';
  return { name: String(name), outside };
}

function pathsOf(e: any): string[] {
  return (e.assets ?? [])
    .map((a: any) => a.path?.contextual ?? a.path?.namespace_relative?.relative_path ?? a.display_name)
    .filter(Boolean);
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`Журнал команды за ${DAYS} дн., без фильтра по категории.`);
  if (NEEDLE) console.log(`Фильтр по пути: «${NEEDLE}»`);
  console.log('');

  const events: any[] = [];
  let page = await call('team_log/get_events', { limit: 1000, time: { start_time: since } });
  events.push(...page.events);
  while (page.has_more) {
    page = await call('team_log/get_events/continue', { cursor: page.cursor });
    events.push(...page.events);
    if (events.length > 20000) break;
  }

  console.log(`всего событий: ${events.length}\n`);

  const byType = new Map<string, number>();
  const outsideByType = new Map<string, number>();
  const outsidePeople = new Map<string, number>();

  for (const e of events) {
    const type = e.event_type?.['.tag'] ?? '?';
    byType.set(type, (byType.get(type) ?? 0) + 1);
    const { name, outside } = actorOf(e);
    if (outside) {
      outsideByType.set(type, (outsideByType.get(type) ?? 0) + 1);
      outsidePeople.set(name, (outsidePeople.get(name) ?? 0) + 1);
    }
  }

  console.log('— типы событий (топ 25) —');
  for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    const out = outsideByType.get(type) ?? 0;
    console.log(`  ${String(n).padStart(5)}  ${type}${out ? `   (вне команды: ${out})` : ''}`);
  }

  console.log('\n— ГЛАВНОЕ: события, где действовал человек вне команды —');
  if (outsidePeople.size === 0) {
    console.log('  ни одного. Действия клиента в журнал не попадают.');
  } else {
    for (const [name, n] of [...outsidePeople].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${name}`);
    }
  }

  if (NEEDLE) {
    const hits = events.filter((e) => pathsOf(e).some((p: string) => p.toLowerCase().includes(NEEDLE)));
    console.log(`\n— события по «${NEEDLE}»: ${hits.length} —`);
    for (const e of hits.slice(0, 40)) {
      const { name, outside } = actorOf(e);
      const text = e.details?.comment_text ? ` «${e.details.comment_text.slice(0, 80)}»` : '';
      console.log(`  ${e.timestamp}  ${e.event_type?.['.tag']}`);
      console.log(`     кто: ${name}${outside ? ' (ВНЕ КОМАНДЫ)' : ''}${text}`);
      for (const p of pathsOf(e).slice(0, 2)) console.log(`     что: ${p}`);
    }
  }

  console.log('\nВывод делать по строке «события, где действовал человек вне команды».');
  console.log('Если там есть имена клиента — панель «Дії з файлом» воспроизводима через API.');
}

main().catch((e) => {
  console.error('Ошибка:', e instanceof Error ? e.message : e);
  process.exit(1);
});
