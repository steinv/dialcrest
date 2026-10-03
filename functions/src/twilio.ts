import * as express from 'express';
import twilio, { Twilio, twiml, validateRequest } from 'twilio';
import { Request } from 'firebase-functions/https';
import { catchError, forkJoin, from, map, Observable, of, switchMap } from 'rxjs';
import { CredentialInstance, CredentialPushType } from 'twilio/lib/rest/conversations/v1/credential';
import { IncomingPhoneNumberInstance } from 'twilio/lib/rest/api/v2010/account/incomingPhoneNumber';
import AccessToken, { AccessTokenOptions } from 'twilio/lib/jwt/AccessToken';
import admin from 'firebase-admin';
import { Database } from 'firebase-admin/database';
import * as logger from 'firebase-functions/logger';
import { FUNCTIONS_BASE_URL, isKnownWebhookUrl, isSignatureFailClosed, webhookPublicBaseUrl, webhookUrl } from './edge';

// Friendly names used to find/create resources in each tenant's Twilio account.
const IOS_APN_FRIENDLY_NAME = 'Dialcrest APN iOS';
const ANDROID_FCM_FRIENDLY_NAME = 'Dialcrest FCM Android';
const TWIML_APP_FRIENDLY_NAME_OUTGOING = 'Dialcrest Outgoing';
const TWIML_APP_FRIENDLY_NAME_INCOMING = 'Dialcrest Incoming';
const API_KEY_FRIENDLY_NAME = 'Dialcrest - Twilio Soft Phone';

// Webhook paths = the exported function names in index.ts. The host written into
// Twilio is config (edge.ts webhookUrl); these functions themselves always live
// at FUNCTIONS_BASE_URL/<path>.
const OUTGOING_CALL_PATH = 'twilioOutgoingCall';
const INCOMING_CALL_PATH = 'twilioIncomingCall';
const STATUS_CALLBACK_PATH = 'twilioCallStatusChanges';
const INCOMING_MESSAGE_PATH = 'twilioIncomingMessage';

/**
 * Persist a tenant's Twilio Auth Token so the inbound webhooks can validate
 * X-Twilio-Signature (see isValidTwilioSignature). Twilio signs webhooks with
 * the number-owning account's Auth Token, which we otherwise never store.
 *
 * A token is only ever written after Twilio itself has accepted it for this
 * account (an authenticated fetch of the account resource). The callables
 * enforce App Check but not account ownership, and twilioAccessToken can succeed
 * entirely from cached state without ever presenting the token to Twilio — so an
 * unproven token must not be trusted: writing it would let any caller poison
 * another tenant's stored secret (forge its webhooks, or — once
 * TWILIO_SIGNATURE_FAIL_CLOSED is on — black-hole its genuine ones). The check
 * costs a Twilio round-trip only when the token differs from the stored one (first
 * link, or a rotation); refreshing it keeps the copy self-healing across rotation.
 *
 * Written under /twilio/{accountSid}/secret, which database.rules.json keeps
 * unreadable and unwritable by clients (Admin SDK bypasses those rules).
 *
 * Best-effort and side-effect-only: an empty/blank token is refused (an empty
 * stored value would silently disable enforcement), an unchanged token skips the
 * write (this runs on the hot access-token path), and any failure — including
 * Twilio rejecting the token — is logged and swallowed so it can never break the
 * callable that carried the token.
 */
export function rememberAuthToken(accountSid: string, authToken: string): Observable<void> {
    if (typeof accountSid !== 'string' || accountSid === '' || typeof authToken !== 'string' || authToken === '') {
        console.error(`Refusing to persist a missing/empty Twilio Auth Token for account "${accountSid}"`);
        return of(undefined);
    }
    const ref = admin.database().ref(`/twilio/${accountSid}/secret/authToken`);
    return from(ref.once('value')).pipe(
        switchMap((snapshot) => snapshot.val() === authToken ?
            of(undefined) :
            from(twilio(accountSid, authToken).api.v2010.accounts(accountSid).fetch()).pipe(
                switchMap(() => from(ref.set(authToken))),
            )),
        map(() => undefined),
        catchError((error) => {
            console.error(`Failed to persist Twilio Auth Token for ${accountSid}`, error);
            return of(undefined);
        }),
    );
}

/**
 * Short-lived in-memory cache of a tenant's Auth Token, keyed by AccountSid. This
 * lives in the function instance's global scope, so it survives across warm
 * invocations and is empty again on every cold start; each instance keeps its own
 * copy and nothing is shared across instances. It exists only to keep the webhook
 * hot path off RTDB on back-to-back requests (one call fans out into an outgoing
 * TwiML fetch plus several status callbacks within seconds). We cache only a token
 * the DB actually returned — never the "no token" or read-failure cases — so a
 * tenant that links for the first time starts enforcing on its next cold read
 * rather than after this TTL. The TTL bounds staleness after an Auth Token
 * rotation: until it expires, a stale cached token makes validateRequest reject
 * genuine webhooks (403), so keep it short.
 */
const AUTH_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const authTokenCache = new Map<string, { authToken: string; expires: number }>();

