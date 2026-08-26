'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardCard } from '@/app/api/board/route';
import { useI18n } from '@/i18n';
import { Activity, Clock, FolderOpen, ICON, ICON_SM, Pin, Send, TriangleAlert, Users } from './icons';
import styles from './Card.module.scss';

interface Props {
  card: BoardCard;
  thresholds: { warn: number; alert: number };
  onOpen: () => void;
  onOpenFolder: (path: string) => void;
}

function staleClass(days: number | null, t: { warn: number; alert: number }) {
  if (days === null) return '';
  if (days >= t.alert) return styles.alert;
  if (days >= t.warn) return styles.warn;
  return '';
}

export function Card({ card, thresholds, onOpen, onOpenFolder }: Props) {
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const pin = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: card.key,
          column: card.isPinned ? null : card.column,
        }),
      });
      if (!res.ok) throw new Error(t('error.pin'));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });

  const progress =
    card.scenesTotal > 0 ? Math.round((card.scenesRendered / card.scenesTotal) * 100) : null;

  return (
    <article className={styles.card} onClick={onOpen}>
      {card.hasCover && (
        // обычный img, а не next/image: файлы лежат вне public и отдаются роутом
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.cover}
          src={`/api/thumb?key=${encodeURIComponent(card.key)}`}
          alt={card.title}
          loading="lazy"
        />
      )}

      <div className={styles.body}>
        <div className={styles.topRow}>
          <span className={styles.job}>{card.jobNumber ?? '—'}</span>
          <span className={styles.actions}>
            <button
              className={styles.iconButton}
              title={`Открыть папку проекта\n${card.path}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFolder(card.path);
              }}
            >
              <FolderOpen {...ICON} />
            </button>
            <button
              className={card.isPinned ? styles.pinActive : styles.iconButton}
              title={
                card.isPinned ? t('card.unpin') : t('card.pin')
              }
              onClick={(e) => {
                e.stopPropagation();
                pin.mutate();
              }}
            >
              <Pin {...ICON} />
            </button>
          </span>
        </div>

        <h3 className={styles.title}>{card.title}</h3>

        {progress !== null && (
          <div className={styles.progressBlock}>
            <div className={styles.progressBar}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <span className={styles.progressText}>
              {t('card.scenes', { done: card.scenesRendered, total: card.scenesTotal })}
            </span>
          </div>
        )}

        {/* Проект бывает одновременно в рендере и в посте — одной колонкой
            это не выразить, поэтому разбивка живёт на карточке */}
        {card.scenesTotal > 0 && card.scenesPost + card.scenesRendering > 0 && (
          <div className={styles.phases}>
            {t('card.phases', {
              rendering: card.scenesRendering,
              post: card.scenesPost,
              converted: card.scenesConverted,
            })}
          </div>
        )}

        <div className={styles.badges}>
          {card.unseenChanges > 0 && (
            <span className={styles.badgeLive}>
              <Activity {...ICON_SM} /> {t('card.changes', { n: card.unseenChanges })}
            </span>
          )}
          {card.round !== null && card.round > 1 && (
            <span className={styles.badge}>{t('card.round', { n: card.round })}</span>
          )}
          {card.maxRound !== null && card.maxRound >= 4 && (
            <span className={styles.badgeWarn}>
              <TriangleAlert {...ICON_SM} /> {t('card.totalRounds', { n: card.maxRound })}
            </span>
          )}
          {/* Закреплённая карточка не должна молча врать: если скан насчитал
              другую колонку, показываем это прямо на карточке */}
          {card.isPinned && card.actualColumn !== card.column && (
            <span className={styles.badgeWarn}>
              <TriangleAlert {...ICON_SM} />{' '}
              {t('card.actually', { column: t(`column.${card.actualColumn}`) })}
            </span>
          )}
          {/* Ферма может работать параллельно с постобработкой, поэтому
              признак живёт отдельно от колонки */}
          {card.farmActive && (
            <span className={styles.badgeLive}>
              {t('card.farmRendering')} · EXR {card.exrTotal}
            </span>
          )}
          {card.isSettling && <span className={styles.badgeLive}>{t('card.settling')}</span>}
          {card.hasClientFeedback && <span className={styles.badge}>{t('card.feedback')}</span>}
          {!card.hasStandardStructure && <span className={styles.badgeMuted}>{t('card.structure')}</span>}
          {card.anomalyCount > 0 && (
            <span className={styles.badgeMuted}>
              <TriangleAlert {...ICON_SM} /> {card.anomalyCount}
            </span>
          )}
        </div>

        <div className={styles.footer}>
          <span className={`${styles.days} ${staleClass(card.daysInStage, thresholds)}`}>
            <Clock {...ICON_SM} />
            {card.daysInStage !== null ? t('card.daysInStage', { n: card.daysInStage }) : t('card.noData')}
          </span>
          <span className={styles.ball}>
            {card.ball === 'CLIENT' ? <Send {...ICON_SM} /> : <Users {...ICON_SM} />}
            {card.ball === 'CLIENT' ? t('card.atClient') : t('card.atUs')}
          </span>
        </div>
      </div>
    </article>
  );
}
