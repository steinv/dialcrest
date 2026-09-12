import * as crypto from 'crypto';
import { google } from 'googleapis';
import { catchError, from, map, Observable, of, switchMap } from 'rxjs';
import admin from 'firebase-admin';

/**
 * Per-accountSid subscription record, stored at /twilio/{accountSid}/subscription.
 * `expiresAt` is the single field enforcement reads (see isSubscriptionActive);
 * everything else is bookkeeping for re-verification and the Settings UI.
 */
type Plan = 'trial' | 'monthly' | 'yearly';
type Store = 'app_store' | 'play_store';

interface SubscriptionRecord {
    plan: Plan;
    expiresAt: number;
    trialStartedAt: number;
    autoRenew: boolean;
    store: Store | null;
    productId: string | null; // Apple product id, or Android base plan id — see planFromId
    originalTransactionId: string | null; // Apple
    purchaseToken: string | null; // Google
    lastVerifiedAt: number;
}

export interface SubscriptionStatus {
    plan: Plan;
    expiresAt: number;
    autoRenew: boolean;
    isActive: boolean;
}

export interface AppleConfig {
    issuerId: string;
    keyId: string;
    privateKey: string;
    bundleId: string;
}

export interface ReverificationConfig {
    apple: AppleConfig;
    googlePackageName: string;
    googleServiceAccountJson: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 'monthly-dialcrest-license' / 'yearly-dialcrest-license'. On iOS these are
 * the literal App Store Connect product ids (Apple has no "base plan"
 * concept). On Android they're the Play Console base plan ids under the
 * single 'dialcrest' product (see ANDROID_PRODUCT_ID) — Play Billing groups
 * both plans into one product, so the store-level product id can't tell them
 * apart, only the base plan id can.
 */
const YEARLY_PLAN_ID = 'yearly-dialcrest-license';

/** The single Play Console product both Android base plans live under. */
const ANDROID_PRODUCT_ID = 'dialcrest';

function planFromId(id: string): Plan {
    return id === YEARLY_PLAN_ID ? 'yearly' : 'monthly';
}

function subscriptionRef(accountSid: string) {
    return admin.database().ref(`/twilio/${accountSid}/subscription`);
}

function createdAtRef(accountSid: string) {
    return admin.database().ref(`/twilio/${accountSid}/createdAt`);
}

export function ensureAccountCreated(accountSid: string): Observable<void> {
    const now = Date.now();
    return from(createdAtRef(accountSid).transaction((current) => current ?? now)).pipe(map(() => undefined));
}

function upsertSubscription(accountSid: string, fields: Partial<SubscriptionRecord>): Promise<void> {
    return subscriptionRef(accountSid).update({ ...fields, lastVerifiedAt: Date.now() });
}

function toStatus(state: { expiresAt: number; autoRenew: boolean; productId: string }): SubscriptionStatus {
    return {
        plan: planFromId(state.productId),
        expiresAt: state.expiresAt,
        autoRenew: state.autoRenew,
        isActive: state.expiresAt > Date.now(),
    };
}

/**
 * Starts a 30-day trial for `accountSid` the first time it's seen — a no-op if
 * a subscription record already exists. Called from twilioRegister, the
 * existing de-facto "account onboarded" hook (see index.ts), guarded by an
 * RTDB transaction so calling it concurrently/repeatedly never resets an
 * existing trial or overwrites a paid subscription.
 */
export function ensureTrialStarted(accountSid: string): Observable<void> {
    const now = Date.now();
    const trial: SubscriptionRecord = {
        plan: 'trial',
        trialStartedAt: now,
        expiresAt: now + THIRTY_DAYS_MS,
        autoRenew: false,
        store: null,
        productId: null,
        originalTransactionId: null,
        purchaseToken: null,
        lastVerifiedAt: now,
    };
    return from(subscriptionRef(accountSid).transaction((current) => current ?? trial)).pipe(map(() => undefined));
}

/**
 * True if `accountSid`'s cached expiry is still in the future. If it's in the
 * past but the record has store purchase identifiers, re-verifies against the
 * Apple/Google server APIs once before answering — so a renewal that already
 * happened but hasn't been polled yet doesn't wrongly lock the user out. A
 * bare trial (no store) just expires with no re-check.
 *
 * A missing record backfills a fresh trial rather than failing closed: normally
 * twilioRegister (see ensureTrialStarted) creates it first, but an account that
 * registered before the subscription system existed would otherwise never get
 * one and would be locked out permanently.
 */
export function isSubscriptionActive(accountSid: string, config: ReverificationConfig): Observable<boolean> {
    return from(subscriptionRef(accountSid).once('value')).pipe(
        switchMap((snapshot) => {
            const record = snapshot.val() as SubscriptionRecord | null;
            if (!record) return ensureTrialStarted(accountSid).pipe(map(() => true));
            if (record.expiresAt > Date.now()) return of(true);

            if (record.store === 'app_store' && record.originalTransactionId) {
                return refreshAppleSubscription(accountSid, record.originalTransactionId, record.productId ?? '', config.apple).pipe(
                    map((state) => state.expiresAt > Date.now()),
                    catchError((e) => {
                        console.error('Apple subscription re-verification failed', e); return of(false);
                    }),
                );
            }
            if (record.store === 'play_store' && record.purchaseToken) {
                return refreshGoogleSubscription(
                    accountSid, record.purchaseToken, config.googlePackageName, config.googleServiceAccountJson,
                ).pipe(
                    map((state) => state.expiresAt > Date.now()),
                    catchError((e) => {
                        console.error('Google subscription re-verification failed', e); return of(false);
                    }),
                );
            }
            return of(false);
        }),
    );
}

// ---------------------------------------------------------------------------
// Apple App Store Server API
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
    return Buffer.from(input as never).toString('base64url');
}

