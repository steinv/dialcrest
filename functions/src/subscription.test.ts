import admin from 'firebase-admin';
import { lastValueFrom } from 'rxjs';
import {
    ensureAccountCreated,
    isSubscriptionActive,
    resolveDeviceEntitlement,
    verifyEntitlement,
    refreshAppleByOriginalTransactionId,
    handleAppleNotification,
    verifyApplePurchase,
    handleGoogleNotification,
    verifyGooglePurchase,
    setAppleVerificationForTests,
    resetFailedOverrideEntitlementsForTests,
    verifyAppleNotificationSignature,
    PresentedEntitlement,
    ReverificationConfig,
} from './subscription';
import { testAppleConfig, appleSubscriptionStatusesResponse, mockAppleFetch, signedPayload } from './testUtils/appleFixtures';
import { googleSubscriptionV2Response } from './testUtils/googleFixtures';
import { appleSignedJws, appleSignedTransaction, testAppleRootCertificate } from './testUtils/appleTestPki';

jest.mock('firebase-admin');
jest.mock('googleapis', () => require('./testUtils/googleFixtures').mockGoogleapisModule());

function resetDb() {
    (admin as unknown as { __resetDatabase: () => void }).__resetDatabase();
}

function dbTree(): any {
    return (admin as unknown as { __getDatabaseTree: () => any }).__getDatabaseTree();
}

function googleMocks() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('googleapis').__mockGoogle) as { subscriptionsV2Get: jest.Mock; acknowledge: jest.Mock };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Sets the line's license override (an epoch-ms timestamp), as an admin would in the Firebase console. */
async function grantOverride(accountSid: string, until: unknown = Date.now() + THIRTY_DAYS_MS) {
    await admin.database().ref(`/twilio/${accountSid}/licenseOverride`).set(until);
}

// App-presented Apple transactions are signature-verified: trust the throwaway test CA.
beforeAll(() => setAppleVerificationForTests([testAppleRootCertificate]));
afterAll(() => setAppleVerificationForTests(null));

const reverificationConfig: ReverificationConfig = {
    apple: testAppleConfig,
    googlePackageName: 'be.peblet.twilio_phone',
    googleServiceAccountJson: '{}',
};

describe('account bookkeeping', () => {
    beforeEach(resetDb);
    afterEach(() => jest.useRealTimers());

    it('records createdAt on first call and never overwrites it on repeat calls', async () => {
        jest.useFakeTimers().setSystemTime(1000);
        await lastValueFrom(ensureAccountCreated('AC1'));
        jest.setSystemTime(5000);
        await lastValueFrom(ensureAccountCreated('AC1'));
        expect(dbTree().twilio.AC1.createdAt).toBe(1000);
    });

    it('never grants a license on its own (no trial, no override)', async () => {
        await lastValueFrom(ensureAccountCreated('AC1'));
        expect(dbTree().twilio.AC1.trial).toBeUndefined();
        expect(dbTree().twilio.AC1.licenseOverride).toBeUndefined();
    });
});

