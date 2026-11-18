/**
 * Build a valid From header from a display name and an address value.
 * The address may already be a full "Name <addr>" mailbox (e.g. SMTP_FROM)
 * — in that case use it verbatim. Wrapping it again
 * produces a malformed header: nodemailer serializes
 * `"SendCMS" <SendCMS <noreply@x>>` as `From: "SendCMS>" <noreply@x>`,
 * so the inbox shows "SendCMS>" as the sender name.
 */
export function formatFromAddress(
  displayName: string,
  address: string
): string {
  if (address.includes("<") && address.includes(">")) return address
  return `"${displayName}" <${address}>`
}
