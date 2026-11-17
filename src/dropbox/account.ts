/**
 * Аккаунт и командное пространство — один разбор ответа Dropbox на оба
 * вызова: после подключения и по кнопке «перечитать».
 */

import { dropboxCall } from './client';
import { saveAccount } from './tokens';

interface AccountResponse {
  name?: { display_name?: string };
  email?: string;
  root_info?: { '.tag'?: string; root_namespace_id?: string; home_namespace_id?: string };
}

export interface DropboxAccount {
  name: string | null;
  email: string | null;
  rootType: string | null;
  rootNamespaceId: string | null;
  homeNamespaceId: string | null;
  /** корень — командное пространство, а не личная папка */
  teamSpace: boolean;
}

/**
 * Запрашивает аккаунт и сразу сохраняет его в настройки. Без root_namespace_id
 * обычный токен видит только личную папку админа и проектов не находит.
 */
export async function fetchAndSaveAccount(): Promise<DropboxAccount> {
  const account = await dropboxCall<AccountResponse>('users/get_current_account', null);
  const root = account?.root_info?.root_namespace_id ?? null;
  const home = account?.root_info?.home_namespace_id ?? null;
  const teamSpace = Boolean(root && root !== home);

  const result: DropboxAccount = {
    name: account?.name?.display_name ?? null,
    email: account?.email ?? null,
    rootType: account?.root_info?.['.tag'] ?? null,
    rootNamespaceId: root,
    homeNamespaceId: home,
    teamSpace,
  };

  saveAccount({
    name: result.name,
    email: result.email,
    rootNamespaceId: teamSpace ? root : null,
  });

  return result;
}
