/**
 * All secrets live in a SINGLE Secret Manager secret, TWILIO_PEBLET_SECRET, as
 * JSON with each individual secret as a property:
 *   { android_fcm: {<FCM v1 service-account JSON>},
 *     ios_apn_pk: "<APN private key PEM>",
 *     apple_iap_key: {issuerId, keyId, privateKey, bundleId} }
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
import { HttpsError, onRequest, onCall } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { defineSecret, defineString } from 'firebase-functions/params';
import { lastValueFrom, switchMap, throwError } from 'rxjs';
import {
    callbackCallStatusChanges,
    callbackIncomingCall,
    callbackIncomingMessage,
    callbackOutgoingCall,
    createOrUpdatePushCredentials,
    accessToken,
    getIncomingAppSid,
    configureSelectedNumbers,
    registerMessagingDevice,
    linkTwilioAccount,
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
    verifyApplePurchase,
    verifyEntitlement,
    verifyGooglePurchase,
} from './subscription';
import * as admin from 'firebase-admin';

admin.initializeApp();

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
        return lastValueFrom(
            ensureAccountCreated(accountSid).pipe(
                switchMap(() => ensureTrialStarted(accountSid)),
                switchMap(() => createOrUpdatePushCredentials(
                    accountSid, req.data['authToken'], iosApnCertificate.value(), iosApnPrivateKey, androidFcmSecret,
                )),
            ),
        );
    }
);

/**
 * Generate a Twilio Voice access token for the given account. The push
 * credential SID is read from the DB (persisted by twilioRegister) so incoming
 * calls reach this device.
 *
 * Gated on the account's subscription: an expired trial/subscription throws
 * 'failed-precondition' instead of minting a token, blocking both outgoing
 * calls and (by never registering a valid push binding) incoming calls.
 *
 * IOS https://github.com/twilio/voice-quickstart-ios#6-create-a-push-credential-with-your-voip-service-certificate
 * ANDROID https://github.com/twilio/voice-quickstart-android#7-create-a-push-credential-using-your-fcm-server-key
 */
exports.twilioAccessToken = onCall(
    { enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => {
        const accountSid = req.data['accountSid'];
        return lastValueFrom(
            isSubscriptionActive(accountSid, presentedEntitlement(req.data), subscriptionReverificationConfig()).pipe(
                switchMap((active) => active ?
                    accessToken(accountSid, req.data['authToken'], req.data['callerId']) :
                    throwError(() => new HttpsError('failed-precondition', 'subscription-expired'))),
            ),
        );
    }
);

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
 * No enforceAppCheck (Apple can't send an App Check token). The handler doesn't
 * trust the payload's values — it re-fetches authoritative state from Apple by
 * transaction id (see handleAppleNotification). HARDENING TODO: verify the JWS
 * signature chain (app-store-server-library) to reject spam at the edge; see
 * SUBSCRIPTION_NOTIFICATIONS.md.
 */
exports.twilioAppleNotifications = onRequest(
    { region: REGION, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req, res) => {
        const signedPayload = req.body?.signedPayload;
        if (typeof signedPayload !== 'string') {
            res.status(400).send('missing signedPayload');
            return;
        }
        lastValueFrom(handleAppleNotification(signedPayload, appleConfig()))
            .then(() => res.status(200).send('ok'))
            // 500 lets Apple retry a transient failure; handleAppleNotification
            // already swallows per-transaction refresh errors, so this only
            // fires on an unexpected/decoding failure.
            .catch((e) => {
                console.error('Apple notification handler error', e);
                res.status(500).send('error');
            });
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
    (req) => lastValueFrom(getIncomingAppSid(req.data['accountSid'], req.data['authToken']))
);

/**
 * Configures exactly the numbers in `selectedSids` to ring this app,
 * restoring any deselected number to its pre-app webhook config. See
 * configureSelectedNumbers in twilio.ts for the snapshot/restore behavior.
 */
exports.twilioConfigureNumbers = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30 },
    (req) => lastValueFrom(configureSelectedNumbers(req.data['accountSid'], req.data['authToken'], req.data['selectedSids']))
);

/**
 * Registers (or refreshes) this device's FCM token so twilioIncomingMessage's
 * webhook can push incoming-SMS notifications to it.
 */
exports.twilioRegisterMessagingDevice = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30 },
    (req) => lastValueFrom(registerMessagingDevice(req.data['accountSid'], req.data['fcmToken']))
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
