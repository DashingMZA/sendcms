"use client"

import { useState } from "react"
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { ApiClientError } from "@sendcms/shared"

function errorMessage(error: unknown): string {
  return error instanceof ApiClientError
    ? error.message
    : "Something went wrong"
}

// Same defaults as the dashboard's query provider: one retry, and a
// global sonner toast on any query/mutation error unless the call site
// passes `meta: { silent: true }`.
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1 },
        },
        queryCache: new QueryCache({
          onError: (error, query) => {
            if (query.meta?.silent) return
            toast.error(errorMessage(error))
          },
        }),
        mutationCache: new MutationCache({
          onError: (error, _vars, _ctx, mutation) => {
            if (mutation.meta?.silent) return
            toast.error(errorMessage(error))
          },
        }),
      })
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
