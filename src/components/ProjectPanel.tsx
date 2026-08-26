'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n, type Localized } from '@/i18n';
import { Activity, ChevronDown, FolderOpen, ICON, ICON_SM, TriangleAlert, X } from './icons';
import styles from './ProjectPanel.module.scss';

interface Detail {
  project: {
    key: string;
    title: string;
    folderName: string;
    path: string;
    evidence: Localized;
    anomalies: Array<Localized | string>;
    missingFolders: string[];
    lastDeliveryAt: number | null;
    lastRenderAt: number | null;
    sizeBytes: number | null;
  };
  scenes: Array<{
    path: string;
    name: string;
    sceneNumber: string | null;
    skus: string[];
    isService: boolean;
    imageCount: number;
    exrCount: number;
    lastExrAt: number | null;
    psdCount: number;
    psdFolder: string | null;
    phase: string;
    versions: Array<{ name: string; imageCount: number }>;
    lastImageAt: number | null;
    hasUnrecognizedFiles: boolean;
  }>;
  deliveries: Array<{
    path: string;
    folderName: string;
    kind: string | null;
    round: number | null;
    isJunk: boolean;
    fileCount: number;
    sentAt: number | null;
  }>;
  changes: Array<{
    area: string;
    target: string;
    kind: string;
    params?: Record<string, string | number>;
    times: number;
    fileAt: number | null;
    detectedAt: number;
    isSeen: boolean;
  }>;
  events: Array<{
    from: string | null;
    to: string;
    reason: string;
    evidence: Localized | null;
    at: number;
  }>;
}

interface Props {
  projectKey: string;
  onClose: () => void;
  onOpenFolder: (path: string) => void;
}

