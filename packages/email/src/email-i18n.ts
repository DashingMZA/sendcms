// packages/email/src/email-i18n.ts
// Sync translator for the `email` domain (EML-010).
//
// Email templates render synchronously (plain functions, no async
// loader), so the email dictionaries are imported statically from the
// `@sendcms/i18n` package instead of going through the async
// `loadLocaleDomain` path. The Urdu dictionary is merged over English,
// so a missing Urdu key falls back to the English string (the same
// per-key fallback the app adapters use) instead of `[missing: key]`.
// Locales without an email dictionary (anything but `ur`) render
// English.
import { createTranslator, type Translator } from "@sendcms/i18n"
import emailEn from "@sendcms/i18n/locales/en/email.json"
import emailUr from "@sendcms/i18n/locales/ur/email.json"

const EMAIL_MESSAGES: Record<string, Record<string, string>> = {
  en: emailEn,
  ur: { ...emailEn, ...emailUr },
}

export function getEmailTranslator(locale: string): Translator {
  const normalized = locale.toLowerCase().startsWith("ur") ? "ur" : "en"
  return createTranslator(EMAIL_MESSAGES[normalized] ?? emailEn)
}