/**
 * Signs a JWT for authenticating to Apple's App Store Server API, per
 * https://developer.apple.com/documentation/appstoreserverapi/generating-json-web-tokens-for-api-requests.
 * Hand-rolled with Node's `crypto` (rather than a JWT library) to avoid an
 * extra dependency for what's a few lines: an ES256-signed header.payload.
 */
function signAppleServerJwt(config: AppleConfig): string {
    const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: config.issuerId, iat: now, exp: now + 5 * 60, aud: 'appstoreconnect-v1', bid: config.bundleId };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    // App Store Connect API keys are P-256 (ES256); Node's crypto.sign defaults to a
    // DER-encoded signature, but JWS needs the raw fixed-length r||s ("ieee-p1363") form.
    const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: config.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${signingInput}.${base64url(signature)}`;
}

/**
 * Decodes (without verifying the signature) the payload of an Apple-signed
 * JWS, e.g. a `signedTransactionInfo`/`signedRenewalInfo` value. Trust here
 * comes from the transport: this is only ever called on values we fetched
 * ourselves directly from Apple's server API over an authenticated HTTPS
 * call, not on anything the client hands us — see refreshAppleSubscription.
 */
function decodeAppleSignedPayload<T>(signedPayload: string): T {
    const [, payload] = signedPayload.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
}

interface AppleTransactionInfo {
    transactionId: string;
    originalTransactionId: string;
    productId: string;
    expiresDate: number;
}

interface AppleRenewalInfo {
    autoRenewStatus: 0 | 1;
}

interface AppleSubscriptionStatusesResponse {
    data: Array<{ lastTransactions: Array<{ signedTransactionInfo: string; signedRenewalInfo: string }> }>;
}

/** https://developer.apple.com/documentation/appstoreserverapi/get-all-subscription-statuses */
async function fetchAppleSubscriptionStatuses(originalTransactionId: string, config: AppleConfig): Promise<AppleSubscriptionStatusesResponse> {
    const token = signAppleServerJwt(config);
    // A single build can produce transactions from either environment (sandbox
    // testers vs real purchases); Apple's own guidance is to try production
    // first and fall back to sandbox on a 404 rather than tracking which
    // environment a given transaction came from.
    const bases = ['https://api.storekit.itunes.apple.com', 'https://api.storekit-sandbox.itunes.apple.com'];
    for (const base of bases) {
        const response = await fetch(`${base}/inApps/v1/subscriptions/${originalTransactionId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) return response.json() as Promise<AppleSubscriptionStatusesResponse>;
        if (response.status !== 404) {
            throw new Error(`Apple subscription status lookup failed: ${response.status} ${await response.text()}`);
        }
    }
    throw new Error(`Apple transaction ${originalTransactionId} not found in production or sandbox`);
}

/**
 * Picks the subscription-status entry matching `productIdHint` out of Apple's
 * response (falling back to the one expiring furthest in the future — covers
 * plan upgrade/downgrade, where the active product can differ from the one
 * originally purchased), and decodes it into the fields we persist.
 */
function extractAppleSubscriptionState(body: AppleSubscriptionStatusesResponse, productIdHint: string) {
    const entries = (body.data ?? []).flatMap((group) => group.lastTransactions ?? []);
    const decoded = entries.map((entry) => ({
        tx: decodeAppleSignedPayload<AppleTransactionInfo>(entry.signedTransactionInfo),
        renewal: decodeAppleSignedPayload<AppleRenewalInfo>(entry.signedRenewalInfo),
    }));
    const match = decoded.find((d) => d.tx.productId === productIdHint) ??
        decoded.sort((a, b) => b.tx.expiresDate - a.tx.expiresDate)[0];
    if (!match) throw new Error(`No subscription transactions found for product ${productIdHint}`);
    return { productId: match.tx.productId, expiresAt: match.tx.expiresDate, autoRenew: match.renewal.autoRenewStatus === 1 };
}

