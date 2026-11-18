// Protocol constants shared by the server and the browser SDK — a
// single source of truth so the two sides can never drift apart.

// The hidden honeypot input the SDK renders in every enhanced form.
// Humans leave it empty; a filled value marks the submission as spam
// (see @sendcms/submissions validators + the SDK's api.ts).
export const HONEYPOT_FIELD = "_sendcms_honeypot"
