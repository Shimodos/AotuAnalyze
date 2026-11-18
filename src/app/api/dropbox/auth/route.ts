import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { DROPBOX, isConfigured } from '@/dropbox/config';

export const dynamic = 'force-dynamic';

/** Шаг 1: уводим пользователя на страницу согласия Dropbox */
export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json(
      { error: 'Не задан DROPBOX_APP_KEY' },
      { status: 500 },
    );
  }

  // state защищает от подделки ответа: сверим его в callback
  const state = randomBytes(16).toString('hex');

  // PKCE: вместо секрета приложения — одноразовая пара. В Dropbox уходит
  // только хеш (challenge), сам verifier остаётся у нас в cookie и
  // предъявляется при обмене кода на токены. 32 байта дают 43 символа —
  // нижняя граница длины, допустимой для verifier.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const url = new URL(DROPBOX.authorizeUrl);
  url.searchParams.set('client_id', DROPBOX.appKey);
  url.searchParams.set('redirect_uri', DROPBOX.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DROPBOX.scopes.join(' '));
  url.searchParams.set('state', state);
  // offline — иначе вернётся только короткоживущий токен без refresh
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const response = NextResponse.redirect(url.toString());
  const cookie = { httpOnly: true, sameSite: 'lax', maxAge: 600, path: '/' } as const;
  response.cookies.set('dropbox_oauth_state', state, cookie);
  response.cookies.set('dropbox_oauth_verifier', verifier, cookie);
  return response;
}