export function ProjectPanel({ projectKey, onClose, onOpenFolder }: Props) {
  const { t, tl, lang } = useI18n();
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const locale = lang === 'uk' ? 'uk-UA' : 'en-US';
  const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(locale) : '—');

  const { data, isLoading, error } = useQuery<Detail>({
    queryKey: ['project', projectKey],
    queryFn: async () => {
      const res = await fetch(`/api/project?key=${encodeURIComponent(projectKey)}`);
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? `не удалось загрузить проект (HTTP ${res.status})`);
      }
      return payload;
    },
  });

  // Карточку открыли — изменения считаем просмотренными, иначе счётчик вечный
  const markSeen = useMutation({
    mutationFn: async () => {
      await fetch('/api/changes/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: projectKey }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });

  // Последнее изменение по каждой папке: нужно, чтобы показать отметку
  // прямо в строке сцены, а не только общим списком внизу.
  const latestByTarget = useMemo(() => {
    const map = new Map<string, Detail['changes'][number]>();
    for (const change of data?.changes ?? []) {
      if (!map.has(change.target)) map.set(change.target, change); // changes уже отсортированы, свежие первыми
    }
    return map;
  }, [data]);

// Сколько записей показываем в свёрнутом виде. Раньше свёрнутый вид показывал
  // все непросмотренные — и пока просмотренных не было, кнопка ничего не меняла.
  const COLLAPSED_LIMIT = 3;
  const allChanges = data?.changes ?? [];
  const collapsedChanges = allChanges.filter((c) => !c.isSeen).slice(0, COLLAPSED_LIMIT);
  const shownChanges = historyOpen ? allChanges : collapsedChanges;
  const hiddenCount = allChanges.length - shownChanges.length;

  const unseenCount = data?.changes.filter((c) => !c.isSeen).length ?? 0;
  const hasUnseen = unseenCount > 0;
  const { mutate: doMarkSeen } = markSeen;
  useEffect(() => {
    if (hasUnseen) doMarkSeen();
  }, [hasUnseen, doMarkSeen]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <aside className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <header className={styles.head}>
          <h2 className={styles.title}>
            {data?.project.title ?? (error ? t('panel.error') : t('panel.loading'))}
          </h2>
          <button className={styles.close} onClick={onClose} title={t('panel.close')}>
            <X {...ICON} />
          </button>
        </header>

        {isLoading && <div className={styles.muted}>{t('panel.loading')}</div>}
        {error && <div className={styles.failure}>{(error as Error).message}</div>}

        {data && (
          <div className={styles.content}>
            <section className={styles.section}>
              <div className={styles.kv}>
                <span>{t('panel.folder')}</span>
                <button
                  className={styles.pathButton}
                  title={`Открыть в проводнике\n${data.project.path}`}
                  onClick={() => onOpenFolder(data.project.path)}
                >
                  <FolderOpen {...ICON_SM} /> {data.project.folderName}
                </button>
              </div>
              <div className={styles.kv}>
                <span>{t('panel.evidence')}</span>
                <code>{tl(data.project.evidence)}</code>
              </div>
              <div className={styles.kv}>
                <span>{t('panel.lastDelivery')}</span>
                <b>{fmt(data.project.lastDeliveryAt)}</b>
              </div>
              <div className={styles.kv}>
                <span>{t('panel.lastRender')}</span>
                <b>{fmt(data.project.lastRenderAt)}</b>
              </div>
              {data.project.sizeBytes !== null && (
                <div className={styles.kv}>
                  <span>{t('panel.size')}</span>
                  <b>{(data.project.sizeBytes / 1024 ** 3).toFixed(1)} ГБ</b>
                </div>
              )}
            </section>

            <section className={styles.section}>
              <h3 className={styles.h3}>
                {t('panel.changesCount', { count: data.changes.length })}
              </h3>
              {data.changes.length === 0 && (
                <div className={styles.mutedLine}>{t('panel.noChanges')}</div>
              )}

              {/* Новые изменения показываем сразу, старую историю прячем,
                  чтобы разворот карточки не превращался в простыню */}
              {shownChanges.map((c, i) => (
                <div key={i} className={c.isSeen ? styles.change : styles.changeFresh}>
                  <span className={styles.changeTarget}>{c.target}</span>
                  <span className={styles.changeText}>
                    {t(c.kind, c.params)}
                    {c.times > 1 && <span className={styles.changeTimes}>×{c.times}</span>}
                  </span>
                  <span className={styles.changeWhen}>{fmt(c.fileAt ?? c.detectedAt)}</span>
                </div>
              ))}

              {/* Кнопку показываем только если ей есть что раскрыть или свернуть,
                  иначе она выглядит сломанной */}
              {(hiddenCount > 0 || historyOpen) && (
                <button
                  className={styles.historyToggle}
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <ChevronDown
                    {...ICON_SM}
                    className={historyOpen ? styles.chevronOpen : styles.chevron}
                  />
                  {historyOpen
                    ? t('panel.collapse')
                    : t('panel.showAll', { count: allChanges.length })}
                </button>
              )}

              {historyOpen && <div className={styles.changesHint}>{t('panel.changesHint')}</div>}
            </section>

            <section className={styles.section}>
              <h3 className={styles.h3}>{t('panel.scenes', { count: data.scenes.length })}</h3>
              {data.scenes.map((s) => (
                <div key={s.name} className={styles.scene}>
                  <div className={styles.sceneHead}>
                    <button
                      className={styles.sceneName}
                      title={`Открыть папку сцены\n${s.path}`}
                      onClick={() => onOpenFolder(s.path)}
                    >
                      <FolderOpen {...ICON_SM} /> {s.name}
                    </button>
                    <span className={styles.counts}>
                      {/* EXR — сырьё с ферм, JPG — уже сконвертированное руками.
                          Держим врозь, иначе непонятно, на каком этапе сцена */}
                      <span className={s.exrCount > 0 ? styles.countExr : styles.countZero}>
                        {t('panel.exr', { count: s.exrCount })}
                      </span>
                      <span className={s.imageCount > 0 ? styles.countOk : styles.countZero}>
                        {t('panel.jpg', { count: s.imageCount })}
                      </span>
                      <span className={s.psdCount > 0 ? styles.countPsd : styles.countZero}>
                        {t('panel.psd', { count: s.psdCount })}
                      </span>
                    </span>
                  </div>
                  <div className={styles.sceneMeta}>
                    {s.skus.slice(0, 6).map((sku) => (
                      <span key={sku} className={styles.sku}>
                        {sku}
                      </span>
                    ))}
                    {s.versions.length > 0 && (
                      <span className={styles.versions}>
                        {t('panel.stages', {
                          list: s.versions.map((v) => `${v.name} (${v.imageCount})`).join(', '),
                        })}
                      </span>
                    )}
                    <span className={styles.phaseFlag} data-phase={s.phase}>
                      {t('phase.' + s.phase)}
                    </span>
                    {s.psdFolder && s.psdFolder !== s.name && (
                      <span className={styles.versions}>PSD: {s.psdFolder}</span>
                    )}
                    {s.hasUnrecognizedFiles && (
                      <span className={styles.flag}>
                        <TriangleAlert {...ICON_SM} /> {t('panel.unrecognized')}
                      </span>
                    )}
                  </div>
                  {(() => {
                    const change = latestByTarget.get(s.name);
                    if (!change) return null;
                    return (
                      <div className={change.isSeen ? styles.rowChange : styles.rowChangeFresh}>
                        <Activity {...ICON_SM} />
                        <span>
                          {t(change.kind, change.params)}
                          {change.times > 1 && (
                            <span className={styles.changeTimes}>×{change.times}</span>
                          )}
                        </span>
                        <span className={styles.rowChangeWhen}>
                          {fmt(change.fileAt ?? change.detectedAt)}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              ))}
            </section>

            <section className={styles.section}>
              <h3 className={styles.h3}>{t('panel.deliveries', { count: data.deliveries.length })}</h3>
              {data.deliveries.map((d) => (
                <div key={d.folderName} className={d.isJunk ? styles.deliveryJunk : styles.delivery}>
                  <button
                    className={styles.deliveryName}
                    title={`Открыть папку отгрузки\n${d.path}`}
                    onClick={() => onOpenFolder(d.path)}
                  >
                    <FolderOpen {...ICON_SM} /> {d.folderName}
                  </button>
                  <span className={styles.deliveryMeta}>
                    {d.fileCount === 0 ? t('panel.empty') : t('panel.files', { count: d.fileCount })} ·{' '}
                    {fmt(d.sentAt)}
                    {d.isJunk && ` · ${t('panel.junk')}`}
                  </span>
                  {(() => {
                    const change = latestByTarget.get(d.folderName);
                    if (!change) return null;
                    return (
                      <div className={change.isSeen ? styles.rowChange : styles.rowChangeFresh}>
                        <Activity {...ICON_SM} />
                        <span>{t(change.kind, change.params)}</span>
                      </div>
                    );
                  })()}
                </div>
              ))}
            </section>

            {data.events.length > 0 && (
              <section className={styles.section}>
                <h3 className={styles.h3}>{t('panel.history')}</h3>
                {data.events.map((e, i) => (
                  <div key={i} className={styles.event}>
                    <span>
                      {e.from ? t(`column.${e.from}`) : t('panel.newProject')} →{' '}
                      <b>{t(`column.${e.to}`)}</b>
                    </span>
                    <span className={styles.eventMeta}>
                      {t(`event.${e.reason}`)} · {fmt(e.at)}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {data.project.anomalies.length > 0 && (
              <section className={styles.section}>
                <h3 className={styles.h3}>{t('panel.anomalies')}</h3>
                {data.project.anomalies.map((a, i) => (
                  <div key={i} className={styles.anomaly}>
                    <TriangleAlert {...ICON_SM} />
                    <span>{tl(a)}</span>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
