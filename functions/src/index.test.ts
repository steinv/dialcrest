import admin from 'firebase-admin';
import { testAppleConfig, appleSubscriptionStatusesResponse, mockAppleFetch, signedPayload } from './testUtils/appleFixtures';
import { googleSubscriptionV2Response } from './testUtils/googleFixtures';
import { appleSignedJws, appleSignedTransaction, testAppleRootCertificate } from './testUtils/appleTestPki';
import { setAppleVerificationForTests } from './subscription';

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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    rememberAuthToken: jest.fn(() => require('rxjs').of(undefined)),
    accessToken: jest.fn().mockResolvedValue('fake-jwt-token'),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    deviceSubscription: jest.fn(() => require('rxjs').of(null)),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    recordDeviceCheckIn: jest.fn(() => require('rxjs').of(undefined)),
    verifyTwilioCredentials: jest.fn().mockResolvedValue(undefined),
    InvalidTwilioCredentialsError: class InvalidTwilioCredentialsError extends Error {},
    createOrUpdatePushCredentials: jest.fn().mockResolvedValue({ androidSid: 'CR-android', iosSid: null }),
    getIncomingAppSid: jest.fn(),
    configureSelectedNumbers: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ensureWebhooksCurrent: jest.fn(() => require('rxjs').of(undefined)),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    registerMessagingDevice: jest.fn(() => require('rxjs').of(undefined)),
    callbackIncomingCall: jest.fn(),
    callbackOutgoingCall: jest.fn(),
    callbackCallStatusChanges: jest.fn(),
    callbackIncomingMessage: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const functions = require('./index');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** The calling device's (anonymous) Firebase identity — its uid keys its device record and Voice identity. */
const DEVICE = { uid: 'device1' };

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

function makeReq(body: unknown) {
    return { body };
}

beforeEach(() => {
    resetDb();
    process.env.TWILIO_PEBLET_SECRET = JSON.stringify({
        apple_iap_key: testAppleConfig,
        android_fcm: { type: 'service_account' },
    });
    setAppleVerificationForTests([testAppleRootCertificate]);
});

afterAll(() => setAppleVerificationForTests(null));

describe('twilioRegister', () => {
    it('creates the account, starts its trial, and provisions push credentials', async () => {
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        expect(dbTree().twilio.AC1.createdAt).toEqual(expect.any(Number));
        expect(dbTree().twilio.AC1.trial.plan).toBe('trial');
        expect(twilioMocks().createOrUpdatePushCredentials).toHaveBeenCalledWith(
            'AC1', 'tok', expect.any(String), expect.any(String), expect.any(String),
        );
    });

    it('never resets an existing trial on re-registration', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        jest.setSystemTime(1000);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        expect(dbTree().twilio.AC1.trial.trialStartedAt).toBe(0);
        jest.useRealTimers();
    });
});

describe('twilioAccessToken (subscription gating)', () => {
    it('mints a token while the trial is active', async () => {
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        const jwt = await functions.twilioAccessToken.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', callerId: '+3200000000' } });
        expect(jwt).toBe('fake-jwt-token');
        expect(twilioMocks().accessToken).toHaveBeenCalledWith('AC1', 'tok', '+3200000000', 'device1');
    });

    it('refuses to mint a token once the trial has expired with no entitlement presented', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        await expect(functions.twilioAccessToken.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } }))
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
            auth: DEVICE,
            data: {
                accountSid: 'AC1', authToken: 'tok', callerId: 'x',
                signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
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
            auth: DEVICE,
            data: {
                accountSid: 'AC1', authToken: 'tok', callerId: 'x',
                signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'missing', productId: 'monthly-dialcrest-license' }),
            },
        })).rejects.toMatchObject({ code: 'failed-precondition', message: 'subscription-expired' });
        jest.useRealTimers();
    });
});