describe('isSubscriptionActive (the override-OR-entitlement gate)', () => {
    beforeEach(() => {
        resetDb();
        jest.useFakeTimers().setSystemTime(0);
    });
    afterEach(() => jest.useRealTimers());

    it('is active while the license override has not expired, with no entitlement presented', async () => {
        await grantOverride('AC1');
        const active = await lastValueFrom(isSubscriptionActive('AC1', null, reverificationConfig));
        expect(active).toBe(true);
    });

    it('is inactive with no override and no entitlement, and backfills nothing', async () => {
        const active = await lastValueFrom(isSubscriptionActive('AC1', null, reverificationConfig));
        expect(active).toBe(false);
        expect(dbTree().twilio).toBeUndefined();
    });

    it.each([true, 'forever', { until: THIRTY_DAYS_MS }])('treats a non-number override (%p) as none', async (value) => {
        await grantOverride('AC1', value);
        const active = await lastValueFrom(isSubscriptionActive('AC1', null, reverificationConfig));
        expect(active).toBe(false);
    });

    it('is inactive once the license override has expired and no entitlement is presented', async () => {
        await grantOverride('AC1');
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        const active = await lastValueFrom(isSubscriptionActive('AC1', null, reverificationConfig));
        expect(active).toBe(false);
    });

    it('never re-verifies a store entitlement while the license override is live (cheap path first)', async () => {
        await grantOverride('AC1');
        const fetchMock = mockAppleFetch({});
        const entitlement: PresentedEntitlement = {
            store: 'app_store',
            signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
        const active = await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig));
        expect(active).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to a live Apple entitlement once the license override has expired', async () => {
        await grantOverride('AC1');
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license',
                    expiresDate: THIRTY_DAYS_MS + 1 + 100000, autoRenewStatus: 1,
                }]),
            },
        });
        const entitlement: PresentedEntitlement = {
            store: 'app_store',
            signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
        const active = await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig));
        expect(active).toBe(true);
        expect(dbTree().subscriptions.apple.orig1.plan).toBe('monthly');
    });

    it('is inactive when the presented Apple entitlement itself has already expired', async () => {
        await grantOverride('AC1');
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license',
                    expiresDate: THIRTY_DAYS_MS - 1, autoRenewStatus: 0,
                }]),
            },
        });
        const entitlement: PresentedEntitlement = {
            store: 'app_store',
            signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
        const active = await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig));
        expect(active).toBe(false);
    });

    it('falls back to a live Google entitlement once the license override has expired', async () => {
        await grantOverride('AC1');
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(THIRTY_DAYS_MS + 1 + 100000).toISOString(), autoRenewEnabled: true, basePlanId: 'yearly-dialcrest-license',
        }));
        const entitlement: PresentedEntitlement = { store: 'play_store', purchaseToken: 'tok1' };
        const active = await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig));
        expect(active).toBe(true);
        expect(dbTree().subscriptions.google.tok1.plan).toBe('yearly');
    });

    it('treats a store re-verification failure as inactive rather than throwing', async () => {
        await grantOverride('AC1');
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        (global as unknown as { fetch: typeof fetch }).fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
        const entitlement: PresentedEntitlement = {
            store: 'app_store',
            signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
        const active = await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig));
        expect(active).toBe(false);
    });
});

describe('verifyEntitlement', () => {
    beforeEach(() => {
        resetDb();
        jest.useFakeTimers().setSystemTime(0);
    });
    afterEach(() => jest.useRealTimers());

    it('re-verifies an Apple entitlement against the App Store Server API', async () => {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license', expiresDate: 100000, autoRenewStatus: 1,
                }]),
            },
        });
        const status = await lastValueFrom(verifyEntitlement(
            'AC1',
            { store: 'app_store', signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license' }) },
            reverificationConfig,
        ));
        expect(status).toEqual({ plan: 'yearly', expiresAt: 100000, autoRenew: true, freeTrial: false, isActive: true });
    });

    it('re-verifies a Google entitlement and acknowledges a pending purchase', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(200000).toISOString(), autoRenewEnabled: false, basePlanId: 'monthly-dialcrest-license',
            acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
        }));
        const status = await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokA' }, reverificationConfig));
        expect(status).toEqual({ plan: 'monthly', expiresAt: 200000, autoRenew: false, freeTrial: false, isActive: true });
        expect(googleMocks().acknowledge).toHaveBeenCalledTimes(1);
    });

    it('does not re-acknowledge an already-acknowledged Google purchase', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(200000).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokA' }, reverificationConfig));
        expect(googleMocks().acknowledge).not.toHaveBeenCalled();
    });
});

describe('store free-trial detection', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    beforeEach(() => {
        resetDb();
        jest.useFakeTimers().setSystemTime(0);
    });
    afterEach(() => jest.useRealTimers());

    function appleEntitlement(): PresentedEntitlement {
        return {
            store: 'app_store',
            signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
    }

    it('flags an Apple introductory free-trial transaction', async () => {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license',
                    expiresDate: 30 * DAY_MS, autoRenewStatus: 1, offerType: 1, offerDiscountType: 'FREE_TRIAL',
                }]),
            },
        });
        const status = await lastValueFrom(verifyEntitlement('AC1', appleEntitlement(), reverificationConfig));
        expect(status.freeTrial).toBe(true);
        expect(dbTree().subscriptions.apple.orig1.freeTrial).toBe(true);
    });

    it('does not flag a regular Apple transaction', async () => {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't2', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license',
                    expiresDate: 60 * DAY_MS, autoRenewStatus: 1,
                }]),
            },
        });
        const status = await lastValueFrom(verifyEntitlement('AC1', appleEntitlement(), reverificationConfig));
        expect(status.freeTrial).toBe(false);
    });

    it('flags a Google free-trial offer while still in its first period', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(30 * DAY_MS).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
            offerId: 'free-trial-monthly', startTime: new Date(0).toISOString(),
        }));
        const status = await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokT' }, reverificationConfig));
        expect(status.freeTrial).toBe(true);
        expect(dbTree().subscriptions.google.tokT.freeTrial).toBe(true);
    });

    it('stops flagging a Google free-trial offer once it has converted (first paid period)', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(60 * DAY_MS).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
            offerId: 'free-trial-monthly', startTime: new Date(0).toISOString(),
        }));
        const status = await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokT' }, reverificationConfig));
        expect(status.freeTrial).toBe(false);
    });

    it('does not flag a Google base-plan purchase (no offer)', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(30 * DAY_MS).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
            startTime: new Date(0).toISOString(),
        }));
        const status = await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokT' }, reverificationConfig));
        expect(status.freeTrial).toBe(false);
    });
});

