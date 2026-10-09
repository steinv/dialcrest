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
 * LEGACY Voice SDK client identity: the bare AccountSid, shared by every device
 * on the line. Tokens minted before per-device identities were registered under
 * it; the incoming-call TwiML still dials it while the line's license override is
 * live (see incomingCallIdentities).
 */
export function clientIdentity(accountSid: string): string {
    return accountSid;
}

/**
 * Per-device Voice SDK identity: `<AccountSid>_<uid>`, uid being the device's
 * anonymous Firebase Auth uid. A distinct identity per device is what lets the
 * incoming-call TwiML ring only the devices whose OWN user is entitled — with one
 * shared identity, Twilio rings every device on the line or none. Twilio client
 * identities allow letters, digits and underscores.
 */
export function deviceIdentity(accountSid: string, uid: string): string {
    return `${accountSid}_${uid}`;
}

/**
 * A Twilio AccountSid: "AC" + 32 lowercase hex. Checked before the SID is used in
 * an RTDB path: a crafted value (e.g. containing '.', '/', '#') could otherwise
 * address another node, or make the lookup throw — which the webhooks' read-error
 * path would treat as "allow".
 */
export const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

/** Anonymous Firebase uids are alphanumeric; anything else is refused (it becomes an identity and an RTDB key). */
export const DEVICE_UID = /^[A-Za-z0-9]{1,128}$/;

/** RTDB paths the webhooks read/write, relative to the database root. */
export const dbPaths = {
    authToken: (accountSid: string) => `/twilio/${accountSid}/secret/authToken`,
    /**
     * The tenant's stored Auth Tokens ({ authToken, previousAuthToken? }): the latest
     * verified one, plus the one it replaced — Twilio signs webhooks with the
     * account's PRIMARY token while the app may be presenting the secondary during
     * a rotation, so webhooks accept a signature under either (StoredAuthTokens).
     */
    secret: (accountSid: string) => `/twilio/${accountSid}/secret`,
    createdAt: (accountSid: string) => `/twilio/${accountSid}/createdAt`,
    /**
     * The line's license override: an epoch-ms timestamp, set by hand (Firebase
     * console) to license every device on the account until then — for ourselves,
     * trusted partners and the store review accounts. Absent for everyone else.
     */
    licenseOverride: (accountSid: string) => `/twilio/${accountSid}/licenseOverride`,
    /** Per-device registry (DeviceRecord), keyed by the device's Firebase uid. Server-only. */
    devices: (accountSid: string) => `/twilio/${accountSid}/devices`,
    device: (accountSid: string, uid: string) => `/twilio/${accountSid}/devices/${uid}`,
    /** `subscription` pointers are record paths without a leading slash, e.g. `subscriptions/apple/123`. */
    subscriptionExpiresAt: (recordPath: string) => `/${recordPath}/expiresAt`,
    /** LEGACY SMS-push registry (fcmToken → true) from before the per-device registry. */
    messagingTokens: (accountSid: string) => `/twilio/${accountSid}/messaging-tokens`,
    messagingToken: (accountSid: string, fcmToken: string) => `/twilio/${accountSid}/messaging-tokens/${fcmToken}`,
};

/** The /twilio/{sid}/secret node. */
export interface StoredAuthTokens {
    authToken?: string | null;
    previousAuthToken?: string | null;
}

/** The distinct, non-empty Auth Tokens a webhook signature may validate against (latest first). */
export function webhookSigningTokens(secret: StoredAuthTokens | null): string[] {
    return [...new Set([secret?.authToken, secret?.previousAuthToken].filter((t): t is string => typeof t === 'string' && t !== ''))];
}

// ---------------------------------------------------------------------------
// Per-device entitlement — who an inbound call rings / an inbound SMS notifies
// ---------------------------------------------------------------------------

/**
 * One device on a line, at /twilio/{sid}/devices/{uid}. Written only by the
 * backend: `subscription` by twilioAccessToken (from store-verified state),
 * `fcmToken` by twilioRegisterMessagingDevice.
 */
export interface DeviceRecord {
    /**
     * Path of the store record (/subscriptions/...) of the subscription this
     * device's user holds, or null/absent if none. A POINTER, not a copy: store
     * notifications keep the record's expiresAt current, so renewals and refunds
     * take effect without the device checking in.
     */
    subscription?: string | null;
    /** FCM registration token for incoming-SMS pushes. */
    fcmToken?: string | null;
    /** Last time this device checked in (token mint / messaging registration). */
    lastSeen?: number;
}

/** Devices not seen for this long are ignored — Twilio drops a Voice registration after a year idle too. */
export const DEVICE_STALE_MS = 365 * 24 * 60 * 60 * 1000;

/** Twilio rings at most 10 <Client>s per <Dial>. */
export const MAX_DIAL_CLIENTS = 10;

export function overrideLive(licenseOverride: number | null, now: number): boolean {
    return typeof licenseOverride === 'number' && licenseOverride > now;
}

