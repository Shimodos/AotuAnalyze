/** @type {import('next').NextConfig} */
const nextConfig = {
  // Пакеты, работающие с файловой системой и нативными модулями, нельзя
  // бандлить — в сборке Next они ломаются. У xlsx это проявлялось особенно
  // подло: разбор плана молча возвращал пустой результат, и выглядело так,
  // будто таблицы у проектов просто нет.
  serverExternalPackages: ['better-sqlite3', 'sharp', 'xlsx'],

  // Самостоятельная сборка для установщика (scripts/pack.mjs): сервер вместе
  // с нужной частью node_modules. Обычные `npm run dev` и `npm run build`
  // переменную не задают и работают как раньше.
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/output
  ...(process.env.VIARDE_PACK ? { output: 'standalone' } : {}),
};
export default nextConfig;