describe('refunds, revocations, holds and grace periods', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const NOW = 10 * DAY_MS;

    beforeEach(() => {
        resetDb();
        jest.useFakeTimers().setSystemTime(NOW);
    });
    afterEach(() => jest.useRealTimers());

    function appleEntitlement(): PresentedEntitlement {
        return {
            store: 'app_store',
            signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
    }

    function mockAppleTx(tx: { expiresDate: number; revocationDate?: number; gracePeriodExpiresDate?: number }) {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', autoRenewStatus: 0, ...tx,
                }]),
            },
        });
    }

    it('ends a refunded Apple subscription at its revocation date, not its original expiry', async () => {
        mockAppleTx({ expiresDate: 30 * DAY_MS, revocationDate: 5 * DAY_MS });
        const status = await lastValueFrom(verifyEntitlement('AC1', appleEntitlement(), reverificationConfig));
        expect(status.isActive).toBe(false);
        expect(status.expiresAt).toBe(5 * DAY_MS);
        expect(dbTree().subscriptions.apple.orig1.expiresAt).toBe(5 * DAY_MS);
    });

    it('keeps an Apple subscription in its billing grace period active until the grace period ends', async () => {
        mockAppleTx({ expiresDate: 9 * DAY_MS, gracePeriodExpiresDate: 25 * DAY_MS });
        const status = await lastValueFrom(verifyEntitlement('AC1', appleEntitlement(), reverificationConfig));
        expect(status.isActive).toBe(true);
        expect(status.expiresAt).toBe(25 * DAY_MS);
    });

    it('lets a revocation win over a grace period', async () => {
        mockAppleTx({ expiresDate: 9 * DAY_MS, gracePeriodExpiresDate: 25 * DAY_MS, revocationDate: 8 * DAY_MS });
        const status = await lastValueFrom(verifyEntitlement('AC1', appleEntitlement(), reverificationConfig));
        expect(status.isActive).toBe(false);
    });

    it.each([
        'SUBSCRIPTION_STATE_EXPIRED',
        'SUBSCRIPTION_STATE_ON_HOLD',
        'SUBSCRIPTION_STATE_PAUSED',
        'SUBSCRIPTION_STATE_PENDING',
        'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED',
    ])('treats a Google subscription in %s as inactive even with a future expiryTime', async (subscriptionState) => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(30 * DAY_MS).toISOString(), autoRenewEnabled: false, basePlanId: 'monthly-dialcrest-license',
            subscriptionState,
        }));
        const status = await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokR' }, reverificationConfig));
        expect(status.isActive).toBe(false);
        expect(dbTree().subscriptions.google.tokR.expiresAt).toBe(NOW);
    });

    it.each(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'])(
        'keeps a Google subscription in %s active until its expiryTime', async (subscriptionState) => {
            googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
                expiryTime: new Date(30 * DAY_MS).toISOString(), autoRenewEnabled: false, basePlanId: 'monthly-dialcrest-license',
                subscriptionState,
            }));
            const status = await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokA' }, reverificationConfig));
            expect(status.isActive).toBe(true);
            expect(status.expiresAt).toBe(30 * DAY_MS);
        },
    );

    it('a Google revocation notification cuts access off immediately', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(30 * DAY_MS).toISOString(), autoRenewEnabled: false, basePlanId: 'monthly-dialcrest-license',
            subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        }));
        await lastValueFrom(handleGoogleNotification(
            { voidedPurchaseNotification: { purchaseToken: 'tokV', orderId: 'GPA.1' } }, 'be.peblet.twilio_phone', '{}',
        ));
        expect(dbTree().subscriptions.google.tokV.expiresAt).toBe(NOW);
    });
});

