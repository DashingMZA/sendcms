export {
  BILLING_PROVIDERS,
  BILLING_PROVIDER_IDS,
  assertPayPalMode,
  assertPolarEnvironment,
  assertStripeKeyMode,
  expectedStripeMode,
  getBillingProviderDefinition,
  isProviderConfigured,
  missingEnvVars,
  paypalMode,
  polarEnvironment,
  stripeKeyModeMismatch,
  stripeSecretKeyMode,
} from "./registry"
export type {
  BillingProviderDefinition,
  BillingProviderId,
  PayPalMode,
  PolarEnvironment,
  StripeKeyMode,
} from "./registry"
export {
  createBillingPortalSession,
  createCheckoutSession,
  handleWebhook,
  listBillingEvents,
  listCheckoutAttempts,
  listCountries,
  listEnabledProviders,
  listMyBillingEvents,
  listProviderConfigs,
  listPublicCountries,
  reconcileCheckout,
  requireBillingAdmin,
  setProviderConfig,
  verifyCheckoutReturn,
} from "./service"
// SRC-110: the dashboard billing page server-fetches the caller's
// subscription instead of waiting on the client query. The read lives
// in @sendcms/plans; the billing module re-exports it so the
// dashboard keeps a single billing facade (it does not depend on
// @sendcms/plans directly).
export { getMySubscription } from "@sendcms/plans"
export type {
  BillingEventRow,
  BillingProviderConfigRow,
  CheckoutAttemptRow,
  CheckoutReturnVerification,
  EnabledBillingProvider,
} from "./service"
export { getFreemiusPlanMapCount } from "./providers"
// BIL-022: test/reset hook for the module-scope PayPal token cache
// (same reset*Cache precedent as @sendcms/plans / @sendcms/security).
export { resetPayPalTokenCache } from "./providers/paypal"
// BIL-001 / BIL-082 / BIL-089: the provider-side cancel + plan-change
// dispatchers — the api routes pass them into the plans service so
// provider-billed subscriptions are actually canceled / re-priced at
// the provider, not only in SendCMS.
export {
  cancelSubscriptionAtProvider,
  updateSubscriptionAtProvider,
} from "./providers"
export {
  getPaymentDetail,
  getPaymentStats,
  listPayments,
  PAYMENT_EVENT_KINDS,
  refundPayment,
} from "./payments"
export type {
  PaymentDetail,
  PaymentEventKind,
  PaymentKind,
  PaymentRefundResult,
  PaymentRow,
  PaymentStats,
  PaymentStatsBucket,
  PaymentStatus,
  PaymentTab,
  PaymentsPage,
} from "./payments"
export { countryFromHeaders } from "./geo"
export {
  checkoutSessionSchema,
  BillingEventsQuerySchema,
  CheckoutAttemptsQuerySchema,
  PaymentsQuerySchema,
  RefundPaymentSchema,
  reconcileCheckoutSchema,
  setProviderConfigBodySchema,
  setProviderConfigSchema,
} from "./validators"
export type {
  BillingEventsQuery,
  CheckoutAttemptsQuery,
  CheckoutSessionInput,
  PaymentsQuery,
  ReconcileCheckoutInput,
  RefundPaymentInput,
  SetProviderConfigBodyInput,
  SetProviderConfigInput,
} from "./validators"
export {
  useBillingCountries,
  useBillingEvents,
  useBillingProviders,
  useCancelMySubscription,
  useEnabledBillingProviders,
  useMyBillingEvents,
  useMySubscription,
  useMyUsage,
  usePaymentDetail,
  useRefundPayment,
  useSubscribeFreePlan,
} from "./queries"
export type { BillingEventsFilters, BillingEventsPage } from "./queries"
