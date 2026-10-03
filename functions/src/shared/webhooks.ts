/**
 * The pure, dependency-free core of the four Twilio webhooks, shared by the Cloud
 * Functions (functions/src/twilio.ts) and the Cloudflare Worker (worker/) so the
 * two implementations can't drift while both serve traffic — see
 * docs/edge-hardening-plan.md §14 and AGENTS.md. No Node or Workers APIs here:
 * only plain TypeScript that both runtimes can bundle.
 *
 * The TwiML builders produce byte-for-byte the same documents as the twilio npm
 * package's VoiceResponse/MessagingResponse (asserted in shared/webhooks.test.ts).
 */

/** The webhook routes, named after the original Cloud Functions; also the URL paths. */
export const WEBHOOK_PATHS = {
    incomingCall: 'twilioIncomingCall',
    outgoingCall: 'twilioOutgoingCall',
    callStatusChanges: 'twilioCallStatusChanges',
    incomingMessage: 'twilioIncomingMessage',
} as const;

/**
 * Voice SDK client identity for a tenant. Each user brings their own Twilio
 * account, so the account SID uniquely and stably identifies the tenant (across
 * devices and logins). Twilio sends this same AccountSid on inbound-call
 * webhooks, so the incoming-call TwiML can route to the matching <Client> with no
 * extra lookup.
 */
export function clientIdentity(accountSid: string): string {
    return accountSid;
}

/** RTDB paths the webhooks read/write, relative to the database root. */
export const dbPaths = {
    authToken: (accountSid: string) => `/twilio/${accountSid}/secret/authToken`,
    createdAt: (accountSid: string) => `/twilio/${accountSid}/createdAt`,
    messagingTokens: (accountSid: string) => `/twilio/${accountSid}/messaging-tokens`,
    messagingToken: (accountSid: string, fcmToken: string) => `/twilio/${accountSid}/messaging-tokens/${fcmToken}`,
};

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
        .replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}

/**
 * TwiML for an inbound PSTN call: ring the tenant's registered app (Voice SDK
 * client). Always — inbound calls are deliberately NOT gated on the trial or a
 * subscription. The webhook only knows the line (every device shares the
 * AccountSid identity) while paid subscriptions belong to a person, so any gate
 * here would either silence paying users or let one customer pay for the whole
 * line. Entitlement is enforced where the person is known: twilioAccessToken
 * (outgoing calls, and registering a device for incoming calls).
 */
export function incomingCallTwiml(accountSid: string): string {
    return `${XML_DECLARATION}<Response><Dial><Client>${escapeText(clientIdentity(accountSid))}</Client></Dial></Response>`;
}

/**
 * TwiML for an outgoing call placed by the SDK. The twilio_voice plugin sends
 * `From` (the account's number, used as caller ID) and `To` (the destination);
 * dial the destination with the account number as caller ID.
 */
export function outgoingCallTwiml(to: string | undefined, callerId: string | undefined): string {
    if (!to) {
        return `${XML_DECLARATION}<Response><Say>No destination number was provided.</Say></Response>`;
    }
    const callerIdAttribute = callerId === undefined ? '' : ` callerId="${escapeAttribute(callerId)}"`;
    return `${XML_DECLARATION}<Response><Dial${callerIdAttribute}>${escapeText(to)}</Dial></Response>`;
}

/** Empty MessagingResponse: an inbound SMS is acknowledged without replying to the sender. */
export function emptyMessagingTwiml(): string {
    return `${XML_DECLARATION}<Response/>`;
}

/**
 * Data payload of the silent push sent to each of a tenant's devices for an
 * inbound SMS/MMS. accountSid rides along so a device in vacation mode can
 * recognize its own tenant and skip displaying the notification.
 */
export function incomingMessagePushData(fields: {
    accountSid: string; from: string; to: string; body: string; messageSid: string;
}): Record<string, string> {
    return { dialcrest_type: 'incoming_message', ...fields };
}