function readCachedAuthToken(accountSid: string): string | null {
    const entry = authTokenCache.get(accountSid);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
        authTokenCache.delete(accountSid);
        return null;
    }
    return entry.authToken;
}

/** Test-only: drop every cached Auth Token so one case's read can't leak into the next. */
export function resetAuthTokenCacheForTests(): void {
    authTokenCache.clear();
}

/**
 * True iff an inbound webhook may proceed. Twilio computes the signature over the
 * exact URL it was configured to call plus the POST params, so we validate against
 * the static URL this function is served at (FUNCTIONS_BASE_URL/<webhookPath>;
 * these carry no query string) rather than reconstructing it from spoofable
 * request headers. A tenant already re-pointed to the Worker never reaches this
 * function, so its own URL is the only one to accept. The signing key is the tenant's
 * Auth Token, looked up by the request's AccountSid from where rememberAuthToken
 * stored it (served from authTokenCache when a recent read is still fresh).
 *
 * No stored token: by default the check is skipped, with a warning — the grace
 * period for tenants registered before validation shipped (their app stores the
 * token the next time it hits a callable). With TWILIO_SIGNATURE_FAIL_CLOSED on,
 * the request is rejected instead, so a made-up AccountSid can no longer pass
 * (§6.1a). Either way it's logged as event twilio_webhook_tokenless, with whether
 * the SID is a tenant we know, to tell when the flip is safe. Once a token IS
 * stored, enforcement is always strict: a missing header or bad signature is
 * rejected.
 *
 * Fail-open on a read error too: these webhooks sit on the call-setup hot path and
 * previously did no DB work, so a transient RTDB outage must not turn every
 * outgoing call / status callback into a 500. A failed read is treated like "no
 * stored token" — allow, with an error log — which just falls back to the
 * pre-hardening behavior for the duration of the outage. The catch is scoped to
 * the read alone so a genuine bug in validation still surfaces. This stays
 * fail-open even with TWILIO_SIGNATURE_FAIL_CLOSED on: an outside caller can't
 * induce an RTDB outage, so it isn't a bypass, and an outage shouldn't drop calls.
 *
 * A request without a usable AccountSid is rejected outright: a genuine Twilio
 * webhook always carries one, and without it there is no tenant to check.
 */
export async function isValidTwilioSignature(request: Request, webhookPath: string): Promise<boolean> {
    const accountSid = request.body?.AccountSid;
    if (typeof accountSid !== 'string' || accountSid === '') {
        return false;
    }
    let authToken = readCachedAuthToken(accountSid);
    if (authToken === null) {
        try {
            const snapshot = await admin.database().ref(`/twilio/${accountSid}/secret/authToken`).once('value');
            authToken = snapshot.val() as string | null;
        } catch (error) {
            console.error(`Allowing Twilio webhook for ${accountSid}: Auth Token read failed (signature not checked)`, error);
            return true;
        }
        if (!authToken) {
            return allowTokenlessWebhook(accountSid, webhookPath);
        }
        authTokenCache.set(accountSid, { authToken, expires: Date.now() + AUTH_TOKEN_CACHE_TTL_MS });
    }
    const signature = request.header('X-Twilio-Signature');
    if (typeof signature !== 'string') {
        return false;
    }
    return validateRequest(authToken, signature, `${FUNCTIONS_BASE_URL}/${webhookPath}`, request.body ?? {});
}

/**
 * The no-stored-Auth-Token branch of isValidTwilioSignature: allow (grace period)
 * or reject (TWILIO_SIGNATURE_FAIL_CLOSED), logging whether the SID belongs to a
 * tenant we know (has a createdAt) — residual tokenless traffic from known
 * tenants means the fail-closed flip would drop real calls; from unknown SIDs it
 * is exactly the junk the flip exists to reject.
 */
async function allowTokenlessWebhook(accountSid: string, webhookPath: string): Promise<boolean> {
    const failClosed = isSignatureFailClosed();
    let knownTenant: boolean | null = null;
    try {
        knownTenant = (await admin.database().ref(`/twilio/${accountSid}/createdAt`).once('value')).exists();
    } catch (error) {
        // Diagnostic only; never let it change the outcome.
    }
    logger.warn(`${failClosed ? 'Rejecting' : 'Allowing'} Twilio webhook for ${accountSid}: no stored Auth Token`, {
        event: 'twilio_webhook_tokenless',
        accountSid,
        path: webhookPath,
        knownTenant,
        outcome: failClosed ? 'rejected' : 'allowed',
    });
    return !failClosed;
}

/**
 * Signature guard shared by the four Twilio webhooks: validates the request and,
 * on failure, responds 403 and returns false so the handler bails before doing
 * any work. These endpoints are public and App-Check-exempt (Twilio can't send
 * an App Check token), so this signature check is their authentication.
 */
async function twilioSignatureGuard(request: Request, response: express.Response, webhookPath: string): Promise<boolean> {
    if (await isValidTwilioSignature(request, webhookPath)) {
        return true;
    }
    console.warn('Rejected Twilio webhook with an invalid signature', {
        path: webhookPath,
        accountSid: request.body?.AccountSid ?? null,
    });
    response.status(403).type('text/plain').send('Invalid Twilio signature');
    return false;
}

