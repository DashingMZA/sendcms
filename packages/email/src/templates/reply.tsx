// EML-001/030/061/090 (Phase 16, Wave 9): explicit React import —
// the standalone worker runs these templates under tsx, whose
// per-tsconfig `jsx: react-jsx` does not reach files outside the
// worker tsconfig's `include` scope, so JSX would compile to
// classic `React.createElement` calls with no React in scope.
import React from "react"
import { Heading, Text } from "react-email"
import { EmailLayout } from "./layout"
import { getEmailTranslator } from "../email-i18n"
import { truncateFieldValue } from "../truncate"
import type { ReplyProps } from "../notification-types"

type Props = ReplyProps

/** Plain-text fallback for the reply (Resend/SMTP `text` part) — the
    owner's body, as written. */
export function replyText({
  body,
}: Omit<Props, "accentColor" | "footerText">): string {
  // EML-012: the body is capped at send time (2000 at the route),
  // but the render truncates defensively anyway.
  return truncateFieldValue(body)
}

export function Reply({
  formName,
  body,
  accentColor,
  footerText,
  locale,
}: Props) {
  const t = getEmailTranslator(locale ?? "en")
  return (
    <EmailLayout
      preview={t("replyHeading", { formName })}
      accentColor={accentColor}
      footerText={footerText}
      locale={locale}
    >
      <Heading
        as="h2"
        style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 16px" }}
      >
        {t("replyHeading", { formName })}
      </Heading>
      {truncateFieldValue(body)
        .split(/\n{2,}/)
        .map((paragraph, i) => (
          <Text
            key={i}
            style={{ fontSize: "14px", lineHeight: "1.6", margin: "0 0 12px" }}
          >
            {paragraph.split("\n").map((line, j) => (
              <span key={j}>
                {line}
                {j < paragraph.split("\n").length - 1 && <br />}
              </span>
            ))}
          </Text>
        ))}
    </EmailLayout>
  )
}
