'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TrackedData, TrackedItem } from '@/app/api/tracked/route';
import { useI18n } from '@/i18n';
import { fetchJson } from './fetchJson';
import { ICON, X } from './icons';
import { RootFolder } from './RootFolder';
import styles from './TrackedProjects.module.scss';

interface Props {
  onClose: () => void;
}

/**
 * Какие проекты из Dropbox показывать на доске.
 *
 * Через API в корне видно в разы больше папок, чем синхронизировано на диск,
 * поэтому список явный: трекер читает только отмеченные проекты.
 */
export function TrackedProjects({ onClose }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [onlyTracked, setOnlyTracked] = useState(false);

  const { data, isLoading, error } = useQuery<TrackedData>({
    queryKey: ['tracked'],
    queryFn: () => fetchJson<TrackedData>('/api/tracked', undefined, (s) => t('tracked.error', { status: s })),
    // Пока дерево добавленного проекта подтягивается — опрашиваем, чтобы
    // «завантажується» сменилось числом файлов без ручного обновления
    refetchInterval: (query) => (query.state.data?.syncing ? 3_000 : false),
  });

  const toggle = useMutation({
    mutationFn: (item: TrackedItem) =>
      fetchJson<{ ok: true }>('/api/tracked', { json: { key: item.key, tracked: !item.tracked } }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tracked'] });
      // доска показывает только отмеченные проекты — карточка должна уйти или вернуться сразу
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (i) => (!onlyTracked || i.tracked) && (!needle || i.folderName.toLowerCase().includes(needle)),
    );
  }, [data, filter, onlyTracked]);

  const status = (item: TrackedItem) => {
    if (!item.inRoot) return <span className={styles.chipAlert}>{t('tracked.missing')}</span>;
    if (item.tracked && !item.synced) return <span className={styles.chip}>{t('tracked.loading')}</span>;
    if (item.tracked) return <span className={styles.chipMuted}>{t('tracked.files', { count: item.files })}</span>;
    if (item.isNew) return <span className={styles.chipNew}>{t('tracked.new')}</span>;
    return null;
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>{t('tracked.title')}</h2>
            <span className={styles.subtitle}>
              {data
                ? t('tracked.summary', { tracked: data.trackedCount, total: data.items.length })
                : t('tracked.hint')}
            </span>
          </div>
          <button className={styles.close} onClick={onClose} title={t('panel.close')}>
            <X {...ICON} />
          </button>
        </header>

        <RootFolder />

        <div className={styles.tools}>
          <input
            className={styles.search}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('tracked.search')}
          />
          <label className={styles.only}>
            <input type="checkbox" checked={onlyTracked} onChange={(e) => setOnlyTracked(e.target.checked)} />
            {t('tracked.onlyTracked')}
          </label>
        </div>

        {isLoading && <div className={styles.muted}>{t('tracked.listLoading')}</div>}
        {error && <div className={styles.failure}>{error.message}</div>}
        {toggle.error && <div className={styles.failure}>{toggle.error.message}</div>}

        {data && (
          <ul className={styles.list}>
            {shown.map((item) => (
              <li key={item.key}>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={item.tracked}
                    disabled={toggle.isPending}
                    onChange={() => toggle.mutate(item)}
                  />
                  <span className={styles.job}>{item.jobNumber ?? '—'}</span>
                  <span className={styles.name} title={item.folderName}>
                    {item.title}
                  </span>
                  {status(item)}
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className={styles.muted}>{t('tracked.empty')}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
