// The marketing app's URL — the changelog page's "home" links point
// back at the public site, which lives in the marketing app.
export function marketingUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  )
}
