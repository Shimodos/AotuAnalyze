'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RootData } from '@/app/api/settings/root/route';
import { useI18n } from '@/i18n';
import { ApiError, fetchJson } from './fetchJson';
import styles from './TrackedProjects.module.scss';

/** Коды отказов сервера, для которых есть перевод; остальное показываем как пришло */
const KNOWN_ERRORS = ['empty', 'not-absolute', 'not-found', 'env'];

/**
 * Где на этом компьютере лежит папка Dropbox.
 *
 * Доска строится по данным API и от этой папки не зависит. Путь нужен для
 * того, что делается локально: открыть папку проекта и записать чеклист
 * правок рядом с кадрами.
 */
export function RootFolder() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');

  const { data } = useQuery<RootData>({
    queryKey: ['root'],
    queryFn: () => fetchJson<RootData>('/api/settings/root'),
  });

  // Поле заполняем сохранённым путём один раз, дальше его правит человек
  useEffect(() => {
    if (data) setValue((current) => current || data.path);
  }, [data]);

  const save = useMutation({
    mutationFn: () => fetchJson<RootData>('/api/settings/root', { json: { path: value } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['root'], saved);
      setValue(saved.path);
      // пути папок на карточках изменились — доску перечитываем
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const locked = data?.source === 'env';
  const changed = data !== undefined && value.trim() !== data.path;

  const failure = (error: Error) =>
    error instanceof ApiError && error.code && KNOWN_ERRORS.includes(error.code)
      ? t(`root.error.${error.code}`)
      : error.message;

  return (
    <section className={styles.root}>
      <label className={styles.rootLabel} htmlFor="root-folder">
        {t('root.title')}
      </label>
      <form
        className={styles.rootRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && !locked) save.mutate();
        }}
      >
        <input
          id="root-folder"
          className={styles.search}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="D:\Dropbox"
          disabled={locked}
          spellCheck={false}
        />
        <button className={styles.rootSave} type="submit" disabled={!changed || locked || save.isPending}>
          {save.isPending ? t('root.saving') : t('root.save')}
        </button>
      </form>

      {save.error ? (
        <span className={styles.rootAlert}>{failure(save.error)}</span>
      ) : locked ? (
        <span className={styles.rootHint}>{t('root.locked')}</span>
      ) : data && !data.exists ? (
        <span className={styles.rootAlert}>{t('root.missing')}</span>
      ) : data ? (
        <span className={styles.rootHint}>
          {t('root.found', { found: data.localProjects, total: data.trackedProjects })}
        </span>
      ) : null}
    </section>
  );
}
