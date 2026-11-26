import type { ReactNode } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sendcms/ui"

// One section shell for the form-detail page (Wave 10, UX-101): every
// section is a shared Card — title + description in the header, body in
// the content. Section titles are CardTitle (text-base); the form name
// in the header card is the one text-lg heading (UX-107). The danger
// zone uses tone="destructive".
export function FormSection({
  title,
  description,
  tone,
  children,
}: {
  title: string
  description?: string
  tone?: "destructive"
  children: ReactNode
}) {
  return (
    <Card
      className={tone === "destructive" ? "border-destructive/50" : undefined}
    >
      <CardHeader>
        <CardTitle
          className={tone === "destructive" ? "text-destructive" : undefined}
        >
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
