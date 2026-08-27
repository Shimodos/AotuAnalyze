/** @type {import('next').NextConfig} */
const nextConfig = {
  // Пакеты, работающие с файловой системой и нативными модулями, нельзя
  // бандлить — в сборке Next они ломаются. У xlsx это проявлялось особенно
  // подло: разбор плана молча возвращал пустой результат, и выглядело так,
  // будто таблицы у проектов просто нет.
  serverExternalPackages: ['better-sqlite3', 'sharp', 'xlsx'],
};
export default nextConfig;
