/**
 * All secrets live in a SINGLE Secret Manager secret, TWILIO_PEBLET_SECRET, as
 * JSON with each individual secret as a property:
 *   { android_fcm: {<FCM v1 service-account JSON>},
 *     ios_apn_pk: "<APN private key PEM>",
 *     apple_iap_key: {issuerId, keyId, privateKey, bundleId, appAppleId} }
 * android_fcm doubles as the Google Play service account: it's also been
 * granted "View financial data" access in Play Console, so the same
 * credentials verify Play subscription purchases (see
 * subscriptionReverificationConfig) — no separate Play-specific service
 * account needed.
 * One secret instead of several keeps Secret Manager cost down and gives every
 * function a single, consistent place to read credentials from. Locally it's
 * read from functions/.secret.local.
 * https://firebase.google.com/docs/functions/config-env#secrets
 *
 * Manage with:
 *   firebase functions:secrets:set     TWILIO_PEBLET_SECRET  # set / rotate
 *   firebase functions:secrets:access  TWILIO_PEBLET_SECRET  # view
 *   firebase functions:secrets:destroy TWILIO_PEBLET_SECRET  # delete
 *   firebase functions:secrets:prune                         # remove unreferenced
 */

// Must be first: restores buffer.SlowBuffer (removed in Node 24+) before the
// firebase-admin require chain below reads it at load time. See slowBufferShim.ts.
import './slowBufferShim';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onRequest, onCall } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { defineSecret, defineString } from 'firebase-functions/params';
import { catchError, from, lastValueFrom, map, of, switchMap, throwError } from 'rxjs';
import {
    callbackCallStatusChanges,
    callbackIncomingCall,
    callbackIncomingMessage,
    callbackOutgoingCall,
    createOrUpdatePushCredentials,
    accessToken,
    getIncomingAppSid,
    configureSelectedNumbers,
    InvalidTwilioCredentialsError,
    unregisterOnlyToken,
    verifyTwilioCredentials,
    ensureWebhooksCurrent,
    registerMessagingDevice,
    linkTwilioAccount,
    rememberAuthToken,
} from './twilio';
import {
    AppleConfig,
    PresentedEntitlement,
    ReverificationConfig,
    ensureAccountCreated,
    ensureTrialStarted,
    handleAppleNotification,
    handleGoogleNotification,
    isSubscriptionActive,
    verifyAppleNotificationSignature,
    verifyApplePurchase,
    verifyEntitlement,
    verifyGooglePurchase,
} from './subscription';
import * as admin from 'firebase-admin';

admin.initializeApp();

// Cost ceiling (docs/edge-hardening-plan.md §6.6): a flood that reaches any
// function — webhook or callable — scales to at most this many instances.
// minInstances stays at the default 0.
setGlobalOptions({ maxInstances: 10 });

const twilioPebletSecret = defineSecret('TWILIO_PEBLET_SECRET');

// Empty until iOS push is enabled — when empty, createOrUpdatePushCredentials skips the iOS branch.
// See README "Enabling iOS push" for how to obtain and configure it.
const iosApnCertificate = defineString('IOS_APN_CERTIFICATE', { default: '' });
const androidPackageName = defineString('ANDROID_PACKAGE_NAME', { default: 'be.peblet.twilio_phone' });

interface PebletSecrets {
    android_fcm?: object;
    ios_apn_pk?: string;
    apple_iap_key?: AppleConfig;
}

function pebletSecrets(): PebletSecrets {
    return JSON.parse(twilioPebletSecret.value()) as PebletSecrets;
}

function appleConfig(): AppleConfig {
    return pebletSecrets().apple_iap_key ?? ({} as AppleConfig);
}

/**
 * Reads the optional store entitlement a device attaches to a gated request
 * (twilioAccessToken) or a status refresh. iOS sends `signedTransactionInfo`
 * (a StoreKit JWS), Android sends `purchaseToken`; a trialing device that has
 * never purchased sends neither, and gets null.
 */
function presentedEntitlement(data: Record<string, unknown>): PresentedEntitlement | null {
    if (typeof data['signedTransactionInfo'] === 'string' && data['signedTransactionInfo']) {
        return { store: 'app_store', signedTransactionInfo: data['signedTransactionInfo'] };
    }
    if (typeof data['purchaseToken'] === 'string' && data['purchaseToken']) {
        return { store: 'play_store', purchaseToken: data['purchaseToken'] };
    }
    return null;
}