/**
 * Voice SDK client identity for a tenant. Each user brings their own Twilio
 * account, so the account SID uniquely and stably identifies the tenant (across
 * devices and logins). Twilio sends this same AccountSid on inbound-call
 * webhooks, so callbackIncomingCall can route to the matching <Client> with no
 * extra lookup.
 */
function clientIdentity(accountSid: string): string {
    return accountSid;
}

function twimlAppSidRef(accountSid: string, direction: 'outgoing' | 'incoming') {
    return admin.database().ref(`/twilio/${accountSid}/twiml-app-sid/${direction}`);
}

/**
 * Find (or create) one of the tenant's two TwiML Apps (outgoing/incoming) and
 * cache its SID in RTDB under /twilio/{accountSid}/twiml-app-sid/{direction}.
 * The app's voice URL points at the matching webhook; the SID is used as
 * outgoingApplicationSid in the grant (outgoing) or voiceApplicationSid on
 * each phone number (incoming).
 *
 * The cached SID is trusted without re-checking it against Twilio on every
 * call — the app is long-lived and this runs on hot paths (e.g. every voice
 * token mint). If a tenant deletes the app directly in the Twilio console the
 * cache goes stale, but that surfaces at the point of use: configureNumber's
 * update fails with error 22108 (Invalid Application SID), which clears the
 * cache (see configureSelectedNumbers). An empty cache then lands here and
 * find-or-create repoints it at a live app.
 *
 * An app found by name (rather than created) may predate a webhook host change,
 * so its voiceUrl is corrected on the way into the cache — ensureWebhooksCurrent
 * only re-points apps that are already cached.
 */
function getOrCreateTwimlApp(
    client: Twilio, accountSid: string, direction: 'outgoing' | 'incoming', friendlyName: string, voiceUrl: string,
): Observable<string> {
    const ref = twimlAppSidRef(accountSid, direction);
    return from(ref.once('value')).pipe(
        switchMap((snapshot) => {
            const cached = snapshot.val() as string | null;
            if (cached) return of(cached);
            return from(client.applications.list({ friendlyName, limit: 1 })).pipe(
                switchMap((apps) => {
                    if (apps.length === 0) return from(client.applications.create({ friendlyName, voiceUrl, voiceMethod: 'POST' }));
                    if (apps[0].voiceUrl === voiceUrl) return of(apps[0]);
                    return from(client.applications(apps[0].sid).update({ voiceUrl, voiceMethod: 'POST' }));
                }),
                switchMap((app) => from(ref.set(app.sid)).pipe(map(() => app.sid))),
            );
        }),
    );
}

/**
 * Resolve (creating if necessary) the tenant's incoming TwiML App SID. Exposed
 * so the client can tell, per number, whether its current voiceApplicationSid
 * already matches ours (i.e. whether that number is configured for this app)
 * without needing a second source of truth for "opted in".
 */
export function getIncomingAppSid(accountSid: string, authToken: string): Observable<string> {
    const client: Twilio = twilio(accountSid, authToken);
    return getOrCreateTwimlApp(client, accountSid, 'incoming', TWIML_APP_FRIENDLY_NAME_INCOMING, webhookUrl(INCOMING_CALL_PATH));
}

/**
 * Verifies that (accountSid, authToken) are valid credentials for that account,
 * then stamps the caller's Firebase uid with an `accountSid` custom claim so
 * RTDB rules can authorize per-account reads/writes (see database.rules.json).
 *
 * Ownership is proven the same way the client's validateCredentials does it —
 * fetching the account resource succeeds only with a token that authenticates as
 * THIS account — so a caller can never claim an account it doesn't hold the
 * token for. The claim is overwritten on every call, so a user switching Twilio
 * accounts on the same device just re-links the same anonymous uid.
 */
export function linkTwilioAccount(uid: string, accountSid: string, authToken: string): Observable<void> {
    const client: Twilio = twilio(accountSid, authToken);
    return from(client.api.v2010.accounts(accountSid).fetch()).pipe(
        switchMap(() => from(admin.auth().setCustomUserClaims(uid, { accountSid }))),
        map(() => undefined),
    );
}

/** The subset of a number's webhook config we overwrite, and therefore snapshot/restore. */
interface OriginalNumberConfig {
    voiceUrl: string;
    voiceMethod: string;
    voiceApplicationSid: string;
    voiceFallbackUrl: string;
    voiceFallbackMethod: string;
    statusCallback: string;
    statusCallbackMethod: string;
    smsUrl: string;
    smsMethod: string;
}

function originalConfigRef(db: Database, accountSid: string, numberSid: string) {
    return db.ref(`/twilio/${accountSid}/numbers/${numberSid}/original`);
}

