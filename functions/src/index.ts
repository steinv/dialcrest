/**
 * The Cloud Functions themselves: each export is one deployed function. Shared
 * helpers (secret/param access, entitlement parsing, request guards) live in
 * helpers.ts; Twilio and subscription logic in twilio.ts / subscription.ts.
 */

// Must be first: restores buffer.SlowBuffer (removed in Node 24+) before the
// firebase-admin require chain below reads it at load time. See slowBufferShim.ts.
import './slowBufferShim';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onRequest, onCall } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { lastValueFrom, map, switchMap, throwError } from 'rxjs';
import {
    callbackCallStatusChanges,
    callbackIncomingCall,
    callbackIncomingMessage,
    callbackOutgoingCall,
    createOrUpdatePushCredentials,
    accessToken,
    getIncomingAppSid,
    configureSelectedNumbers,
    deviceSubscription,
    recordDeviceCheckIn,
    ensureWebhooksCurrent,
    registerMessagingDevice,
    linkTwilioAccount,
    rememberAuthToken,
} from './twilio';
import {
    ensureAccountCreated,
    ensureTrialStarted,
    handleAppleNotification,
    handleGoogleNotification,
    resolveDeviceEntitlement,
    verifyAppleNotificationSignature,
    verifyApplePurchase,
    verifyEntitlement,
    verifyGooglePurchase,
} from './subscription';
import {
    androidPackageName,
    appleConfig,
    iosApnCertificate,
    pebletSecrets,
    presentedEntitlement,
    pushSecrets,
    requireDeviceUid,
    requireTwilioCredentials,
    subscriptionReverificationConfig,
    twilioPebletSecret,
} from './helpers';
import * as admin from 'firebase-admin';

admin.initializeApp();

// Cost ceiling (docs/edge-hardening-plan.md §6.6): a flood that reaches any
// function — webhook or callable — scales to at most this many instances.
// minInstances stays at the default 0.
setGlobalOptions({ maxInstances: 10 });

/**
 * FCM registration tokens are base64url-ish strings with ':' separators. Checked
 * because the token becomes an RTDB key: anything else (notably '/') could write
 * outside the device record it is stored on.
 */
const FCM_TOKEN = /^[A-Za-z0-9_:-]{1,4096}$/;
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
 * Generate a Twilio Voice access token for THIS DEVICE (identity
 * `<AccountSid>_<uid>`, uid = the caller's anonymous Firebase uid). The push
 * credential SID is read from the DB (persisted by twilioRegister) so incoming
 * calls reach this device.
 *
 * The caller must first prove it holds the account's Auth Token
 * (verifyTwilioCredentials) — 'permission-denied' otherwise.
 *
 * Gated on the PERSON's subscription: the line's trial, or the store entitlement
 * this device presents (resolveDeviceEntitlement). Every call also records the
 * device's check-in and subscription pointer (/twilio/{sid}/devices/{uid}), which
 * is what the inbound webhooks use to ring / notify only entitled devices — so an
 * unsubscribed co-user on a shared line stops receiving calls and SMS
 * notifications without affecting subscribed users. When not entitled it throws
 * 'failed-precondition' 'subscription-expired' instead of minting.
 *
 * IOS https://github.com/twilio/voice-quickstart-ios#6-create-a-push-credential-with-your-voip-service-certificate
 * ANDROID https://github.com/twilio/voice-quickstart-android#7-create-a-push-credential-using-your-fcm-server-key
 */
exports.twilioAccessToken = onCall(
    { enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => {
        const accountSid = req.data['accountSid'];
        const authToken = req.data['authToken'];
        const uid = requireDeviceUid(req.auth?.uid);
        return lastValueFrom(
            requireTwilioCredentials(accountSid, authToken).pipe(
                switchMap(() => deviceSubscription(accountSid, uid)),
                switchMap((current) => resolveDeviceEntitlement(
                    accountSid, presentedEntitlement(req.data), current, subscriptionReverificationConfig(),
                )),
                switchMap(({ entitled, subscription }) => recordDeviceCheckIn(accountSid, uid, subscription).pipe(map(() => entitled))),
                switchMap((entitled) => entitled ?
                    accessToken(accountSid, authToken, req.data['callerId'], uid) :
                    throwError(() => new HttpsError('failed-precondition', 'subscription-expired'))),
                switchMap((jwt) => ensureWebhooksCurrent(accountSid, authToken).pipe(map(() => jwt))),
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
 * Registers (or refreshes) this device's FCM token so twilioIncomingMessage's
 * webhook can push incoming-SMS notifications — including the message text — to
 * it, on this device's record (/twilio/{sid}/devices/{uid}) — pushes then only
 * go to it while its user is entitled (see callbackIncomingMessage). Requires the
 * account's Auth Token (requireTwilioCredentials): otherwise anyone passing App
 * Check could name another tenant's AccountSid and receive that tenant's incoming
 * messages on their own device.
 */
exports.twilioRegisterMessagingDevice = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30 },
    (req) => {
        const accountSid = req.data['accountSid'];
        const fcmToken = req.data['fcmToken'];
        if (typeof fcmToken !== 'string' || !FCM_TOKEN.test(fcmToken)) {
            throw new HttpsError('invalid-argument', 'invalid-fcm-token');
        }
        const uid = requireDeviceUid(req.auth?.uid);
        return lastValueFrom(requireTwilioCredentials(accountSid, req.data['authToken']).pipe(
            switchMap(() => registerMessagingDevice(accountSid, uid, fcmToken)),
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
