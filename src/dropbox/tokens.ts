/**
 * Хранение токенов Dropbox и автоматическое обновление.
 *
 * Токены лежат в той же SQLite, что и остальное состояние: отдельного секрет-хранилища
 * для локального инструмента заводить незачем, а файл базы и так не выходит за пределы
 * машины. Access token короткоживущий, поэтому просим refresh token
 * (token_access_type=offline) и обновляем его сами.
 */

import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { DROPBOX } from './config';

const KEYS = {
  refreshToken: 'dropbox.refresh_token',
  accessToken: 'dropbox.access_token',
  expiresAt: 'dropbox.expires_at',
  accountName: 'dropbox.account_name',
  accountEmail: 'dropbox.account_email',
  rootNamespaceId: 'dropbox.root_namespace_id',
} as const;

export function readSetting(key: string): string | null {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value ?? null;
}

export function writeSetting(key: string, value: string | null) {
  const db = getDb();
  if (value === null) {
    db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
    return;
  }
  const values = { key, value, updatedAt: new Date() };
  db.insert(schema.settings)
    .values(values)
    .onConflictDoUpdate({ target: schema.settings.key, set: values })
    .run();
}

export interface DropboxAccount {
  name: string | null;
  email: string | null;
  rootNamespaceId: string | null;
}

export function isConnected(): boolean {
  return Boolean(readSetting(KEYS.refreshToken));
}

export function getAccount(): DropboxAccount {
  return {
    name: readSetting(KEYS.accountName),
    email: readSetting(KEYS.accountEmail),
    rootNamespaceId: readSetting(KEYS.rootNamespaceId),
  };
}

export function saveTokens(payload: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}) {
  writeSetting(KEYS.accessToken, payload.access_token);
  if (payload.refresh_token) writeSetting(KEYS.refreshToken, payload.refresh_token);
  if (payload.expires_in) {
    writeSetting(KEYS.expiresAt, String(Date.now() + payload.expires_in * 1000));
  }
}

export function saveAccount(account: {
  name?: string | null;
  email?: string | null;
  rootNamespaceId?: string | null;
}) {
  if (account.name !== undefined) writeSetting(KEYS.accountName, account.name);
  if (account.email !== undefined) writeSetting(KEYS.accountEmail, account.email);
  if (account.rootNamespaceId !== undefined) {
    writeSetting(KEYS.rootNamespaceId, account.rootNamespaceId);
  }
}

export function disconnect() {
  for (const key of Object.values(KEYS)) writeSetting(key, null);
}

/** Действующий access token. Обновляет сам, если срок вышел или скоро выйдет. */
export async function getAccessToken(): Promise<string> {
  const refreshToken = readSetting(KEYS.refreshToken);
  if (!refreshToken) throw new Error('Dropbox не подключён');

  const token = readSetting(KEYS.accessToken);
  const expiresAt = Number(readSetting(KEYS.expiresAt) ?? 0);

  if (token && expiresAt - DROPBOX.refreshSkewMs > Date.now()) return token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: DROPBOX.appKey,
    client_secret: DROPBOX.appSecret,
  });

  const res = await fetch(DROPBOX.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Не удалось обновить токен: HTTP ${res.status} ${text.slice(0, 200)}`);

  const payload = JSON.parse(text) as { access_token: string; expires_in?: number };
  saveTokens(payload);
  return payload.access_token;
}