/**
 * Snapshot `number`'s current webhook config to RTDB (so it can be restored
 * later) then point it at the incoming TwiML App (and the shared status
 * callback) so PSTN calls ring the app.
 *
 * Uses voiceApplicationSid rather than voiceUrl: a TwiML App always wins over
 * a directly-configured voiceUrl, so a number left over from prior manual
 * setup with some other TwiML App would otherwise silently never reach
 * twilioIncomingCall. Routing through our own App sidesteps that precedence
 * fight entirely instead of just clearing voiceUrl.
 *
 * The snapshot is written only when one doesn't already exist. configureNumber
 * can run again on a number we've partially configured before (e.g. an older
 * build set voiceApplicationSid but not smsUrl, and the broadened isConfigured
 * check now re-runs it to repair the SMS webhook). Re-snapshotting there would
 * capture our OWN values as the "original", corrupting a later restoreNumber.
 */
function configureNumber(
    client: Twilio, db: Database, accountSid: string, number: IncomingPhoneNumberInstance, incomingAppSid: string,
): Observable<void> {
    const ref = originalConfigRef(db, accountSid, number.sid);
    const snapshot$ = from(ref.once('value')).pipe(
        switchMap((snapshot) => {
            if (snapshot.exists()) return of(undefined);
            const original: OriginalNumberConfig = {
                voiceUrl: number.voiceUrl ?? '',
                voiceMethod: number.voiceMethod ?? 'POST',
                voiceApplicationSid: number.voiceApplicationSid ?? '',
                voiceFallbackUrl: number.voiceFallbackUrl ?? '',
                voiceFallbackMethod: number.voiceFallbackMethod ?? 'POST',
                statusCallback: number.statusCallback ?? '',
                statusCallbackMethod: number.statusCallbackMethod ?? 'POST',
                smsUrl: number.smsUrl ?? '',
                smsMethod: number.smsMethod ?? 'POST',
            };
            return from(ref.set(original));
        }),
    );
    return snapshot$.pipe(
        switchMap(() => from(client.incomingPhoneNumbers(number.sid).update({
            voiceApplicationSid: incomingAppSid,
            voiceUrl: '',
            statusCallback: webhookUrl(STATUS_CALLBACK_PATH),
            statusCallbackMethod: 'POST',
            smsUrl: webhookUrl(INCOMING_MESSAGE_PATH),
            smsMethod: 'POST',
        }))),
        map(() => undefined),
    );
}

/**
 * Restore `numberSid`'s webhook config from the RTDB snapshot taken by
 * configureNumber, then clear the snapshot. If there's no snapshot (the
 * number was never configured by us), this just clears our own fields
 * instead of guessing at a prior third-party config.
 */
function restoreNumber(client: Twilio, db: Database, accountSid: string, numberSid: string): Observable<void> {
    const ref = originalConfigRef(db, accountSid, numberSid);
    return from(ref.once('value')).pipe(
        switchMap((snapshot) => {
            const original = snapshot.val() as OriginalNumberConfig | null;
            const restoreFields: OriginalNumberConfig = original ?? {
                voiceUrl: '', voiceMethod: 'POST', voiceApplicationSid: '',
                voiceFallbackUrl: '', voiceFallbackMethod: 'POST',
                statusCallback: '', statusCallbackMethod: 'POST',
                smsUrl: '', smsMethod: 'POST',
            };
            return from(client.incomingPhoneNumbers(numberSid).update(restoreFields));
        }),
        switchMap(() => from(ref.remove())),
        map(() => undefined),
    );
}

/**
 * Configure exactly `selectedSids` to ring this app, restoring any number
 * that's no longer selected to its pre-app config. A number already matching
 * the desired state (configured-and-selected, or never-configured-and-not-
 * selected) is left untouched. Returns which numbers were actually changed.
 */
