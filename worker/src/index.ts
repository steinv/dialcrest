import {
    ACCOUNT_SID,
    DeviceRecord,
    StoredAuthTokens,
    WEBHOOK_PATHS,
    dbPaths,
    emptyMessagingTwiml,
    entitledDevices,
    incomingCallIdentities,
    incomingCallTwiml,
    incomingMessagePushData,
    incomingMessageTargets,
    outgoingCallTwiml,
    subscriptionsToCheck,
    webhookSigningTokens,
} from '../../functions/src/shared/webhooks';
import { FirebaseConfig, rtdbDelete, rtdbGet, sendDataMessage } from './firebase';
import { isTransient, parseServiceAccount } from './google';
import { isValidTwilioSignature } from './twilioSignature';

/**
 * The four Twilio webhooks, served on dialcrest-hooks.peblet.be — the Worker
 * port of callbackIncomingCall / callbackOutgoingCall / callbackCallStatusChanges
 * / callbackIncomingMessage in functions/src/twilio.ts (docs/edge-hardening-plan.md
 * §14). Behavior must match the functions: the pure parts (TwiML, RTDB paths, push
 * payload) are imported from functions/src/shared/webhooks.ts rather than copied.
 */

export interface Env {
    PUBLIC_BASE_URL: string;
    FIREBASE_PROJECT_ID: string;
    FIREBASE_DATABASE_URL: string;
    TWILIO_SIGNATURE_FAIL_CLOSED?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON: string;
}

type Route = typeof WEBHOOK_PATHS[keyof typeof WEBHOOK_PATHS];
const ROUTES = new Set<string>(Object.values(WEBHOOK_PATHS));

/**
 * Short-lived per-isolate cache of tenants' Auth Tokens — same policy as the
 * functions' authTokenCache: only tokens the DB actually returned are cached,
 * and the TTL bounds how long a rotated token keeps being used.
 */
const AUTH_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const authTokenCache = new Map<string, { tokens: string[]; expires: number }>();

/** Test-only: drop every cached Auth Token. */
export function resetAuthTokenCacheForTests(): void {
    authTokenCache.clear();
}

function firebaseConfig(env: Env): FirebaseConfig {
    return {
        account: parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON),
        databaseUrl: env.FIREBASE_DATABASE_URL,
        projectId: env.FIREBASE_PROJECT_ID,
    };
}

function xml(body: string): Response {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/xml' } });
}