function subscriptionReverificationConfig(): ReverificationConfig {
    return {
        apple: appleConfig(),
        googlePackageName: androidPackageName.value(),
        // android_fcm doubles as the Google Play service account (granted
        // "View financial data" access in Play Console) — see the file header.
        googleServiceAccountJson: JSON.stringify(pebletSecrets().android_fcm ?? {}),
    };
}

/**
 * Unpack the combined secret into the individual values the Twilio helpers want.
 * androidFcmSecret must be the FCM service-account JSON as a string.
 */
function pushSecrets(): { androidFcmSecret: string; iosApnPrivateKey: string } {
    const parsed = pebletSecrets();
    return {
        androidFcmSecret: JSON.stringify(parsed.android_fcm ?? {}),
        iosApnPrivateKey: parsed.ios_apn_pk ?? '',
    };
}

const REGION = 'europe-west1';

// https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioIncomingCall
exports.twilioIncomingCall = onRequest({ region: REGION, cors: true, timeoutSeconds: 30 },
    (req, res) => callbackIncomingCall(req, res)
);

// https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioOutgoingCall
exports.twilioOutgoingCall = onRequest({ region: REGION, cors: true, timeoutSeconds: 30 },
    (req, res) => callbackOutgoingCall(req, res)
);

// https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioCallStatusChanges
exports.twilioCallStatusChanges = onRequest({ region: REGION, cors: true, timeoutSeconds: 30 },
    (req, res) => callbackCallStatusChanges(req, res)
);

// https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioIncomingMessage
exports.twilioIncomingMessage = onRequest({ region: REGION, cors: true, timeoutSeconds: 30 },
    (req, res) => callbackIncomingMessage(req, res)
);

/**
 * Each user brings their own Twilio account (multi-tenant). On login the app
 * calls this with the user's Twilio accountSid/authToken; we create (or update)
 * the FCM/APN push credential in THAT account using our shared FCM secret, and
 * persist the resulting CR... SID(s) under /twilio/{accountSid}/push-credential.
 * Also the de-facto "account onboarded" hook: records this account's creation
 * timestamp and starts its 30-day trial the first time it's ever seen (see
 * ensureAccountCreated, ensureTrialStarted).
 */
exports.twilioRegister = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => {
        const { androidFcmSecret, iosApnPrivateKey } = pushSecrets();
        const accountSid = req.data['accountSid'];
        const authToken = req.data['authToken'];
        return lastValueFrom(
            ensureAccountCreated(accountSid).pipe(
                switchMap(() => ensureTrialStarted(accountSid)),
                switchMap(() => createOrUpdatePushCredentials(
                    accountSid, authToken, iosApnCertificate.value(), iosApnPrivateKey, androidFcmSecret,
                )),
                switchMap((result) => rememberAuthToken(accountSid, authToken).pipe(map(() => result))),
            ),
        );
    }
);

/**
 * Generate a Twilio Voice access token for the given account. The push
 * credential SID is read from the DB (persisted by twilioRegister) so incoming
 * calls reach this device.
 *
 * The caller must first prove it holds the account's Auth Token
 * (verifyTwilioCredentials) — 'permission-denied' otherwise.
 *
 * Gated on the PERSON's subscription: the line's trial, or the store entitlement
 * this device presents. When neither is active it throws 'failed-precondition'
 * 'subscription-expired' instead of minting, blocking outgoing calls; the error's
 * details carry an `unregisterToken` (unregisterOnlyToken) so the device can drop
 * its own incoming-call registration. Other devices on the same line are
 * unaffected — inbound calls themselves are not gated (see incomingCallTwiml).
 *
 * IOS https://github.com/twilio/voice-quickstart-ios#6-create-a-push-credential-with-your-voip-service-certificate
 * ANDROID https://github.com/twilio/voice-quickstart-android#7-create-a-push-credential-using-your-fcm-server-key
 */
