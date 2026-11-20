import { Button, Heading, Link, Section, Text } from "react-email"
import { EmailLayout } from "./layout"
import type { DigestProps } from "../notification-types"

type Props = DigestProps

/** Plain-text fallback for the digest (Resend/SMTP `text` part). */
export function digestText({
  formName,
  count,
  summary,
  highlights,
  items,
  inboxUrl,
}: Omit<Props, "accentColor" | "footerText">): string {
  const lines = [
    `${count} new submission${count === 1 ? "" : "s"} on ${formName}`,
    "",
    summary,
    "",
    ...(highlights.length > 0
      ? ["Highlights:", ...highlights.map((h) => `- ${h}`), ""]
      : []),
    "New submissions:",
    ...items.map(
      (item) =>
        `- ${item.senderName ?? "Unknown"} (${item.receivedAt.toISOString()}): ${item.snippet}`
    ),
    "",
    `View in your inbox: ${inboxUrl}`,
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
}: Props) {
  return (
    <EmailLayout
      preview={`${count} new submission${count === 1 ? "" : "s"} on ${formName}`}
      accentColor={accentColor}
      footerText={footerText}
    >
      <Heading
        as="h2"
        style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 8px" }}
      >
        {count} new submission{count === 1 ? "" : "s"} on {formName}
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
            Highlights
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
            <strong>{item.senderName ?? "Unknown"}</strong> ·{" "}
            {item.receivedAt.toISOString()}
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
