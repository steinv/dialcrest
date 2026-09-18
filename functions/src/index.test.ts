import admin from 'firebase-admin';
import { testAppleConfig, appleSubscriptionStatusesResponse, mockAppleFetch, signedPayload } from './testUtils/appleFixtures';
import { googleSubscriptionV2Response } from './testUtils/googleFixtures';

jest.mock('firebase-admin');
jest.mock('googleapis', () => require('./testUtils/googleFixtures').mockGoogleapisModule());

/**
 * index.ts's Cloud Functions are the wiring around subscription.ts, not
 * subscription logic themselves — twilio.ts (Twilio REST API calls for
 * numbers/credentials/tokens) is out of scope here, so every twilio.ts export
 * is stubbed. accessToken() only needs to resolve so twilioAccessToken's
 * "subscription active" path can be observed end to end.
 */
jest.mock('./twilio', () => ({
    accessToken: jest.fn().mockResolvedValue('fake-jwt-token'),
    createOrUpdatePushCredentials: jest.fn().mockResolvedValue({ androidSid: 'CR-android', iosSid: null }),
    getIncomingAppSid: jest.fn(),
    configureSelectedNumbers: jest.fn(),
    registerMessagingDevice: jest.fn(),
    callbackIncomingCall: jest.fn(),
    callbackOutgoingCall: jest.fn(),
    callbackCallStatusChanges: jest.fn(),
    callbackIncomingMessage: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const functions = require('./index');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

function twilioMocks() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./twilio');
}

function makeRes() {
    const res: { statusCode?: number; body?: unknown; status: jest.Mock; send: jest.Mock; type: jest.Mock } = {
        status: jest.fn(),
        send: jest.fn(),
        type: jest.fn(),
    };
    res.status.mockImplementation((code: number) => { res.statusCode = code; return res; });
    res.send.mockImplementation((body: unknown) => { res.body = body; return res; });
    res.type.mockImplementation(() => res);
    return res;
}

function flushMicrotasks() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    resetDb();
    process.env.TWILIO_PEBLET_SECRET = JSON.stringify({
        apple_iap_key: testAppleConfig,
        android_fcm: { type: 'service_account' },
    });
});

describe('twilioRegister', () => {
    it('creates the account, starts its trial, and provisions push credentials', async () => {
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        expect(dbTree().twilio.AC1.createdAt).toEqual(expect.any(Number));
        expect(dbTree().twilio.AC1.subscription.plan).toBe('trial');
        expect(twilioMocks().createOrUpdatePushCredentials).toHaveBeenCalledWith(
            'AC1', 'tok', expect.any(String), expect.any(String), expect.any(String),
        );
    });

    it('never resets an existing trial on re-registration', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        jest.setSystemTime(1000);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        expect(dbTree().twilio.AC1.subscription.trialStartedAt).toBe(0);
        jest.useRealTimers();
    });
});

describe('twilioAccessToken (subscription gating)', () => {
    it('mints a token while the trial is active', async () => {
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        const jwt = await functions.twilioAccessToken.run({ data: { accountSid: 'AC1', authToken: 'tok', callerId: '+3200000000' } });
        expect(jwt).toBe('fake-jwt-token');
        expect(twilioMocks().accessToken).toHaveBeenCalledWith('AC1', 'tok', '+3200000000');
    });

    it('refuses to mint a token once the trial has expired with no entitlement presented', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        await expect(functions.twilioAccessToken.run({ data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } }))
            .rejects.toMatchObject({ code: 'failed-precondition', message: 'subscription-expired' });
        expect(twilioMocks().accessToken).not.toHaveBeenCalled();
        jest.useRealTimers();
    });

    it('mints a token once the trial expires if a live Apple entitlement is presented', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
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
        const jwt = await functions.twilioAccessToken.run({
            data: {
                accountSid: 'AC1', authToken: 'tok', callerId: 'x',
                signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
            },
        });
        expect(jwt).toBe('fake-jwt-token');
        expect(dbTree().subscriptions.apple.orig1.plan).toBe('monthly');
        jest.useRealTimers();
    });

    it('refuses to mint a token once the trial expires if the presented entitlement fails to verify', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        mockAppleFetch({}); // both production and sandbox 404
        await expect(functions.twilioAccessToken.run({
            data: {
                accountSid: 'AC1', authToken: 'tok', callerId: 'x',
                signedTransactionInfo: signedPayload({ originalTransactionId: 'missing', productId: 'monthly-dialcrest-license' }),
            },
        })).rejects.toMatchObject({ code: 'failed-precondition', message: 'subscription-expired' });
        jest.useRealTimers();
    });
});

