// Must precede @apple/app-store-server-library, whose jsonwebtoken → jwa chain
// reads buffer.SlowBuffer at load time (removed in Node 24+). See slowBufferShim.ts.
import './slowBufferShim';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import { Environment, SignedDataVerifier, VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { catchError, defer, from, map, Observable, of, switchMap } from 'rxjs';
import admin from 'firebase-admin';

/**
 * Licenses live on TWO independent axes (see SUBSCRIPTION_NOTIFICATIONS.md):
 *
 *  - License override, keyed on accountSid at /twilio/{accountSid}/licenseOverride:
 *    an epoch-ms timestamp set by hand (Firebase console), never by code. It
 *    licenses every device on the LINE until then — for ourselves, trusted
 *    partners and the store review accounts. Absent for everyone else.
 *
 *  - Paid axis, keyed on the STORE identity at /subscriptions/{store}/{id}
 *    (Apple originalTransactionId / Google purchaseToken). A paid subscription
 *    belongs to the PERSON (their Apple ID / Google account), not the line, so
 *    it works on any Twilio account they sign into and two store accounts can
 *    never overwrite each other's record. New subscribers start with the
 *    store's own 30-day free trial (configured in App Store Connect / Play
 *    Console), which the store reports as an active subscription.
 *
 * Enforcement (isSubscriptionActive) is an OR gate: an account can mint a token
 * if its license override is live OR the device presents an active store entitlement.
 */
type Plan = 'monthly' | 'yearly';
type Store = 'app_store' | 'play_store';

/**
 * Paid record at /subscriptions/{store}/{id}. `expiresAt` is the single field
 * enforcement reads; the rest is bookkeeping for re-verification, notifications,
 * and the Settings UI. This IS the primary record — because App Store Server
 * Notifications / Play RTDN arrive keyed by exactly these store identifiers,
 * no separate reverse index is needed.
 */
interface PaidRecord {
    plan: Plan;
    expiresAt: number;
    autoRenew: boolean;
    /** In the store's free-trial period; `expiresAt` is then the trial's end. */
    freeTrial: boolean;
    store: Store;
    productId: string; // Apple product id, or Android base plan id — see planFromId
    originalTransactionId: string | null; // Apple
    purchaseToken: string | null; // Google
    linkedPurchaseToken: string | null; // Google — previous token this one renewed/replaced
    // Last Twilio account that presented this entitlement (informational). A store
    // notification carries no account, so it never overwrites this with null —
    // see buildPaidRecord.
    lastAccountSid?: string | null;
    lastVerifiedAt: number;
}

/** The store entitlement a device presents on a gated request, if it has one. */
export type PresentedEntitlement =
    | { store: 'app_store'; signedTransactionInfo: string }
    | { store: 'play_store'; purchaseToken: string };

/** Re-verified store state, plus the path of the store record it was written to. */
interface PaidState {
    expiresAt: number;
    autoRenew: boolean;
    productId: string;
    freeTrial: boolean;
    /** e.g. `subscriptions/apple/123` — what a device's `subscription` pointer stores. */
    recordPath: string;
}

export interface SubscriptionStatus {
    plan: Plan;
    expiresAt: number;
    autoRenew: boolean;
    freeTrial: boolean;
    isActive: boolean;
}

export interface AppleConfig {
    issuerId: string;
    keyId: string;
    privateKey: string;
    bundleId: string;
    /**
     * The app's numeric Apple ID (App Store Connect → App Information → Apple ID).
     * Required to verify PRODUCTION App Store data (notifications and purchases
     * the app presents); without it only Sandbox verifies. A numeric string is
     * accepted too (see configuredAppAppleId).
     */
    appAppleId?: number | string;
}

export interface ReverificationConfig {
    apple: AppleConfig;
    googlePackageName: string;
    googleServiceAccountJson: string;
}

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

/**
 * Play offers whose id starts with this are the free-trial offers (Play Console
 * → dialcrest → each base plan → offer `free-trial-monthly` / `free-trial-yearly`).
 */
const GOOGLE_FREE_TRIAL_OFFER_PREFIX = 'free-trial';

/** Upper bound on a store free trial (30 days, plus slack for the store's own rounding). */
const MAX_FREE_TRIAL_MS = 32 * 24 * 60 * 60 * 1000;

function planFromId(id: string): Plan {
    return id === YEARLY_PLAN_ID ? 'yearly' : 'monthly';
}

// ---------------------------------------------------------------------------
// Database refs
// ---------------------------------------------------------------------------

/** License override, keyed on accountSid. Read directly by the app (database.rules.json). */
function licenseOverrideRef(accountSid: string) {
    return admin.database().ref(`/twilio/${accountSid}/licenseOverride`);
}

/** Paid axis, keyed on the Apple original transaction id. */
function applePaidRef(originalTransactionId: string) {
    return admin.database().ref(`/subscriptions/apple/${encodeDbKey(originalTransactionId)}`);
}

/**
 * Escapes a store identifier for use as a single Realtime Database key.
 * `encodeURIComponent` covers every RTDB-forbidden character (`/`, `#`, `$`,
 * `[`, `]`, and control chars) EXCEPT `.`, which it leaves untouched — so a
 * Google purchase token containing a `.` (they do occur) would otherwise reach
 * `.ref()` unescaped and throw "invalid path". We escape `.` explicitly
 * afterwards; since `%` is itself percent-encoded (to `%25`), `%2E` can never
 * collide with an escaped literal `.`, so the mapping stays injective (distinct
 * identifiers → distinct keys). Backward compatible: an identifier with no
 * forbidden character (e.g. Apple's numeric originalTransactionId, or a
 * dot-free purchase token) encodes to itself.
 */
function encodeDbKey(key: string): string {
    return encodeURIComponent(key).replace(/\./g, '%2E');
}

/** Path (no leading slash) of the store-keyed paid record for `key` — matches applePaidRef/googlePaidRef. */
function paidRecordPath(store: Store, key: string): string {
    return `subscriptions/${store === 'app_store' ? 'apple' : 'google'}/${encodeDbKey(key)}`;
}

/**
 * Paid axis, keyed on the Google purchase token. Auto-renewals normally keep
 * the same token, but some events (upgrade/downgrade, resubscribe) rotate it
 * and link the new token to the old one via `linkedPurchaseToken` — see
 * resolveGooglePaidKey, which chases that link so the record stays keyed on
 * the chain root instead of forking a new record per rotation.
 */
function googlePaidRef(key: string) {
    return admin.database().ref(`/subscriptions/google/${encodeDbKey(key)}`);
}

/**
 * A redirect node left at a superseded purchase token, naming the chain root
 * where the real record lives. Distinct in shape from a PaidRecord (which has
 * no `redirectTo`), so a single read tells the two apart — see
 * resolveGooglePaidKey / writeGooglePaidRecord.
 */
interface GooglePaidRedirect {
    redirectTo: string;
}

function isGooglePaidRedirect(value: unknown): value is GooglePaidRedirect {
    return typeof value === 'object' && value !== null &&
        typeof (value as GooglePaidRedirect).redirectTo === 'string';
}

/**
 * Resolves the DB key a Google paid record lives (or should live) under,
 * following the linkedPurchaseToken chain to its root. Play rotates the token
 * on upgrade/downgrade/resubscribe and sets the new token's linkedPurchaseToken
 * to the token it *directly* replaced (not the chain root). The record stays at
 * the chain root and writeGooglePaidRecord leaves a redirect at every superseded
 * token pointing straight at that root, so one lookup of the linked token always
 * resolves the whole chain, however long:
 *   - no node        → the linked token is unknown; start a fresh chain here
 *   - redirect node  → a superseded token; its record lives at `redirectTo`
 *   - full record    → the linked token is itself the chain root
 */
function resolveGooglePaidKey(purchaseToken: string, linkedPurchaseToken: string | null): Observable<string> {
    if (!linkedPurchaseToken) return of(purchaseToken);
    return from(googlePaidRef(linkedPurchaseToken).once('value')).pipe(
        map((snapshot) => {
            if (!snapshot.exists()) return purchaseToken;
            const value = snapshot.val();
            return isGooglePaidRedirect(value) ? value.redirectTo : linkedPurchaseToken;
        }),
    );
}

/**
 * Writes a Google paid record at its chain root and, when the active token has
 * rotated away from that root, leaves a redirect at the active token's key so
 * the *next* rotation — which will link back to this token — resolves to the
 * root in one hop instead of forking a new record (see resolveGooglePaidKey).
 * The redirect is written via a transaction so it can never clobber a full
 * record that already happens to live at that key.
 */
function writeGooglePaidRecord(rootKey: string, purchaseToken: string, record: PaidRecord): Observable<void> {
    const writeRecord$ = from(googlePaidRef(rootKey).update(record));
    if (purchaseToken === rootKey) return writeRecord$.pipe(map(() => undefined));
    return writeRecord$.pipe(
        switchMap(() => from(googlePaidRef(purchaseToken).transaction(
            (current) => (current && !isGooglePaidRedirect(current) ? current : { redirectTo: rootKey }),
        ))),
        map(() => undefined),
    );
}

function createdAtRef(accountSid: string) {
    return admin.database().ref(`/twilio/${accountSid}/createdAt`);
}

export function ensureAccountCreated(accountSid: string): Observable<void> {
    const now = Date.now();
    return from(createdAtRef(accountSid).transaction((current) => current ?? now)).pipe(map(() => undefined));
}

function toStatus(state: { expiresAt: number; autoRenew: boolean; productId: string; freeTrial: boolean }): SubscriptionStatus {
    return {
        plan: planFromId(state.productId),
        expiresAt: state.expiresAt,
        autoRenew: state.autoRenew,
        freeTrial: state.freeTrial,
        isActive: state.expiresAt > Date.now(),
    };
}

/**
 * Builds a PaidRecord from re-verified store state plus the store-specific
 * identifiers. With no `accountSid` (a store notification), lastAccountSid is
 * left out rather than set to null: records are written with update(), so this
 * keeps the account that last presented the entitlement instead of erasing it.
 */
function buildPaidRecord(
    accountSid: string | null,
    state: { expiresAt: number; autoRenew: boolean; productId: string; freeTrial: boolean },
    storeFields: Pick<PaidRecord, 'store' | 'originalTransactionId' | 'purchaseToken' | 'linkedPurchaseToken'>,
): PaidRecord {
    return {
        plan: planFromId(state.productId),
        expiresAt: state.expiresAt,
        autoRenew: state.autoRenew,
        freeTrial: state.freeTrial,
        productId: state.productId,
        ...(accountSid === null ? {} : { lastAccountSid: accountSid }),
        lastVerifiedAt: Date.now(),
        ...storeFields,
    };
}

// ---------------------------------------------------------------------------
// License override
// ---------------------------------------------------------------------------

/** True if `accountSid` has a license override that hasn't expired. Anything but a number counts as none. */
function overrideActive(accountSid: string): Observable<boolean> {
    return from(licenseOverrideRef(accountSid).once('value')).pipe(
        map((snapshot) => {
            const until: unknown = snapshot.val();
            return typeof until === 'number' && until > Date.now();
        }),
    );
}

// ---------------------------------------------------------------------------
// Enforcement — the OR gate
// ---------------------------------------------------------------------------

/**
 * True if the account may mint a Voice token: its license override is live, OR
 * the device presented a store entitlement that re-verifies as active. The
 * override check is a cheap cached read and runs first, so an overridden line
 * never triggers a store round-trip. Re-verifying the
 * presented entitlement also refreshes the paid record, so a renewal that
 * already happened but wasn't yet pushed by a notification still counts.
 */
export function isSubscriptionActive(
    accountSid: string, entitlement: PresentedEntitlement | null, config: ReverificationConfig,
): Observable<boolean> {
    return overrideActive(accountSid).pipe(
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
    return verifyEntitlementState(accountSid, entitlement, config).pipe(map(toStatus));
}

function verifyEntitlementState(
    accountSid: string, entitlement: PresentedEntitlement, config: ReverificationConfig,
): Observable<PaidState> {
    if (entitlement.store === 'app_store') {
        return from(verifyPresentedAppleTransaction(entitlement.signedTransactionInfo, config.apple)).pipe(
            switchMap(({ originalTransactionId, productId }) =>
                refreshAppleSubscription(accountSid, originalTransactionId, productId, config.apple)),
        );
    }
    return refreshGoogleSubscription(
        accountSid, entitlement.purchaseToken, config.googlePackageName, config.googleServiceAccountJson,
    );
}

/** What resolveDeviceEntitlement decided for one device. */
export interface DeviceEntitlement {
    /** May this device mint a Voice token (the override-OR-entitlement gate)? */
    entitled: boolean;
    /** The device's subscription pointer to store (DeviceRecord.subscription). */
    subscription: string | null;
}

/**
 * The override-OR-entitlement gate for one DEVICE, plus the subscription pointer the
 * device registry (shared/webhooks.ts DeviceRecord) should hold for it — which is
 * what lets the inbound webhooks ring/notify exactly the devices whose own user
 * is entitled, and keep doing so across renewals without the device checking in.
 *
 * - No entitlement presented: entitled iff the line's license override is live;
 *   the existing pointer is KEPT (e.g. an iOS reinstall wipes the locally stored
 *   entitlement but not the uid — clearing it would silence a paying user until
 *   they restore). Its record's expiry still decides reachability.
 * - Override live: entitled. The pointer follows the PRESENTED entitlement, so a
 *   stale pointer (e.g. to a lapsed purchase the user has since replaced) is
 *   corrected before the override ends — someone who also paid keeps ringing the
 *   moment it ends. This runs on every token mint, so it avoids the
 *   store: an entitlement whose record already exists (written when the purchase
 *   was verified, or by a store notification) is pointed at directly. Only one
 *   with no record yet is re-verified with the store, and a failure there is
 *   remembered for a while (failedOverrideEntitlements) so a permanently invalid
 *   entitlement isn't sent to the store on every mint; the pointer is kept.
 * - Without an override, a presented entitlement whose stored record is active
 *   and was verified with the store within STORED_EXPIRY_TRUST_MS is trusted as
 *   is (trustedStoredRecord), so a subscriber's token mints don't call Apple or
 *   Google every time. Store notifications rewrite the record on renewals and
 *   refunds; the window bounds how long a missed notification can matter.
 *   Otherwise the entitlement is re-verified with the store (as
 *   isSubscriptionActive does) and the pointer is its record — even
 *   when that subscription has currently lapsed: the record's own expiry already
 *   decides reachability, and keeping the pointer means a renewal that lands
 *   later (e.g. after billing retry, via a store notification) reaches the device
 *   again without it checking in.
 * - A failed re-verification never grants a token beyond the override, but keeps the
 *   existing pointer: that record's own expiry still governs ringing, so a store
 *   outage doesn't silence a paying user.
 */
export function resolveDeviceEntitlement(
    accountSid: string, entitlement: PresentedEntitlement | null, currentPointer: string | null, config: ReverificationConfig,
): Observable<DeviceEntitlement> {
    return overrideActive(accountSid).pipe(
        switchMap((override): Observable<DeviceEntitlement> => {
            if (!entitlement) return of({ entitled: override, subscription: currentPointer });
            if (override) {
                return overridePointer(accountSid, entitlement, currentPointer, config).pipe(
                    map((subscription) => ({ entitled: true, subscription })),
                );
            }
            // Deferred: building the store lookup already fires the API request.
            const reverified$ = defer(() => verifyEntitlementState(accountSid, entitlement, config)).pipe(
                map((state) => ({ entitled: state.expiresAt > Date.now(), subscription: state.recordPath })),
                catchError((e) => {
                    console.error('Store entitlement re-verification failed', e);
                    return of({ entitled: false, subscription: currentPointer });
                }),
            );
            return trustedStoredRecord(entitlement, config.apple).pipe(
                switchMap((recordPath) => (recordPath ?
                    of({ entitled: true, subscription: recordPath }) : reverified$)),
            );
        }),
    );
}

/** How long a stored paid record's expiry is trusted after its last store verification. */
const STORED_EXPIRY_TRUST_MS = 24 * 60 * 60 * 1000;

/**
 * The path of the presented entitlement's stored record if it can be trusted
 * without asking the store — it exists, hasn't expired, and was verified with the
 * store within STORED_EXPIRY_TRUST_MS — else null. Never errors: any failure
 * (e.g. an Apple transaction that fails offline verification) yields null, so the
 * caller falls back to the store and never grants on an unreadable record.
 */
function trustedStoredRecord(entitlement: PresentedEntitlement, apple: AppleConfig): Observable<string | null> {
    return existingRecordPath(entitlement, apple).pipe(
        switchMap((recordPath) => {
            if (!recordPath) return of(null);
            return from(admin.database().ref(`/${recordPath}`).once('value')).pipe(
                map((snapshot) => {
                    const record = snapshot.val() as Partial<PaidRecord> | null;
                    const now = Date.now();
                    const trusted = typeof record?.expiresAt === 'number' && record.expiresAt > now &&
                        typeof record.lastVerifiedAt === 'number' && now - record.lastVerifiedAt < STORED_EXPIRY_TRUST_MS;
                    return trusted ? recordPath : null;
                }),
            );
        }),
        catchError(() => of(null)),
    );
}

/** How long an override-time re-verification failure suppresses the next store call for that entitlement. */
const FAILED_OVERRIDE_ENTITLEMENT_TTL_MS = 60 * 60 * 1000;
const FAILED_OVERRIDE_ENTITLEMENTS_MAX = 1000;

/**
 * Entitlements (by entitlementKey) whose store re-verification failed while the
 * line's license override was live, with when to try again. Per function instance, like authTokenCache in
 * twilio.ts: it only bounds how often one instance asks the store.
 */
const failedOverrideEntitlements = new Map<string, number>();

function entitlementKey(entitlement: PresentedEntitlement): string {
    const value = entitlement.store === 'app_store' ? entitlement.signedTransactionInfo : entitlement.purchaseToken;
    return crypto.createHash('sha256').update(`${entitlement.store}:${value}`).digest('base64url');
}

/** The pointer a device on an overridden line should hold — see resolveDeviceEntitlement. Never errors. */
function overridePointer(
    accountSid: string, entitlement: PresentedEntitlement, currentPointer: string | null, config: ReverificationConfig,
): Observable<string | null> {
    return existingRecordPath(entitlement, config.apple).pipe(
        switchMap((existing) => {
            if (existing) return of(existing);
            const key = entitlementKey(entitlement);
            if ((failedOverrideEntitlements.get(key) ?? 0) > Date.now()) return of(currentPointer);
            return verifyEntitlementState(accountSid, entitlement, config).pipe(
                map((state) => state.recordPath),
                catchError((e) => {
                    console.error('Store entitlement re-verification failed', e);
                    if (failedOverrideEntitlements.size >= FAILED_OVERRIDE_ENTITLEMENTS_MAX) failedOverrideEntitlements.clear();
                    failedOverrideEntitlements.set(key, Date.now() + FAILED_OVERRIDE_ENTITLEMENT_TTL_MS);
                    return of(currentPointer);
                }),
            );
        }),
        catchError((e) => {
            console.error('Presented store entitlement lookup failed', e);
            return of(currentPointer);
        }),
    );
}

/**
 * The path of the paid record a presented entitlement already has, or null if it
 * has none yet — without a store round-trip. An Apple transaction is verified
 * offline first (its signature is what makes the originalTransactionId trusted);
 * a Google purchase token resolves through its redirect node, if superseded, to
 * the chain root (see resolveGooglePaidKey).
 */
function existingRecordPath(entitlement: PresentedEntitlement, apple: AppleConfig): Observable<string | null> {
    if (entitlement.store === 'app_store') {
        return from(verifyPresentedAppleTransaction(entitlement.signedTransactionInfo, apple)).pipe(
            switchMap(({ originalTransactionId }) => from(applePaidRef(originalTransactionId).once('value')).pipe(
                map((snapshot) => (snapshot.exists() ? paidRecordPath('app_store', originalTransactionId) : null)),
            )),
        );
    }
    const { purchaseToken } = entitlement;
    return from(googlePaidRef(purchaseToken).once('value')).pipe(
        map((snapshot) => {
            if (!snapshot.exists()) return null;
            const value = snapshot.val();
            return paidRecordPath('play_store', isGooglePaidRedirect(value) ? value.redirectTo : purchaseToken);
        }),
    );
}

/** Test-only: forget remembered override-time re-verification failures. */
export function resetFailedOverrideEntitlementsForTests(): void {
    failedOverrideEntitlements.clear();
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
 * NOT for anything the app presents — that goes through
 * verifyPresentedAppleTransaction, since a forged JWS could otherwise name
 * another customer's transaction.
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
    /** 1 = introductory offer (our free trial is the only one). */
    offerType?: number;
    offerDiscountType?: string;
}

/** True if this transaction is the introductory free-trial period. */
function isAppleFreeTrial(tx: AppleTransactionInfo): boolean {
    return tx.offerType === 1 && tx.offerDiscountType === 'FREE_TRIAL';
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
    return {
        productId: match.tx.productId,
        expiresAt: match.tx.expiresDate,
        autoRenew: match.renewal.autoRenewStatus === 1,
        freeTrial: isAppleFreeTrial(match.tx),
    };
}

/**
 * Fetches authoritative state for an Apple subscription and writes it to the
 * store-keyed paid record. `accountSid` is recorded only informationally (which
 * account last presented this entitlement); it is not part of the key.
 */
function refreshAppleSubscription(
    accountSid: string | null, originalTransactionId: string, productIdHint: string, config: AppleConfig,
): Observable<PaidState> {
    return from(fetchAppleSubscriptionStatuses(originalTransactionId, config)).pipe(
        map((body) => extractAppleSubscriptionState(body, productIdHint)),
        switchMap((state) => {
            const record = buildPaidRecord(accountSid, state, {
                store: 'app_store',
                originalTransactionId,
                purchaseToken: null,
                linkedPurchaseToken: null,
            });
            return from(applePaidRef(originalTransactionId).update(record)).pipe(
                map(() => ({ ...state, recordPath: paidRecordPath('app_store', originalTransactionId) })),
            );
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

/**
 * Apple Root CA - G3, which anchors every App Store JWS (x5c chain). Bundled with
 * the function (functions/certs, downloaded from apple.com/certificateauthority;
 * SHA-256 63:34:3A:BF:…:91:79) rather than fetched at runtime, so trust doesn't
 * depend on the network. Read lazily, once per instance.
 */
let appleRootCertificates: Buffer[] | null = null;
let appleOnlineChecks = true;

function loadAppleRootCertificates(): Buffer[] {
    if (appleRootCertificates === null) {
        appleRootCertificates = [fs.readFileSync(path.join(__dirname, '..', 'certs', 'AppleRootCA-G3.cer'))];
    }
    return appleRootCertificates;
}

/**
 * Test-only: trust `rootCertificates` instead of Apple's root, and skip the
 * online checks (OCSP + "now" as the validity date) so fixtures signed by a
 * throwaway CA verify offline. Pass null to restore the production behavior.
 * `onlineChecks` overrides the online-check setting (to prove a path ignores it).
 */
export function setAppleVerificationForTests(rootCertificates: Buffer[] | null, onlineChecks = rootCertificates === null): void {
    appleRootCertificates = rootCertificates;
    appleOnlineChecks = onlineChecks;
    appleVerifierCache.clear();
}

/**
 * The app's numeric Apple ID from config, accepting it stored as a number or as a
 * numeric string (an easy slip when editing the secret JSON by hand). Undefined
 * when absent or malformed — logged as an error, since every Production purchase
 * and notification is then rejected.
 */
function configuredAppAppleId(config: AppleConfig): number | undefined {
    const raw: unknown = config.appAppleId;
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
    if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim())) return Number(raw.trim());
    if (!loggedMissingAppAppleId) {
        loggedMissingAppAppleId = true; // once per instance, not per request
        console.error('apple_iap_key.appAppleId is missing or not a number: Production App Store purchases and notifications will be rejected');
    }
    return undefined;
}

let loggedMissingAppAppleId = false;

/**
 * SignedDataVerifiers, built once per instance per configuration rather than per
 * call: the library caches verified certificate chains (15 min) inside each
 * instance, which a fresh verifier would throw away.
 *
 * `onlineChecks`: OCSP revocation + validity against the current time. Right for
 * notifications (delivered just after Apple signs them); wrong for transactions
 * the APP presents, which it stores and re-presents for as long as the
 * subscription lasts — those are verified against their own signedDate, as
 * Apple's library recommends for stored data (no OCSP, no expiry of a chain that
 * was valid when Apple signed).
 */
const appleVerifierCache = new Map<string, Map<Environment, SignedDataVerifier>>();

function appleVerifiers(config: AppleConfig, onlineChecks: boolean): Map<Environment, SignedDataVerifier> {
    const appAppleId = configuredAppAppleId(config);
    const key = JSON.stringify([config.bundleId, appAppleId ?? null, onlineChecks]);
    let verifiers = appleVerifierCache.get(key);
    if (!verifiers) {
        const roots = loadAppleRootCertificates();
        verifiers = new Map([[Environment.SANDBOX, new SignedDataVerifier(roots, onlineChecks, Environment.SANDBOX, config.bundleId)]]);
        // The library requires appAppleId for Production: without it Production data is rejected, never waved through.
        if (appAppleId !== undefined) {
            verifiers.set(Environment.PRODUCTION, new SignedDataVerifier(roots, onlineChecks, Environment.PRODUCTION, config.bundleId, appAppleId));
        }
        appleVerifierCache.set(key, verifiers);
    }
    return verifiers;
}

/**
 * The verifier(s) to try for a payload: just the one for the environment the
 * (still unverified) payload claims — the verification itself then enforces that
 * claim, so a wrong one simply fails — instead of running a full chain check per
 * environment. All of them when the payload claims none.
 */
function verifiersFor(verifiers: Map<Environment, SignedDataVerifier>, claimedEnvironment: unknown): SignedDataVerifier[] {
    const matching = verifiers.get(claimedEnvironment as Environment);
    if (matching) return [matching];
    return claimedEnvironment === Environment.SANDBOX || claimedEnvironment === Environment.PRODUCTION ? [] : [...verifiers.values()];
}

/** The unverified `environment` a JWS payload claims (only used to pick a verifier). */
function claimedEnvironment(jws: string, pick: (payload: Record<string, unknown>) => unknown): unknown {
    try {
        return pick(decodeAppleSignedPayload<Record<string, unknown>>(jws));
    } catch {
        return undefined;
    }
}

/** Thrown when an app-presented Apple transaction fails signature verification. */
export class InvalidAppleTransactionError extends Error {
    constructor(readonly retryable: boolean) {
        super(retryable ?
            'Apple transaction could not be verified right now (retryable)' :
            'Apple transaction failed signature verification');
    }
}

/**
 * Verifies a `signedTransactionInfo` the APP presents (purchase verification, or
 * the entitlement attached to twilioAccessToken) before its originalTransactionId
 * is trusted: x5c chain up to Apple's root, ES256 signature, our bundleId, and the
 * environment. Without this a tampered app could forge a JWS naming ANOTHER
 * customer's active originalTransactionId — the server would then look that
 * subscription up and entitle the forger with it. Verified OFFLINE against its
 * signedDate (see appleVerifiers): the app keeps re-presenting the same JWS.
 *
 * Data we fetch from Apple ourselves over the authenticated Server API is still
 * only decoded (decodeAppleSignedPayload): the transport is the trust there.
 */
async function verifyPresentedAppleTransaction(signedTransactionInfo: string, config: AppleConfig): Promise<AppleTransactionInfo> {
    let retryable = false;
    const environment = claimedEnvironment(signedTransactionInfo, (payload) => payload.environment);
    for (const verifier of verifiersFor(appleVerifiers(config, false), environment)) {
        try {
            const decoded = await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
            return {
                transactionId: decoded.transactionId ?? '',
                originalTransactionId: decoded.originalTransactionId ?? '',
                productId: decoded.productId ?? '',
                expiresDate: decoded.expiresDate ?? 0,
            };
        } catch (error) {
            if (error instanceof VerificationException && error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) retryable = true;
        }
    }
    console.warn('Rejected an app-presented Apple transaction that failed signature verification');
    throw new InvalidAppleTransactionError(retryable);
}

/** Outcome of verifying an App Store Server Notification's signature. */
export type AppleNotificationVerification = 'verified' | 'invalid' | 'retryable';

/**
 * Verifies an App Store Server Notification V2 `signedPayload` — its x5c chain
 * up to Apple's root, the ES256 signature, and that it's for OUR app (bundleId,
 * plus appAppleId in Production) — with Apple's app-store-server-library.
 *
 * Production and Sandbox notifications arrive at the same URL, and the library
 * binds a verifier to one environment, so each configured environment is tried
 * in turn; a payload is accepted if any of them verifies it. The Production
 * verifier needs `appAppleId` — if it isn't configured, Production
 * notifications are rejected (logged), not waved through.
 *
 * Online checks (OCSP revocation, validity against the current time) are on:
 * this endpoint isn't latency-sensitive, and an unreachable OCSP responder comes
 * back as 'retryable' so the caller can 5xx and let Apple redeliver.
 */
export async function verifyAppleNotificationSignature(
    signedPayload: string, config: AppleConfig,
): Promise<AppleNotificationVerification> {
    const environment = claimedEnvironment(signedPayload, (payload) => {
        const data = (payload.data ?? payload.summary) as { environment?: unknown } | undefined;
        return data?.environment;
    });
    const failures: Array<VerificationStatus | null> = [];
    for (const verifier of verifiersFor(appleVerifiers(config, appleOnlineChecks), environment)) {
        try {
            await verifier.verifyAndDecodeNotification(signedPayload);
            return 'verified';
        } catch (error) {
            failures.push(error instanceof VerificationException ? error.status : null);
        }
    }
    console.warn('Apple notification failed signature verification',
        failures.map((status) => (status === null ? 'unknown' : VerificationStatus[status])));
    return failures.includes(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) ? 'retryable' : 'invalid';
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
 * or a bogus one (which 404s). On top of that, the twilioAppleNotifications
 * webhook only calls this after verifyAppleNotificationSignature accepted the
 * payload, so spam never reaches the Apple Server API lookup.
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
    return from(verifyPresentedAppleTransaction(signedTransactionInfo, config)).pipe(
        switchMap(({ originalTransactionId, productId }) => refreshAppleSubscription(accountSid, originalTransactionId, productId, config)),
        map(toStatus),
    );
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
): Observable<PaidState> {
    const client = androidPublisherClient(serviceAccountJson);
    return from(client.purchases.subscriptionsv2.get({ packageName, token: purchaseToken })).pipe(
        switchMap((response) => {
            const purchase = response.data;
            // Only one product ('dialcrest') is ever purchased, so there's exactly one line item.
            const lineItem = purchase.lineItems?.[0];
            if (!lineItem?.expiryTime) throw new Error(`Google subscription lookup returned no line items for token ${purchaseToken}`);
            const expiresAt = new Date(lineItem.expiryTime).getTime();
            const state = {
                expiresAt,
                autoRenew: Boolean(lineItem.autoRenewingPlan?.autoRenewEnabled),
                // The base plan id ('monthly-dialcrest-license'/'yearly-dialcrest-license') is
                // what distinguishes the plan — the product id itself is always ANDROID_PRODUCT_ID.
                productId: lineItem.offerDetails?.basePlanId ?? '',
                freeTrial: isGoogleFreeTrial(lineItem.offerDetails?.offerId, purchase.startTime, expiresAt),
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
            const linkedPurchaseToken = purchase.linkedPurchaseToken ?? null;
            const record = buildPaidRecord(accountSid, state, {
                store: 'play_store',
                originalTransactionId: null,
                purchaseToken,
                linkedPurchaseToken,
            });
            return acknowledge$.pipe(
                switchMap(() => resolveGooglePaidKey(purchaseToken, linkedPurchaseToken)),
                switchMap((key) => writeGooglePaidRecord(key, purchaseToken, record).pipe(
                    map(() => ({ ...state, recordPath: paidRecordPath('play_store', key) })),
                )),
            );
        }),
    );
}

/**
 * True while a Google subscription bought through a free-trial offer is still in
 * its first period. The API has no per-phase field, and the offer id stays the
 * same after the trial converts, so the trial is told apart by its expiry still
 * being within the trial length of the purchase's start.
 */
function isGoogleFreeTrial(offerId: string | null | undefined, startTime: string | null | undefined, expiresAt: number): boolean {
    if (!offerId?.startsWith(GOOGLE_FREE_TRIAL_OFFER_PREFIX) || !startTime) return false;
    return expiresAt - new Date(startTime).getTime() <= MAX_FREE_TRIAL_MS;
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

interface GoogleRtdnMessage {
    subscriptionNotification?: { notificationType: number; purchaseToken: string; subscriptionId: string };
    voidedPurchaseNotification?: { purchaseToken: string; orderId: string };
    testNotification?: { version: string };
}

/**
 * Handles one Play Real-time Developer Notification (the decoded Pub/Sub
 * message body). Both subscription events and refunds/voids carry a
 * `purchaseToken`; we re-fetch authoritative state for it (see
 * refreshGoogleByPurchaseToken) rather than trusting the notification's type,
 * so any event just reconciles the record. Test notifications (Play Console's
 * "Send test notification") carry no token and are ignored.
 */
export function handleGoogleNotification(
    message: unknown, packageName: string, serviceAccountJson: string,
): Observable<void> {
    const rtdn = message as GoogleRtdnMessage;
    const purchaseToken =
        rtdn.subscriptionNotification?.purchaseToken ?? rtdn.voidedPurchaseNotification?.purchaseToken;
    if (!purchaseToken) {
        console.log('Google RTDN carries no subscription purchase token (test or unrelated notification); ignoring');
        return of(undefined);
    }
    return refreshGoogleByPurchaseToken(purchaseToken, packageName, serviceAccountJson).pipe(
        map(() => undefined),
        catchError((e) => {
            console.error('Google RTDN refresh failed', e);
            return of(undefined);
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