export function configureSelectedNumbers(
    accountSid: string, authToken: string, selectedSids: string[],
): Observable<{ configured: string[]; restored: string[] }> {
    const client: Twilio = twilio(accountSid, authToken);
    const db = admin.database();
    const selected = new Set(selectedSids);

    const attempt = (): Observable<{ configured: string[]; restored: string[] }> =>
        getOrCreateTwimlApp(client, accountSid, 'incoming', TWIML_APP_FRIENDLY_NAME_INCOMING, webhookUrl(INCOMING_CALL_PATH)).pipe(
            switchMap((incomingAppSid) => from(client.incomingPhoneNumbers.list({ limit: 1000 })).pipe(
                switchMap((numbers) => {
                    const changes = numbers.map((number) => {
                        // Both webhooks must match: a number voice-configured by an older build
                        // that predates SMS support has the right voiceApplicationSid but no
                        // smsUrl, and must be re-run through configureNumber to gain it.
                        // isCurrent also requires the CURRENT host, so a selected number still
                        // on a previous webhook host is re-pointed (its snapshot is kept);
                        // isOurs accepts any host we've used, so deselecting such a number
                        // still restores it.
                        const isOurs = number.voiceApplicationSid === incomingAppSid &&
                            isKnownWebhookUrl(number.smsUrl, INCOMING_MESSAGE_PATH);
                        const isCurrent = number.voiceApplicationSid === incomingAppSid &&
                            number.smsUrl === webhookUrl(INCOMING_MESSAGE_PATH);
                        const shouldBeConfigured = selected.has(number.sid);
                        if (shouldBeConfigured && !isCurrent) {
                            return configureNumber(client, db, accountSid, number, incomingAppSid)
                                .pipe(map(() => ({ sid: number.sid, action: 'configured' as const })));
                        }
                        if (!shouldBeConfigured && isOurs) {
                            return restoreNumber(client, db, accountSid, number.sid)
                                .pipe(map(() => ({ sid: number.sid, action: 'restored' as const })));
                        }
                        return of({ sid: number.sid, action: 'unchanged' as const });
                    });
                    return changes.length === 0 ? of([]) : forkJoin(changes);
                }),
            )),
            map((results) => ({
                configured: results.filter((r) => r.action === 'configured').map((r) => r.sid),
                restored: results.filter((r) => r.action === 'restored').map((r) => r.sid),
            })),
        );

    // A cached incoming app SID whose app the tenant deleted in the Twilio
    // console makes configureNumber fail with 22108 (Invalid Application SID) —
    // the one point where Twilio tells us the cache is wrong. Drop the stale
    // cache and retry once: getOrCreateTwimlApp then finds an empty cache and
    // recreates the app before we re-point the numbers.
    return attempt().pipe(
        catchError((e: { code?: number }) => {
            if (e?.code !== 22108) throw e;
            console.warn(`Incoming TwiML App for ${accountSid} invalid (22108), clearing cache and retrying`);
            return from(twimlAppSidRef(accountSid, 'incoming').remove()).pipe(switchMap(() => attempt()));
        }),
    );
}

function webhookBaseMarkerRef(accountSid: string) {
    return admin.database().ref(`/twilio/${accountSid}/webhook-base-url`);
}

/**
 * Self-heal a tenant's Twilio config onto the current webhook host
 * (docs/edge-hardening-plan.md §6.3). Existing TwiML Apps and numbers keep
 * whatever URL they were configured with — the cached app SID is never
 * re-checked on hot paths and numbers carry statusCallback/smsUrl directly — so
 * when WEBHOOK_PUBLIC_BASE_URL changes, each tenant is re-pointed the next time
 * its app hits a callable, using the live credentials that callable carries.
 *
 * The marker /twilio/{accountSid}/webhook-base-url records the base URL the
 * tenant was last re-pointed to. Comparing against the base URL itself (not a
 * version counter) means a rollback of the param re-points tenants back with no
 * extra step. When current — the steady state — this is one RTDB read.
 *
 * Only touches what is ours: the cached outgoing/incoming TwiML Apps, and on
 * numbers routed to our incoming app only the statusCallback/smsUrl fields that
 * still point at one of our known hosts (a webhook the tenant re-pointed
 * elsewhere by hand is left alone). The restore snapshot is never touched.
 *
 * Best-effort like rememberAuthToken: failures are logged and swallowed so they
 * can't break the callable; the marker is only advanced after every update
 * succeeded, so a failure is retried on the next call.
 */
export function ensureWebhooksCurrent(accountSid: string, authToken: string): Observable<void> {
    if (typeof accountSid !== 'string' || accountSid === '' || typeof authToken !== 'string' || authToken === '') {
        return of(undefined);
    }
    const publicBase = webhookPublicBaseUrl();
    const marker = webhookBaseMarkerRef(accountSid);
    return from(marker.once('value')).pipe(
        switchMap((snapshot) => snapshot.val() === publicBase ?
            of(undefined) :
            from(repointWebhooks(twilio(accountSid, authToken), accountSid)).pipe(
                switchMap(() => from(marker.set(publicBase))),
                map(() => console.log(`Re-pointed ${accountSid}'s Twilio webhooks to ${publicBase}`)),
            )),
        catchError((error) => {
            console.error(`Failed to re-point ${accountSid}'s Twilio webhooks to ${publicBase}`, error);
            return of(undefined);
        }),
    );
}

async function repointWebhooks(client: Twilio, accountSid: string): Promise<void> {
    const [outgoingAppSid, incomingAppSid] = await Promise.all([
        twimlAppSidRef(accountSid, 'outgoing').once('value').then((s) => s.val() as string | null),
        twimlAppSidRef(accountSid, 'incoming').once('value').then((s) => s.val() as string | null),
    ]);
    await Promise.all([
        outgoingAppSid ? repointTwimlApp(client, accountSid, 'outgoing', outgoingAppSid, webhookUrl(OUTGOING_CALL_PATH)) : undefined,
        incomingAppSid ? repointTwimlApp(client, accountSid, 'incoming', incomingAppSid, webhookUrl(INCOMING_CALL_PATH)) : undefined,
    ]);
    if (!incomingAppSid) return; // no incoming app → no number of ours to re-point

    const desired = { statusCallback: webhookUrl(STATUS_CALLBACK_PATH), smsUrl: webhookUrl(INCOMING_MESSAGE_PATH) };
    const numbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
    await Promise.all(numbers
        .filter((number) => number.voiceApplicationSid === incomingAppSid)
        .map((number) => {
            const update: { statusCallback?: string; statusCallbackMethod?: string; smsUrl?: string; smsMethod?: string } = {};
            if (number.statusCallback !== desired.statusCallback && isKnownWebhookUrl(number.statusCallback, STATUS_CALLBACK_PATH)) {
                update.statusCallback = desired.statusCallback;
                update.statusCallbackMethod = 'POST';
            }
            if (number.smsUrl !== desired.smsUrl && isKnownWebhookUrl(number.smsUrl, INCOMING_MESSAGE_PATH)) {
                update.smsUrl = desired.smsUrl;
                update.smsMethod = 'POST';
            }
            return Object.keys(update).length === 0 ? undefined : client.incomingPhoneNumbers(number.sid).update(update);
        }));
}