exports.twilioAccessToken = onCall(
    { enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => {
        const accountSid = req.data['accountSid'];
        const authToken = req.data['authToken'];
        return lastValueFrom(
            requireTwilioCredentials(accountSid, authToken).pipe(
                switchMap(() => isSubscriptionActive(accountSid, presentedEntitlement(req.data), subscriptionReverificationConfig())),
                switchMap((active) => active ?
                    accessToken(accountSid, authToken, req.data['callerId']) :
                    subscriptionExpired(accountSid, authToken)),
                switchMap((jwt) => ensureWebhooksCurrent(accountSid, authToken).pipe(map(() => jwt))),
            ),
        );
    }
);

/**
 * Proves the caller holds a valid Auth Token for `accountSid` (verifyTwilioCredentials)
 * before a callable grants anything for that account — App Check proves a genuine
 * app, not account ownership. 'permission-denied' when Twilio rejects the token.
 */
function requireTwilioCredentials(accountSid: unknown, authToken: unknown) {
    return from(verifyTwilioCredentials(accountSid as string, authToken as string)).pipe(
        catchError((e) => throwError(() => e instanceof InvalidTwilioCredentialsError ?
            new HttpsError('permission-denied', 'invalid-twilio-credentials') :
            e)),
    );
}

/**
 * The 'subscription-expired' refusal, carrying an unregister-only token in its
 * details. If that token can't be minted the refusal is still thrown, just
 * without it — the device then simply keeps its registration until next time.
 */
function subscriptionExpired(accountSid: string, authToken: string) {
    return unregisterOnlyToken(accountSid, authToken).pipe(
        map((unregisterToken): { unregisterToken?: string } => ({ unregisterToken })),
        catchError((e) => {
            console.error(`Failed to mint an unregister token for ${accountSid}`, e);
            return of({});
        }),
        switchMap((details) => throwError(() => new HttpsError('failed-precondition', 'subscription-expired', details))),
    );
}

/**
 * Verifies a subscription purchase the client just made against the App Store
 * Server API (not the client-supplied receipt alone), and persists the
 * resulting expiry/auto-renew state.
 */
exports.twilioVerifyApplePurchase = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => lastValueFrom(verifyApplePurchase(req.data['accountSid'], req.data['signedTransactionInfo'], appleConfig()))
);

/**
 * Verifies a subscription purchase the client just made against the Google
 * Play Developer API (not the client-supplied purchase token alone), and
 * persists the resulting expiry/auto-renew state.
 */
