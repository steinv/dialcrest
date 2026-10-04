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

/**
 * Helpers shared by the Cloud Functions in index.ts: secret/param access,
 * entitlement parsing, and the guards callables run before granting anything.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { catchError, from, throwError } from 'rxjs';
import { InvalidTwilioCredentialsError, verifyTwilioCredentials } from './twilio';
import { AppleConfig, PresentedEntitlement, ReverificationConfig } from './subscription';
import { DEVICE_UID } from './shared/webhooks';

export const twilioPebletSecret = defineSecret('TWILIO_PEBLET_SECRET');

// Empty until iOS push is enabled — when empty, createOrUpdatePushCredentials skips the iOS branch.
// See README "Enabling iOS push" for how to obtain and configure it.
export const iosApnCertificate = defineString('IOS_APN_CERTIFICATE', { default: '' });
export const androidPackageName = defineString('ANDROID_PACKAGE_NAME', { default: 'be.peblet.twilio_phone' });

export interface PebletSecrets {
    android_fcm?: object;
    ios_apn_pk?: string;
    apple_iap_key?: AppleConfig;
}

export function pebletSecrets(): PebletSecrets {
    return JSON.parse(twilioPebletSecret.value()) as PebletSecrets;
}

export function appleConfig(): AppleConfig {
    return pebletSecrets().apple_iap_key ?? ({} as AppleConfig);
}

/**
 * Reads the optional store entitlement a device attaches to a gated request
 * (twilioAccessToken) or a status refresh. iOS sends `signedTransactionInfo`
 * (a StoreKit JWS), Android sends `purchaseToken`; a device that has never
 * purchased sends neither, and gets null.
 */
export function presentedEntitlement(data: Record<string, unknown>): PresentedEntitlement | null {
    if (typeof data['signedTransactionInfo'] === 'string' && data['signedTransactionInfo']) {
        return { store: 'app_store', signedTransactionInfo: data['signedTransactionInfo'] };
    }
    if (typeof data['purchaseToken'] === 'string' && data['purchaseToken']) {
        return { store: 'play_store', purchaseToken: data['purchaseToken'] };
    }
    return null;
}

export function subscriptionReverificationConfig(): ReverificationConfig {
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
export function pushSecrets(): { androidFcmSecret: string; iosApnPrivateKey: string } {
    const parsed = pebletSecrets();
    return {
        androidFcmSecret: JSON.stringify(parsed.android_fcm ?? {}),
        iosApnPrivateKey: parsed.ios_apn_pk ?? '',
    };
}

/**
 * The caller's anonymous Firebase uid, which keys its device record and becomes
 * part of its Voice identity. The app signs in anonymously at startup
 * (AccountAuthService.ensureSignedIn), so a missing uid is 'unauthenticated'.
 */
export function requireDeviceUid(uid: string | undefined): string {
    if (typeof uid !== 'string' || !DEVICE_UID.test(uid)) {
        throw new HttpsError('unauthenticated', 'device-identity-required');
    }
    return uid;
}

/**
 * Proves the caller holds a valid Auth Token for `accountSid` (verifyTwilioCredentials)
 * before a callable grants anything for that account — App Check proves a genuine
 * app, not account ownership. 'permission-denied' when Twilio rejects the token.
 */
export function requireTwilioCredentials(accountSid: unknown, authToken: unknown) {
    return from(verifyTwilioCredentials(accountSid as string, authToken as string)).pipe(
        catchError((e) => throwError(() => e instanceof InvalidTwilioCredentialsError ?
            new HttpsError('permission-denied', 'invalid-twilio-credentials') :
            e)),
    );
}
