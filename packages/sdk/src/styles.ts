// Scoped SDK styles. Every selector is prefixed with `.sc-` so the
// SDK never leaks styles into the host page, and the host page's CSS
// cannot break the status element (all properties it needs are set
// here). The host's own form inputs are intentionally NOT styled —
// they belong to the site, not to the SDK.

export const SDK_STYLES = `
.sc-status {
  display: none;
  margin-top: 0.75rem;
  padding: 0.625rem 0.875rem;
  border-radius: 0.5rem;
  font-family: inherit;
  font-size: 0.875rem;
  line-height: 1.5;
}
.sc-status--visible { display: block; }
.sc-status--sending {
  background: #f1f5f9;
  color: #334155;
}
.sc-status--success {
  background: #dcfce7;
  color: #166534;
}
.sc-status--error {
  background: #fee2e2;
  color: #991b1b;
}
.sc-honeypot {
  position: absolute !important;
  left: -9999px !important;
  top: auto !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  opacity: 0 !important;
}
`

let injected = false

/** Injects the SDK stylesheet once per page. Safe to call repeatedly. */
export function ensureStyles(): void {
  if (injected) return
  if (document.querySelector("style[data-sendcms]")) {
    injected = true
    return
  }
  const style = document.createElement("style")
  style.setAttribute("data-sendcms", "")
  style.textContent = SDK_STYLES
  document.head.appendChild(style)
  injected = true
}