/**
 * Point a cached TwiML App at `voiceUrl`. If the tenant deleted the app in the
 * console (20404), drop the stale cache instead of failing: getOrCreateTwimlApp
 * recreates it — with the current URL — the next time it's needed.
 */
async function repointTwimlApp(
    client: Twilio, accountSid: string, direction: 'outgoing' | 'incoming', appSid: string, voiceUrl: string,
): Promise<void> {
    try {
        await client.applications(appSid).update({ voiceUrl, voiceMethod: 'POST' });
    } catch (error) {
        if ((error as { code?: number })?.code !== 20404) throw error;
        await twimlAppSidRef(accountSid, direction).remove();
    }
}

/**
 * Resolve a usable Twilio API key for `accountSid`, cached in RTDB under
 * /twilio/{accountSid}/api-key:
 *   1. cached key present -> verify it still authenticates, then reuse it;
 *   2. cached but revoked/deleted (401) -> drop the stale cache, mint a fresh one;
 *   3. no cache -> mint and cache.
 * accessToken()'s toJwt() signs locally and never contacts Twilio, so a dead key
 * would otherwise go undetected here — hence the explicit auth probe. Only a 401
 * counts as revoked; transient errors are re-thrown so we never churn a good key.
 */
async function getOrCreateApiKey(client: Twilio, accountSid: string): Promise<{ sid: string; secret: string }> {
    const ref = admin.database().ref(`/twilio/${accountSid}/api-key`);
    const cached = (await ref.once('value')).val() as { sid: string; secret: string } | null;

    if (cached) {
        try {
            // Authenticate WITH the cached key; a 401 means it was revoked/deleted.
            await twilio(cached.sid, cached.secret, { accountSid }).api.v2010.accounts(accountSid).fetch();
            return cached;
        } catch (err) {
            if ((err as { status?: number }).status !== 401) throw err;
            await ref.remove();
        }
    }

    const created = await client.iam.v1.newApiKey.create({ accountSid, friendlyName: API_KEY_FRIENDLY_NAME });
    await ref.set({ sid: created.sid, secret: created.secret });
    return { sid: created.sid, secret: created.secret };
}

/**
 * Mint a Twilio Voice access token for a tenant's account.
 * The push credential SID (created by twilioRegister) is read from the DB and
 * added to the VoiceGrant so this device can receive incoming-call pushes.
 */
export function accessToken(accountSid: string, authToken: string, callerId: string): Observable<string> {
    const client: Twilio = twilio(accountSid, authToken);
    const db = admin.database();

    // Reuse the cached API key (verifying it still authenticates), or mint one.
    const apiKey$ = from(getOrCreateApiKey(client, accountSid));

    // Push credential SID persisted by twilioRegister; required for incoming calls.
    const pushCredentialSid$ = from(db.ref(`/twilio/${accountSid}/push-credential/android`).once('value')).pipe(
        map((snapshot) => snapshot.val() as string | null),
    );

    return forkJoin({
        apiKeyInstance: apiKey$,
        pushCredentialSid: pushCredentialSid$,
        appSid: getOrCreateTwimlApp(client, accountSid, 'outgoing', TWIML_APP_FRIENDLY_NAME_OUTGOING, webhookUrl(OUTGOING_CALL_PATH)),
    }).pipe(
        map(({ apiKeyInstance, pushCredentialSid, appSid }) => {
            // TTL default 1h max 24h
            const options: AccessTokenOptions = { ttl: 600, identity: clientIdentity(accountSid) };
            const token = new AccessToken(accountSid, apiKeyInstance.sid, apiKeyInstance.secret, options);
            token.addGrant(new AccessToken.VoiceGrant({
                outgoingApplicationSid: appSid,
                outgoingApplicationParams: { callerId },
                incomingAllow: true,
                // Only set when registered; an empty value disables incoming push.
                ...(pushCredentialSid ? { pushCredentialSid } : {}),
            }));
            /**
             * TODO messaging grant
             * token.addGrant(new AccessToken.ChatGrant({ serviceSid: messagingSid }));
             */
            return token.toJwt();
        }),
    );
}

