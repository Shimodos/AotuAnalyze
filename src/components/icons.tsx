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
  Flame,
  FolderOpen,
  Info,
  Languages,
  Layers,
  Check,
  LayoutGrid,
  Link2,
  ListChecks,
  Moon,
  Pin,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sun,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';

/** Иконка в кнопке */
export const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** Иконка внутри строки текста: бейджи, подписи, метаданные */
export const ICON_SM = { size: 13, strokeWidth: 1.75 } as const;

/** Иконка в плитке метрики — крупнее, на тёмной заливке */
export const ICON_LG = { size: 19, strokeWidth: 1.75 } as const;
