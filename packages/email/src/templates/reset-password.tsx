import { Button, Link, Text } from "react-email"
import { EmailLayout } from "./layout"
import { getEmailTranslator } from "../email-i18n"

type Props = {
  userName: string
  url: string
  accentColor: string
  footerText: string
  /** Recipient locale ("en" | "ur"); defaults to English. */
  locale?: string
}

export function ResetPasswordEmail({
  userName,
  url,
  accentColor,
  footerText,
  locale,
}: Props) {
  const t = getEmailTranslator(locale ?? "en")
  return (
    <EmailLayout
      preview={t("resetPreview")}
      accentColor={accentColor}
      footerText={footerText}
      locale={locale}
    >
      <Text style={{ fontSize: "16px", fontWeight: 600, margin: "0 0 12px" }}>
        {t("greeting", { name: userName })}
      </Text>
      <Text style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 16px" }}>
        {t("resetIntro")}
      </Text>
      <Button
        href={url}
        style={{
          backgroundColor: accentColor,
          borderRadius: "6px",
          color: "#ffffff",
          display: "inline-block",
          fontSize: "14px",
          fontWeight: 600,
          padding: "12px 24px",
          textDecoration: "none",
        }}
      >
        {t("resetButton")}
      </Button>
      <Text
        style={{
          color: "#6b7280",
          fontSize: "13px",
          lineHeight: "1.6",
          margin: "16px 0 4px",
        }}
      >
        {t("buttonFallback")}
      </Text>
      <Link href={url} style={{ fontSize: "13px", wordBreak: "break-all" }}>
        {url}
      </Link>
    </EmailLayout>
  )
}
