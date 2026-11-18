'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'viarde.theme';
export const DEFAULT_THEME: Theme = 'dark';

interface ThemeValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

/**
 * Скрипт вставляется в <head> и выполняется до первой отрисовки: без него
 * страница успевает мигнуть тёмной темой, прежде чем React прочитает
 * localStorage. Ключ здесь обязан совпадать со STORAGE_KEY.
 */
export const themeBootstrapScript = `
(function () {
  try {
    var saved = localStorage.getItem('viarde.theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.dataset.theme = saved;
    }
  } catch (e) {}
})();
`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme вызван вне ThemeProvider');
  return value;
}
