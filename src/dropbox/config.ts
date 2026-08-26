/**
 * Настройки подключения к Dropbox.
 *
 * Секрет приложения живёт только на сервере: все роуты в src/app/api/dropbox
 * серверные, в клиентский бандл он не попадает.
 */

export const DROPBOX = {
  appKey: process.env.DROPBOX_APP_KEY ?? '',
  appSecret: process.env.DROPBOX_APP_SECRET ?? '',
  redirectUri: process.env.DROPBOX_REDIRECT_URI ?? 'http://localhost:3000/api/dropbox/callback',

  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  apiUrl: 'https://api.dropboxapi.com/2',

  /**
   * Минимально необходимый набор прав.
   * account_info.read нужен, чтобы узнать root namespace командного пространства,
   * иначе пути проектов не резолвятся (PROJECT.md §7).
   */
  scopes: ['account_info.read', 'files.metadata.read', 'files.content.read'],

  /** Обновляем токен заранее, чтобы не ловить 401 на границе */
  refreshSkewMs: 5 * 60 * 1000,
} as const;

export function isConfigured(): boolean {
  return Boolean(DROPBOX.appKey && DROPBOX.appSecret);
}
