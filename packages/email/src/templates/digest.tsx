// EML-001/030/061/090 (Phase 16, Wave 9): explicit React import —
// the standalone worker runs these templates under tsx, whose
// per-tsconfig `jsx: react-jsx` does not reach files outside the
// worker tsconfig's `include` scope, so JSX would compile to
// classic `React.createElement` calls with no React in scope.
import React from "react"
import { Button, Heading, Link, Section, Text } from "react-email"
import { formatDate, formatPlural, formatTime } from "@sendcms/i18n"
import { EmailLayout } from "./layout"
import { getEmailTranslator } from "../email-i18n"
import type { DigestProps } from "../notification-types"

type Props = DigestProps

const SHORT_DATE: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
}

function digestHeading(
  locale: string,
  count: number,
  formName: string
): string {
  const t = getEmailTranslator(locale)
  return formatPlural(
    locale,
    count,
    { one: t("digestHeadingOne"), other: t("digestHeadingOther") },
    { formName }
  )
}

/** Plain-text fallback for the digest (Resend/SMTP `text` part). */
export function digestText({
  formName,
  count,
  summary,
  highlights,
  items,
  inboxUrl,
  locale,
}: Omit<Props, "accentColor" | "footerText">): string {
  const effectiveLocale = locale ?? "en"
  const t = getEmailTranslator(effectiveLocale)
  const lines = [
    digestHeading(effectiveLocale, count, formName),
    "",
    summary,
    "",
    ...(highlights.length > 0
      ? [t("digestHighlights"), ...highlights.map((h) => `- ${h}`), ""]
      : []),
    t("digestNewSubmissions"),
    ...items.map(
      (item) =>
        `- ${item.senderName ?? t("notificationUnknownSender")} (${formatDate(effectiveLocale, item.receivedAt, SHORT_DATE)} ${formatTime(effectiveLocale, item.receivedAt)}): ${item.snippet}`
    ),
    "",
    `${t("textViewInbox")} ${inboxUrl}`,
  ]
  return lines.join("\n")
}

export function Digest({
  formName,
  count,
  summary,
  highlights,
  items,
  inboxUrl,
  accentColor,
  footerText,
  locale,
}: Props) {
  const effectiveLocale = locale ?? "en"
  const t = getEmailTranslator(effectiveLocale)
  const heading = digestHeading(effectiveLocale, count, formName)
  return (
    <EmailLayout
      preview={heading}
      accentColor={accentColor}
      footerText={footerText}
      locale={locale}
    >
      <Heading
        as="h2"
        style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 8px" }}
      >
        {heading}
      </Heading>
      <Text style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 16px" }}>
        {summary}
      </Text>
      {highlights.length > 0 && (
        <Section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            padding: "12px 16px",
            margin: "0 0 16px",
          }}
        >
          <Text
            style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 8px" }}
          >
            {t("digestHighlights")}
          </Text>
          {highlights.map((highlight) => (
            <Text
              key={highlight}
              style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 4px" }}
            >
              • {highlight}
            </Text>
          ))}
        </Section>
      )}
      <Section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "8px",
          padding: "12px 16px",
          margin: "0 0 16px",
        }}
      >
        {items.map((item) => (
          <Text
            key={`${item.receivedAt.toISOString()}-${item.senderName ?? "unknown"}`}
            style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 8px" }}
          >
            <strong>{item.senderName ?? t("notificationUnknownSender")}</strong>{" "}
            · {formatDate(effectiveLocale, item.receivedAt, SHORT_DATE)}{" "}
            {formatTime(effectiveLocale, item.receivedAt)}
            <br />
            {item.snippet}
          </Text>
        ))}
      </Section>
      <Button
        href={inboxUrl}
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
        {t("notificationViewInbox")}
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
      <Link
        href={inboxUrl}
        style={{ fontSize: "13px", wordBreak: "break-all" }}
      >
        {inboxUrl}
      </Link>
    </EmailLayout>
  )
}
