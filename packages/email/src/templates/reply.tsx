import { Heading, Text } from "react-email"
import { EmailLayout } from "./layout"
import { getEmailTranslator } from "../email-i18n"
import type { ReplyProps } from "../notification-types"

type Props = ReplyProps

/** Plain-text fallback for the reply (Resend/SMTP `text` part) — the
    owner's body, as written. */
export function replyText({
  body,
}: Omit<Props, "accentColor" | "footerText">): string {
  return body
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
      {body.split(/\n{2,}/).map((paragraph, i) => (
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
