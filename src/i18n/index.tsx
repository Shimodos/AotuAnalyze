'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { interpolate } from './interpolate';
import en from './locales/en.json';
import uk from './locales/uk.json';

export const LANGUAGES = ['uk', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_LABEL: Record<Language, string> = { uk: 'UA', en: 'EN' };

/** Локаль для дат и чисел — одна на все компоненты */
const LOCALE: Record<Language, string> = { uk: 'uk-UA', en: 'en-US' };

const DICTIONARIES: Record<Language, Record<string, string>> = { uk, en };

const STORAGE_KEY = 'viarde.lang';
export const DEFAULT_LANGUAGE: Language = 'uk';

// Значение, приходящее с сервера: код перевода и подстановки.
// Стадии и отклонения считаются на сервере, а показываются на любом языке,
// поэтому в БД лежит код, а не готовая фраза.
export type { Localized } from './types';
import type { Localized } from './types';

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Language;
  /** локаль для toLocaleDateString и подобного */
  locale: string;
  setLang: (lang: Language) => void;
  t: Translate;
  /** Перевод значения, пришедшего с сервера. Строку показываем как есть — это данные из старой базы. */
  tl: (value: Localized | string | null | undefined) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>(DEFAULT_LANGUAGE);

  // Читаем сохранённый выбор после монтирования: на сервере localStorage нет,
  // а расхождение разметки при гидрации нам ни к чему.
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && (LANGUAGES as readonly string[]).includes(saved)) {
      setLangState(saved as Language);
      // иначе <html lang> остаётся тем, что отдал сервер, до первого переключения
      document.documentElement.lang = saved;
    }
  }, []);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.lang = next;
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dictionary = DICTIONARIES[lang];
    const t: Translate = (key, params) => interpolate(dictionary[key] ?? key, params);
    return {
      lang,
      locale: LOCALE[lang],
      setLang,
      t,
      tl: (input) => {
        if (!input) return '';
        if (typeof input === 'string') return input;
        return t(input.code, input.params);
      },
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n вызван вне I18nProvider');
  return value;
}