/**
 * TwiML for an inbound PSTN call: ring the registered mobile app (Voice SDK
 * client). The <Client> name MUST match the access token identity, otherwise
 * Twilio has no registered endpoint to deliver the push to. Twilio sends the
 * number-owning AccountSid on the request, which is exactly our tenant identity.
 * <?xml version="1.0" encoding="UTF-8"?>
 * <Response><Dial><Client>{AccountSid}</Client></Dial></Response>
 *
 * Checked against the account's (cached) subscription expiry first: a device
 * can hold a push binding independent of its access token's short TTL, so an
 * expired account could otherwise keep ringing even though twilioAccessToken
 * refuses to mint it a fresh token. This only reads the cached expiresAt (no
 * live store re-check, to keep the webhook fast) — the authoritative,
 * re-verified check lives in twilioAccessToken.
 * @param request http request that initiated this function
 * @param response http response to be sent back to the caller
 */
export async function callbackIncomingCall(request: Request, response: express.Response) {
    if (!await twilioSignatureGuard(request, response, INCOMING_CALL_PATH)) return;
    const accountSid = request.body.AccountSid;
    const voiceResponse = new twiml.VoiceResponse();

    const expiresAtSnapshot = await admin.database().ref(`/twilio/${accountSid}/trial/expiresAt`).once('value');
    const expiresAt = expiresAtSnapshot.val() as number | null;
    if (expiresAt === null || expiresAt <= Date.now()) {
        voiceResponse.say('This number is temporarily unavailable.');
    } else {
        voiceResponse.dial().client(clientIdentity(accountSid));
    }

    response.type('text/xml')
        .status(200)
        .send(voiceResponse.toString());
}

/**
 * TwiML for an outgoing call placed by the SDK. The twilio_voice plugin sends
 * `From` (the account's number, used as caller ID) and `To` (the destination)
 * as POST params; dial the destination with the account number as caller ID.
 */
export async function callbackOutgoingCall(request: Request, response: express.Response) {
    if (!await twilioSignatureGuard(request, response, OUTGOING_CALL_PATH)) return;
    const voiceResponse = new twiml.VoiceResponse();
    const to: string | undefined = request.body.To;
    const callerId: string | undefined = request.body.From;
    if (to) {
        voiceResponse.dial({ callerId }, to);
    } else {
        voiceResponse.say('No destination number was provided.');
    }
    response.type('text/xml')
        .status(200)
        .send(voiceResponse.toString());
}

// https://www.twilio.com/docs/voice/api/call-resource#statuscallback
export async function callbackCallStatusChanges(request: Request, response: express.Response) {
    if (!await twilioSignatureGuard(request, response, STATUS_CALLBACK_PATH)) return;
    console.log('callbackCallStatusChanges %j', request.body);
    request.body.From;
    request.body.To;
    request.body.CallDuration; // only present if CallStatus is completed. Duration in seconds
    request.body.Timestamp; // when the status changed
    request.body.CallStatus; // queued, initiated, ringing, in-progress, completed, busy, failed, no-answer, canceled
    request.body.CallSid; // unique identifier for the call

    // todo save request body in database using callSid as key
    response.status(202).send();
}

/**
 * TwiML webhook for an inbound SMS/MMS (configured as the number's smsUrl by
 * configureNumber). Pushes a silent/data-only FCM message to every device
 * registered for this tenant (registerMessagingDevice) so the client shows an
 * in-app banner (foreground) or an OS notification (background/terminated) —
 * sent directly via the Firebase Admin SDK rather than through Twilio's
 * Conversations/Notify push-credential system, which is Voice-specific (see
 * the TODO on createOrUpdatePushCredentials). accountSid rides along in the
 * payload so a device in vacation mode can recognize its own tenant and skip
 * displaying the notification (still delivered — vacation mode never touches
 * this registration/fan-out, only client-side display). No reply is sent
 * back to the sender, so the response is an empty MessagingResponse.
 */
export async function callbackIncomingMessage(request: Request, response: express.Response) {
    if (!await twilioSignatureGuard(request, response, INCOMING_MESSAGE_PATH)) return;
    const accountSid = request.body.AccountSid;
    const from = request.body.From ?? '';
    const to = request.body.To ?? '';
    const body = request.body.Body ?? '';
    const messageSid = request.body.MessageSid ?? '';

    const tokensSnapshot = await admin.database().ref(`/twilio/${accountSid}/messaging-tokens`).once('value');
    const tokens = Object.keys((tokensSnapshot.val() ?? {}) as Record<string, boolean>);

    if (tokens.length > 0) {
        const results = await Promise.allSettled(tokens.map((token) => admin.messaging().send({
            token,
            data: { dialcrest_type: 'incoming_message', accountSid, from, to, body, messageSid },
            android: { priority: 'high' },
            apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1 } } },
        })));

        // Drop tokens FCM reports as unregistered (uninstalled app / stale token) so
        // this list doesn't grow unboundedly and future sends don't keep failing on them.
        await Promise.all(results.map((result, i) => {
            const isUnregistered = result.status === 'rejected' &&
                String((result.reason as { code?: string })?.code ?? result.reason).includes('registration-token-not-registered');
            return isUnregistered ?
                admin.database().ref(`/twilio/${accountSid}/messaging-tokens/${tokens[i]}`).remove() :
                Promise.resolve();
        }));
    }

    response.type('text/xml')
        .status(200)
        .send(new twiml.MessagingResponse().toString());
}

