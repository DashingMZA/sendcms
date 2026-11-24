import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Page not found — SendCMS API",
  description: "The page you're looking for doesn't exist or was moved.",
  // Error page — never indexed (Phase 16, PRF-034).
  robots: { index: false, follow: false },
}

// Branded 404 for the api app. The api app serves route handlers only —
// it has no Tailwind setup and no shared UI dependency — so this page is
// self-contained plain HTML plus one <style> block (no @sendcms/ui, no
// globals.css). The brand cyan is the SendCMS brand color; the api app
// has no design tokens to reference. Links are absolute and env-driven,
// never hardcoded.
function appURL(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  )
}

function dashboardURL(): string {
  return (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
  ).replace(/\/$/, "")
}

function docsURL(): string {
  return (process.env.NEXT_PUBLIC_DOCS_URL ?? "http://localhost:3003").replace(
    /\/$/,
    ""
  )
}

export default function NotFound() {
  return (
    <>
      <style>{`
        .sendcms-not-found {
          display: flex;
          min-height: 100svh;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 4rem 1rem;
          text-align: center;
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #0f172a;
          background: #ffffff;
        }
        .sendcms-not-found-code {
          margin: 0 0 0.5rem;
          font-size: 4.5rem;
          font-weight: 700;
          letter-spacing: -0.025em;
          line-height: 1;
          color: #0891b2;
        }
        .sendcms-not-found h1 {
          margin: 0 0 0.75rem;
          font-size: 1.5rem;
          font-weight: 700;
          letter-spacing: -0.025em;
        }
        .sendcms-not-found p {
          margin: 0 0 2rem;
          max-width: 28rem;
          line-height: 1.625;
          color: #64748b;
        }
        .sendcms-not-found-links {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
        }
        .sendcms-not-found-links a {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 2.5rem;
          padding: 0 1rem;
          border-radius: 0.375rem;
          border: 1px solid #e2e8f0;
          font-size: 0.875rem;
          font-weight: 500;
          text-decoration: none;
          color: #0f172a;
          background: #ffffff;
        }
        .sendcms-not-found-links a.sendcms-not-found-primary {
          border-color: #0891b2;
          color: #ffffff;
          background: #0891b2;
        }
      `}</style>
      <main className="sendcms-not-found">
        <p className="sendcms-not-found-code">404</p>
        <h1>Page not found</h1>
        <p>
          The page you&apos;re looking for doesn&apos;t exist or was moved. This
          is the SendCMS API — the app lives on the dashboard.
        </p>
        <div className="sendcms-not-found-links">
          <a className="sendcms-not-found-primary" href={dashboardURL()}>
            Go to dashboard
          </a>
          <a href={appURL()}>SendCMS home</a>
          <a href={docsURL()}>Read the docs</a>
        </div>
      </main>
    </>
  )
}
