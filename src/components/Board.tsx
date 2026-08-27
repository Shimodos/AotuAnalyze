'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COLUMNS, type Column } from '@/config';
import type { BoardCard } from '@/app/api/board/route';
import { LANGUAGES, LANGUAGE_LABEL, useI18n } from '@/i18n';
import { useTheme } from './ThemeProvider';
import { Card } from './Card';
import { DropboxStatus } from './DropboxStatus';
import { Archive, ChevronLeft, ChevronRight, ICON, ICON_SM, Moon, RefreshCw, Sun, X } from './icons';
import { ProjectPanel } from './ProjectPanel';
import { useEdgeScroll } from './useEdgeScroll';
import { useOpenFolder } from './useOpenFolder';
import styles from './Board.module.scss';

interface BoardData {
  columns: readonly Column[];
  cards: BoardCard[];
  thresholds: { warn: number; alert: number };
  lastScan: { at: number | null; durationMs: number | null; projectCount: number | null } | null;
}

export function Board() {
  const queryClient = useQueryClient();
  const [showArchive, setShowArchive] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { openFolder, copyLink, notice, dismissNotice } = useOpenFolder();
  const { t, lang, setLang } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const edge = useEdgeScroll<HTMLDivElement>();
  const locale = lang === 'uk' ? 'uk-UA' : 'en-US';

  const { data, isLoading, error } = useQuery<BoardData>({
    queryKey: ['board'],
    queryFn: async () => {
      const res = await fetch('/api/board');
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? t('error.board', { status: res.status }));
      }
      return payload;
    },
    // Скан диска запускает сам роут /api/board, когда данные старше
    // CONFIG.boardRefreshMs. Опрос нужен, чтобы подхватить результат чужого
    // ручного скана, поэтому минуты достаточно.
    refetchInterval: 60_000,
  });

  const scan = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/scan', { method: 'POST' });
      if (!res.ok) throw new Error(t('error.scan'));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });

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
            disabled={scan.isPending}
          >
            <RefreshCw {...ICON} className={scan.isPending ? styles.spin : undefined} />
            {scan.isPending ? t('board.scanning') : t('board.scan')}
          </button>
        </div>
      </header>

      {error && <div className={styles.error}>{(error as Error).message}</div>}
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
                      thresholds={data?.thresholds ?? { warn: 5, alert: 14 }}
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
