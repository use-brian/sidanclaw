/** Shared OSS app and consent wording catalog. [COMP:crm/operations-contract] */
export const APP_LOCALES = ['en', 'zh', 'zh-CN', 'ja'] as const
export type AppLocale = (typeof APP_LOCALES)[number]
