import {
    WEBHOOK_PATHS,
    dbPaths,
    emptyMessagingTwiml,
    incomingCallTwiml,
    incomingMessagePushData,
    outgoingCallTwiml,
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
 * A Twilio AccountSid: "AC" + 32 lowercase hex. Checked before the SID is used in
 * an RTDB path, so a crafted value can't walk to another node.
 */
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

/**
 * Short-lived per-isolate cache of tenants' Auth Tokens — same policy as the
 * functions' authTokenCache: only tokens the DB actually returned are cached,
 * and the TTL bounds how long a rotated token keeps being used.
 */
const AUTH_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const authTokenCache = new Map<string, { authToken: string; expires: number }>();

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
    let authToken = cached && cached.expires > Date.now() ? cached.authToken : null;
    if (authToken === null) {
        try {
            authToken = await rtdbGet<string>(firebase, dbPaths.authToken(accountSid));
        } catch (error) {
            if (!isTransient(error)) throw error;
            console.error({ event: 'twilio_webhook_token_read_failed', accountSid, path: route, error: String(error) });
            return true;
        }
        if (!authToken) {
            return allowTokenless(env, firebase, route, accountSid);
        }
        authTokenCache.set(accountSid, { authToken, expires: Date.now() + AUTH_TOKEN_CACHE_TTL_MS });
    }
    const signature = request.headers.get('X-Twilio-Signature');
    if (!signature) return false;
    const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/${route}`;
    return isValidTwilioSignature(authToken, signature, url, params);
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

/** Inbound SMS/MMS: data-only push to each of the tenant's devices, dropping tokens FCM no longer knows. */
async function incomingMessage(firebase: FirebaseConfig, accountSid: string, params: URLSearchParams): Promise<Response> {
    const tokens = Object.keys((await rtdbGet<Record<string, boolean>>(firebase, dbPaths.messagingTokens(accountSid))) ?? {});
    const data = incomingMessagePushData({
        accountSid,
        from: params.get('From') ?? '',
        to: params.get('To') ?? '',
        body: params.get('Body') ?? '',
        messageSid: params.get('MessageSid') ?? '',
    });
    const results = await Promise.allSettled(tokens.map((token) => sendDataMessage(firebase, token, data)));
    await Promise.allSettled(results.map((result, i) => result.status === 'fulfilled' && result.value === 'unregistered' ?
        rtdbDelete(firebase, dbPaths.messagingToken(accountSid, tokens[i])) :
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

    if (!await authenticate(env, firebase, typedRoute, accountSid, request, params)) {
        console.warn({ event: 'twilio_webhook_rejected', path: route, accountSid });
        return text(403, 'Invalid Twilio signature');
    }

    switch (typedRoute) {
    case WEBHOOK_PATHS.incomingCall:
        // Always rings — inbound calls aren't entitlement-gated (see incomingCallTwiml).
        return xml(incomingCallTwiml(accountSid));
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