describe('Apple purchase verification', () => {
    beforeEach(resetDb);

    it('picks the transaction matching the presented product id out of several (covers plan upgrade/downgrade)', async () => {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([
                    { transactionId: 't-old', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 500, autoRenewStatus: 0 },
                    { transactionId: 't-new', originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license', expiresDate: 999999, autoRenewStatus: 1 },
                ]),
            },
        });
        const status = await lastValueFrom(verifyApplePurchase(
            'AC1', appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license' }), testAppleConfig,
        ));
        expect(status.plan).toBe('yearly');
        expect(status.expiresAt).toBe(999999);
    });

    it('falls back to the sandbox environment when production 404s', async () => {
        mockAppleFetch({
            sandbox: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig-sandbox', productId: 'monthly-dialcrest-license', expiresDate: 999999, autoRenewStatus: 1,
                }]),
            },
        });
        const status = await lastValueFrom(verifyApplePurchase(
            'AC1', appleSignedTransaction({ originalTransactionId: 'orig-sandbox', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
        expect(status.plan).toBe('monthly');
    });

    it('throws when the transaction is found in neither production nor sandbox', async () => {
        mockAppleFetch({});
        await expect(lastValueFrom(verifyApplePurchase(
            'AC1', appleSignedTransaction({ originalTransactionId: 'missing', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ))).rejects.toThrow();
    });

    it('persists the paid record keyed by originalTransactionId, tagging the presenting account informationally', async () => {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 999999, autoRenewStatus: 1,
                }]),
            },
        });
        await lastValueFrom(verifyApplePurchase(
            'AC-presenting', appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
        const record = dbTree().subscriptions.apple.orig1;
        expect(record.lastAccountSid).toBe('AC-presenting');
        expect(record.store).toBe('app_store');
        expect(record.originalTransactionId).toBe('orig1');
    });
});

describe('Apple App Store Server Notifications', () => {
    beforeEach(resetDb);

    it('ignores a notification carrying no transaction info', async () => {
        const payload = signedPayload({ notificationType: 'TEST' });
        await expect(lastValueFrom(handleAppleNotification(payload, testAppleConfig))).resolves.toBeUndefined();
    });

    it('re-fetches authoritative state by originalTransactionId, ignoring the values the notification itself carries', async () => {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 424242, autoRenewStatus: 1,
                }]),
            },
        });
        // The notification's own signedTransactionInfo claims a huge expiry — refreshAppleByOriginalTransactionId
        // must ignore that and trust only what fetching Apple's server API by id reports (424242).
        const forgedNotificationTx = signedPayload({
            transactionId: 't1', originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license', expiresDate: 999999999,
        });
        const payload = signedPayload({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: forgedNotificationTx } });
        await lastValueFrom(handleAppleNotification(payload, testAppleConfig));
        expect(dbTree().subscriptions.apple.orig1.expiresAt).toBe(424242);
    });

    it('swallows a re-verification failure and resolves normally (so index.ts can 200 or 500 as it sees fit)', async () => {
        mockAppleFetch({});
        const notifTx = signedPayload({ transactionId: 't1', originalTransactionId: 'missing', productId: 'monthly-dialcrest-license', expiresDate: 1 });
        const payload = signedPayload({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: notifTx } });
        await expect(lastValueFrom(handleAppleNotification(payload, testAppleConfig))).resolves.toBeUndefined();
    });
});

