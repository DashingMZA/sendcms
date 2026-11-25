import { Button, Heading, Link, Section, Text } from "react-email"
import { formatDate, formatTime } from "@sendcms/i18n"
import { EmailLayout } from "./layout"
import { getEmailTranslator } from "../email-i18n"
import type { SubmissionNotificationProps } from "../notification-types"

type Props = SubmissionNotificationProps

const SHORT_DATE: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
}

/** Plain-text fallback for the notification (Resend/SMTP `text` part). */
export function submissionNotificationText({
  formName,
  senderName,
  senderEmail,
  fields,
  pageUrl,
  originDomain,
  receivedAt,
  inboxUrl,
  locale,
}: Omit<Props, "accentColor" | "footerText">): string {
  const effectiveLocale = locale ?? "en"
  const t = getEmailTranslator(effectiveLocale)
  const received = `${formatDate(effectiveLocale, receivedAt, SHORT_DATE)} ${formatTime(effectiveLocale, receivedAt)}`
  const lines = [
    t("notificationHeading", { formName }),
    "",
    `${t("textFrom")} ${senderName ?? t("notificationUnknownSender")}${senderEmail ? ` <${senderEmail}>` : ""}`,
    `${t("textReceived")} ${received}`,
    `${t("textOrigin")} ${originDomain}`,
    ...(pageUrl ? [`${t("textPage")} ${pageUrl}`] : []),
    "",
    ...fields.map((field) => `${field.label}: ${field.value}`),
    "",
    `${t("textViewInbox")} ${inboxUrl}`,
  ]
  return lines.join("\n")
}

export function SubmissionNotification({
  formName,
  senderName,
  senderEmail,
  fields,
  pageUrl,
  originDomain,
  receivedAt,
  inboxUrl,
  accentColor,
  footerText,
  locale,
}: Props) {
  const effectiveLocale = locale ?? "en"
  const t = getEmailTranslator(effectiveLocale)
  const received = `${formatDate(effectiveLocale, receivedAt, SHORT_DATE)} ${formatTime(effectiveLocale, receivedAt)}`
  return (
    <EmailLayout
      preview={t("notificationHeading", { formName })}
      accentColor={accentColor}
      footerText={footerText}
      locale={locale}
    >
      <Heading
        as="h2"
        style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 8px" }}
      >
        {t("notificationHeading", { formName })}
      </Heading>
      <Text style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 4px" }}>
        {t("textFrom")} {senderName ?? t("notificationUnknownSender")}
        {senderEmail ? ` <${senderEmail}>` : ""}
      </Text>
      <Text
        style={{
          color: "#6b7280",
          fontSize: "13px",
          lineHeight: "1.6",
          margin: "0 0 16px",
        }}
      >
        {t("notificationReceived", { date: received, domain: originDomain })}
        {pageUrl ? ` · ${pageUrl}` : ""}
      </Text>
      <Section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "8px",
          padding: "12px 16px",
          margin: "0 0 16px",
        }}
      >
        {fields.map((field) => (
          <Text
            key={field.label}
            style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 8px" }}
          >
            <strong>{field.label}:</strong> {field.value}
          </Text>
        ))}
        {fields.length === 0 && (
          <Text style={{ fontSize: "14px", margin: 0 }}>
            {t("notificationNoFields")}
          </Text>
        )}
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
