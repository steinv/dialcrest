import admin from 'firebase-admin';
import { lastValueFrom } from 'rxjs';
import {
    ensureAccountCreated,
    ensureTrialStarted,
    isSubscriptionActive,
    resolveDeviceEntitlement,
    verifyEntitlement,
    refreshAppleByOriginalTransactionId,
    handleAppleNotification,
    verifyApplePurchase,
    handleGoogleNotification,
    verifyGooglePurchase,
    setAppleVerificationForTests,
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

// App-presented Apple transactions are signature-verified: trust the throwaway test CA.
beforeAll(() => setAppleVerificationForTests([testAppleRootCertificate]));
afterAll(() => setAppleVerificationForTests(null));

const reverificationConfig: ReverificationConfig = {
    apple: testAppleConfig,
    googlePackageName: 'be.peblet.twilio_phone',
    googleServiceAccountJson: '{}',
};

describe('trial axis', () => {
    beforeEach(resetDb);
    afterEach(() => jest.useRealTimers());

    it('records createdAt on first call and never overwrites it on repeat calls', async () => {
        jest.useFakeTimers().setSystemTime(1000);
        await lastValueFrom(ensureAccountCreated('AC1'));
        jest.setSystemTime(5000);
        await lastValueFrom(ensureAccountCreated('AC1'));
        expect(dbTree().twilio.AC1.createdAt).toBe(1000);
    });

    it('starts a 30-day trial and never resets it on repeat calls', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await lastValueFrom(ensureTrialStarted('AC1'));
        expect(dbTree().twilio.AC1.trial).toEqual({
            plan: 'trial', trialStartedAt: 0, expiresAt: THIRTY_DAYS_MS, lastVerifiedAt: 0,
        });
        jest.setSystemTime(1000);
        await lastValueFrom(ensureTrialStarted('AC1'));
        expect(dbTree().twilio.AC1.trial.trialStartedAt).toBe(0);
        expect(dbTree().twilio.AC1.trial.expiresAt).toBe(THIRTY_DAYS_MS);
    });
});

describe('isSubscriptionActive (the trial-OR-entitlement gate)', () => {
    beforeEach(() => {
        resetDb();
        jest.useFakeTimers().setSystemTime(0);
    });
    afterEach(() => jest.useRealTimers());

    it('is active while the trial has not expired, with no entitlement presented', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
        const active = await lastValueFrom(isSubscriptionActive('AC1', null, reverificationConfig));
        expect(active).toBe(true);
    });

    it('backfills a trial (and stays active) for an account that predates the subscription system', async () => {
        const active = await lastValueFrom(isSubscriptionActive('AC-legacy', null, reverificationConfig));
        expect(active).toBe(true);
        expect(dbTree().twilio['AC-legacy'].trial.plan).toBe('trial');
    });

    it('is inactive once the trial has expired and no entitlement is presented', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        const active = await lastValueFrom(isSubscriptionActive('AC1', null, reverificationConfig));
        expect(active).toBe(false);
    });

    it('never re-verifies a store entitlement while the trial is still live (cheap path first)', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
        const fetchMock = mockAppleFetch({});
        const entitlement: PresentedEntitlement = {
            store: 'app_store',
            signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
        const active = await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig));
        expect(active).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to a live Apple entitlement once the trial has expired', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
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
        await lastValueFrom(ensureTrialStarted('AC1'));
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

    it('falls back to a live Google entitlement once the trial has expired', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
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
        await lastValueFrom(ensureTrialStarted('AC1'));
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
        expect(status).toEqual({ plan: 'yearly', expiresAt: 100000, autoRenew: true, isActive: true });
    });

    it('re-verifies a Google entitlement and acknowledges a pending purchase', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(200000).toISOString(), autoRenewEnabled: false, basePlanId: 'monthly-dialcrest-license',
            acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
        }));
        const status = await lastValueFrom(verifyEntitlement('AC1', { store: 'play_store', purchaseToken: 'tokA' }, reverificationConfig));
        expect(status).toEqual({ plan: 'monthly', expiresAt: 200000, autoRenew: false, isActive: true });
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
    beforeEach(resetDb);
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

    async function afterTrial() {
        jest.useFakeTimers().setSystemTime(0);
        await lastValueFrom(ensureTrialStarted('AC1'));
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
    }

    it('trial, nothing presented: entitled, no pointer', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', null, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: null });
    });

    it('trial, purchase presented, no pointer yet: verifies once and points at the record (keeps ringing after the trial)', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
        mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
    });

    it('trial with a pointer already: keeps it without a store round-trip', async () => {
        await lastValueFrom(ensureTrialStarted('AC1'));
        const fetchMock = mockApple(Date.now() + 1e9);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('after the trial with nothing presented: not entitled, pointer cleared', async () => {
        await afterTrial();
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', null, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: false, subscription: null });
    });

    it('after the trial with an active purchase: entitled, pointer set', async () => {
        await afterTrial();
        mockApple(THIRTY_DAYS_MS * 3);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: true, subscription: 'subscriptions/apple/orig1' });
    });

    it('after the trial with a lapsed purchase: not entitled, but the pointer is kept (a later renewal reaches the device again)', async () => {
        await afterTrial();
        mockApple(1);
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, null, reverificationConfig)))
            .toEqual({ entitled: false, subscription: 'subscriptions/apple/orig1' });
    });

    it('a store outage refuses a token but keeps the pointer (the record still governs ringing)', async () => {
        await afterTrial();
        mockAppleFetch({ production: { status: 500 } });
        expect(await lastValueFrom(resolveDeviceEntitlement('AC1', appleEntitlement, 'subscriptions/apple/orig1', reverificationConfig)))
            .toEqual({ entitled: false, subscription: 'subscriptions/apple/orig1' });
    });

    it('a Google pointer names the chain root, so it survives token rotation', async () => {
        await afterTrial();
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

    it('a forged transaction never entitles a token mint after the trial', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await lastValueFrom(ensureTrialStarted('AC1'));
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