describe('Google RTDN handling and purchase-token rotation', () => {
    beforeEach(resetDb);

    it('ignores a notification carrying no purchase token (e.g. Play Console test notification)', async () => {
        await expect(lastValueFrom(
            handleGoogleNotification({ testNotification: { version: '1.0' } }, 'pkg', '{}'),
        )).resolves.toBeUndefined();
    });

    it('refreshes and persists on a subscriptionNotification', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(500000).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(handleGoogleNotification(
            { subscriptionNotification: { notificationType: 4, purchaseToken: 'tokA', subscriptionId: 'dialcrest' } }, 'pkg', '{}',
        ));
        expect(dbTree().subscriptions.google.tokA.plan).toBe('monthly');
    });

    it('refreshes on a voidedPurchaseNotification (refund/revoke) too', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(0).toISOString(), autoRenewEnabled: false, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(handleGoogleNotification(
            { voidedPurchaseNotification: { purchaseToken: 'tokA', orderId: 'o1' } }, 'pkg', '{}',
        ));
        expect(dbTree().subscriptions.google.tokA).toBeDefined();
    });

    it('swallows a Play API failure and resolves normally', async () => {
        googleMocks().subscriptionsV2Get.mockRejectedValueOnce(new Error('play api down'));
        await expect(lastValueFrom(handleGoogleNotification(
            { subscriptionNotification: { notificationType: 4, purchaseToken: 'tokA', subscriptionId: 'dialcrest' } }, 'pkg', '{}',
        ))).resolves.toBeUndefined();
    });

    it('throws when Google reports no line items for the token', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce({ data: { lineItems: [] } });
        await expect(lastValueFrom(verifyGooglePurchase('AC1', 'tokEmpty', 'pkg', '{}'))).rejects.toThrow();
    });

    it('starts a fresh chain when the linked token is unknown (never seen before)', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(1000).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
            linkedPurchaseToken: 'never-seen-token',
        }));
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokNew', 'pkg', '{}'));
        expect(dbTree().subscriptions.google.tokNew.plan).toBe('monthly');
        expect(dbTree().subscriptions.google['never-seen-token']).toBeUndefined();
    });

    it('stores a record for a purchase token containing a "." (RTDB-forbidden char)', async () => {
        // Real Google purchase tokens can contain a "." — which encodeURIComponent
        // leaves unescaped, so it used to reach RTDB's ref() unescaped and throw
        // "invalid path". The record must persist and be findable under the token.
        const dottedToken = 'gmbfmblojgdiagpldacpahno.AO-J1OwMHhWyTy6A';
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(1000).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(verifyGooglePurchase('AC1', dottedToken, 'pkg', '{}'));
        const googleTree = dbTree().subscriptions.google as Record<string, { plan?: string }>;
        const record = Object.values(googleTree).find((v) => v.plan === 'monthly');
        expect(record).toBeDefined();
        // The stored key must not contain a literal "." (the mock would have thrown otherwise).
        expect(Object.keys(googleTree).every((k) => !k.includes('.'))).toBe(true);
    });

    it('follows a chain of rotated purchase tokens back to the original record instead of forking new ones', async () => {
        // Original purchase: token A.
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(1000).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        expect(dbTree().subscriptions.google.tokA.plan).toBe('monthly');

        // Upgrade rotates the token: new token B links back to A.
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(2000).toISOString(), autoRenewEnabled: true, basePlanId: 'yearly-dialcrest-license', linkedPurchaseToken: 'tokA',
        }));
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokB', 'pkg', '{}'));
        expect(dbTree().subscriptions.google.tokA.plan).toBe('yearly');
        expect(dbTree().subscriptions.google.tokA.expiresAt).toBe(2000);
        expect(dbTree().subscriptions.google.tokB).toEqual({ redirectTo: 'tokA' });

        // A second rotation links to B, itself now just a redirect — resolveGooglePaidKey
        // must chase it one more hop back to the real root, A, rather than forking at B.
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(3000).toISOString(), autoRenewEnabled: false, basePlanId: 'yearly-dialcrest-license', linkedPurchaseToken: 'tokB',
        }));
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokC', 'pkg', '{}'));

        expect(dbTree().subscriptions.google.tokA.expiresAt).toBe(3000);
        expect(dbTree().subscriptions.google.tokA.autoRenew).toBe(false);
        expect(dbTree().subscriptions.google.tokB).toEqual({ redirectTo: 'tokA' });
        expect(dbTree().subscriptions.google.tokC).toEqual({ redirectTo: 'tokA' });
    });

    it('refuses to clobber an existing real record at a key with a redirect', async () => {
        // Two independent purchase chains, each already a chain root in its own right.
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(1000).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(verifyGooglePurchase('AC-Y', 'tokY', 'pkg', '{}'));
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(2000).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(verifyGooglePurchase('AC-X', 'tokX', 'pkg', '{}'));
        const tokXBefore = { ...dbTree().subscriptions.google.tokX };

        // An unexpected event on tokX claims to link back to tokY (a real, unrelated chain).
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(3000).toISOString(), autoRenewEnabled: true, basePlanId: 'yearly-dialcrest-license', linkedPurchaseToken: 'tokY',
        }));
        await lastValueFrom(verifyGooglePurchase('AC-X', 'tokX', 'pkg', '{}'));

        // tokX's own real record must be left untouched — the redirect write refused to overwrite it.
        expect(dbTree().subscriptions.google.tokX).toEqual(tokXBefore);
    });
});

/**
 * Paid subscriptions belong to the PERSON (store identity), never to the shared
 * Twilio account: nothing about a purchase may be written under /twilio/{sid}
 * (one customer must not pay for everyone on the line). And a store notification,
 * which carries no account, must not erase which account last presented it.
 */
