// Locale + translation providers — single source is `@sendcms/ui`
// (SRC-120, Phase 16, Wave 12). This file re-exports it so existing
// `@/components/admin/translation-provider` imports keep working;
// do not add providers here.
export {
  LocaleProvider,
  TranslationProvider,
  useLocale,
  useTranslation,
  type Dictionaries,
} from "@sendcms/ui"
