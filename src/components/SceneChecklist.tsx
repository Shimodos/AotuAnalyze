'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChecklistData } from '@/app/api/checklist/route';
import type { ChecklistItem } from '@/checklist/checklist';
import type { WriteResult } from '@/checklist/file';
import { useI18n } from '@/i18n';
import { fetchJson } from './fetchJson';
import { Check, ICON, ICON_SM, Link2, TriangleAlert, X } from './icons';
import styles from './SceneChecklist.module.scss';

type SaveBody = { fileName: string; isDone: boolean; note: string | null };
type SaveResponse = ChecklistData & { file: WriteResult };

/** Пауза после последней буквы, по которой заметка уходит на сервер */
const NOTE_DEBOUNCE_MS = 700;

interface Props {
  projectKey: string;
  sceneName: string;
  onClose: () => void;
  onCopyLink: (url: string) => void;
}

export function SceneChecklist({ projectKey, sceneName, onClose, onCopyLink }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [round, setRound] = useState<number | null>(null);
  // Черновики заметок: поле ввода должно печататься мгновенно, а уходить
  // на сервер с задержкой, иначе каждая буква — запись файла в Dropbox.
  // Ключ — имя файла в пределах ОДНОГО круга: при смене круга черновики
  // сбрасываются, иначе заметка круга 3 показывалась бы и в круге 2.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => setDrafts({}), [round]);

  // Отложенные сохранения заметок: таймер и текст. Текст храним рядом,
  // чтобы при закрытии окна не потерять то, что набрали в последние 700 мс.
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; note: string }>());

  const query = round === null ? '' : `&round=${round}`;
  const { data, isLoading, error } = useQuery<ChecklistData>({
    queryKey: ['checklist', projectKey, sceneName, round],
    queryFn: () =>
      fetchJson<ChecklistData>(
        `/api/checklist?key=${encodeURIComponent(projectKey)}&scene=${encodeURIComponent(sceneName)}${query}`,
      ),
  });

  // Актуальные данные для таймеров: замыкание таймера видело бы состояние
  // на момент набора, а галочку могли переключить позже
  const dataRef = useRef(data);
  dataRef.current = data;

  const save = useMutation({
    mutationFn: (body: SaveBody) =>
      fetchJson<SaveResponse>('/api/checklist', {
        json: { key: projectKey, scene: sceneName, round: dataRef.current?.round, ...body },
      }),
    onSuccess: (payload) => {
      // Ответ уже содержит пересобранный список — второй запрос не нужен
      queryClient.setQueryData(
        ['checklist', projectKey, sceneName, round],
        (old: ChecklistData | undefined) =>
          old ? { ...old, items: payload.items, done: payload.done, total: payload.total } : old,
      );
      // Счётчик в строке сцены живёт в другом запросе
      queryClient.invalidateQueries({ queryKey: ['project', projectKey] });
    },
  });
  const { mutate } = save;

  /** Отправить отложенную заметку сейчас, не дожидаясь таймера */
  function flushNote(fileName: string) {
    const p = pending.current.get(fileName);
    if (!p) return;
    clearTimeout(p.timer);
    pending.current.delete(fileName);
    const item = dataRef.current?.items.find((i) => i.fileName === fileName);
    mutate({ fileName, isDone: item?.isDone ?? false, note: p.note.trim() || null });
  }

  // При закрытии окна отложенные заметки не отменяем, а отправляем:
  // иначе набранное в последние 700 мс пропадало бы молча
  useEffect(() => {
    const map = pending.current;
    return () => {
      for (const [fileName, p] of map) {
        clearTimeout(p.timer);
        const item = dataRef.current?.items.find((i) => i.fileName === fileName);
        mutate({ fileName, isDone: item?.isDone ?? false, note: p.note.trim() || null });
      }
      map.clear();
    };
  }, [mutate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = data?.items ?? [];
  const percent = data && data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;

  function toggle(item: ChecklistItem) {
    // Отложенная заметка по этому кадру уезжает вместе с галочкой — иначе
    // таймер сработал бы позже с устаревшим isDone и снял бы её обратно
    const p = pending.current.get(item.fileName);
    if (p) {
      clearTimeout(p.timer);
      pending.current.delete(item.fileName);
    }
    const note = drafts[item.fileName] ?? item.note ?? '';
    mutate({ fileName: item.fileName, isDone: !item.isDone, note: note.trim() || null });
  }

  function editNote(item: ChecklistItem, value: string) {
    setDrafts((prev) => ({ ...prev, [item.fileName]: value }));
    const existing = pending.current.get(item.fileName);
    if (existing) clearTimeout(existing.timer);
    pending.current.set(item.fileName, {
      note: value,
      timer: setTimeout(() => flushNote(item.fileName), NOTE_DEBOUNCE_MS),
    });
  }

  const fileNotice = save.data?.file;

  return (
    // Чеклист лежит внутри панели проекта; без stopPropagation клик по фону
    // всплывал бы до её overlay и закрывал обе
    <div
      className={styles.overlay}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <section className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <header className={styles.head}>
          <div className={styles.headText}>
            <h2 className={styles.title}>{t('checklist.title')}</h2>
            <span className={styles.scene}>{sceneName}</span>
          </div>
          <button className={styles.close} onClick={onClose} title={t('checklist.close')}>
            <X {...ICON} />
          </button>
        </header>

        {data && (
          <div className={styles.summary}>
            <div className={styles.rounds} role="group" aria-label={t('checklist.roundPick')}>
              {data.rounds.map((r) => (
                <button
                  key={r}
                  className={r === data.round ? styles.roundActive : styles.round}
                  onClick={() => setRound(r)}
                >
                  {t('checklist.round', { n: r })}
                </button>
              ))}
            </div>
            <div className={styles.progressBar}>
              <span style={{ width: `${percent}%` }} />
            </div>
            <span className={styles.progressText}>
              {t('checklist.progress', { done: data.done, total: data.total })}
            </span>
          </div>
        )}

        <div className={styles.body}>
          {isLoading && <div className={styles.muted}>{t('checklist.loading')}</div>}
          {error && <div className={styles.failure}>{error.message}</div>}
          {data && items.length === 0 && <div className={styles.muted}>{t('checklist.empty')}</div>}

          {items.map((item) => {
            const note = drafts[item.fileName] ?? item.note ?? '';
            return (
              <div
                key={item.fileName}
                className={item.isOrphan ? styles.rowOrphan : item.isDone ? styles.rowDone : styles.row}
              >
                <button
                  className={item.isDone ? styles.boxChecked : styles.box}
                  onClick={() => toggle(item)}
                  aria-pressed={item.isDone}
                  title={t('checklist.done')}
                >
                  {item.isDone && <Check size={13} strokeWidth={3} />}
                </button>

                <div className={styles.rowBody}>
                  <div className={styles.fileRow}>
                    <span className={styles.fileName}>{item.fileName}</span>
                    {item.isOrphan && (
                      <span className={styles.orphanFlag}>
                        <TriangleAlert {...ICON_SM} /> {t('checklist.orphan')}
                      </span>
                    )}
                    {item.webUrl && (
                      <button
                        className={styles.linkButton}
                        title={`${t('checklist.openInDropbox')}\n${item.webUrl}`}
                        onClick={() => onCopyLink(item.webUrl!)}
                      >
                        <Link2 {...ICON_SM} />
                      </button>
                    )}
                  </div>
                  <textarea
                    className={styles.note}
                    value={note}
                    rows={note ? 2 : 1}
                    placeholder={t('checklist.note')}
                    onChange={(e) => editNote(item, e.target.value)}
                    onBlur={() => flushNote(item.fileName)}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <footer className={styles.foot}>
          <span className={styles.hint}>{t('checklist.hint')}</span>
          {save.isPending && <span className={styles.saving}>{t('checklist.saving')}</span>}
          {fileNotice && !fileNotice.ok && (
            <span className={styles.fileWarn}>
              {fileNotice.reason === 'disabled'
                ? t('checklist.writeOff')
                : t('checklist.writeFailed', {
                    file: '_Revisions.txt',
                    reason: fileNotice.reason ?? '—',
                  })}
            </span>
          )}
          {fileNotice?.ok && (
            <span className={styles.fileOk}>{t('checklist.savedTo', { file: '_Revisions.txt' })}</span>
          )}
        </footer>
      </section>
    </div>
  );
}