/**
 * Registers (or refreshes) this device's FCM token so callbackIncomingMessage
 * can push incoming-SMS notifications to it. Stored as a set keyed by token
 * (rather than one token per account) so every device sharing this tenant's
 * Twilio account gets notified, not just the most recently registered one.
 */
export function registerMessagingDevice(accountSid: string, fcmToken: string): Observable<void> {
    return from(admin.database().ref(`/twilio/${accountSid}/messaging-tokens/${fcmToken}`).set(true));
}

/**
 * Create (or update) the FCM/APN push credentials in a tenant's own Twilio
 * account, then persist the resulting CR... SID(s) under
 * /twilio/{accountSid}/push-credential so accessToken() can use them.
 *
 * The FCM secret is OUR Firebase service-account JSON (shared across tenants) —
 * every device receives push through our single Firebase project.
 *
 * TODO messaging: when SMS is added, create/find a Messaging Service + Notify
 * Service here. (Removed the previous stub — it created a new Notify service on
 * every call and isn't needed for Voice incoming calls.)
 */
export function createOrUpdatePushCredentials(
    accountSid: string,
    authToken: string,
    iosApnCertificate: string,
    iosApnPrivateKey: string,
    androidFcmSecret: string,
): Observable<{ androidSid: string; iosSid: string | null }> {
    const client: Twilio = twilio(accountSid, authToken);
    const hasIos = Boolean(iosApnCertificate && iosApnPrivateKey);

    // Find existing push credentials in this tenant's account by friendly name.
    // Twilio credentials can't change `type` in place (RestException 20001), so a
    // stale credential under the same friendly name but the wrong type (e.g. a
    // legacy `gcm` one before this project moved to FCM v1) must be deleted
    // rather than updated.
    return from(client.conversations.v1.credentials.list({ limit: 1000 })).pipe(
        map((credentials) => ({
            android: credentials.find((c) => c.friendlyName === ANDROID_FCM_FRIENDLY_NAME),
            ios: credentials.find((c) => c.friendlyName === IOS_APN_FRIENDLY_NAME),
        })),
        switchMap(({ android, ios }) =>
            forkJoin({
                android: dropIfWrongType(client, android, 'fcm'),
                ios: dropIfWrongType(client, ios, 'apn'),
            }),
        ),
        // Create, or update in place if a credential with that friendly name and type exists.
        switchMap(({ android, ios }) =>
            forkJoin({
                android: createOrUpdateAndroidCredential(client, android?.sid, androidFcmSecret),
                ios: hasIos ? createOrUpdateiOSCredential(client, ios?.sid, iosApnCertificate, iosApnPrivateKey) : of(null),
            }),
        ),
        // Persist the CR... SIDs for accessToken() to read. Which numbers ring
        // this app is a separate, user-driven choice — see configureSelectedNumbers.
        switchMap(({ android, ios }) =>
            from(admin.database().ref(`/twilio/${accountSid}/push-credential`).set({
                android: android.sid,
                ios: ios?.sid ?? null,
            })).pipe(map(() => ({
                androidSid: android.sid,
                iosSid: ios?.sid ?? null,
            }))),
        ),
    );
}

/**
 * Delete `credential` if it exists but isn't of `expectedType`, so it doesn't
 * get passed into a Credential.update() call (Twilio rejects type changes with
 * RestException 20001 "Cannot update credential type. Create a new Credential
 * instead."). Returns undefined when there's no reusable credential left, so
 * the caller creates a fresh one.
 */
function dropIfWrongType(
    client: Twilio, credential: CredentialInstance | undefined, expectedType: CredentialPushType,
): Observable<CredentialInstance | undefined> {
    if (!credential || credential.type === expectedType) return of(credential);
    return from(client.conversations.v1.credentials(credential.sid).remove()).pipe(map(() => undefined));
}

function createOrUpdateiOSCredential(client: Twilio, sid: string | undefined, certificate: string, privateKey: string): Promise<CredentialInstance> {
    const fields = {
        certificate, // The URL encoded representation of the certificate.
        privateKey, // The URL encoded representation of the private key.
        sandbox: false, // Whether to use the sandbox environment. Defaults to false.
        friendlyName: IOS_APN_FRIENDLY_NAME,
    };
    return sid === undefined ?
        client.conversations.v1.credentials.create({ ...fields, type: 'apn' as CredentialPushType }) :
        client.conversations.v1.credentials(sid).update(fields);
}

function createOrUpdateAndroidCredential(client: Twilio, sid: string | undefined, androidSecret: string): Promise<CredentialInstance> {
    const fields = {
        secret: androidSecret, // FCM v1 service-account JSON (the whole JSON string).
        friendlyName: ANDROID_FCM_FRIENDLY_NAME,
    };
    return sid === undefined ?
        client.conversations.v1.credentials.create({ ...fields, type: 'fcm' as CredentialPushType }) :
        client.conversations.v1.credentials(sid).update(fields);
}