function freshDevices(devices: Record<string, DeviceRecord> | null, now: number): Array<[string, DeviceRecord]> {
    return Object.entries(devices ?? {})
        .filter(([, record]) => typeof record?.lastSeen === 'number' && now - record.lastSeen < DEVICE_STALE_MS);
}

/**
 * The subscription records whose expiry must be read before deciding: none while
 * the line's license override is live (every device is entitled then), otherwise each
 * distinct record a fresh device points at.
 */
export function subscriptionsToCheck(
    devices: Record<string, DeviceRecord> | null, licenseOverride: number | null, now: number,
): string[] {
    if (overrideLive(licenseOverride, now)) return [];
    const paths = freshDevices(devices, now)
        .map(([, record]) => record.subscription)
        .filter((path): path is string => typeof path === 'string' && path !== '');
    return [...new Set(paths)];
}

/**
 * The devices whose user is entitled — the same OR gate twilioAccessToken applies
 * per person: the line's license override is live, or the device's own subscription
 * record (`subscriptionExpiries[path]`) hasn't expired. Most recently seen first.
 */
export function entitledDevices(
    devices: Record<string, DeviceRecord> | null,
    licenseOverride: number | null,
    subscriptionExpiries: Record<string, number | null>,
    now: number,
): Array<{ uid: string; record: DeviceRecord }> {
    const override = overrideLive(licenseOverride, now);
    return freshDevices(devices, now)
        .filter(([, record]) => {
            if (override) return true;
            const expiresAt = record.subscription ? subscriptionExpiries[record.subscription] : null;
            return typeof expiresAt === 'number' && expiresAt > now;
        })
        .sort(([, a], [, b]) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
        .map(([uid, record]) => ({ uid, record }));
}

/**
 * The <Client> identities an inbound call rings: each entitled device's own
 * identity, plus — only while the line's license override is live, when everyone is
 * entitled anyway — the legacy shared identity, so devices that haven't updated
 * yet still ring. Capped at MAX_DIAL_CLIENTS (legacy first, then most recent).
 */
export function incomingCallIdentities(
    accountSid: string, entitled: Array<{ uid: string }>, licenseOverride: number | null, now: number,
): string[] {
    const legacy = overrideLive(licenseOverride, now) ? [clientIdentity(accountSid)] : [];
    return [...legacy, ...entitled.map(({ uid }) => deviceIdentity(accountSid, uid))].slice(0, MAX_DIAL_CLIENTS);
}

/**
 * Where an inbound SMS push goes: an FCM token, and the RTDB path to delete if FCM
 * reports it unregistered — for a device, its whole record: the install is gone
 * (on Android its Voice pushes use the same token), so it shouldn't keep taking a
 * ring slot until DEVICE_STALE_MS.
 */
export interface MessagingTarget {
    fcmToken: string;
    removePath: string;
}

/**
 * The FCM tokens an inbound SMS is pushed to: each entitled device's token, plus
 * — only while the line's license override is live — the legacy messaging-tokens entries of
 * not-yet-updated apps. Deduplicated by token (a reinstall can leave the same
 * token under an old and a new uid).
 */
export function incomingMessageTargets(
    accountSid: string,
    entitled: Array<{ uid: string; record: DeviceRecord }>,
    legacyTokens: Record<string, unknown> | null,
    licenseOverride: number | null,
    now: number,
): MessagingTarget[] {
    const targets = new Map<string, MessagingTarget>();
    for (const { uid, record } of entitled) {
        if (record.fcmToken) targets.set(record.fcmToken, { fcmToken: record.fcmToken, removePath: dbPaths.device(accountSid, uid) });
    }
    if (overrideLive(licenseOverride, now)) {
        for (const fcmToken of Object.keys(legacyTokens ?? {})) {
            if (!targets.has(fcmToken)) targets.set(fcmToken, { fcmToken, removePath: dbPaths.messagingToken(accountSid, fcmToken) });
        }
    }
    return [...targets.values()];
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
        .replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}

/**
 * TwiML for an inbound PSTN call: ring the given Voice SDK client identities
 * simultaneously (incomingCallIdentities picks them: only devices whose own user
 * is entitled). With nobody to ring, announce the number as unavailable.
 */
export function incomingCallTwiml(identities: string[]): string {
    if (identities.length === 0) {
        return `${XML_DECLARATION}<Response><Say>This number is temporarily unavailable.</Say></Response>`;
    }
    const clients = identities.map((identity) => `<Client>${escapeText(identity)}</Client>`).join('');
    return `${XML_DECLARATION}<Response><Dial>${clients}</Dial></Response>`;
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
 * recognize its own tenant and skip displaying the notification. The sender
 * travels as `sender`: FCM rejects `from` as a reserved data key.
 */
export function incomingMessagePushData({ from, ...fields }: {
    accountSid: string; from: string; to: string; body: string; messageSid: string;
}): Record<string, string> {
    return { dialcrest_type: 'incoming_message', ...fields, sender: from };
}
