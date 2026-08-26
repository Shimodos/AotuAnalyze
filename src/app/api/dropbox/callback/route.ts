import { NextResponse } from 'next/server';
import { DROPBOX, isConfigured } from '@/dropbox/config';
import { dropboxCall } from '@/dropbox/client';
import { saveAccount, saveTokens } from '@/dropbox/tokens';

export const dynamic = 'force-dynamic';

/** Шаг 2: меняем код на токены и запоминаем аккаунт */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const back = (params: Record<string, string>) => {
    const target = new URL('/', url.origin);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    const response = NextResponse.redirect(target.toString());
    response.cookies.delete('dropbox_oauth_state');
    return response;
  };

  if (error) return back({ dropbox: 'error', reason: error });
  if (!code) return back({ dropbox: 'error', reason: 'нет кода авторизации' });
  if (!isConfigured()) return back({ dropbox: 'error', reason: 'нет ключей приложения' });

  const expected = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('dropbox_oauth_state='))
    ?.slice('dropbox_oauth_state='.length);

  if (!expected || expected !== state) {
    return back({ dropbox: 'error', reason: 'state не совпал' });
  }

  try {
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: DROPBOX.appKey,
      client_secret: DROPBOX.appSecret,
      redirect_uri: DROPBOX.redirectUri,
    });

    const res = await fetch(DROPBOX.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!res.ok) return back({ dropbox: 'error', reason: `обмен кода: HTTP ${res.status}` });

    saveTokens(JSON.parse(text));

    // Сразу выясняем командное пространство — без него пути проектов не резолвятся
    const account = await dropboxCall<any>('users/get_current_account', null);
    const root = account?.root_info?.root_namespace_id ?? null;
    const home = account?.root_info?.home_namespace_id ?? null;
    saveAccount({
      name: account?.name?.display_name ?? null,
      email: account?.email ?? null,
      rootNamespaceId: root && root !== home ? root : null,
    });

    return back({ dropbox: 'connected' });
  } catch (e) {
    return back({ dropbox: 'error', reason: (e as Error).message.slice(0, 120) });
  }
}
