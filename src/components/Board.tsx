'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COLUMNS, type Column } from '@/config';
import type { BoardCard } from '@/app/api/board/route';
import { LANGUAGES, LANGUAGE_LABEL, useI18n } from '@/i18n';
import { useTheme } from './ThemeProvider';
import { Card } from './Card';
import { DropboxStatus } from './DropboxStatus';
import {
  Activity,
  Archive,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  ICON,
  ICON_LG,
  Layers,
  LayoutGrid,
  Moon,
  RefreshCw,
  Search,
  Send,
  Sun,
  X,
} from './icons';
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

/** Область карточек: архив живёт отдельно, иначе он раздувает все счётчики */
type Scope = 'active' | 'all' | 'archive';

/** Быстрый срез по признаку. Одновременно активен только один — как в чипах-фильтрах */
type Flag = 'changes' | 'farm' | 'stale' | 'client' | 'pinned';

export function Board() {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>('active');
  const [flag, setFlag] = useState<Flag | null>(null);
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { openFolder, copyLink, notice, dismissNotice } = useOpenFolder();
  const { t, lang, setLang } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const edge = useEdgeScroll<HTMLDivElement>();
  const locale = lang === 'uk' ? 'uk-UA' : 'en-US';

  // Ссылки на колонки — по ним прокручивается доска из меню слева
  const columnRefs = useRef(new Map<Column, HTMLElement | null>());
  const [focusedColumn, setFocusedColumn] = useState<Column | null>(null);

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

  const all = useMemo(() => data?.cards ?? [], [data]);
  const alertDays = data?.thresholds.alert ?? 14;

  // Карточки выбранной области — база и для метрик, и для счётчиков в чипах.
  // Считать их по отфильтрованному списку нельзя: счётчик чипа обязан
  // показывать, сколько станет видно после нажатия, а не сколько видно сейчас.
  const inScope = useMemo(() => {
    if (scope === 'all') return all;
    if (scope === 'archive') return all.filter((c) => c.isArchived);
    return all.filter((c) => !c.isArchived);
  }, [all, scope]);

  const matchesFlag = useCallback(
    (card: BoardCard, which: Flag) => {
      switch (which) {
        case 'changes':
          return card.unseenChanges > 0;
        case 'farm':
          return card.farmActive;
        case 'stale':
          return card.daysInStage !== null && card.daysInStage >= alertDays;
        case 'client':
          return card.ball === 'CLIENT';
        case 'pinned':
          return card.isPinned;
      }
    },
    [alertDays],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return inScope.filter((c) => {
      if (flag && !matchesFlag(c, flag)) return false;
      if (!needle) return true;
      return (
        c.title.toLowerCase().includes(needle) ||
        c.folderName.toLowerCase().includes(needle) ||
        String(c.jobNumber ?? '').includes(needle)
      );
    });
  }, [inScope, flag, matchesFlag, query]);

  const metrics = useMemo(() => {
    const active = all.filter((c) => !c.isArchived);
    const farm = active.filter((c) => c.farmActive);
    const withChanges = active.filter((c) => c.unseenChanges > 0);
    const stale = active.filter((c) => c.daysInStage !== null && c.daysInStage >= alertDays);
    return {
      active: active.length,
      archived: all.length - active.length,
      farm: farm.length,
      exr: farm.reduce((sum, c) => sum + c.exrTotal, 0),
      changes: withChanges.reduce((sum, c) => sum + c.unseenChanges, 0),
      changeProjects: withChanges.length,
      client: active.filter((c) => c.ball === 'CLIENT').length,
      stale: stale.length,
    };
  }, [all, alertDays]);

  const byColumn = useMemo(() => {
    const map = new Map<Column, BoardCard[]>();
    for (const c of COLUMNS) map.set(c, []);
    for (const card of visible) map.get(card.column)?.push(card);
    return map;
  }, [visible]);

  // Среднее время в стадии — правая подпись в шапке колонки.
  // Считаем по видимым карточкам, чтобы цифра не спорила со счётчиком рядом.
  const columnAvg = useMemo(() => {
    const map = new Map<Column, number | null>();
    for (const [column, cards] of byColumn) {
      const days = cards.map((c) => c.daysInStage).filter((d): d is number => d !== null);
      map.set(column, days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null);
    }
    return map;
  }, [byColumn]);

  const scrollToColumn = useCallback((column: Column) => {
    setFocusedColumn(column);
    columnRefs.current.get(column)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  }, []);

  // Карточки появились — ширина содержимого изменилась, подсказки у краёв
  // должны это учесть. ResizeObserver следит только за самим контейнером.
  const { refresh } = edge;
  useEffect(() => {
    refresh();
  }, [byColumn, refresh]);

  const flagChips: Array<{ id: Flag; label: string }> = [
    { id: 'changes', label: t('filter.changes') },
    { id: 'farm', label: t('filter.farm') },
    { id: 'stale', label: t('filter.stale') },
    { id: 'client', label: t('filter.client') },
    { id: 'pinned', label: t('filter.pinned') },
  ];

  const scopeChips: Array<{ id: Scope; label: string }> = [
    { id: 'active', label: t('filter.scopeActive') },
    { id: 'all', label: t('filter.scopeAll') },
    { id: 'archive', label: t('filter.scopeArchive') },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <span className={styles.brandMark}>
              <Layers {...ICON} />
            </span>
            <span className={styles.brandName}>Viarde</span>
          </div>

          <div className={styles.navGroup}>{t('nav.stages')}</div>
          <nav className={styles.navList}>
            {COLUMNS.map((column) => (
              <button
                key={column}
                className={focusedColumn === column ? styles.navItemActive : styles.navItem}
                onClick={() => scrollToColumn(column)}
              >
                <LayoutGrid {...ICON} />
                <span className={styles.navLabel}>{t(`column.${column}`)}</span>
                <span className={styles.navCount}>{byColumn.get(column)?.length ?? 0}</span>
              </button>
            ))}
          </nav>

          <div className={styles.sidebarFoot}>
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
          </div>
        </aside>

        <main className={styles.main}>
          <header className={styles.topbar}>
            <div className={styles.titleBlock}>
              <h1 className={styles.title}>{t('nav.board')}</h1>
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
              <label className={styles.search}>
                <Search {...ICON} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('board.search')}
                />
              </label>
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

          {data && (
            <section className={styles.metrics}>
              <div className={styles.metric}>
                <span className={styles.metricIcon}>
                  <LayoutGrid {...ICON_LG} />
                </span>
                <div className={styles.metricBody}>
                  <div className={styles.metricLabel}>{t('metric.inWork')}</div>
                  <div className={styles.metricValueRow}>
                    <span className={styles.metricValue}>{metrics.active}</span>
                    <span className={styles.metricUnit}>{t('metric.inWorkUnit')}</span>
                    {metrics.archived > 0 && (
                      <span className={styles.metricNeutral}>
                        {t('metric.archived', { n: metrics.archived })}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className={styles.metric}>
                <span className={styles.metricIcon}>
                  <Flame {...ICON_LG} />
                </span>
                <div className={styles.metricBody}>
                  <div className={styles.metricLabel}>{t('metric.rendering')}</div>
                  <div className={styles.metricValueRow}>
                    <span className={styles.metricValue}>{metrics.farm}</span>
                    <span className={styles.metricUnit}>{t('metric.renderingUnit')}</span>
                    {metrics.farm > 0 ? (
                      <span className={styles.metricOk}>{t('metric.exr', { n: metrics.exr })}</span>
                    ) : (
                      <span className={styles.metricNeutral}>{t('metric.idle')}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className={styles.metric}>
                <span className={styles.metricIcon}>
                  <Activity {...ICON_LG} />
                </span>
                <div className={styles.metricBody}>
                  <div className={styles.metricLabel}>{t('metric.changes')}</div>
                  <div className={styles.metricValueRow}>
                    <span className={styles.metricValue}>{metrics.changes}</span>
                    <span className={styles.metricUnit}>{t('metric.changesUnit')}</span>
                    {metrics.changes > 0 ? (
                      <span className={styles.metricWarn}>
                        {t('metric.inProjects', { n: metrics.changeProjects })}
                      </span>
                    ) : (
                      <span className={styles.metricOk}>{t('metric.allSeen')}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className={styles.metric}>
                <span className={styles.metricIcon}>
                  <Send {...ICON_LG} />
                </span>
                <div className={styles.metricBody}>
                  <div className={styles.metricLabel}>{t('metric.atClient')}</div>
                  <div className={styles.metricValueRow}>
                    <span className={styles.metricValue}>{metrics.client}</span>
                    <span className={styles.metricUnit}>{t('metric.atClientUnit')}</span>
                  </div>
                </div>
              </div>

              <div className={styles.metric}>
                <span className={styles.metricIcon}>
                  <Clock {...ICON_LG} />
                </span>
                <div className={styles.metricBody}>
                  <div className={styles.metricLabel}>{t('metric.stale')}</div>
                  <div className={styles.metricValueRow}>
                    <span className={styles.metricValue}>{metrics.stale}</span>
                    <span className={styles.metricUnit}>{t('metric.staleUnit', { n: alertDays })}</span>
                    {metrics.stale > 0 ? (
                      <span className={styles.metricAlert}>{t('metric.breach')}</span>
                    ) : (
                      <span className={styles.metricOk}>{t('metric.onTarget')}</span>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          <div className={styles.filters}>
            {scopeChips.map((chip) => (
              <button
                key={chip.id}
                className={scope === chip.id ? styles.chipActive : styles.chip}
                onClick={() => setScope(chip.id)}
              >
                {chip.id === 'archive' && <Archive {...ICON} />}
                {chip.label}
              </button>
            ))}

            <span className={styles.filterDivider} />

            {flagChips.map((chip) => {
              const count = inScope.filter((c) => matchesFlag(c, chip.id)).length;
              return (
                <button
                  key={chip.id}
                  className={flag === chip.id ? styles.chipActive : styles.chip}
                  onClick={() => setFlag(flag === chip.id ? null : chip.id)}
                  title={flag === chip.id ? t('filter.reset') : chip.label}
                >
                  {chip.label}
                  <span className={styles.chipCount}>{count}</span>
                </button>
              );
            })}

            <span className={styles.showing}>
              {t('board.showing', { shown: visible.length, total: all.length })}
            </span>
          </div>

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
                const avg = columnAvg.get(column) ?? null;
                return (
                  <section
                    key={column}
                    className={styles.column}
                    ref={(node) => {
                      columnRefs.current.set(column, node);
                    }}
                  >
                    <div className={styles.columnHead}>
                      <span className={styles.columnName}>{t(`column.${column}`)}</span>
                      <span className={styles.columnCount}>{cards.length}</span>
                      {avg !== null && (
                        <span className={styles.columnMeta}>{t('board.columnAvg', { n: avg })}</span>
                      )}
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
                      {cards.length === 0 && (
                        <div className={styles.columnEmpty}>
                          {flag || query ? t('board.nothingFound') : t('board.columnEmpty')}
                        </div>
                      )}
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
        </main>
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
