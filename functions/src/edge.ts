import { defineBoolean, defineString } from 'firebase-functions/params';

/**
 * Webhook host configuration, see docs/edge-hardening-plan.md. The Twilio
 * webhooks are moving from these Cloud Functions to a Cloudflare Worker on
 * EDGE_BASE_URL; WEBHOOK_PUBLIC_BASE_URL decides which of the two gets written
 * into newly configured Twilio resources. Existing tenants are moved by
 * scripts/backfillWebhooks.ts.
 *
 * NOTE: a param's `default` is only applied by the CLI at deploy time; at runtime
 * `.value()` is just process.env (empty when unset, e.g. in tests). The getters
 * below therefore fall back to the same default themselves.
 */

/** Where these Cloud Functions are served — the URL Twilio signs for requests that reach them. */
export const FUNCTIONS_BASE_URL = 'https://europe-west1-twilio-phone-peblet.cloudfunctions.net';
/** The Cloudflare Worker that takes over the Twilio webhooks (docs/edge-hardening-plan.md §14). */
export const EDGE_BASE_URL = 'https://dialcrest-hooks.peblet.be';

const webhookPublicBaseUrlParam = defineString('WEBHOOK_PUBLIC_BASE_URL', {
    default: FUNCTIONS_BASE_URL,
    description: 'Base URL written into tenants\' Twilio config (TwiML Apps, numbers): the functions, or the Worker after cutover.',
});
const signatureFailClosedParam = defineBoolean('TWILIO_SIGNATURE_FAIL_CLOSED', {
    default: false,
    description: 'Reject Twilio webhooks for an AccountSid with no stored Auth Token instead of skipping the check.',
});

/** The host we write into tenants' Twilio config. */
export function webhookPublicBaseUrl(): string {
    return (webhookPublicBaseUrlParam.value() || FUNCTIONS_BASE_URL).trim().replace(/\/+$/, '');
}

/** Public URL tenants' Twilio config should use for the webhook named `path`, e.g. `twilioIncomingCall`. */
export function webhookUrl(path: string): string {
    return `${webhookPublicBaseUrl()}/${path}`;
}

/**
 * True iff `url` is the `path` webhook on any host we've ever configured — used
 * to recognize a tenant's webhook as OURS (to re-point or restore it), whichever
 * side of the cutover it's on.
 */
export function isKnownWebhookUrl(url: string | null | undefined, path: string): boolean {
    const bases = new Set([webhookPublicBaseUrl(), FUNCTIONS_BASE_URL, EDGE_BASE_URL]);
    return typeof url === 'string' && [...bases].some((base) => url === `${base}/${path}`);
}

export function isSignatureFailClosed(): boolean {
    return signatureFailClosedParam.value();
}
