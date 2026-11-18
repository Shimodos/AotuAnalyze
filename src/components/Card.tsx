'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardCard } from '@/app/api/board/route';
import { useI18n } from '@/i18n';
import { fetchJson } from './fetchJson';
import {
  Activity,
  Clock,
  FolderOpen,
  ICON,
  ICON_SM,
  Info,
  Link2,
  Pin,
  Send,
  TriangleAlert,
  Users,
} from './icons';
import styles from './Card.module.scss';

interface Props {
  card: BoardCard;
  thresholds: { warn: number; alert: number };
  onOpen: () => void;
  onOpenFolder: (path: string) => void;
  onCopyLink: (url: string) => void;
}

function staleClass(days: number | null, t: { warn: number; alert: number }) {
  if (days === null) return '';
  if (days >= t.alert) return styles.alert;
  if (days >= t.warn) return styles.warn;
  return '';
}

export function Card({ card, thresholds, onOpen, onOpenFolder, onCopyLink }: Props) {
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const pin = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: true }>(
        '/api/pin',
        { json: { key: card.key, column: card.isPinned ? null : card.column } },
        () => t('error.pin'),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });

  // Когда есть план клиента, показываем прогресс по кадрам: он точнее,
  // чем «сцен готово», потому что сцена бывает сделана наполовину.
  const hasPlan = card.plannedTotal > 0;
  const progress = hasPlan
    ? Math.min(100, Math.round((card.plannedDone / card.plannedTotal) * 100))
    : card.scenesTotal > 0
      ? Math.round((card.scenesRendered / card.scenesTotal) * 100)
      : null;

  // Превью может не получиться (Dropbox отказал, сети нет). Сломанная картинка
  // с alt-текстом хуже, чем её отсутствие — прячем и пробуем снова при
  // следующем обновлении доски.
  const [coverFailed, setCoverFailed] = useState(false);

  // Карточка «поднимается» только когда есть повод: непросмотренные изменения
  // или просроченная стадия. Остальные лежат плоско и не спорят за внимание.
  const needsAttention =
    card.unseenChanges > 0 ||
    card.farmActive ||
    (card.daysInStage !== null && card.daysInStage >= thresholds.warn);

  // Расхождение с закреплённой колонкой — не метка, а объяснение,
  // почему карточка стоит не там, где её посчитал скан
  const note =
    card.isPinned && card.actualColumn !== card.column
      ? t('card.actually', { column: t(`column.${card.actualColumn}`) })
      : null;

  return (
    <article className={needsAttention ? styles.card : styles.cardCalm} onClick={onOpen}>
      {card.hasCover && !coverFailed && (
        // обычный img, а не next/image: файлы лежат вне public и отдаются роутом
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.cover}
          src={`/api/thumb?key=${encodeURIComponent(card.key)}`}
          alt={card.title}
          loading="lazy"
          onError={() => setCoverFailed(true)}
        />
      )}

      <div className={styles.body}>
        <div className={styles.head}>
          <span className={card.farmActive ? `${styles.avatar} ${styles.avatarLive}` : styles.avatar}>
            {card.jobNumber ?? '—'}
          </span>

          <div className={styles.headText}>
            <h3 className={styles.title}>{card.title}</h3>
            <span className={styles.sub}>
              {hasPlan
                ? t('card.planShort', { done: card.plannedDone, total: card.plannedTotal })
                : card.scenesTotal > 0
                  ? t('card.scenesShort', { total: card.scenesTotal })
                  : t('card.noScenes')}
            </span>
          </div>

          <span className={styles.actions}>
            <button
              className={styles.iconButton}
              title={`${t('card.openFolder')}\n${card.path}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFolder(card.path);
              }}
            >
              <FolderOpen {...ICON} />
            </button>
            {card.webUrl && (
              <button
                className={styles.iconButton}
                title={t('action.copyLink')}
                onClick={(e) => {
                  e.stopPropagation();
                  onCopyLink(card.webUrl!);
                }}
              >
                <Link2 {...ICON} />
              </button>
            )}
            <button
              className={card.isPinned ? styles.pinActive : styles.iconButton}
              title={card.isPinned ? t('card.unpin') : t('card.pin')}
              onClick={(e) => {
                e.stopPropagation();
                pin.mutate();
              }}
            >
              <Pin {...ICON} />
            </button>
          </span>
        </div>

        {progress !== null && (
          <div className={styles.progressBlock}>
            <div className={styles.progressBar}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <span className={styles.progressText}>
              {hasPlan
                ? t('card.planned', { done: card.plannedDone, total: card.plannedTotal })
                : t('card.scenes', { done: card.scenesRendered, total: card.scenesTotal })}
            </span>
          </div>
        )}

        {/* Закреплённая карточка не должна молча врать: если скан насчитал
            другую колонку, показываем это прямо на карточке */}
        {note && (
          <div className={styles.note}>
            <Info {...ICON_SM} />
            <span>{note}</span>
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
