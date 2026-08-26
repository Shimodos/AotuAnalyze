import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { DROPBOX, isConfigured } from '@/dropbox/config';

export const dynamic = 'force-dynamic';

/** Шаг 1: уводим пользователя на страницу согласия Dropbox */
export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json(
      { error: 'Не заданы DROPBOX_APP_KEY и DROPBOX_APP_SECRET в .env.local' },
      { status: 500 },
    );
  }

  // state защищает от подделки ответа: сверим его в callback
  const state = randomBytes(16).toString('hex');

  const url = new URL(DROPBOX.authorizeUrl);
  url.searchParams.set('client_id', DROPBOX.appKey);
  url.searchParams.set('redirect_uri', DROPBOX.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DROPBOX.scopes.join(' '));
  url.searchParams.set('state', state);
  // offline — иначе вернётся только короткоживущий токен без refresh
  url.searchParams.set('token_access_type', 'offline');

  const response = NextResponse.redirect(url.toString());
  response.cookies.set('dropbox_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return response;
}
