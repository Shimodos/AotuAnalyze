import { NextResponse } from 'next/server';
import { fetchAndSaveAccount } from '@/dropbox/account';
import { errorMessage, jsonError, requireSameOrigin } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Перечитать данные аккаунта и командное пространство без повторной авторизации.
 * Нужен, если при первом подключении запрос не прошёл — токены при этом уже сохранены.
 */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  try {
    const account = await fetchAndSaveAccount();
    return NextResponse.json({ ok: true, ...account });
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}
