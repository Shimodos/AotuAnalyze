'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n';
import { fetchJson } from './fetchJson';
import { Cloud, CloudOff, ICON } from './icons';
import styles from './Board.module.scss';

interface Status {
  configured: boolean;
  connected: boolean;
  account: { name: string | null; email: string | null; rootNamespaceId: string | null } | null;
}

/** Кнопка подключения Dropbox в шапке. Секрет приложения остаётся на сервере. */
export function DropboxStatus() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const { data } = useQuery<Status>({
    queryKey: ['dropbox-status'],
    queryFn: () => fetchJson<Status>('/api/dropbox/status'),
  });

  const disconnect = useMutation({
    mutationFn: () => fetchJson<{ ok: true }>('/api/dropbox/disconnect', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dropbox-status'] }),
  });

  if (!data) return null;

  if (!data.configured) {
    return (
      <span className={styles.iconToggle} title={t('dropbox.notConfigured')}>
        <CloudOff {...ICON} />
      </span>
    );
  }

  if (data.connected) {
    const name = data.account?.name ?? data.account?.email ?? '—';
    return (
      <button
        className={styles.iconToggle}
        title={`${t('dropbox.connected', { name })}\n${t('dropbox.disconnect')}`}
        onClick={() => disconnect.mutate()}
      >
        <Cloud {...ICON} />
      </button>
    );
  }

  return (
    <a className={styles.iconToggle} href="/api/dropbox/auth" title={t('dropbox.connect')}>
      <CloudOff {...ICON} />
    </a>
  );
}
