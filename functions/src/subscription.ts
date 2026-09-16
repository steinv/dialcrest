import * as crypto from 'crypto';
import { google } from 'googleapis';
import { catchError, from, map, Observable, of, switchMap } from 'rxjs';
import admin from 'firebase-admin';

/**
 * Subscriptions live on TWO independent axes (see SUBSCRIPTION_NOTIFICATIONS.md):
 *
 *  - Trial axis, keyed on accountSid at /twilio/{accountSid}/subscription.
 *    Auto-started on registration (ensureTrialStarted), no store interaction.
 *    A trial is a per-LINE grant: everyone sharing a Twilio account shares it.
 *
 *  - Paid axis, keyed on the STORE identity at /subscriptions/{store}/{id}
 *    (Apple originalTransactionId / Google purchaseToken). A paid subscription
 *    belongs to the PERSON (their Apple ID / Google account), not the line, so
 *    it works on any Twilio account they sign into and two store accounts can
 *    never overwrite each other's record.
 *
 * Enforcement (isSubscriptionActive) is an OR gate: an account can mint a token
 * if its trial is still live OR the device presents an active store entitlement.
 */
type Plan = 'trial' | 'monthly' | 'yearly';
type Store = 'app_store' | 'play_store';

/**
 * Trial record at /twilio/{accountSid}/subscription. Store fields no longer
 * live here — paid state moved to the store-keyed PaidRecord.
 */
interface TrialRecord {
    plan: 'trial';
    trialStartedAt: number;
    expiresAt: number;
    lastVerifiedAt: number;
}

/**
 * Paid record at /subscriptions/{store}/{id}. `expiresAt` is the single field
 * enforcement reads; the rest is bookkeeping for re-verification, notifications,
 * and the Settings UI. This IS the primary record — because App Store Server
 * Notifications / Play RTDN arrive keyed by exactly these store identifiers,
 * no separate reverse index is needed.
 */
interface PaidRecord {
    plan: 'monthly' | 'yearly';
    expiresAt: number;
    autoRenew: boolean;
    store: Store;
    productId: string; // Apple product id, or Android base plan id — see planFromId
    originalTransactionId: string | null; // Apple
    purchaseToken: string | null; // Google
    linkedPurchaseToken: string | null; // Google — previous token this one renewed/replaced
    lastAccountSid: string | null; // last Twilio account that presented this entitlement (informational)
    lastVerifiedAt: number;
}

/** The store entitlement a device presents on a gated request, if it has one. */
export type PresentedEntitlement =
    | { store: 'app_store'; signedTransactionInfo: string }
    | { store: 'play_store'; purchaseToken: string };

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

function planFromId(id: string): 'monthly' | 'yearly' {
    return id === YEARLY_PLAN_ID ? 'yearly' : 'monthly';
}

// ---------------------------------------------------------------------------
// Database refs
// ---------------------------------------------------------------------------

/** Trial axis, keyed on accountSid. Read directly by the app (database.rules.json). */
function trialRef(accountSid: string) {
    return admin.database().ref(`/twilio/${accountSid}/subscription`);
}

/** Paid axis, keyed on the Apple original transaction id. */
function applePaidRef(originalTransactionId: string) {
    return admin.database().ref(`/subscriptions/apple/${originalTransactionId}`);
}

/**
 * Paid axis, keyed on the Google purchase token. Auto-renewals keep the same
 * token, so a renewal updates this same record; a resubscribe after a lapse
 * issues a new token (linked to the old via linkedPurchaseToken) and gets its
 * own record, which is fine — the old one has already expired.
 */
function googlePaidRef(purchaseToken: string) {
    return admin.database().ref(`/subscriptions/google/${encodeURIComponent(purchaseToken)}`);
}

function createdAtRef(accountSid: string) {
    return admin.database().ref(`/twilio/${accountSid}/createdAt`);
}

export function ensureAccountCreated(accountSid: string): Observable<void> {
    const now = Date.now();
    return from(createdAtRef(accountSid).transaction((current) => current ?? now)).pipe(map(() => undefined));
}

