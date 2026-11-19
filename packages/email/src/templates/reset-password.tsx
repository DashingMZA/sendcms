import { Button, Link, Text } from "react-email"
import { EmailLayout } from "./layout"

type Props = {
  userName: string
  url: string
  accentColor: string
  footerText: string
}

export function ResetPasswordEmail({
  userName,
  url,
  accentColor,
  footerText,
}: Props) {
  return (
    <EmailLayout
      preview="Reset your SendCMS password"
      accentColor={accentColor}
      footerText={footerText}
    >
      <Text style={{ fontSize: "16px", fontWeight: 600, margin: "0 0 12px" }}>
        Hi {userName},
      </Text>
      <Text style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 16px" }}>
        We received a request to reset your SendCMS password. Click the button
        below to choose a new one. The link expires in 1 hour. If you
        didn&apos;t request this, you can safely ignore this email.
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
        Reset password
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
      <Link href={url} style={{ fontSize: "13px", wordBreak: "break-all" }}>
        {url}
      </Link>
    </EmailLayout>
  )
}
