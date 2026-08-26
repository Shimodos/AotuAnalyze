import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from './providers';
import { themeBootstrapScript } from '@/components/ThemeProvider';
import './globals.scss';

// Кириллица в subsets обязательна: интерфейс украинский по умолчанию,
// без неё Inter отдаёт латиницу, а кириллица падает на системный шрифт.
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'Viarde Tracker',
  description: 'Стан проєктів визначається зі структури тек',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* до первой отрисовки, иначе светлая тема мигнёт тёмной */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
