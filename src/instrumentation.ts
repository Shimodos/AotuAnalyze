/**
 * Next вызывает register() во всех рантаймах, включая edge.
 *
 * Импорт Node-кода обязан стоять ВНУТРИ ветки NEXT_RUNTIME === 'nodejs':
 * значение подставляется на этапе сборки, и ветка целиком вырезается из
 * edge-бандла. При раннем return импорт остаётся снаружи, edge-компилятор
 * тянет better-sqlite3 -> bindings -> 'fs' и падает.
 *
 * https://nextjs.org/docs/app/guides/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