function text(status: number, body: string): Response {
    return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * True iff the webhook may proceed — the Worker twin of the functions'
 * isValidTwilioSignature. Validates against the static PUBLIC_BASE_URL/<path>
 * (what Twilio was configured to call), never the request's own URL/Host.
 *
 * No stored token: allowed (grace period) unless TWILIO_SIGNATURE_FAIL_CLOSED is
 * "true", logged as event twilio_webhook_tokenless with whether the SID is a
 * known tenant. A token read that fails transiently (RTDB/Google 5xx, network)
 * is allowed too: outsiders can't cause one, and an outage shouldn't drop calls.
 * Any other failure — a revoked key, a missing IAM role — is a misconfiguration
 * and propagates (500): failing open there would silently disable authentication.
 */
async function authenticate(env: Env, firebase: FirebaseConfig, route: Route, accountSid: string, request: Request, params: URLSearchParams) {
    const cached = authTokenCache.get(accountSid);
    let tokens = cached && cached.expires > Date.now() ? cached.tokens : null;
    if (tokens === null) {
        try {
            tokens = webhookSigningTokens(await rtdbGet<StoredAuthTokens>(firebase, dbPaths.secret(accountSid)));
        } catch (error) {
            if (!isTransient(error)) throw error;
            console.error({ event: 'twilio_webhook_token_read_failed', accountSid, path: route, error: String(error) });
            return true;
        }
        if (tokens.length === 0) {
            return allowTokenless(env, firebase, route, accountSid);
        }
        authTokenCache.set(accountSid, { tokens, expires: Date.now() + AUTH_TOKEN_CACHE_TTL_MS });
    }
    const signature = request.headers.get('X-Twilio-Signature');
    if (!signature) return false;
    const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/${route}`;
    // Either stored token: Twilio signs with the primary while the app may have
    // presented (and the backend stored) the secondary during a rotation.
    for (const token of tokens) {
        if (await isValidTwilioSignature(token, signature, url, params)) return true;
    }
    return false;
}

async function allowTokenless(env: Env, firebase: FirebaseConfig, route: Route, accountSid: string): Promise<boolean> {
    const failClosed = env.TWILIO_SIGNATURE_FAIL_CLOSED === 'true';
    let knownTenant: boolean | null = null;
    try {
        knownTenant = (await rtdbGet<number>(firebase, dbPaths.createdAt(accountSid))) !== null;
    } catch {
        // Diagnostic only; never let it change the outcome.
    }
    console.warn({
        event: 'twilio_webhook_tokenless',
        accountSid,
        path: route,
        knownTenant,
        outcome: failClosed ? 'rejected' : 'allowed',
    });
    return !failClosed;
}

/**
 * Who an inbound call/SMS may reach — the Worker twin of readEntitledDevices in
 * functions/src/twilio.ts, using the same shared rules: the device registry and
 * the line's license override, then (only when it isn't live) each subscription record
 * a device points at. Devices whose own user isn't entitled are left out, so an
 * unsubscribed co-user on a shared line isn't rung/notified.
 */
async function readEntitledDevices(firebase: FirebaseConfig, accountSid: string, now: number) {
    const [devices, licenseOverride] = await Promise.all([
        rtdbGet<Record<string, DeviceRecord>>(firebase, dbPaths.devices(accountSid)),
        rtdbGet<number>(firebase, dbPaths.licenseOverride(accountSid)),
    ]);
    const paths = subscriptionsToCheck(devices, licenseOverride, now);
    const expiries = await Promise.all(paths.map((path) => rtdbGet<number>(firebase, dbPaths.subscriptionExpiresAt(path))));
    const subscriptionExpiries = Object.fromEntries(paths.map((path, i) => [path, expiries[i]]));
    return { licenseOverride, entitled: entitledDevices(devices, licenseOverride, subscriptionExpiries, now) };
}

/** Inbound SMS/MMS: data-only push to each entitled device, dropping tokens FCM no longer knows. */
async function incomingMessage(firebase: FirebaseConfig, accountSid: string, params: URLSearchParams): Promise<Response> {
    const now = Date.now();
    const [{ licenseOverride, entitled }, legacyTokens] = await Promise.all([
        readEntitledDevices(firebase, accountSid, now),
        rtdbGet<Record<string, unknown>>(firebase, dbPaths.messagingTokens(accountSid)),
    ]);
    const targets = incomingMessageTargets(accountSid, entitled, legacyTokens, licenseOverride, now);
    const data = incomingMessagePushData({
        accountSid,
        from: params.get('From') ?? '',
        to: params.get('To') ?? '',
        body: params.get('Body') ?? '',
        messageSid: params.get('MessageSid') ?? '',
    });
    const results = await Promise.allSettled(targets.map(({ fcmToken }) => sendDataMessage(firebase, fcmToken, data)));
    await Promise.allSettled(results.map((result, i) => result.status === 'fulfilled' && result.value === 'unregistered' ?
        rtdbDelete(firebase, targets[i].removePath) :
        Promise.resolve()));
    return xml(emptyMessagingTwiml());
}

async function handle(request: Request, env: Env): Promise<Response> {
    const route = new URL(request.url).pathname.slice(1);
    if (!ROUTES.has(route)) return text(404, 'Not found');
    if (request.method !== 'POST') return text(405, 'Method not allowed');

    const params = new URLSearchParams(await request.text());
    const accountSid = params.get('AccountSid') ?? '';
    if (!ACCOUNT_SID.test(accountSid)) return text(403, 'Invalid Twilio signature');

    const firebase = firebaseConfig(env);
    const typedRoute = route as Route;

    // Who an inbound call rings doesn't depend on the signature check, so those
    // reads run in parallel with it — they're in the caller's dead air. This is
    // the one sanctioned exception to "authenticate before any work" (AGENTS.md):
    // read-only lookups for a well-formed AccountSid, whose results are used only
    // after the signature validates; nothing is written or sent before that.
    // Never awaited when the check fails; the catch keeps that from being unhandled.
    const now = Date.now();
    const callTargets = typedRoute === WEBHOOK_PATHS.incomingCall ? readEntitledDevices(firebase, accountSid, now) : null;
    callTargets?.catch(() => undefined);

    if (!await authenticate(env, firebase, typedRoute, accountSid, request, params)) {
        console.warn({ event: 'twilio_webhook_rejected', path: route, accountSid });
        return text(403, 'Invalid Twilio signature');
    }

    switch (typedRoute) {
    case WEBHOOK_PATHS.incomingCall: {
        // Rings only devices whose own user is entitled (see incomingCallIdentities).
        const { licenseOverride, entitled } = await (callTargets as ReturnType<typeof readEntitledDevices>);
        return xml(incomingCallTwiml(incomingCallIdentities(accountSid, entitled, licenseOverride, now)));
    }
    case WEBHOOK_PATHS.outgoingCall:
        return xml(outgoingCallTwiml(params.get('To') ?? undefined, params.get('From') ?? undefined));
    case WEBHOOK_PATHS.callStatusChanges:
        console.log({ event: 'twilio_call_status', ...Object.fromEntries(params) });
        return new Response(null, { status: 202 });
    case WEBHOOK_PATHS.incomingMessage:
        return incomingMessage(firebase, accountSid, params);
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            return await handle(request, env);
        } catch (error) {
            // 5xx makes Twilio fall back / retry, as with an erroring function.
            console.error({ event: 'webhook_error', url: request.url, error: String(error) });
            return text(500, 'Internal error');
        }
    },
} satisfies ExportedHandler<Env>;
