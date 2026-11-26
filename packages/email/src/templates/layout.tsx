// EML-001/030/061/090 (Phase 16, Wave 9): explicit React import —
// the standalone worker runs these templates under tsx, whose
// per-tsconfig `jsx: react-jsx` does not reach files outside the
// worker tsconfig's `include` scope, so JSX would compile to
// classic `React.createElement` calls with no React in scope.
import React from "react"
import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
  Hr,
} from "react-email"
import { getEmailTranslator } from "../email-i18n"

type Props = {
  preview: string
  accentColor: string
  logoUrl?: string | null
  footerText: string
  siteUrl?: string | null
  unsubscribeUrl?: string | null
  /** Recipient locale ("en" | "ur"); drives `<html lang dir>` and the
      layout's own strings (logo alt, Unsubscribe link). Defaults to
      English. */
  locale?: string
  children: React.ReactNode
}

export function EmailLayout({
  preview,
  accentColor,
  logoUrl,
  footerText,
  siteUrl,
  unsubscribeUrl,
  locale,
  children,
}: Props) {
  const t = getEmailTranslator(locale ?? "en")
  const dir = (locale ?? "en").toLowerCase().startsWith("ur") ? "rtl" : "ltr"
  return (
    <Html lang={locale ?? "en"} dir={dir}>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: "#f6f9fc",
          fontFamily: "sans-serif",
          margin: 0,
        }}
      >
        <Container
          style={{ maxWidth: "580px", margin: "0 auto", padding: "20px 0" }}
        >
          {logoUrl && (
            <Section style={{ padding: "20px 24px 0" }}>
              {siteUrl ? (
                <Link href={siteUrl}>
                  <Img src={logoUrl} height={32} alt={t("logoAlt")} />
                </Link>
              ) : (
                <Img src={logoUrl} height={32} alt={t("logoAlt")} />
              )}
            </Section>
          )}

          <Section
            style={{
              backgroundColor: "#ffffff",
              padding: "24px",
              margin: "16px 0",
              borderTop: `3px solid ${accentColor}`,
            }}
          >
            {children}
          </Section>

          <Section style={{ padding: "0 24px" }}>
            <Hr style={{ borderColor: "#e5e7eb" }} />
            <Text
              style={{
                color: "#9ca3af",
                fontSize: "12px",
                lineHeight: "1.6",
                margin: "8px 0 0",
              }}
            >
              {footerText}
              {unsubscribeUrl && (
                <>
                  {" · "}
                  <Link href={unsubscribeUrl} style={{ color: "#9ca3af" }}>
                    {t("unsubscribe")}
                  </Link>
                </>
              )}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