describe('twilioAccessToken (credentials + per-device registry)', () => {
    it('refuses with permission-denied, minting nothing, when the Auth Token is not valid for the account', async () => {
        const { InvalidTwilioCredentialsError } = twilioMocks();
        twilioMocks().verifyTwilioCredentials.mockRejectedValueOnce(new InvalidTwilioCredentialsError('AC1'));
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        await expect(functions.twilioAccessToken.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'guessed', callerId: 'x' } }))
            .rejects.toMatchObject({ code: 'permission-denied', message: 'invalid-twilio-credentials' });
        expect(twilioMocks().accessToken).not.toHaveBeenCalled();
        expect(twilioMocks().recordDeviceCheckIn).not.toHaveBeenCalled();
    });

    it('verifies the credentials before checking the subscription', async () => {
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        await functions.twilioAccessToken.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } });
        expect(twilioMocks().verifyTwilioCredentials).toHaveBeenCalledWith('AC1', 'tok');
    });

    it('requires a signed-in device (its uid is the per-device identity)', async () => {
        await expect(functions.twilioAccessToken.run({ data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } }))
            .rejects.toMatchObject({ code: 'unauthenticated' });
        await expect(functions.twilioAccessToken.run({ auth: { uid: 'bad/uid' }, data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } }))
            .rejects.toMatchObject({ code: 'unauthenticated' });
        expect(twilioMocks().accessToken).not.toHaveBeenCalled();
    });

    it('records the device check-in (no subscription pointer during a plain trial)', async () => {
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        await functions.twilioAccessToken.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } });
        expect(twilioMocks().recordDeviceCheckIn).toHaveBeenCalledWith('AC1', 'device1', null);
    });

    it('points a paying device at its store record, so inbound calls/SMS keep reaching it after the trial', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license',
                    expiresDate: THIRTY_DAYS_MS * 3, autoRenewStatus: 1,
                }]),
            },
        });
        await functions.twilioAccessToken.run({
            auth: DEVICE,
            data: {
                accountSid: 'AC1', authToken: 'tok', callerId: 'x',
                signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license' }),
            },
        });
        expect(twilioMocks().recordDeviceCheckIn).toHaveBeenCalledWith('AC1', 'device1', 'subscriptions/apple/orig1');
        jest.useRealTimers();
    });

    it('refuses an unentitled device after the trial, recording it without a pointer (so it is not rung/notified)', async () => {
        jest.useFakeTimers().setSystemTime(0);
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        jest.setSystemTime(THIRTY_DAYS_MS + 1);
        await expect(functions.twilioAccessToken.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } }))
            .rejects.toMatchObject({ code: 'failed-precondition', message: 'subscription-expired' });
        expect(twilioMocks().recordDeviceCheckIn).toHaveBeenCalledWith('AC1', 'device1', null);
        expect(twilioMocks().accessToken).not.toHaveBeenCalled();
        jest.useRealTimers();
    });
});

