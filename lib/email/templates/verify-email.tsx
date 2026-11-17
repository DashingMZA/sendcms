import { Button, Link, Text } from "react-email"
import { EmailLayout } from "./layout"

type Props = {
  userName: string
  url: string
  accentColor: string
  footerText: string
}

export function VerifyEmail({ userName, url, accentColor, footerText }: Props) {
  return (
    <EmailLayout
      preview="Verify your SendCMS email address"
      accentColor={accentColor}
      footerText={footerText}
    >
      <Text style={{ fontSize: "16px", fontWeight: 600, margin: "0 0 12px" }}>
        Hi {userName},
      </Text>
      <Text style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 16px" }}>
        Click the button below to verify your email address and activate your
        SendCMS account. The link expires in 24 hours.
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
        Verify email address
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
