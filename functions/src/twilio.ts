import * as express from 'express';
import twilio, { Twilio, twiml } from 'twilio';
import { Request } from 'firebase-functions/https';
import { forkJoin, from, map, Observable, of, switchMap, tap } from 'rxjs';
import { CredentialInstance, CredentialPushType } from 'twilio/lib/rest/conversations/v1/credential';
import { IncomingPhoneNumberInstance } from 'twilio/lib/rest/api/v2010/account/incomingPhoneNumber';
import AccessToken, { AccessTokenOptions } from 'twilio/lib/jwt/AccessToken';
import admin from 'firebase-admin';
import { Database } from 'firebase-admin/database';

// Friendly names used to find/create resources in each tenant's Twilio account.
const IOS_APN_FRIENDLY_NAME = 'Dialcrest APN iOS';
const ANDROID_FCM_FRIENDLY_NAME = 'Dialcrest FCM Android';
const TWIML_APP_FRIENDLY_NAME_OUTGOING = 'Dialcrest Outgoing';
const TWIML_APP_FRIENDLY_NAME_INCOMING = 'Dialcrest Incoming';
const API_KEY_FRIENDLY_NAME = 'Dialcrest - Twilio Soft Phone';

const FUNCTIONS_BASE_URL = 'https://europe-west1-twilio-phone-peblet.cloudfunctions.net';
const OUTGOING_CALL_URL = `${FUNCTIONS_BASE_URL}/twilioOutgoingCall`;
const INCOMING_CALL_URL = `${FUNCTIONS_BASE_URL}/twilioIncomingCall`;
const STATUS_CALLBACK_URL = `${FUNCTIONS_BASE_URL}/twilioCallStatusChanges`;
const INCOMING_MESSAGE_URL = `${FUNCTIONS_BASE_URL}/twilioIncomingMessage`;

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

/**
 * Find (or create) one of the tenant's two TwiML Apps (outgoing/incoming) and
 * cache its SID in RTDB under /twilio/{accountSid}/twiml-app-sid/{direction}.
 * The app's voice URL points at the matching webhook; the SID is used as
 * outgoingApplicationSid in the grant (outgoing) or voiceApplicationSid on
 * each phone number (incoming).
 */
function getOrCreateTwimlApp(
    client: Twilio, accountSid: string, direction: 'outgoing' | 'incoming', friendlyName: string, voiceUrl: string,
): Observable<string> {
    const ref = admin.database().ref(`/twilio/${accountSid}/twiml-app-sid/${direction}`);
    return from(ref.once('value')).pipe(
        switchMap((snapshot) => {
            const cached = snapshot.val() as string | null;
            if (cached) return of(cached);
            return from(client.applications.list({ friendlyName, limit: 1 })).pipe(
                switchMap((apps) => apps.length > 0 ?
                    of(apps[0]) :
                    from(client.applications.create({ friendlyName, voiceUrl, voiceMethod: 'POST' }))),
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
    return getOrCreateTwimlApp(client, accountSid, 'incoming', TWIML_APP_FRIENDLY_NAME_INCOMING, INCOMING_CALL_URL);
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
 */
function configureNumber(
    client: Twilio, db: Database, accountSid: string, number: IncomingPhoneNumberInstance, incomingAppSid: string,
): Observable<void> {
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
    return from(originalConfigRef(db, accountSid, number.sid).set(original)).pipe(
        switchMap(() => from(client.incomingPhoneNumbers(number.sid).update({
            voiceApplicationSid: incomingAppSid,
            voiceUrl: '',
            statusCallback: STATUS_CALLBACK_URL,
            statusCallbackMethod: 'POST',
            smsUrl: INCOMING_MESSAGE_URL,
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

    return getOrCreateTwimlApp(client, accountSid, 'incoming', TWIML_APP_FRIENDLY_NAME_INCOMING, INCOMING_CALL_URL).pipe(
        switchMap((incomingAppSid) => from(client.incomingPhoneNumbers.list({ limit: 1000 })).pipe(
            switchMap((numbers) => {
                const changes = numbers.map((number) => {
                    const isConfigured = number.voiceApplicationSid === incomingAppSid;
                    const shouldBeConfigured = selected.has(number.sid);
                    if (shouldBeConfigured && !isConfigured) {
                        return configureNumber(client, db, accountSid, number, incomingAppSid)
                            .pipe(map(() => ({ sid: number.sid, action: 'configured' as const })));
                    }
                    if (!shouldBeConfigured && isConfigured) {
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
}

/**
 * Mint a Twilio Voice access token for a tenant's account.
 * The push credential SID (created by twilioRegister) is read from the DB and
 * added to the VoiceGrant so this device can receive incoming-call pushes.
 */
export function accessToken(accountSid: string, authToken: string, callerId: string): Observable<string> {
    const client: Twilio = twilio(accountSid, authToken);
    const db = admin.database();

    // Create (and cache) a Twilio API key the first time we see this account.
    const newApiKey = from(client.iam.v1.newApiKey.create({ accountSid, friendlyName: API_KEY_FRIENDLY_NAME })).pipe(
        // TODO storing the API secret in RTDB plaintext — lock down with DB rules / move to a secret store.
        tap((response) => db.ref(`/twilio/${accountSid}/api-key`).set({ sid: response.sid, secret: response.secret })),
    );

    const apiKey$ = from(db.ref(`/twilio/${accountSid}/api-key`).once('value')).pipe(
        switchMap((snapshot) => {
            const data = snapshot.val() as { sid: string; secret: string } | null;
            return data ? of(data) : newApiKey;
        }),
    );

    // Push credential SID persisted by twilioRegister; required for incoming calls.
    const pushCredentialSid$ = from(db.ref(`/twilio/${accountSid}/push-credential/android`).once('value')).pipe(
        map((snapshot) => snapshot.val() as string | null),
    );

    return forkJoin({
        apiKeyInstance: apiKey$,
        pushCredentialSid: pushCredentialSid$,
        appSid: getOrCreateTwimlApp(client, accountSid, 'outgoing', TWIML_APP_FRIENDLY_NAME_OUTGOING, OUTGOING_CALL_URL),
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
    const accountSid = request.body.AccountSid;
    const voiceResponse = new twiml.VoiceResponse();

    const expiresAtSnapshot = await admin.database().ref(`/twilio/${accountSid}/subscription/expiresAt`).once('value');
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
export function callbackOutgoingCall(request: Request, response: express.Response) {
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
export function callbackCallStatusChanges(request: Request, response: express.Response) {
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
 * the TODO on createOrUpdatePushCredentials). No reply is sent back to the
 * sender, so the response is an empty MessagingResponse.
 */
export async function callbackIncomingMessage(request: Request, response: express.Response) {
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
            data: { dialcrest_type: 'incoming_message', from, to, body, messageSid },
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
