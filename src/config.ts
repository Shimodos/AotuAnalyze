/**
 * Единая точка настройки правил. Всё, что зависит от конвенции студии, живёт здесь.
 * Позже эта таблица переезжает в БД и редактируется в UI (PROJECT.md §8, таблица rules).
 */

export const CONFIG = {
  /** Корень Dropbox на локальной машине */
  // Прямые слэши намеренно: Node понимает их на Windows, а обратные легко
  // потерять при экранировании — путь тогда молча становится drive-relative.
  root: process.env.VIARDE_ROOT ?? 'D:/Viarde Studio Dropbox',

  /** Папки в корне, которые НЕ являются проектами */
  notProjects: ['Kraus_Start', 'Kraus_1001_Small_task'],

  /** Расширения, которые считаем значащим результатом рендера */
  imageExtensions: ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.exr', '.webp'],

  /**
   * Минимальный размер файла-рендера, байты.
   * Проверено на 1044 реальных jpg: минимум 561 КБ, медиана 3.9 МБ,
   * файлов меньше 100 КБ — ноль. Порог безопасен.
   */
  minFileSize: 100 * 1024,

  /**
   * Служебные имена папок в 04_JPG — не считаются сценами.
   * ВАЖНО: 'studio' здесь НЕТ — по решению студии Studio содержит боевые рендеры
   * (Studio_White_KPF-1610BB_Angle01.jpg) и входит в прогресс.
   */
  serviceSceneNames: [
    'test', 'tests', 'old', 'prev', 'temp', 'tmp',
    'new folder', 'cam_ref', 'backgrounds', 'test backgrounds', 'lessons',
    // рабочая папка внутри 04_PSD, сценой не является
    'ai', 'jpeg',
  ],

  /**
   * Маркеры мусора в именах папок Outbox.
   * Сравнение ПОТОКЕННОЕ, не по подстроке: иначе 'old' ловит «Bolden» и «Gold».
   */
  outboxJunkMarkers: ['test', 'material', 'old', 'scenes', 'studio', 'people', 'dof'],

  /**
   * Имена сцен, которые законно не содержат артикула в названии папки:
   * артикулы у них лежат в именах файлов (Studio_White_KPF-1610BB_Angle01.jpg).
   * Не повод для аномалии.
   */
  sceneNamesWithoutSku: ['studio', 'studios'],

  /**
   * Глубина обхода папки отгрузки в 05_Outbox при подсчёте файлов и даты.
   * К сценам не относится: в сцене считаются только картинки в корне.
   */
  outboxScanDepth: 3,

  /**
   * Насколько «свежими» считаются данные доски. Если последний скан старше —
   * запрос /api/board запускает скан в фоне и отдаёт то, что есть.
   *
   * 30 минут: рендер пишется десятками минут, отгрузка собирается руками —
   * минутная точность здесь не нужна. Если понадобилось прямо сейчас,
   * есть кнопка «Сканувати», она игнорирует этот порог.
   */
  boardRefreshMs: Number(process.env.VIARDE_BOARD_REFRESH_MS ?? 30 * 60_000),

  /**
   * Скан дольше этого порога означает, что диску плохо: в норме обход
   * укладывается в 1–3 с, а когда внешний USB-диск спотыкается или Dropbox
   * переиндексирует папку, тот же обход растягивается до десятков минут.
   * Гонять его в такой момент каждые полчаса — значит добивать диск.
   */
  slowScanMs: Number(process.env.VIARDE_SLOW_SCAN_MS ?? 30_000),

  /**
   * Интервал до следующего скана после медленного или упавшего:
   * даём диску и Dropbox час тишины, чтобы они успели прийти в себя.
   */
  boardRefreshSlowMs: Number(process.env.VIARDE_BOARD_REFRESH_SLOW_MS ?? 60 * 60_000),

  /**
   * Скан, который начался раньше этого срока и не закончился, считаем
   * мёртвым: процесс убили или сервер перезапустили. Иначе одна такая запись
   * заблокировала бы все последующие сканы навсегда. Самый долгий живой
   * скан, который мы видели, — 38 минут; два часа — с запасом.
   */
  scanRunTimeoutMs: Number(process.env.VIARDE_SCAN_RUN_TIMEOUT_MS ?? 2 * 60 * 60_000),

  /**
   * Единственное исключение из правила «приложение только читает»: чеклист
   * правок дублируется в _Revisions.txt в папке сцены, чтобы его можно было
   * открыть без приложения. Выключается через VIARDE_WRITE_REVISIONS=off —
   * тогда чеклист живёт только в базе, и Dropbox не трогается вообще.
   */
  writeRevisionsFile: process.env.VIARDE_WRITE_REVISIONS !== 'off',

  /**
   * Дебаунс: если внутри проекта что-то менялось меньше N минут назад,
   * карточка помечается «в работе» и переход не фиксируется в истории.
   */
  debounceMinutes: 15,

  /** Финал тише этого срока (дней) — уезжает в архив */
  archiveAfterDays: 60,

  /** Порог «застоя» для подсветки карточки, дней */
  staleWarnDays: 5,
  staleAlertDays: 14,

  /** Полный стандартный набор папок проекта */
  standardFolders: [
    '01_Clients', '02_Inspiration', '03_Models',
    '04_EXR', '04_JPG', '04_PSD', '05_Outbox', '06_Textures',
  ],

  /** Куда складывать кеш превью */
  thumbCacheDir: '.cache/thumbs',
  thumbWidth: 640,
} as const;

/** Порядок колонок доски слева направо */
export const COLUMNS = [
  'NEW', 'MODELING', 'RENDERING', 'FAST_PREVIEW', 'PREVIEW', 'PREFINAL', 'FINAL',
] as const;

export type Column = (typeof COLUMNS)[number];


/** Кто держит мяч. Вторая ось модели — см. разбор PROJECT.md §3 */
export const BALLS = ['US', 'CLIENT'] as const;
export type Ball = (typeof BALLS)[number];

/** Вид отгрузки в 05_Outbox */
export const DELIVERY_KINDS = ['FAST_PREVIEW', 'PREVIEW', 'PREFINAL', 'FINAL'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

/**
 * Этап конкретной сцены. Проект бывает одновременно и в рендере, и в посте —
 * одной колонкой это не выразить, поэтому этап живёт на уровне сцены.
 */
export const SCENE_PHASES = ['EMPTY', 'RENDERING', 'CONVERTED', 'POST'] as const;
export type ScenePhase = (typeof SCENE_PHASES)[number];

