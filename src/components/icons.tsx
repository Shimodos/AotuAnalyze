/**
 * Единая точка для иконок. Набор — lucide (сетка 24px, скруглённые концы),
 * параметры отрисовки заданы здесь, чтобы обводка и размер были одинаковыми
 * во всём интерфейсе и не разъезжались от компонента к компоненту.
 */

export {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Activity,
  Cloud,
  CloudOff,
  FolderOpen,
  Layers,
  Link2,
  Moon,
  Pin,
  RefreshCw,
  Send,
  Sun,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';

/** Иконка в кнопке */
export const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** Иконка внутри строки текста: бейджи, подписи, метаданные */
export const ICON_SM = { size: 13, strokeWidth: 1.75 } as const;