function refreshAppleSubscription(
    accountSid: string, originalTransactionId: string, productIdHint: string, config: AppleConfig,
): Observable<{ expiresAt: number; autoRenew: boolean; productId: string }> {
    return from(fetchAppleSubscriptionStatuses(originalTransactionId, config)).pipe(
        map((body) => extractAppleSubscriptionState(body, productIdHint)),
        switchMap((state) => from(upsertSubscription(accountSid, {
            plan: planFromId(state.productId),
            expiresAt: state.expiresAt,
            autoRenew: state.autoRenew,
            store: 'app_store',
            productId: state.productId,
            originalTransactionId,
            purchaseToken: null,
        })).pipe(map(() => state))),
    );
}

/**
 * Verifies a purchase the client just made, using the App Store Server API
 * (not the client-supplied receipt alone) as the source of truth for the
 * actual expiry/auto-renew state.
 */
export function verifyApplePurchase(accountSid: string, signedTransactionInfo: string, config: AppleConfig): Observable<SubscriptionStatus> {
    const { originalTransactionId, productId } = decodeAppleSignedPayload<AppleTransactionInfo>(signedTransactionInfo);
    return refreshAppleSubscription(accountSid, originalTransactionId, productId, config).pipe(map(toStatus));
}

// ---------------------------------------------------------------------------
// Google Play Developer API
// ---------------------------------------------------------------------------

function androidPublisherClient(serviceAccountJson: string) {
    const credentials = JSON.parse(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    return google.androidpublisher({ version: 'v3', auth });
}

function refreshGoogleSubscription(
    accountSid: string, purchaseToken: string, packageName: string, serviceAccountJson: string,
): Observable<{ expiresAt: number; autoRenew: boolean; productId: string }> {
    const client = androidPublisherClient(serviceAccountJson);
    return from(client.purchases.subscriptionsv2.get({ packageName, token: purchaseToken })).pipe(
        switchMap((response) => {
            const purchase = response.data;
            // Only one product ('dialcrest') is ever purchased, so there's exactly one line item.
            const lineItem = purchase.lineItems?.[0];
            if (!lineItem?.expiryTime) throw new Error(`Google subscription lookup returned no line items for token ${purchaseToken}`);
            const state = {
                expiresAt: new Date(lineItem.expiryTime).getTime(),
                autoRenew: Boolean(lineItem.autoRenewingPlan?.autoRenewEnabled),
                // The base plan id ('monthly-dialcrest-license'/'yearly-dialcrest-license') is
                // what distinguishes the plan — the product id itself is always ANDROID_PRODUCT_ID.
                productId: lineItem.offerDetails?.basePlanId ?? '',
            };
            // Required within 3 days of purchase or Google auto-refunds it; a no-op on renewals.
            // Annotated as Observable<unknown>: a bare ternary here produces a union of two
            // differently-typed Observables, and `.pipe()` can't resolve a common multi-operator
            // overload across that union (it silently falls back to the 0-arg identity overload).
            const acknowledge$: Observable<unknown> = purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' ?
                from(client.purchases.subscriptions.acknowledge({
                    packageName, subscriptionId: lineItem.productId ?? ANDROID_PRODUCT_ID, token: purchaseToken, requestBody: {},
                })) :
                of(null);
            return acknowledge$.pipe(
                switchMap(() => from(upsertSubscription(accountSid, {
                    plan: planFromId(state.productId),
                    expiresAt: state.expiresAt,
                    autoRenew: state.autoRenew,
                    store: 'play_store',
                    productId: state.productId,
                    originalTransactionId: null,
                    purchaseToken,
                }))),
                map(() => state),
            );
        }),
    );
}

/**
 * Verifies a purchase the client just made, using the Google Play Developer
 * API (not the client-supplied purchase token alone) as the source of truth
 * for the actual expiry/auto-renew state and which plan (base plan id) was
 * bought — the client never tells us which plan, since both live under the
 * same 'dialcrest' product id.
 */
export function verifyGooglePurchase(
    accountSid: string, purchaseToken: string, packageName: string, serviceAccountJson: string,
): Observable<SubscriptionStatus> {
    return refreshGoogleSubscription(accountSid, purchaseToken, packageName, serviceAccountJson).pipe(map(toStatus));
}