describe('twilioVerifyApplePurchase / twilioVerifyGooglePurchase', () => {
    it('verifies an Apple purchase against the App Store Server API and persists it', async () => {
        const farFuture = Date.now() + 999999999;
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license', expiresDate: farFuture, autoRenewStatus: 1,
                }]),
            },
        });
        const result = await functions.twilioVerifyApplePurchase.run({
            data: { accountSid: 'AC1', signedTransactionInfo: signedPayload({ originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license' }) },
        });
        expect(result).toEqual({ plan: 'yearly', expiresAt: farFuture, autoRenew: true, isActive: true });
        expect(dbTree().subscriptions.apple.orig1.lastAccountSid).toBe('AC1');
    });

    it('verifies a Google purchase against the Play Developer API and persists it', async () => {
        const farFuture = Date.now() + 999999999;
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(farFuture).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        const result = await functions.twilioVerifyGooglePurchase.run({ data: { accountSid: 'AC1', purchaseToken: 'tokA' } });
        expect(result).toEqual({ plan: 'monthly', expiresAt: farFuture, autoRenew: true, isActive: true });
        expect(dbTree().subscriptions.google.tokA.lastAccountSid).toBe('AC1');
    });
});

describe('twilioAppleNotifications webhook', () => {
    it('responds 400 when the request carries no signedPayload', async () => {
        const res = makeRes();
        functions.twilioAppleNotifications({ body: {} }, res);
        await flushMicrotasks();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('responds 200 and persists the refreshed state on a valid notification', async () => {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 12345, autoRenewStatus: 0,
                }]),
            },
        });
        const signedTx = signedPayload({ transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 12345 });
        const body = { signedPayload: signedPayload({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: signedTx } }) };
        const res = makeRes();
        functions.twilioAppleNotifications({ body }, res);
        await flushMicrotasks();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(dbTree().subscriptions.apple.orig1.expiresAt).toBe(12345);
    });
});

describe('onPlaySubscriptionNotification', () => {
    it('refreshes and persists the affected purchase token', async () => {
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(54321).toISOString(), autoRenewEnabled: false, basePlanId: 'yearly-dialcrest-license',
        }));
        await functions.onPlaySubscriptionNotification.run({
            data: { message: { json: { subscriptionNotification: { notificationType: 4, purchaseToken: 'tokA', subscriptionId: 'dialcrest' } } } },
        });
        expect(dbTree().subscriptions.google.tokA.expiresAt).toBe(54321);
    });

    it('does not throw when the Pub/Sub message body is not valid JSON', async () => {
        const event = {
            data: {
                message: {
                    get json(): unknown { throw new Error('invalid JSON'); },
                },
            },
        };
        const result = await functions.onPlaySubscriptionNotification.run(event);
        expect(result).toBeUndefined();
    });
});

describe('twilioRefreshSubscription', () => {
    it('rejects when the device presents no entitlement', async () => {
        await expect(functions.twilioRefreshSubscription.run({ data: { accountSid: 'AC1' } }))
            .rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('re-verifies whatever entitlement is presented', async () => {
        const farFuture = Date.now() + 999999999;
        googleMocks().subscriptionsV2Get.mockResolvedValueOnce(googleSubscriptionV2Response({
            expiryTime: new Date(farFuture).toISOString(), autoRenewEnabled: true, basePlanId: 'monthly-dialcrest-license',
        }));
        const result = await functions.twilioRefreshSubscription.run({ data: { accountSid: 'AC1', purchaseToken: 'tokA' } });
        expect(result).toEqual({ plan: 'monthly', expiresAt: farFuture, autoRenew: true, isActive: true });
    });
});
