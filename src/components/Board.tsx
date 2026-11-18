'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COLUMNS, type Column } from '@/config';
import type { BoardCard, BoardData } from '@/app/api/board/route';
import { LANGUAGES, LANGUAGE_LABEL, useI18n } from '@/i18n';
import { useTheme } from './ThemeProvider';
import { Card } from './Card';
import { DropboxStatus } from './DropboxStatus';
import { ApiError, fetchJson } from './fetchJson';
import { Archive, ChevronLeft, ChevronRight, ICON, ICON_SM, Moon, RefreshCw, Settings, Sun, X } from './icons';
import { ProjectPanel } from './ProjectPanel';
import { TrackedProjects } from './TrackedProjects';
import { useEdgeScroll } from './useEdgeScroll';
import { useOpenFolder } from './useOpenFolder';
import styles from './Board.module.scss';

export function Board() {
  const queryClient = useQueryClient();
  const [showArchive, setShowArchive] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showTracked, setShowTracked] = useState(false);
  const { openFolder, copyLink, notice, dismissNotice } = useOpenFolder();
  const { t, lang, locale, setLang } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const edge = useEdgeScroll<HTMLDivElement>();

  const { data, isLoading, error } = useQuery<BoardData>({
    queryKey: ['board'],
    queryFn: () => fetchJson<BoardData>('/api/board', undefined, (s) => t('error.board', { status: s })),
    // Скан диска запускает сам роут /api/board, когда данные старше
    // CONFIG.boardRefreshMs. Опрос нужен, чтобы подхватить результат скана;
    // рендер идёт десятками минут, пяти минут хватает. Пока скан идёт —
    // чаще, чтобы результат появился без лишнего ожидания.
    // В режиме Dropbox API скан приходит сам, по сигналу об изменении, и опрос
    // раз в 5 минут прятал бы его результат: опрашиваем каждые 20 с. Запрос
    // дешёвый — чтение из базы, диск не трогается.
    refetchInterval: (query) =>
      query.state.data?.scanning ? 5_000 : query.state.data?.live ? 20_000 : 5 * 60_000,
  });

  const scanning = data?.scanning ?? false;

  const scan = useMutation({
    mutationFn: () => fetchJson<{ ok: true }>('/api/scan', { method: 'POST' }, () => t('error.scan')),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });
  // «Скан уже идёт» — не сбой, а ответ; показываем его по-человечески
  const scanError =
    scan.error instanceof ApiError && scan.error.code === 'running'
      ? t('board.scanRunning')
      : scan.error?.message;

  const visible = useMemo(
    () => (data?.cards ?? []).filter((c) => showArchive || !c.isArchived),
    [data, showArchive],
  );

  const archivedCount = (data?.cards ?? []).filter((c) => c.isArchived).length;

  const byColumn = useMemo(() => {
    const map = new Map<Column, BoardCard[]>();
    for (const c of COLUMNS) map.set(c, []);
    for (const card of visible) map.get(card.column)?.push(card);
    return map;
  }, [visible]);

  // Карточки появились — ширина содержимого изменилась, подсказки у краёв
  // должны это учесть. ResizeObserver следит только за самим контейнером.
  const { refresh } = edge;
  useEffect(() => {
    refresh();
  }, [byColumn, refresh]);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{t('app.title')}</h1>
          <span className={styles.subtitle}>{t('app.subtitle')}</span>
        </div>

        <div className={styles.controls}>
          {data?.lastScan?.at && (
            <span className={styles.meta}>
              {t('board.lastScan', {
                time: new Date(data.lastScan.at).toLocaleTimeString(locale),
                ms: data.lastScan.durationMs ?? 0,
                count: data.lastScan.projectCount ?? 0,
              })}
            </span>
          )}
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={showArchive}
              onChange={(e) => setShowArchive(e.target.checked)}
            />
            <Archive {...ICON_SM} />
            {t('board.archive', { count: archivedCount })}
          </label>
          <div className={styles.langSwitch} role="group" aria-label={t('pref.language')}>
            {LANGUAGES.map((code) => (
              <button
                key={code}
                className={code === lang ? styles.langActive : styles.langOption}
                onClick={() => setLang(code)}
              >
                {LANGUAGE_LABEL[code]}
              </button>
            ))}
          </div>
          <DropboxStatus />
          <button className={styles.iconToggle} onClick={() => setShowTracked(true)} title={t('tracked.title')}>
            <Settings {...ICON} />
          </button>
          <button
            className={styles.iconToggle}
            onClick={toggleTheme}
            title={theme === 'dark' ? t('pref.themeLight') : t('pref.themeDark')}
          >
            {theme === 'dark' ? <Sun {...ICON} /> : <Moon {...ICON} />}
          </button>
          <button
            className={styles.scanButton}
            onClick={() => scan.mutate()}
            disabled={scan.isPending || scanning}
            title={scanError}
          >
            <RefreshCw {...ICON} className={scan.isPending || scanning ? styles.spin : undefined} />
            {scan.isPending || scanning ? t('board.scanning') : t('board.scan')}
          </button>
        </div>
      </header>

      {error && <div className={styles.error}>{error.message}</div>}
      {scanError && !scanning && <div className={styles.error}>{scanError}</div>}
      {isLoading && <div className={styles.empty}>{t('board.loading')}</div>}

      {notice && (
        <div className={notice.kind === 'error' ? styles.error : styles.notice}>
          <span>{notice.text}</span>
          <button className={styles.noticeClose} onClick={dismissNotice} title={t('notice.hide')}>
            <X {...ICON} />
          </button>
        </div>
      )}

      <div className={styles.boardWrap}>
        <div
          className={styles.board}
          ref={edge.ref}
          onMouseMove={edge.onMouseMove}
          onMouseLeave={edge.onMouseLeave}
        >
          {COLUMNS.map((column) => {
            const cards = byColumn.get(column) ?? [];
            return (
              <section key={column} className={styles.column}>
                <div className={styles.columnHead}>
                  <span className={styles.columnName}>{t(`column.${column}`)}</span>
                  <span className={styles.columnCount}>{cards.length}</span>
                </div>
                <div className={styles.columnBody}>
                  {cards.map((card) => (
                    <Card
                      key={card.key}
                      card={card}
                      thresholds={data!.thresholds}
                      onOpen={() => setOpenKey(card.key)}
                      onOpenFolder={openFolder}
                      onCopyLink={copyLink}
                    />
                  ))}
                  {cards.length === 0 && <div className={styles.columnEmpty}>{t('board.columnEmpty')}</div>}
                </div>
              </section>
            );
          })}
        </div>

        {/* Подсказки у краёв. pointer-events: none — клики по карточкам не перехватываются */}
        {edge.canLeft && (
          <div className={edge.active === 'left' ? styles.edgeLeftActive : styles.edgeLeft}>
            <ChevronLeft size={22} strokeWidth={1.75} />
          </div>
        )}
        {edge.canRight && (
          <div className={edge.active === 'right' ? styles.edgeRightActive : styles.edgeRight}>
            <ChevronRight size={22} strokeWidth={1.75} />
          </div>
        )}
      </div>

      {showTracked && <TrackedProjects onClose={() => setShowTracked(false)} />}

      {openKey && (
        <ProjectPanel
          projectKey={openKey}
          onClose={() => setOpenKey(null)}
          onOpenFolder={openFolder}
          onCopyLink={copyLink}
        />
      )}
    </div>
  );
}
