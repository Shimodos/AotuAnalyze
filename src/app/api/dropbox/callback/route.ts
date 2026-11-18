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
    response.cookies.delete('dropbox_oauth_verifier');
    return response;
  };

  if (error) return back({ dropbox: 'error', reason: error });
  if (!code) return back({ dropbox: 'error', reason: 'нет кода авторизации' });
  if (!isConfigured()) return back({ dropbox: 'error', reason: 'нет ключа приложения' });

  const cookies = request.headers.get('cookie')?.split(';').map((c) => c.trim()) ?? [];
  const cookie = (name: string) =>
    cookies.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

  const expected = cookie('dropbox_oauth_state');
  if (!expected || expected !== state) {
    return back({ dropbox: 'error', reason: 'state не совпал' });
  }

  const verifier = cookie('dropbox_oauth_verifier');
  if (!verifier) return back({ dropbox: 'error', reason: 'нет verifier — начните вход заново' });

  try {
    // PKCE: verifier вместо секрета приложения
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: DROPBOX.appKey,
      code_verifier: verifier,
      redirect_uri: DROPBOX.redirectUri,
    });

    const res = await fetch(DROPBOX.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!res.ok) return back({ dropbox: 'error', reason: `обмен кода: HTTP ${res.status}` });

    saveTokens(JSON.parse(text), { pkce: true });

    // Сразу выясняем командное пространство — без него пути проектов не резолвятся
    await fetchAndSaveAccount();

    return back({ dropbox: 'connected' });
  } catch (e) {
    return back({ dropbox: 'error', reason: errorMessage(e).slice(0, 120) });
  }
}
