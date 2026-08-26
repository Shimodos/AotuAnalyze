/** Проверка, что путь резолвится и командное пространство подставляется верно */
import { dropboxCall } from '../src/dropbox/client';

const target = process.argv[2];
if (!target) {
  console.error('Укажи путь');
  process.exit(1);
}

dropboxCall<any>('files/get_metadata', { path: target })
  .then((m) => {
    console.log('НАЙДЕН');
    console.log('  имя:   ', m.name);
    console.log('  id:    ', m.id);
    console.log('  путь:  ', m.path_display);
    console.log('  размер:', m.size, 'байт');
    console.log('  изменён:', m.server_modified);
  })
  .catch((e) => {
    console.error('НЕ НАЙДЕН:', (e as Error).message.slice(0, 300));
    process.exit(1);
  });