exports.twilioVerifyGooglePurchase = onCall(
    { enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => lastValueFrom(verifyGooglePurchase(
        req.data['accountSid'], req.data['purchaseToken'], androidPackageName.value(),
        JSON.stringify(pebletSecrets().android_fcm ?? {}),
    ))
);

/**
 * App Store Server Notifications V2 webhook. Apple POSTs `{ signedPayload }`
 * for every subscription lifecycle event (renew, expire, refund, renewal-status
 * change, …). Set the Production and Sandbox notification URLs to this function
 * in App Store Connect — the Sandbox stream is what makes fast-renewing test
 * licenses update without opening the app.
 *
 * No enforceAppCheck (Apple can't send an App Check token). Instead the JWS is
 * verified against Apple's root CA before anything else (forged → 401, an
 * unreachable OCSP responder → 500 so Apple redelivers), and even then the
 * handler doesn't trust the payload's values — it re-fetches authoritative state
 * from Apple by transaction id (see handleAppleNotification).
 */
exports.twilioAppleNotifications = onRequest(
    { region: REGION, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    async (req, res) => {
        const signedPayload = req.body?.signedPayload;
        if (typeof signedPayload !== 'string') {
            res.status(400).send('missing signedPayload');
            return;
        }
        try {
            const verification = await verifyAppleNotificationSignature(signedPayload, appleConfig());
            if (verification !== 'verified') {
                res.status(verification === 'retryable' ? 500 : 401).send('unverified');
                return;
            }
            await lastValueFrom(handleAppleNotification(signedPayload, appleConfig()));
            res.status(200).send('ok');
        } catch (e) {
            // 500 lets Apple retry a transient failure; handleAppleNotification
            // already swallows per-transaction refresh errors, so this only
            // fires on an unexpected/decoding failure.
            console.error('Apple notification handler error', e);
            res.status(500).send('error');
        }
    }
);

/**
 * Play Real-time Developer Notifications consumer. Google publishes
 * subscription lifecycle events to the Pub/Sub topic set up in Play Console
 * (see README / SUBSCRIPTION_NOTIFICATIONS.md); this re-fetches authoritative
 * state for the affected purchase token so renewals/cancels/refunds update the
 * record without the app being opened. Trust here is the Pub/Sub IAM grant, so
 * there's nothing to sign-verify. The topic must match the one configured in
 * Play Console.
 */
exports.onPlaySubscriptionNotification = onMessagePublished(
    { topic: 'play-subscription-notifications', region: REGION, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (event) => {
        let message: unknown;
        try {
            message = event.data.message.json;
        } catch (e) {
            console.error('Play RTDN message body was not valid JSON', e);
            return;
        }
        return lastValueFrom(handleGoogleNotification(
            message, androidPackageName.value(), JSON.stringify(pebletSecrets().android_fcm ?? {}),
        ));
    }
);

/**
 * Re-verifies the store entitlement a device presents and returns its current
 * status, for the Settings screen to show accurate paid state (the trial side
 * is read straight from RTDB). Same re-verification enforcement uses, so
 * Settings self-heals after a renewal instead of showing a stale expiry.
 */
exports.twilioRefreshSubscription = onCall(
    { enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => {
        const entitlement = presentedEntitlement(req.data);
        if (!entitlement) throw new HttpsError('invalid-argument', 'no-entitlement-presented');
        return lastValueFrom(verifyEntitlement(req.data['accountSid'], entitlement, subscriptionReverificationConfig()));
    }
);

/**
 * Resolves (creating if necessary) the tenant's incoming TwiML App SID, so the
 * client can tell whether a given number's voice_application_sid already
 * matches ours (i.e. whether it's configured to ring this app).
 */
exports.twilioGetIncomingAppSid = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30 },
    (req) => lastValueFrom(getIncomingAppSid(req.data['accountSid'], req.data['authToken']).pipe(
        switchMap((sid) => ensureWebhooksCurrent(req.data['accountSid'], req.data['authToken']).pipe(map(() => sid))),
    ))
);

/**
 * Configures exactly the numbers in `selectedSids` to ring this app,
 * restoring any deselected number to its pre-app webhook config. See
 * configureSelectedNumbers in twilio.ts for the snapshot/restore behavior.
 */
exports.twilioConfigureNumbers = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30 },
    // Self-heal first, so the two never update the same number concurrently.
    (req) => lastValueFrom(ensureWebhooksCurrent(req.data['accountSid'], req.data['authToken']).pipe(
        switchMap(() => configureSelectedNumbers(req.data['accountSid'], req.data['authToken'], req.data['selectedSids'])),
    ))
);

/**
 * FCM registration tokens are base64url-ish strings with ':' separators. Checked
 * because the token becomes an RTDB key: anything else (notably '/') could write
 * outside /twilio/{sid}/messaging-tokens/{token}.
 */
const FCM_TOKEN = /^[A-Za-z0-9_:-]{1,4096}$/;

/**
 * Registers (or refreshes) this device's FCM token so twilioIncomingMessage's
 * webhook can push incoming-SMS notifications — including the message text — to
 * it. Requires the account's Auth Token (requireTwilioCredentials): otherwise
 * anyone passing App Check could name another tenant's AccountSid and receive
 * that tenant's incoming messages on their own device.
 */
exports.twilioRegisterMessagingDevice = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30 },
    (req) => {
        const accountSid = req.data['accountSid'];
        const fcmToken = req.data['fcmToken'];
        if (typeof fcmToken !== 'string' || !FCM_TOKEN.test(fcmToken)) {
            throw new HttpsError('invalid-argument', 'invalid-fcm-token');
        }
        return lastValueFrom(requireTwilioCredentials(accountSid, req.data['authToken']).pipe(
            switchMap(() => registerMessagingDevice(accountSid, fcmToken)),
        ));
    }
);

/**
 * Verifies the caller's Twilio credentials and stamps their (anonymous) Firebase
 * identity with an `accountSid` custom claim, which RTDB rules use to authorize
 * per-account reads/writes (see linkTwilioAccount in twilio.ts and
 * database.rules.json). Called at login and whenever the claim needs
 * (re-)establishing.
 */
exports.twilioLinkAccount = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30 },
    (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in to link a Twilio account.');
        return lastValueFrom(linkTwilioAccount(uid, req.data['accountSid'], req.data['authToken']));
    }
);
