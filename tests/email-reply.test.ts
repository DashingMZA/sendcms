// Reply email rendering (Phase 12, Step 4): the real template, not a
// mock — a broken template would send a broken reply, so this pins
// the html + text output for a sample reply.
import { describe, expect, it } from "vitest"
import { notificationDeps } from "@sendcms/email"

const PROPS = {
  formName: "Contact us",
  body: "Hi Ali,\n\nThanks for writing. Your order is on its way.\n\nBest,\nThe team",
  accentColor: "#0891b2",
  footerText: "You're receiving this because you messaged us on Contact us.",
}

describe("renderReply", () => {
  it("renders the owner's body in html and text", async () => {
    const { html, text } = await notificationDeps.renderReply(PROPS)
    expect(html).toContain("Re: your message on Contact us")
    expect(html).toContain("Thanks for writing.")
    expect(html).toContain("Your order is on its way.")
    expect(text).toBe(PROPS.body)
  })
})
