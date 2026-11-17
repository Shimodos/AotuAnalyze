/**
 * Подстановка параметров в шаблон перевода: «{n} з {total}» → «3 з 8».
 * Без React — тем же пользуется CLI.
 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