describe('paid records stay store-keyed', () => {
    beforeEach(resetDb);

    function mockApple(expiresDate: number) {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate, autoRenewStatus: 1,
                }]),
            },
        });
    }

    function mockGoogle(expiresAt: number) {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(expiresAt).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
    }

    it('verifying a purchase writes nothing under the Twilio account', async () => {
        mockApple(5_000_000);
        await lastValueFrom(verifyApplePurchase(
            'AC1', appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
        mockGoogle(6_000_000);
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        expect(dbTree().twilio).toBeUndefined();
    });

    it('an Apple notification keeps lastAccountSid', async () => {
        mockApple(5_000_000);
        await lastValueFrom(verifyApplePurchase(
            'AC1', appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
        mockApple(9_000_000);
        const tx = signedPayload({ transactionId: 't2', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 1 });
        await lastValueFrom(handleAppleNotification(signedPayload({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: tx } }), testAppleConfig));
        expect(dbTree().subscriptions.apple.orig1).toMatchObject({ lastAccountSid: 'AC1', expiresAt: 9_000_000 });
    });

    it('a Google notification keeps lastAccountSid', async () => {
        mockGoogle(6_000_000);
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        mockGoogle(1_000);
        await lastValueFrom(handleGoogleNotification({ voidedPurchaseNotification: { purchaseToken: 'tokA' } }, 'pkg', '{}'));
        expect(dbTree().subscriptions.google.tokA).toMatchObject({ lastAccountSid: 'AC1', expiresAt: 1_000 });
    });
});

describe('resolveDeviceEntitlement (per-device gate + subscription pointer)', () => {
    beforeEach(() => {
        resetDb();
        resetFailedOverrideEntitlementsForTests();
    });
    afterEach(() => jest.useRealTimers());

    const appleEntitlement: PresentedEntitlement = {
        store: 'app_store', signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
    };

    function mockApple(expiresDate: number) {
        return mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate, autoRenewStatus: 1,
                }]),
            },
        });
    }

    async function afterOverride() {
        jest.useFakeTimers().setSystemTime(0);
        await grantOverride('AC1');
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
    }

    it('override, nothing presented: entitled, no pointer', async () => {
        await grantOverride('AC1');
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', null, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: null });
    });

    it('override, purchase presented, no pointer yet: verifies once and points at the record (keeps ringing after the override)', async () => {
        await grantOverride('AC1');
        mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
    });

    it('override with a pointer already: keeps it without a store round-trip', async () => {
        await grantOverride('AC1');
        await admin.database().ref('/subscriptions/apple/orig1').set({ expiresAt: Date.now() + 1e9 });
        const fetchMock = mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('override, stale pointer, presented purchase already has a record: repoints without a store round-trip', async () => {
        await grantOverride('AC1');
        await admin.database().ref('/subscriptions/apple/orig1').set({ expiresAt: Date.now() + 1e9 });
        const fetchMock = mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, 'subscriptions/google/lapsed', reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('override, stale pointer, a new Google purchase with no record yet: verifies it and repoints (keeps ringing after the override)', async () => {
        await grantOverride('AC1');
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(Date.now() + 1e9).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokNew' }, 'subscriptions/google/tokOld', reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/google/tokNew' });
    });

    it('override, a Google token superseded by a rotation: points at the chain root without a store round-trip', async () => {
        await grantOverride('AC1');
        await admin.database().ref('/subscriptions/google/tokA').set({ expiresAt: Date.now() + 1e9 });
        await admin.database().ref('/subscriptions/google/tokB').set({ redirectTo: 'tokA' });
        googleMocks().subscriptionsV2Get.mockClear();
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokB' }, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/google/tokA' });
        expect(googleMocks().subscriptionsV2Get).not.toHaveBeenCalled();
    });

    it('override, an entitlement the store rejects: keeps the pointer and does not ask the store again on the next mint', async () => {
        await grantOverride('AC1');
        googleMocks().subscriptionsV2Get.mockClear();
        googleMocks().subscriptionsV2Get.mockRejectedValue(Object.assign(new Error('Gone'), { code: 410 }));
        const gone: PresentedEntitlement = { store: 'play_store', purchaseToken: 'tokGone' };
        for (let i = 0; i < 3; i++) {
            expect(await lastValueFrom(resolveDeviceEntitlement('AC1', gone, null, reverificationConfig)))
                .toEqual({ entitled: true, subscription: null });
        }
        expect(googleMocks().subscriptionsV2Get).toHaveBeenCalledTimes(1);
        googleMocks().subscriptionsV2Get.mockReset();
    });

    it('override, an Apple transaction that fails signature verification: keeps the pointer, never asks the store', async () => {
        await grantOverride('AC1');
        const fetchMock = mockApple(Date.now() + 1e9);
        const forged: PresentedEntitlement = { store: 'app_store', signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }) };
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', forged, 'subscriptions/apple/old', reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/old' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('nothing presented (e.g. after an iOS reinstall): no token beyond the override, but the pointer is kept', async () => {
        await afterOverride();
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', null, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: false, subscription: 'subscriptions/apple/orig1' });
    });

    it('nothing presented during the override keeps the pointer too (so it still rings once the override ends)', async () => {
        await grantOverride('AC1');
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', null, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
    });

    it('without an override, an active purchase: entitled, pointer set', async () => {
        await afterOverride();
        mockApple(THIRTY_DAYS_MS * 3);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
    });

    it('without an override, a lapsed purchase: not entitled, but the pointer is kept (a later renewal reaches the device again)', async () => {
        await afterOverride();
        mockApple(1);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: false, subscription: 'subscriptions/apple/orig1' });
    });

    it('no override and nothing presented: not entitled (a new user must start a store subscription)', async () => {
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', null, null, reverificationConfig)))
            .toEqual({ entitled: false, subscription: null });
    });

    it('a store outage refuses a token but keeps the pointer (the record still governs ringing)', async () => {
        await afterOverride();
        mockAppleFetch({ production: { status: 500 } });
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: false, subscription: 'subscriptions/apple/orig1' });
    });

    it('no override, an active record verified within the trust window: entitled without a store round-trip', async () => {
        await admin.database().ref('/subscriptions/apple/orig1').set({ expiresAt: Date.now() + 1e9, lastVerifiedAt: Date.now() - 60_000 });
        const fetchMock = mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no override, a Google record verified within the trust window: entitled without a store round-trip', async () => {
        await admin.database().ref('/subscriptions/google/tokA').set({ expiresAt: Date.now() + 1e9, lastVerifiedAt: Date.now() - 60_000 });
        expect(await lastValueFrom(resolveDeviceEntitlement(
            'AC1', { store: 'play_store', purchaseToken: 'tokA' }, null, reverificationConfig,
        ))).toEqual({ entitled: true, subscription: 'subscriptions/google/tokA' });
        expect(googleMocks().subscriptionsV2Get).not.toHaveBeenCalled();
    });

    it('no override, a record last verified longer ago than the trust window: re-verifies with the store', async () => {
        await admin.database().ref('/subscriptions/apple/orig1').set({ expiresAt: Date.now() + 1e9, lastVerifiedAt: Date.now() - 25 * 60 * 60 * 1000 });
        const fetchMock = mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
        expect(fetchMock).toHaveBeenCalled();
        expect(dbTree().subscriptions.apple.orig1.lastVerifiedAt).toBeGreaterThan(Date.now() - 60_000);
    });

    it('no override, a recently verified but expired record: asks the store (which may report a renewal)', async () => {
        await admin.database().ref('/subscriptions/apple/orig1').set({ expiresAt: Date.now() - 1, lastVerifiedAt: Date.now() });
        const fetchMock = mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
        expect(fetchMock).toHaveBeenCalled();
    });

    it('no override, no stored record: asks the store, and a store failure never grants', async () => {
        const fetchMock = mockAppleFetch({ production: { status: 500 } });
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: false, subscription: 'subscriptions/apple/orig1' });
        expect(fetchMock).toHaveBeenCalled();
    });

    it('no override, a record without lastVerifiedAt is not trusted', async () => {
        await admin.database().ref('/subscriptions/apple/orig1').set({ expiresAt: Date.now() + 1e9 });
        const fetchMock = mockAppleFetch({ production: { status: 500 } });
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: false, subscription: null });
        expect(fetchMock).toHaveBeenCalled();
    });

    it('a Google pointer names the chain root, so it survives token rotation', async () => {
        await afterOverride();
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(THIRTY_DAYS_MS * 3).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(THIRTY_DAYS_MS * 4).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
            linkedPurchaseToken: 'tokA',
        }));
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokB' }, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/google/tokA' });
    });
});

