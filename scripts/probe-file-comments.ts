/**
 * Комментарии к файлу через недокументированный эндпоинт /2/comments2/list_comments —
 * тот самый, которым пользуется веб-интерфейс Dropbox. Публичного API для
 * комментариев у Dropbox нет.
 *
 * Токен берётся из базы, куда его положил OAuth-поток, и обновляется автоматически.
 * Пароль не нужен.
 *
 * Запуск:
 *   npm run probe:file -- "/путь/к/файлу.jpg"
 *   npm run probe:file -- --id=id:AbCdEf123
 *   npm run probe:file -- --folder="/Kraus_215_Waterfall_Deckplate/05_Outbox"
 *
 * Только чтение.
 */

import { dropboxCall } from '../src/dropbox/client';
import { getAccount, isConnected } from '../src/dropbox/tokens';

const args = process.argv.slice(2);
const idArg = args.find((a) => a.startsWith('--id='))?.slice('--id='.length);
const folderArg = args.find((a) => a.startsWith('--folder='))?.slice('--folder='.length);
const pathArg = args.find((a) => !a.startsWith('--'));

async function listComments(fileRef: string) {
  return dropboxCall<any>('comments2/list_comments', {
    stream: {
      type: { '.tag': 'file' },
      identifier: { '.tag': 'file_path_or_id', file_path_or_id: fileRef },
    },
    include_permissions: true,
  });
}

function report(label: string, data: any): number {
  const threads: any[] = data?.threads ?? [];
  const users: any[] = data?.users ?? [];
  const nameOf = (id: string) => users.find((u) => u.id === id)?.public_name ?? id;

  const total = threads.reduce(
    (sum, t) => sum + (t.comments ?? []).filter((c: any) => c.content).length,
    0,
  );

  if (total === 0) {
    console.log(`  ${label}\n     комментариев нет`);
    return 0;
  }

  console.log(`  ${label}`);
  console.log(`     веток: ${threads.length}, комментариев: ${total}`);
  for (const thread of threads) {
    const region = thread.annotation_data?.regions?.[0];
    const where = region ? `  метка: ${JSON.stringify(region).slice(0, 90)}` : '';
    const resolved = thread.is_resolved ? ' (закрыта)' : '';
    console.log(`     — ветка${resolved}${where}`);
    for (const c of thread.comments ?? []) {
      if (!c.content) continue;
      console.log(`        ${nameOf(c.author_id)}: ${String(c.content).slice(0, 200)}`);
    }
  }
  return total;
}

async function main() {
  if (!isConnected()) {
    console.error('Dropbox не подключён. Открой доску и нажми иконку облака.');
    process.exit(1);
  }
  const account = getAccount();
  console.log(`Аккаунт: ${account.name ?? account.email ?? '—'}`);
  console.log(`Командное пространство: ${account.rootNamespaceId ?? 'нет'}\n`);

  if (idArg || pathArg) {
    const ref = idArg ?? (pathArg as string);
    console.log('Проверяю файл:\n');
    report(ref, await listComments(ref));
    return;
  }

  if (folderArg) {
    console.log(`Обхожу папку: ${folderArg}\n`);
    let page = await dropboxCall<any>('files/list_folder', {
      path: folderArg,
      recursive: true,
    });
    const entries: any[] = [...(page.entries ?? [])];
    let guard = 0;
    while (page.has_more && guard++ < 50) {
      page = await dropboxCall<any>('files/list_folder/continue', { cursor: page.cursor });
      entries.push(...(page.entries ?? []));
    }

    const images = entries.filter(
      (e) => e['.tag'] === 'file' && /\.(jpg|jpeg|png|tif|tiff|webp)$/i.test(e.name),
    );
    console.log(`Картинок найдено: ${images.length}\n`);

    let withComments = 0;
    let totalComments = 0;
    for (const file of images) {
      try {
        const n = report(file.path_display ?? file.id, await listComments(file.id));
        if (n > 0) withComments++;
        totalComments += n;
      } catch (error) {
        console.log(`  ${file.name}\n     ошибка: ${(error as Error).message.slice(0, 200)}`);
      }
    }

    console.log(`\nИтог: файлов с комментариями ${withComments} из ${images.length}`);
    console.log(`Всего комментариев: ${totalComments}`);
    return;
  }

  console.error('Укажи путь к файлу, --id= или --folder=');
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\nОшибка:', message);
  if (message.includes('409')) {
    console.error('409 — Dropbox не нашёл файл по этому пути. Проверь путь относительно корня.');
  }
  if (message.includes('400') || message.includes('403')) {
    console.error(
      'Эндпоинт недокументированный. Возможно, он закрыт для сторонних приложений —\n' +
        'это и есть главный риск этого пути.',
    );
  }
  process.exit(1);
});
