/**
 * Push secrets live in a SINGLE Secret Manager secret, TWILIO_PEBLET_SECRET,
 * holding both push keys as JSON: { android_fcm: {<FCM v1 service-account>},
 * ios_apn_pk: "<APN private key PEM>" }. One secret instead of two keeps the
 * Secret Manager cost down. Locally it's read from functions/.secret.local.
 * https://firebase.google.com/docs/functions/config-env#secrets
 *
 * Manage with:
 *   firebase functions:secrets:set     TWILIO_PEBLET_SECRET  # set / rotate
 *   firebase functions:secrets:access  TWILIO_PEBLET_SECRET  # view
 *   firebase functions:secrets:destroy TWILIO_PEBLET_SECRET  # delete
 *   firebase functions:secrets:prune                         # remove unreferenced
 */

import { HttpsError, onRequest, onCall } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { lastValueFrom, switchMap, throwError } from 'rxjs';
import {
    callbackCallStatusChanges,
    callbackIncomingCall,
    callbackOutgoingCall,
    createOrUpdatePushCredentials,
    accessToken,
    getIncomingAppSid,
    configureSelectedNumbers,
} from './twilio';
import {
    AppleConfig,
    ReverificationConfig,
    ensureTrialStarted,
    isSubscriptionActive,
    verifyApplePurchase,
    verifyGooglePurchase,
} from './subscription';
import * as admin from 'firebase-admin';

admin.initializeApp();

const twilioPebletSecret = defineSecret('TWILIO_PEBLET_SECRET');

// Empty until iOS push is enabled — when empty, createOrUpdatePushCredentials skips the iOS branch.
// See README "Enabling iOS push" for how to obtain and configure it.
const iosApnCertificate = defineString('IOS_APN_CERTIFICATE', { default: '' });

// App Store Connect "In-App Purchase" API key, as JSON: {issuerId, keyId, privateKey, bundleId}.
// Used to call the App Store Server API to verify/re-verify subscription purchases.
const appleIapKeySecret = defineSecret('APPLE_IAP_KEY');
// Google Play service-account JSON with access to this app's subscription data,
// used to call the Play Developer API to verify/re-verify subscription purchases.
const googlePlayServiceAccountSecret = defineSecret('GOOGLE_PLAY_SERVICE_ACCOUNT');
const androidPackageName = defineString('ANDROID_PACKAGE_NAME', { default: '' });

function appleConfig(): AppleConfig {
    return JSON.parse(appleIapKeySecret.value()) as AppleConfig;
}

function subscriptionReverificationConfig(): ReverificationConfig {
    return {
        apple: appleConfig(),
        googlePackageName: androidPackageName.value(),
        googleServiceAccountJson: googlePlayServiceAccountSecret.value(),
    };
}

/**
 * Unpack the combined secret into the individual values the Twilio helpers want.
 * androidFcmSecret must be the FCM service-account JSON as a string.
 */
function pushSecrets(): { androidFcmSecret: string; iosApnPrivateKey: string } {
    const parsed = JSON.parse(twilioPebletSecret.value());
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

/**
 * Each user brings their own Twilio account (multi-tenant). On login the app
 * calls this with the user's Twilio accountSid/authToken; we create (or update)
 * the FCM/APN push credential in THAT account using our shared FCM secret, and
 * persist the resulting CR... SID(s) under /twilio/{accountSid}/push-credential.
 * Also the de-facto "account onboarded" hook: starts this account's 30-day
 * trial the first time it's ever seen (see ensureTrialStarted).
 */
exports.twilioRegister = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [twilioPebletSecret] },
    (req) => {
        const { androidFcmSecret, iosApnPrivateKey } = pushSecrets();
        const accountSid = req.data['accountSid'];
        return lastValueFrom(
            ensureTrialStarted(accountSid).pipe(
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
    { enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [appleIapKeySecret, googlePlayServiceAccountSecret] },
    (req) => {
        const accountSid = req.data['accountSid'];
        return lastValueFrom(
            isSubscriptionActive(accountSid, subscriptionReverificationConfig()).pipe(
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
exports.twilioVerifyApplePurchase = onCall({ enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [appleIapKeySecret] },
    (req) => lastValueFrom(verifyApplePurchase(req.data['accountSid'], req.data['signedTransactionInfo'], appleConfig()))
);

/**
 * Verifies a subscription purchase the client just made against the Google
 * Play Developer API (not the client-supplied purchase token alone), and
 * persists the resulting expiry/auto-renew state.
 */
exports.twilioVerifyGooglePurchase = onCall(
    { enforceAppCheck: true, region: REGION, cors: true, timeoutSeconds: 30, secrets: [googlePlayServiceAccountSecret] },
    (req) => lastValueFrom(verifyGooglePurchase(
        req.data['accountSid'], req.data['purchaseToken'], androidPackageName.value(), googlePlayServiceAccountSecret.value(),
    ))
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
