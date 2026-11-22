import { ApiError } from "@sendcms/shared"
import type { CheckoutArgs, CheckoutResult } from "./types"

// Gumroad is registered and toggleable, but has NO checkout.
// Gumroad offers no API to create a payment or a subscription
// (Memberships are created in the Gumroad dashboard and bought on
// Gumroad-hosted pages), no webhook signature verification, and no
// official Node SDK. Any checkout attempt must fail loudly instead
// of pretending to sell.
export async function createGumroadCheckoutSession(
  args: CheckoutArgs
): Promise<CheckoutResult> {
  throw new ApiError(
    `Checkout is not available for Gumroad: Gumroad has no API to create a payment or a subscription, so the "${args.version.planName}" plan cannot be sold through it. Create the membership in the Gumroad dashboard instead.`,
    422
  )
}
