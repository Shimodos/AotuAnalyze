/**
 * Тип общий для сервера и клиента, поэтому вынесен отдельно от провайдера:
 * в index.tsx стоит 'use client', и тянуть его в сканер нельзя.
 */
export interface Localized {
  code: string;
  params?: Record<string, string | number>;
}
