import { NextResponse } from 'next/server';
import { fetchAndSaveAccount } from '@/dropbox/account';
import { DROPBOX, isConfigured } from '@/dropbox/config';
import { saveTokens } from '@/dropbox/tokens';
import { errorMessage } from '@/server/http';

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
    await fetchAndSaveAccount();

    return back({ dropbox: 'connected' });
  } catch (e) {
    return back({ dropbox: 'error', reason: errorMessage(e).slice(0, 120) });
  }
}