describe('twilioRegisterMessagingDevice', () => {
    const FCM = 'dAbC-123_x:APA91bExample';

    it('registers the device once the Auth Token is verified for the account', async () => {
        await functions.twilioRegisterMessagingDevice.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', fcmToken: FCM } });
        expect(twilioMocks().verifyTwilioCredentials).toHaveBeenCalledWith('AC1', 'tok');
        expect(twilioMocks().registerMessagingDevice).toHaveBeenCalledWith('AC1', 'device1', FCM);
    });

    it('refuses another tenant\'s AccountSid without its Auth Token (no SMS interception)', async () => {
        const { InvalidTwilioCredentialsError } = twilioMocks();
        twilioMocks().verifyTwilioCredentials.mockRejectedValueOnce(new InvalidTwilioCredentialsError('AC-victim'));
        await expect(functions.twilioRegisterMessagingDevice.run({ auth: DEVICE, data: { accountSid: 'AC-victim', authToken: 'guessed', fcmToken: FCM } }))
            .rejects.toMatchObject({ code: 'permission-denied', message: 'invalid-twilio-credentials' });
        expect(twilioMocks().registerMessagingDevice).not.toHaveBeenCalled();
    });

    it('requires a signed-in device', async () => {
        await expect(functions.twilioRegisterMessagingDevice.run({ data: { accountSid: 'AC1', authToken: 'tok', fcmToken: FCM } }))
            .rejects.toMatchObject({ code: 'unauthenticated' });
        expect(twilioMocks().registerMessagingDevice).not.toHaveBeenCalled();
    });

    it('refuses a call that sends no Auth Token at all (pre-fix app builds)', async () => {
        const { InvalidTwilioCredentialsError } = twilioMocks();
        twilioMocks().verifyTwilioCredentials.mockRejectedValueOnce(new InvalidTwilioCredentialsError('AC1'));
        await expect(functions.twilioRegisterMessagingDevice.run({ auth: DEVICE, data: { accountSid: 'AC1', fcmToken: FCM } }))
            .rejects.toMatchObject({ code: 'permission-denied' });
        expect(twilioMocks().verifyTwilioCredentials).toHaveBeenCalledWith('AC1', undefined);
        expect(twilioMocks().registerMessagingDevice).not.toHaveBeenCalled();
    });

    it.each(['', 'a/b', '../secret', 'tok.en', 'tok#1', 'tok$', 'tok[0]'])('rejects a malformed FCM token %p before anything else', async (fcmToken) => {
        await expect(functions.twilioRegisterMessagingDevice.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', fcmToken } }))
            .rejects.toMatchObject({ code: 'invalid-argument' });
        expect(twilioMocks().verifyTwilioCredentials).not.toHaveBeenCalled();
        expect(twilioMocks().registerMessagingDevice).not.toHaveBeenCalled();
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
            data: { accountSid: 'AC1', signedTransactionInfo: appleSignedTransaction({ originalTransactionId: 'orig1', productId: 'yearly-dialcrest-license' }) },
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
    const signedTx = signedPayload({ transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 12345 });

    function notification(data: Record<string, unknown>) {
        return { notificationType: 'DID_RENEW', notificationUUID: 'n1', version: '2.0', signedDate: Date.now(), data };
    }

    function sandboxNotification(overrides: Record<string, unknown> = {}) {
        return notification({ environment: 'Sandbox', bundleId: testAppleConfig.bundleId, signedTransactionInfo: signedTx, ...overrides });
    }

    function mockRenewedSubscription() {
        mockAppleFetch({
            production: {
                status: 200,
                body: appleSubscriptionStatusesResponse([{
                    transactionId: 't1', originalTransactionId: 'orig1', productId: 'monthly-dialcrest-license', expiresDate: 12345, autoRenewStatus: 0,
                }]),
            },
        });
    }

    async function post(body: unknown) {
        const res = makeRes();
        await functions.twilioAppleNotifications(makeReq(body), res);
        await flushMicrotasks();
        return res;
    }

    it('responds 400 when the request carries no signedPayload', async () => {
        const res = await post({});
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('responds 200 and persists the refreshed state on a genuinely signed notification', async () => {
        mockRenewedSubscription();
        const res = await post({ signedPayload: appleSignedJws(sandboxNotification()) });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(dbTree().subscriptions.apple.orig1.expiresAt).toBe(12345);
    });

    it('rejects an unsigned/forged notification with 401 before calling Apple or touching the DB', async () => {
        const fetchMock = mockAppleFetch({});
        const res = await post({ signedPayload: signedPayload(sandboxNotification()) });
        expect(res.status).toHaveBeenCalledWith(401);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(dbTree().subscriptions).toBeUndefined();
    });

    it('rejects a genuinely signed notification whose payload was altered afterwards', async () => {
        const fetchMock = mockAppleFetch({});
        const [header, , signature] = appleSignedJws(sandboxNotification()).split('.');
        const altered = Buffer.from(JSON.stringify(sandboxNotification({ signedTransactionInfo: 'swapped' }))).toString('base64url');
        const res = await post({ signedPayload: `${header}.${altered}.${signature}` });
        expect(res.status).toHaveBeenCalledWith(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a validly signed notification for a different app (bundleId)', async () => {
        const res = await post({ signedPayload: appleSignedJws(sandboxNotification({ bundleId: 'com.someone.else' })) });
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects Production notifications while apple_iap_key.appAppleId is not configured', async () => {
        const production = notification({ environment: 'Production', bundleId: testAppleConfig.bundleId, appAppleId: 42, signedTransactionInfo: signedTx });
        const res = await post({ signedPayload: appleSignedJws(production) });
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('accepts Production notifications for the configured appAppleId', async () => {
        process.env.TWILIO_PEBLET_SECRET = JSON.stringify({ apple_iap_key: { ...testAppleConfig, appAppleId: 42 } });
        mockRenewedSubscription();
        const production = notification({ environment: 'Production', bundleId: testAppleConfig.bundleId, appAppleId: 42, signedTransactionInfo: signedTx });
        const res = await post({ signedPayload: appleSignedJws(production) });
        expect(res.status).toHaveBeenCalledWith(200);
    });
});

describe('webhook self-heal triggers (ensureWebhooksCurrent)', () => {
    it('twilioAccessToken re-points the tenant after minting', async () => {
        await functions.twilioRegister.run({ data: { accountSid: 'AC1', authToken: 'tok' } });
        await functions.twilioAccessToken.run({ auth: DEVICE, data: { accountSid: 'AC1', authToken: 'tok', callerId: 'x' } });
        expect(twilioMocks().ensureWebhooksCurrent).toHaveBeenCalledWith('AC1', 'tok');
    });

    it('twilioConfigureNumbers self-heals before configuring numbers', async () => {
        const order: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { of } = require('rxjs');
        twilioMocks().ensureWebhooksCurrent.mockImplementationOnce(() => { order.push('heal'); return of(undefined); });
        twilioMocks().configureSelectedNumbers.mockImplementationOnce(() => {
            order.push('configure'); return of({ configured: [], restored: [] });
        });
        await functions.twilioConfigureNumbers.run({ data: { accountSid: 'AC1', authToken: 'tok', selectedSids: [] } });
        expect(order).toEqual(['heal', 'configure']);
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
