import { NextResponse } from 'next/server';
import { dropboxCall } from '@/dropbox/client';
import { saveAccount } from '@/dropbox/tokens';

export const dynamic = 'force-dynamic';

/**
 * Перечитать данные аккаунта и командное пространство без повторной авторизации.
 * Нужен, если при первом подключении запрос не прошёл — токены при этом уже сохранены.
 */
export async function POST() {
  try {
    const account = await dropboxCall<any>('users/get_current_account', null);
    const root = account?.root_info?.root_namespace_id ?? null;
    const home = account?.root_info?.home_namespace_id ?? null;

    saveAccount({
      name: account?.name?.display_name ?? null,
      email: account?.email ?? null,
      rootNamespaceId: root && root !== home ? root : null,
    });

    return NextResponse.json({
      ok: true,
      name: account?.name?.display_name ?? null,
      email: account?.email ?? null,
      rootType: account?.root_info?.['.tag'] ?? null,
      rootNamespaceId: root,
      homeNamespaceId: home,
      teamSpace: Boolean(root && root !== home),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
