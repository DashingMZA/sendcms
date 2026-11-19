import { Button, Heading, Link, Section, Text } from "react-email"
import { EmailLayout } from "./layout"
import type { SubmissionNotificationProps } from "../notification-types"

type Props = SubmissionNotificationProps

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
}: Omit<Props, "accentColor" | "footerText">): string {
  const lines = [
    `New submission on ${formName}`,
    "",
    `From: ${senderName ?? "Unknown"}${senderEmail ? ` <${senderEmail}>` : ""}`,
    `Received: ${receivedAt.toISOString()}`,
    `Origin: ${originDomain}`,
    ...(pageUrl ? [`Page: ${pageUrl}`] : []),
    "",
    ...fields.map((field) => `${field.label}: ${field.value}`),
    "",
    `View in your inbox: ${inboxUrl}`,
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
}: Props) {
  return (
    <EmailLayout
      preview={`New submission on ${formName}`}
      accentColor={accentColor}
      footerText={footerText}
    >
      <Heading
        as="h2"
        style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 8px" }}
      >
        New submission on {formName}
      </Heading>
      <Text style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 4px" }}>
        From: {senderName ?? "Unknown"}
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
        Received {receivedAt.toISOString()} · {originDomain}
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
          <Text style={{ fontSize: "14px", margin: 0 }}>No field values.</Text>
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
        View in inbox
      </Button>
      <Text
        style={{
          color: "#6b7280",
          fontSize: "13px",
          lineHeight: "1.6",
          margin: "16px 0 4px",
        }}
      >
        If the button doesn&apos;t work, paste this link into your browser:
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
