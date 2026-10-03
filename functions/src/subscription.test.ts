import admin from 'firebase-admin';
import { lastValueFrom } from 'rxjs';
import {
    ensureAccountCreated,
    ensureTrialStarted,
    isSubscriptionActive,
    verifyEntitlement,
    refreshAppleByOriginalTransactionId,
    handleAppleNotification,
    verifyApplePurchase,
    handleGoogleNotification,
    verifyGooglePurchase,
    PresentedEntitlement,
    ReverificationConfig,
} from './subscription';
import { testAppleConfig, appleSubscriptionStatusesResponse, mockAppleFetch, signedPayload } from './testUtils/appleFixtures';
import { googleSubscriptionV2Response } from './testUtils/googleFixtures';

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
            signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
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
            signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
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
            signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
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
            signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
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
            { store: 'app_store', signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license' }) },
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
            'AC1', signedPayload({ originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license' }), testAppleConfig,
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
            'AC1', signedPayload({ originalTransactionId: 'orig-sandbox', productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
        expect(status.plan).toBe('monthly');
    });

    it('throws when the transaction is found in neither production nor sandbox', async () => {
        mockAppleFetch({});
        await expect(lastValueFrom(verifyApplePurchase(
            'AC1', signedPayload({ originalTransactionId: 'missing', productId: 'monthly-dialcrest-license' }), testAppleConfig,
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
            'AC-presenting', signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }), testAppleConfig,
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
 * Regression: the inbound-call webhook only knows the AccountSid, and paid state
 * is keyed by store identity — so paying users stopped ringing once their trial
 * ended. Verified store state is now mirrored into /twilio/{sid}/paid, both when
 * an entitlement is presented and when a store notification arrives later.
 */
describe('account paid cache (/twilio/{sid}/paid) for the inbound-call webhook', () => {
    beforeEach(resetDb);

    function mockApple(originalTransactionId: string, expiresDate: number) {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId, productId: 'monthly-dialcrest-license', expiresDate, autoRenewStatus: 1,
                }]),
            },
        });
    }

    function presentApple(accountSid: string, originalTransactionId: string) {
        return lastValueFrom(verifyApplePurchase(
            accountSid, signedPayload({ originalTransactionId, productId: 'monthly-dialcrest-license' }), testAppleConfig,
        ));
    }

    function appleRenewalNotification(originalTransactionId: string) {
        const tx = signedPayload({ transactionId: 't2', originalTransactionId, productId: 'monthly-dialcrest-license', expiresDate: 1 });
        return lastValueFrom(handleAppleNotification(
            signedPayload({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: tx } }), testAppleConfig,
        ));
    }

    function mockGoogle(expiresAt: number, linkedPurchaseToken?: string) {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(expiresAt).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license', linkedPurchaseToken,
        }));
    }

    it('caches a verified Apple purchase on the presenting account', async () => {
        mockApple('orig1', 5_000_000);
        await presentApple('AC1', 'orig1');
        expect(dbTree().twilio.AC1.paid).toMatchObject({ store: 'app_store', key: 'orig1', expiresAt: 5_000_000 });
    });

    it('caches a verified Google purchase on the presenting account', async () => {
        mockGoogle(6_000_000);
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        expect(dbTree().twilio.AC1.paid).toMatchObject({ store: 'play_store', key: 'tokA', expiresAt: 6_000_000 });
    });

    it('caches via isSubscriptionActive too (the twilioAccessToken path once the trial is over)', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await lastValueFrom(ensureTrialStarted('AC1'));
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        mockApple('orig1', THIRTY_DAYS_MS * 3);
        const entitlement: PresentedEntitlement = {
            store: 'app_store', signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
        };
        expect(await lastValueFrom(isSubscriptionActive('AC1', entitlement, reverificationConfig))).toBe(true);
        expect(dbTree().twilio.AC1.paid.expiresAt).toBe(THIRTY_DAYS_MS * 3);
        jest.useRealTimers();
    });

    it('an Apple renewal notification keeps lastAccountSid and extends that account\'s cache', async () => {
        mockApple('orig1', 5_000_000);
        await presentApple('AC1', 'orig1');
        mockApple('orig1', 9_000_000);
        await appleRenewalNotification('orig1');
        expect(dbTree().subscriptions.apple.orig1.lastAccountSid).toBe('AC1');
        expect(dbTree().twilio.AC1.paid.expiresAt).toBe(9_000_000);
    });

    it('a Google refund notification shortens the cache of the same purchase', async () => {
        mockGoogle(6_000_000);
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        mockGoogle(1_000);
        await lastValueFrom(handleGoogleNotification({ voidedPurchaseNotification: { purchaseToken: 'tokA' } }, 'pkg', '{}'));
        expect(dbTree().subscriptions.google.tokA.lastAccountSid).toBe('AC1');
        expect(dbTree().twilio.AC1.paid.expiresAt).toBe(1_000);
    });

    it('follows a rotated Google token to the chain root and the account behind it', async () => {
        mockGoogle(6_000_000);
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        mockGoogle(8_000_000, 'tokA'); // upgrade: new token linked to tokA, arriving as a notification
        await lastValueFrom(handleGoogleNotification({ subscriptionNotification: { purchaseToken: 'tokB' } }, 'pkg', '{}'));
        expect(dbTree().twilio.AC1.paid).toMatchObject({ key: 'tokA', expiresAt: 8_000_000 });
    });

    it('a notification for a record no account ever presented caches nothing', async () => {
        mockApple('orig1', 5_000_000);
        await appleRenewalNotification('orig1');
        expect(dbTree().twilio).toBeUndefined();
    });

    it('a lapsed other purchase never shadows a longer-lived one on the same account', async () => {
        mockApple('orig-new', 9_000_000);
        await presentApple('AC1', 'orig-new');
        mockApple('orig-old', 2_000_000);
        await presentApple('AC1', 'orig-old');
        expect(dbTree().twilio.AC1.paid).toMatchObject({ key: 'orig-new', expiresAt: 9_000_000 });
    });

    it('a longer-lived other purchase replaces the cached one', async () => {
        mockApple('orig-old', 2_000_000);
        await presentApple('AC1', 'orig-old');
        mockGoogle(9_000_000);
        await lastValueFrom(verifyGooglePurchase('AC1', 'tokA', 'pkg', '{}'));
        expect(dbTree().twilio.AC1.paid).toMatchObject({ store: 'play_store', key: 'tokA', expiresAt: 9_000_000 });
    });

    it('a failing cache write never fails the verification it rides on', async () => {
        mockApple('orig1', 5_000_000);
        const realDatabase = admin.database;
        const spy = jest.spyOn(admin, 'database').mockImplementation(() => {
            const db = realDatabase();
            return {
                ...db,
                ref: (path: string) => path.endsWith('/paid') ?
                    { transaction: () => Promise.reject(new Error('RTDB down')) } :
                    db.ref(path),
            } as unknown as ReturnType<typeof admin.database>;
        });
        try {
            await expect(presentApple('AC1', 'orig1')).resolves.toMatchObject({ isActive: expect.any(Boolean), expiresAt: 5_000_000 });
        } finally {
            spy.mockRestore();
        }
    });
});