function toStatus(state: { expiresAt: number; autoRenew: boolean; productId: string }): SubscriptionStatus {
    return {
        plan: planFromId(state.productId),
        expiresAt: state.expiresAt,
        autoRenew: state.autoRenew,
        isActive: state.expiresAt > Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Trial axis
// ---------------------------------------------------------------------------

/**
 * Starts a 30-day trial for `accountSid` the first time it's seen — a no-op if
 * a trial record already exists. Called from twilioRegister, the existing
 * de-facto "account onboarded" hook (see index.ts), guarded by an RTDB
 * transaction so calling it concurrently/repeatedly never resets an existing
 * trial.
 */
export function ensureTrialStarted(accountSid: string): Observable<void> {
    const now = Date.now();
    const trial: TrialRecord = {
        plan: 'trial',
        trialStartedAt: now,
        expiresAt: now + THIRTY_DAYS_MS,
        lastVerifiedAt: now,
    };
    return from(trialRef(accountSid).transaction((current) => current ?? trial)).pipe(map(() => undefined));
}

/**
 * True if `accountSid`'s trial is still live. A missing record backfills a
 * fresh trial rather than failing closed: normally twilioRegister creates it
 * first, but an account that registered before the subscription system existed
 * would otherwise be locked out permanently.
 */
function trialActive(accountSid: string): Observable<boolean> {
    return from(trialRef(accountSid).once('value')).pipe(
        switchMap((snapshot) => {
            const record = snapshot.val() as TrialRecord | null;
            if (!record) return ensureTrialStarted(accountSid).pipe(map(() => true));
            return of(record.expiresAt > Date.now());
        }),
    );
}

// ---------------------------------------------------------------------------
// Enforcement — the OR gate
// ---------------------------------------------------------------------------

/**
 * True if the account may mint a Voice token: its trial is still live, OR the
 * device presented a store entitlement that re-verifies as active. The trial
 * check is a cheap cached read and runs first, so a trialing user (who has no
 * entitlement to present) never triggers a store round-trip. Re-verifying the
 * presented entitlement also refreshes the paid record, so a renewal that
 * already happened but wasn't yet pushed by a notification still counts.
 */
export function isSubscriptionActive(
    accountSid: string, entitlement: PresentedEntitlement | null, config: ReverificationConfig,
): Observable<boolean> {
    return trialActive(accountSid).pipe(
        switchMap((active) => {
            if (active) return of(true);
            if (!entitlement) return of(false);
            return verifyEntitlement(accountSid, entitlement, config).pipe(
                map((status) => status.isActive),
                catchError((e) => {
                    console.error('Store entitlement re-verification failed', e); return of(false);
                }),
            );
        }),
    );
}

/**
 * Re-verifies a presented store entitlement against the store's server API
 * (the source of truth), updates the paid record, and returns its status.
 * Shared by enforcement and the Settings refresh callable.
 */
export function verifyEntitlement(
    accountSid: string, entitlement: PresentedEntitlement, config: ReverificationConfig,
): Observable<SubscriptionStatus> {
    if (entitlement.store === 'app_store') {
        const { originalTransactionId, productId } =
            decodeAppleSignedPayload<AppleTransactionInfo>(entitlement.signedTransactionInfo);
        return refreshAppleSubscription(accountSid, originalTransactionId, productId, config.apple).pipe(map(toStatus));
    }
    return refreshGoogleSubscription(
        accountSid, entitlement.purchaseToken, config.googlePackageName, config.googleServiceAccountJson,
    ).pipe(map(toStatus));
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
 *
 * NOTE: the client-presented entitlement in verifyEntitlement is decoded here
 * only to read the originalTransactionId; the actual subscription state is then
 * re-fetched from Apple by originalTransactionId, so a forged JWS can't grant
 * access — the worst it can do is name a transaction Apple then reports on.
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

/**
 * Fetches authoritative state for an Apple subscription and writes it to the
 * store-keyed paid record. `accountSid` is recorded only informationally (which
 * account last presented this entitlement); it is not part of the key.
 */
function refreshAppleSubscription(
    accountSid: string | null, originalTransactionId: string, productIdHint: string, config: AppleConfig,
): Observable<{ expiresAt: number; autoRenew: boolean; productId: string }> {
    return from(fetchAppleSubscriptionStatuses(originalTransactionId, config)).pipe(
        map((body) => extractAppleSubscriptionState(body, productIdHint)),
        switchMap((state) => {
            const record: PaidRecord = {
                plan: planFromId(state.productId),
                expiresAt: state.expiresAt,
                autoRenew: state.autoRenew,
                store: 'app_store',
                productId: state.productId,
                originalTransactionId,
                purchaseToken: null,
                linkedPurchaseToken: null,
                lastAccountSid: accountSid,
                lastVerifiedAt: Date.now(),
            };
            return from(applePaidRef(originalTransactionId).update(record)).pipe(map(() => state));
        }),
    );
}

/**
 * Re-verifies an Apple subscription by original transaction id — used by the
 * App Store Server Notifications handler, which receives the id but no
 * account/product context.
 */
export function refreshAppleByOriginalTransactionId(
    originalTransactionId: string, config: AppleConfig,
): Observable<SubscriptionStatus> {
    // Empty product hint → extractAppleSubscriptionState falls back to the
    // furthest-future transaction, which is the currently-active plan.
    return refreshAppleSubscription(null, originalTransactionId, '', config).pipe(map(toStatus));
}

interface AppleNotificationPayload {
    notificationType: string;
    subtype?: string;
    data?: { signedTransactionInfo?: string; signedRenewalInfo?: string };
}

/**
 * Handles one App Store Server Notification V2 (its decoded `signedPayload`).
 *
 * TRUST MODEL: this only reads the `originalTransactionId` out of the
 * notification and then re-fetches authoritative state from Apple's Server API
 * (authenticated with our own key) — it never trusts the expiry/renewal values
 * the notification carries. So a forged notification cannot inject subscription
 * state; at worst it names a real transaction (which we'd refresh accurately)
 * or a bogus one (which 404s). The remaining reason to verify the JWS signature
 * is to reject spam/DoS at the edge — see the note in index.ts and
 * SUBSCRIPTION_NOTIFICATIONS.md for adding app-store-server-library-based
 * signature verification as hardening.
 */
export function handleAppleNotification(signedPayload: string, config: AppleConfig): Observable<void> {
    const payload = decodeAppleSignedPayload<AppleNotificationPayload>(signedPayload);
    const signedTx = payload.data?.signedTransactionInfo;
    if (!signedTx) {
        console.log(`Apple notification ${payload.notificationType} carries no transaction info; ignoring`);
        return of(undefined);
    }
    const { originalTransactionId } = decodeAppleSignedPayload<AppleTransactionInfo>(signedTx);
    return refreshAppleByOriginalTransactionId(originalTransactionId, config).pipe(
        map(() => undefined),
        catchError((e) => {
            console.error(`Apple notification ${payload.notificationType} refresh failed`, e);
            return of(undefined);
        }),
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

/**
 * Fetches authoritative state for a Google subscription and writes it to the
 * store-keyed paid record. `accountSid` is recorded only informationally.
 */
function refreshGoogleSubscription(
    accountSid: string | null, purchaseToken: string, packageName: string, serviceAccountJson: string,
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
            const record: PaidRecord = {
                plan: planFromId(state.productId),
                expiresAt: state.expiresAt,
                autoRenew: state.autoRenew,
                store: 'play_store',
                productId: state.productId,
                originalTransactionId: null,
                purchaseToken,
                linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
                lastAccountSid: accountSid,
                lastVerifiedAt: Date.now(),
            };
            return acknowledge$.pipe(
                switchMap(() => from(googlePaidRef(purchaseToken).update(record))),
                map(() => state),
            );
        }),
    );
}

/**
 * Re-verifies a Google subscription by purchase token — used by the Play RTDN
 * handler, which receives the token but no account context.
 */
export function refreshGoogleByPurchaseToken(
    purchaseToken: string, packageName: string, serviceAccountJson: string,
): Observable<SubscriptionStatus> {
    return refreshGoogleSubscription(null, purchaseToken, packageName, serviceAccountJson).pipe(map(toStatus));
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
