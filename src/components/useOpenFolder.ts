'use client';

import { useCallback, useState } from 'react';
import { useI18n } from '@/i18n';

export interface FolderNotice {
  kind: 'error' | 'info';
  text: string;
}

/**
 * Открытие папки в проводнике.
 *
 * Папка открывается на машине, где работает сервер. Когда доска открыта с неё же
 * (localhost) — это ровно то, что нужно. При заходе по сети сервер отвечает 409,
 * и мы вместо окна кладём путь в буфер обмена.
 */
export function useOpenFolder() {
  const { t } = useI18n();
  const [notice, setNotice] = useState<FolderNotice | null>(null);

  const openFolder = useCallback(async (target: string) => {
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target }),
      });
      const payload = await res.json().catch(() => null);

      if (res.ok) {
        setNotice(null);
        return;
      }

      if (payload?.error === 'remote') {
        const copied = await copyToClipboard(payload.path);
        setNotice({
          kind: 'info',
          text: copied
            ? t('notice.remoteCopied', { path: payload.path })
            : t('notice.remote', { path: payload.path }),
        });
        return;
      }

      setNotice({
        kind: 'error',
        text: payload?.error ?? t('notice.openFailed', { status: res.status }),
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [t]);

  return { openFolder, notice, dismissNotice: useCallback(() => setNotice(null), []) };
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* пробуем запасной путь */
  }
  // По сети через http Clipboard API недоступен — остаётся старый способ
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