/**
 * Regression: an app-presented Apple transaction was only decoded, so a tampered
 * app could forge a JWS naming ANOTHER customer's active originalTransactionId and
 * be entitled with that customer's subscription. It must now verify against
 * Apple's chain, our bundle id and the environment before anything is looked up.
 */
describe('app-presented Apple transactions are signature-verified', () => {
    beforeEach(resetDb);
    afterEach(() => jest.useRealTimers());

    function someoneElsesActiveSubscription() {
        return mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'victim', productId: 'monthly-dialcrest-license',
                    expiresDate: Date.now() + 1e9, autoRenewStatus: 1,
                }]),
            },
        });
    }

    const forged = signedPayload({ originalTransactionId: 'victim', productId: 'monthly-dialcrest-license' });

    it('verifyApplePurchase rejects a forged (unsigned) transaction without asking Apple about it', async () => {
        const fetchMock = someoneElsesActiveSubscription();
        await expect(lastValueFrom(verifyApplePurchase('AC1', forged, testAppleConfig))).rejects.toThrow('signature verification');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(dbTree().subscriptions).toBeUndefined();
    });

    it('a forged transaction never entitles a token mint without an override', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await grantOverride('AC1');
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        const fetchMock = someoneElsesActiveSubscription();
        const entitlement: PresentedEntitlement = { store: 'app_store', signedTransactionInfo: forged };
        expect(await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig))).toBe(false);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', entitlement, null, reverificationConfig)))
            .toEqual({ entitled: false, subscription: null });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a genuinely signed transaction for another app (bundle id)', async () => {
        const fetchMock = someoneElsesActiveSubscription();
        const otherApp = appleSignedTransaction({ originalTransactionId: 'victim', productId: 'monthly-dialcrest-license', bundleId: 'com.other.app' });
        await expect(lastValueFrom(verifyApplePurchase('AC1', otherApp, testAppleConfig))).rejects.toThrow('signature verification');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a Production transaction while appAppleId is not configured', async () => {
        someoneElsesActiveSubscription();
        const production = appleSignedTransaction({ originalTransactionId: 'victim', productId: 'monthly-dialcrest-license', environment: 'Production' });
        await expect(lastValueFrom(verifyApplePurchase('AC1', production, testAppleConfig))).rejects.toThrow('signature verification');
    });

    it('rejects a signed transaction whose payload was altered (e.g. swapping in another originalTransactionId)', async () => {
        const fetchMock = someoneElsesActiveSubscription();
        const [header, , signature] = appleSignedTransaction({ originalTransactionId: 'mine', productId: 'monthly-dialcrest-license' }).split('.');
        const swapped = Buffer.from(JSON.stringify({
            originalTransactionId: 'victim', productId: 'monthly-dialcrest-license', bundleId: 'be.peblet.dialcrest',
            environment: 'Sandbox', signedDate: Date.UTC(2027, 0, 1),
        })).toString('base64url');
        await expect(lastValueFrom(verifyApplePurchase('AC1', `${header}.${swapped}.${signature}`, testAppleConfig))).rejects.toThrow();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts a genuine transaction and looks up exactly the transaction it names', async () => {
        const fetchMock = someoneElsesActiveSubscription();
        await lastValueFrom(verifyApplePurchase(
            'AC1', appleSignedTransaction({ originalTransactionId: 'victim', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/inApps/v1/subscriptions/victim'), expect.anything());
    });
});

describe('Apple verification configuration', () => {
    beforeEach(resetDb);
    afterEach(() => setAppleVerificationForTests([testAppleRootCertificate]));

    function mockActive() {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license',
                    expiresDate: Date.now() + 1e9, autoRenewStatus: 1,
                }]),
            },
        });
    }

    it('accepts appAppleId stored as a numeric string for Production transactions', async () => {
        mockActive();
        const production = appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', environment: 'Production' });
        // The test chain doesn't carry a real appAppleId claim for transactions; the library only checks it for Production
        // notifications/app transactions, so this proves the string form builds a Production verifier at all.
        const status = await lastValueFrom(verifyApplePurchase('AC1', production, { ...testAppleConfig, appAppleId: '42' }));
        expect(status.isActive).toBe(true);
    });

    it('verifies app-presented transactions offline (against signedDate) even when online checks are on', async () => {
        // With online checks the library would demand an OCSP responder in the chain, which the test
        // chain doesn't have — so this only passes because presented transactions skip them.
        setAppleVerificationForTests([testAppleRootCertificate], true);
        mockActive();
        const status = await lastValueFrom(verifyApplePurchase(
            'AC1', appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
        expect(status.isActive).toBe(true);
    });

    it('still runs online checks for server notifications', async () => {
        setAppleVerificationForTests([testAppleRootCertificate], true);
        const notification = appleSignedJws({
            notificationType: 'DID_RENEW', notificationUUID: 'n1', version: '2.0', signedDate: Date.UTC(2027, 0, 1),
            data: { environment: 'Sandbox', bundleId: testAppleConfig.bundleId },
        });
        // The test chain has no OCSP responder: an online check can't pass.
        expect(await verifyAppleNotificationSignature(notification, testAppleConfig)).not.toBe('verified');
    });
});
