import { PageHeader } from "@/components/dashboard/page-header"
import { NewFormForm } from "./new-form-form"

export default function NewFormPage() {
  return (
    <div>
      <PageHeader
        title="New form"
        description="Create a contact form for your sites"
      />

      <div className="p-4 sm:p-6">
        <NewFormForm />
      </div>
    </div>
  )
}
