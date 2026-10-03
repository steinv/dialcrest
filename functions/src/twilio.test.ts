import { createHmac } from 'crypto';
import { lastValueFrom } from 'rxjs';
import admin from 'firebase-admin';
import twilio from 'twilio';
import {
    InvalidTwilioCredentialsError,
    accessToken,
    callbackIncomingCall,
    callbackIncomingMessage,
    configureSelectedNumbers,
    ensureWebhooksCurrent,
    getIncomingAppSid,
    isValidTwilioSignature,
    rememberAuthToken,
    recordDeviceCheckIn,
    registerMessagingDevice,
    resetAuthTokenCacheForTests,
    verifyTwilioCredentials,
} from './twilio';

jest.mock('firebase-admin');
// Only the REST client factory (the default export) is faked; validateRequest,
// twiml, etc. stay real so signature validation is exercised for real.
jest.mock('twilio', () => {
    const actual = jest.requireActual('twilio');
    const factory = jest.fn();
    return Object.assign(factory, actual, { __esModule: true, default: factory });
});

/**
 * isValidTwilioSignature is the authentication for the four public, App-Check-
 * exempt Twilio webhooks (see index.ts / twilio.ts). The real twilio
 * validateRequest is exercised here — we sign with Twilio's documented algorithm
 * (HMAC-SHA1 over the URL followed by the alphabetically-sorted POST params,
 * base64-encoded) and assert validation accepts a genuine signature and rejects
 * every way a forgery differs.
 */

const LEGACY_BASE = 'https://europe-west1-twilio-phone-peblet.cloudfunctions.net';
const EDGE_BASE = 'https://dialcrest-hooks.peblet.be';
const WEBHOOK_PATH = 'twilioCallStatusChanges';
const WEBHOOK_URL = `${LEGACY_BASE}/${WEBHOOK_PATH}`;
const AUTH_TOKEN = 'the-tenant-auth-token';
const PARAMS = { AccountSid: 'AC1', From: '+3210000000', To: '+3220000000', CallStatus: 'completed' };

function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
    const signed = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
    return createHmac('sha1', authToken).update(Buffer.from(signed, 'utf-8')).digest('base64');
}

function seedAuthToken(accountSid: string, authToken: string): Promise<void> {
    return admin.database().ref(`/twilio/${accountSid}/secret/authToken`).set(authToken);
}

function dbTree(): any {
    return (admin as unknown as { __getDatabaseTree: () => any }).__getDatabaseTree();
}

function fakeRequest(opts: { signature?: string; body?: Record<string, string> }) {
    const headers: Record<string, string> = {};
    if (opts.signature !== undefined) headers['x-twilio-signature'] = opts.signature;
    return {
        body: opts.body ?? {},
        header: (name: string) => headers[name.toLowerCase()],
    } as unknown as Parameters<typeof isValidTwilioSignature>[0];
}

const WEBHOOK_ENV = ['WEBHOOK_PUBLIC_BASE_URL', 'TWILIO_SIGNATURE_FAIL_CLOSED'];

beforeEach(() => {
    (admin as unknown as { __resetDatabase: () => void }).__resetDatabase();
    resetAuthTokenCacheForTests();
    WEBHOOK_ENV.forEach((name) => delete process.env[name]);
    twilioFactory().mockReset();
});

function twilioFactory(): jest.Mock {
    return twilio as unknown as jest.Mock;
}

describe('isValidTwilioSignature', () => {
    it('accepts a request signed with the tenant\'s stored Auth Token', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(true);
    });

    it('rejects a signature made with a different token (spoofed caller)', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature('a-different-token', WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(false);
    });

    it('rejects a tampered body even with an otherwise valid signature', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        const tampered = { ...PARAMS, To: '+3299999999' };
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: tampered }), WEBHOOK_PATH)).toBe(false);
    });

    it('rejects a signature computed for a different URL', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL + 'X', PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(false);
    });

    it('rejects when the X-Twilio-Signature header is missing', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        expect(await isValidTwilioSignature(fakeRequest({ body: PARAMS }), WEBHOOK_PATH)).toBe(false);
    });

    it('fails open (skips the check) when no Auth Token is stored for the AccountSid', async () => {
        // No seedAuthToken: the tenant registered before validation shipped.
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(true);
    });

    it('fails open for an un-stored tenant even with no signature header at all', async () => {
        expect(await isValidTwilioSignature(fakeRequest({ body: PARAMS }), WEBHOOK_PATH)).toBe(true);
    });

    it('rejects when the request carries no AccountSid to look up', async () => {
        const bodyWithoutSid = { From: '+3210000000', To: '+3220000000', CallStatus: 'completed' };
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, bodyWithoutSid);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: bodyWithoutSid }), WEBHOOK_PATH)).toBe(false);
    });

    it('serves a token from the in-memory cache without re-reading RTDB on the next webhook', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        // First call reads RTDB and caches AUTH_TOKEN for AC1.
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(true);
        // Rotate the stored token: a cache hit must still validate the original signature,
        // proving the second call never consulted RTDB.
        await seedAuthToken('AC1', 'a-rotated-token');
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(true);
    });

    it('fails open (allows) when the Auth Token read throws, rather than 500-ing the call path', async () => {
        const spy = jest.spyOn(admin, 'database').mockReturnValue({
            ref: () => ({ once: () => Promise.reject(new Error('RTDB unavailable')) }),
        } as unknown as ReturnType<typeof admin.database>);
        try {
            const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
            expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('rememberAuthToken', () => {
    it('stores a new Auth Token only after Twilio accepts it for that account', async () => {
        const client = fakeTwilioClient();
        twilioFactory().mockReturnValue(client);
        await lastValueFrom(rememberAuthToken('AC1', 'the-token'));
        expect(twilioFactory()).toHaveBeenCalledWith('AC1', 'the-token');
        expect(client.accountFetch).toHaveBeenCalled();
        expect(dbTree().twilio.AC1.secret.authToken).toBe('the-token');
    });

    it('refuses a token Twilio rejects, so a caller cannot poison another tenant\'s stored token', async () => {
        await seedAuthToken('AC1', 'good-token');
        const client = fakeTwilioClient();
        client.accountFetch.mockRejectedValue(Object.assign(new Error('Authenticate'), { status: 401 }));
        twilioFactory().mockReturnValue(client);
        await expect(lastValueFrom(rememberAuthToken('AC1', 'attacker-token'))).resolves.toBeUndefined();
        expect(dbTree().twilio.AC1.secret.authToken).toBe('good-token');
    });

    it('refuses an empty token rather than overwriting a stored one (would silently disable enforcement)', async () => {
        await seedAuthToken('AC1', 'good-token');
        await lastValueFrom(rememberAuthToken('AC1', ''));
        expect(dbTree().twilio.AC1.secret.authToken).toBe('good-token');
    });

    it('resolves without throwing when the token is undefined (no set(undefined) crash)', async () => {
        await expect(lastValueFrom(rememberAuthToken('AC1', undefined as unknown as string))).resolves.toBeUndefined();
        expect(dbTree().twilio?.AC1?.secret).toBeUndefined();
    });

    it('leaves an unchanged token in place without a Twilio round-trip', async () => {
        await seedAuthToken('AC1', 'tok');
        await lastValueFrom(rememberAuthToken('AC1', 'tok'));
        expect(dbTree().twilio.AC1.secret.authToken).toBe('tok');
        expect(twilioFactory()).not.toHaveBeenCalled();
    });
});

describe('isValidTwilioSignature — host binding and fail-closed', () => {
    it('validates against the function\'s own URL even after tenants are pointed at the Worker', async () => {
        process.env.WEBHOOK_PUBLIC_BASE_URL = EDGE_BASE;
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(true);
    });

    it('rejects a signature computed for the Worker URL (those requests belong to the Worker)', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, `${EDGE_BASE}/${WEBHOOK_PATH}`, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(false);
    });

    it('rejects a signature replayed from a different webhook path', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, `${LEGACY_BASE}/twilioIncomingCall`, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(false);
    });

    it('with TWILIO_SIGNATURE_FAIL_CLOSED, rejects an AccountSid that has no stored token', async () => {
        process.env.TWILIO_SIGNATURE_FAIL_CLOSED = 'true';
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(false);
        expect(await isValidTwilioSignature(fakeRequest({ body: PARAMS }), WEBHOOK_PATH)).toBe(false);
    });

    it('with TWILIO_SIGNATURE_FAIL_CLOSED, still accepts a correctly signed request for a stored tenant', async () => {
        process.env.TWILIO_SIGNATURE_FAIL_CLOSED = 'true';
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_PATH)).toBe(true);
    });
});

interface FakeNumber { sid: string; voiceApplicationSid: string; smsUrl: string; statusCallback: string }

/** The slice of the Twilio REST client twilio.ts uses, recording every update. */
function fakeTwilioClient(opts: { apps?: Array<{ sid: string; friendlyName: string; voiceUrl: string }>; numbers?: FakeNumber[] } = {}) {
    const appUpdates: Array<{ sid: string; params: Record<string, unknown> }> = [];
    const numberUpdates: Array<{ sid: string; params: Record<string, unknown> }> = [];
    const accountFetch = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn(async (sid: string, params: Record<string, unknown>) => {
        appUpdates.push({ sid, params });
        return { sid, ...params };
    });
    const numbersList = jest.fn(async () => opts.numbers ?? []);
    const applications = Object.assign(
        (sid: string) => ({ update: (params: Record<string, unknown>) => appUpdate(sid, params) }),
        {
            list: jest.fn(async ({ friendlyName }: { friendlyName: string }) => (opts.apps ?? []).filter((a) => a.friendlyName === friendlyName)),
            create: jest.fn(async (params: Record<string, unknown>) => ({ sid: 'AP-new', ...params })),
        },
    );
    const incomingPhoneNumbers = Object.assign(
        (sid: string) => ({
            update: async (params: Record<string, unknown>) => {
                numberUpdates.push({ sid, params });
                return { sid, ...params };
            },
        }),
        { list: numbersList },
    );
    return {
        api: { v2010: { accounts: () => ({ fetch: accountFetch }) } },
        applications,
        incomingPhoneNumbers,
        accountFetch, appUpdate, numbersList, appUpdates, numberUpdates,
    };
}

function seedTwimlApps(accountSid: string, apps: { outgoing?: string; incoming?: string }) {
    return admin.database().ref(`/twilio/${accountSid}/twiml-app-sid`).set(apps);
}

describe('ensureWebhooksCurrent (self-heal onto the current webhook host)', () => {
    const legacyNumber: FakeNumber = {
        sid: 'PN1', voiceApplicationSid: 'AP-in',
        smsUrl: `${LEGACY_BASE}/twilioIncomingMessage`, statusCallback: `${LEGACY_BASE}/twilioCallStatusChanges`,
    };

    beforeEach(() => {
        process.env.WEBHOOK_PUBLIC_BASE_URL = EDGE_BASE;
    });

    it('is a single RTDB read (no Twilio client) when the tenant is already on the current host', async () => {
        await admin.database().ref('/twilio/AC1/webhook-base-url').set(EDGE_BASE);
        await lastValueFrom(ensureWebhooksCurrent('AC1', 'tok'));
        expect(twilioFactory()).not.toHaveBeenCalled();
    });

    it('re-points both TwiML Apps and our numbers\' webhooks, then records the host', async () => {
        await seedTwimlApps('AC1', { outgoing: 'AP-out', incoming: 'AP-in' });
        const client = fakeTwilioClient({ numbers: [legacyNumber] });
        twilioFactory().mockReturnValue(client);

        await lastValueFrom(ensureWebhooksCurrent('AC1', 'tok'));

        expect(client.appUpdates).toEqual(expect.arrayContaining([
            { sid: 'AP-out', params: { voiceUrl: `${EDGE_BASE}/twilioOutgoingCall`, voiceMethod: 'POST' } },
            { sid: 'AP-in', params: { voiceUrl: `${EDGE_BASE}/twilioIncomingCall`, voiceMethod: 'POST' } },
        ]));
        expect(client.numberUpdates).toEqual([{
            sid: 'PN1',
            params: {
                statusCallback: `${EDGE_BASE}/twilioCallStatusChanges`, statusCallbackMethod: 'POST',
                smsUrl: `${EDGE_BASE}/twilioIncomingMessage`, smsMethod: 'POST',
            },
        }]);
        expect(dbTree().twilio.AC1['webhook-base-url']).toBe(EDGE_BASE);
    });

    it('leaves numbers that are not ours, and webhooks the tenant pointed elsewhere, untouched', async () => {
        await seedTwimlApps('AC1', { incoming: 'AP-in' });
        const foreignApp: FakeNumber = { ...legacyNumber, sid: 'PN2', voiceApplicationSid: 'AP-someone-else' };
        const customSms: FakeNumber = { ...legacyNumber, sid: 'PN3', smsUrl: 'https://tenant.example/sms' };
        const client = fakeTwilioClient({ numbers: [foreignApp, customSms] });
        twilioFactory().mockReturnValue(client);

        await lastValueFrom(ensureWebhooksCurrent('AC1', 'tok'));

        expect(client.numberUpdates).toEqual([{
            sid: 'PN3',
            params: { statusCallback: `${EDGE_BASE}/twilioCallStatusChanges`, statusCallbackMethod: 'POST' },
        }]);
    });

    it('never touches the restore snapshot', async () => {
        await seedTwimlApps('AC1', { incoming: 'AP-in' });
        const original = { voiceUrl: 'https://tenant.example/voice', smsUrl: 'https://tenant.example/sms' };
        await admin.database().ref('/twilio/AC1/numbers/PN1/original').set(original);
        twilioFactory().mockReturnValue(fakeTwilioClient({ numbers: [legacyNumber] }));

        await lastValueFrom(ensureWebhooksCurrent('AC1', 'tok'));

        expect(dbTree().twilio.AC1.numbers.PN1.original).toEqual(original);
    });

    it('drops the cache of a TwiML App the tenant deleted (20404) instead of failing', async () => {
        await seedTwimlApps('AC1', { outgoing: 'AP-out' });
        const client = fakeTwilioClient();
        client.appUpdate.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 20404 }));
        twilioFactory().mockReturnValue(client);

        await lastValueFrom(ensureWebhooksCurrent('AC1', 'tok'));

        expect(dbTree().twilio.AC1['twiml-app-sid']?.outgoing).toBeUndefined();
        expect(dbTree().twilio.AC1['webhook-base-url']).toBe(EDGE_BASE);
    });

    it('swallows a Twilio failure and leaves the marker unset so the next call retries', async () => {
        await seedTwimlApps('AC1', { incoming: 'AP-in' });
        const client = fakeTwilioClient();
        client.numbersList.mockRejectedValue(new Error('Twilio down'));
        twilioFactory().mockReturnValue(client);

        await expect(lastValueFrom(ensureWebhooksCurrent('AC1', 'tok'))).resolves.toBeUndefined();
        expect(dbTree().twilio.AC1['webhook-base-url']).toBeUndefined();
    });

    it('re-points tenants back when the public host is rolled back', async () => {
        await seedTwimlApps('AC1', { outgoing: 'AP-out' });
        await admin.database().ref('/twilio/AC1/webhook-base-url').set(EDGE_BASE);
        process.env.WEBHOOK_PUBLIC_BASE_URL = LEGACY_BASE;
        const client = fakeTwilioClient();
        twilioFactory().mockReturnValue(client);

        await lastValueFrom(ensureWebhooksCurrent('AC1', 'tok'));

        expect(client.appUpdates).toEqual([{ sid: 'AP-out', params: { voiceUrl: `${LEGACY_BASE}/twilioOutgoingCall`, voiceMethod: 'POST' } }]);
        expect(dbTree().twilio.AC1['webhook-base-url']).toBe(LEGACY_BASE);
    });
});

describe('configureSelectedNumbers across a webhook host change', () => {
    beforeEach(() => {
        process.env.WEBHOOK_PUBLIC_BASE_URL = EDGE_BASE;
    });

    const onLegacyHost: FakeNumber = {
        sid: 'PN1', voiceApplicationSid: 'AP-in',
        smsUrl: `${LEGACY_BASE}/twilioIncomingMessage`, statusCallback: `${LEGACY_BASE}/twilioCallStatusChanges`,
    };

    it('still restores a deselected number that points at the previous host', async () => {
        await seedTwimlApps('AC1', { incoming: 'AP-in' });
        await admin.database().ref('/twilio/AC1/numbers/PN1/original').set({ voiceUrl: 'https://tenant.example/voice' });
        const client = fakeTwilioClient({ numbers: [onLegacyHost] });
        twilioFactory().mockReturnValue(client);

        const result = await lastValueFrom(configureSelectedNumbers('AC1', 'tok', []));

        expect(result.restored).toEqual(['PN1']);
        expect(client.numberUpdates[0].params).toEqual({ voiceUrl: 'https://tenant.example/voice' });
    });

    it('re-points a selected number on the previous host, keeping its original snapshot', async () => {
        await seedTwimlApps('AC1', { incoming: 'AP-in' });
        const original = { voiceUrl: 'https://tenant.example/voice' };
        await admin.database().ref('/twilio/AC1/numbers/PN1/original').set(original);
        const client = fakeTwilioClient({ numbers: [onLegacyHost] });
        twilioFactory().mockReturnValue(client);

        const result = await lastValueFrom(configureSelectedNumbers('AC1', 'tok', ['PN1']));

        expect(result.configured).toEqual(['PN1']);
        expect(client.numberUpdates[0].params).toMatchObject({
            smsUrl: `${EDGE_BASE}/twilioIncomingMessage`, statusCallback: `${EDGE_BASE}/twilioCallStatusChanges`,
        });
        expect(dbTree().twilio.AC1.numbers.PN1.original).toEqual(original);
    });
});

describe('getIncomingAppSid', () => {
    it('corrects the voiceUrl of an existing app found by name before caching it', async () => {
        process.env.WEBHOOK_PUBLIC_BASE_URL = EDGE_BASE;
        const client = fakeTwilioClient({
            apps: [{ sid: 'AP-in', friendlyName: 'Dialcrest Incoming', voiceUrl: `${LEGACY_BASE}/twilioIncomingCall` }],
        });
        twilioFactory().mockReturnValue(client);

        expect(await lastValueFrom(getIncomingAppSid('AC1', 'tok'))).toBe('AP-in');
        expect(client.appUpdates).toEqual([{ sid: 'AP-in', params: { voiceUrl: `${EDGE_BASE}/twilioIncomingCall`, voiceMethod: 'POST' } }]);
        expect(dbTree().twilio.AC1['twiml-app-sid'].incoming).toBe('AP-in');
    });
});

const DAY = 24 * 60 * 60 * 1000;

/** Seeds the per-device registry and (optionally) the line's trial and subscription records. */
async function seedLine(opts: {
    trialExpiresAt?: number;
    devices?: Record<string, { subscription?: string | null; fcmToken?: string; lastSeen?: number }>;
    subscriptions?: Record<string, number>; // record path → expiresAt
    legacyTokens?: string[];
}) {
    const db = admin.database();
    if (opts.trialExpiresAt !== undefined) await db.ref('/twilio/AC1/trial/expiresAt').set(opts.trialExpiresAt);
    for (const [uid, record] of Object.entries(opts.devices ?? {})) {
        await db.ref(`/twilio/AC1/devices/${uid}`).set({ lastSeen: Date.now(), ...record });
    }
    for (const [path, expiresAt] of Object.entries(opts.subscriptions ?? {})) {
        await db.ref(`/${path}`).set({ expiresAt });
    }
    for (const token of opts.legacyTokens ?? []) await db.ref(`/twilio/AC1/messaging-tokens/${token}`).set(true);
}

function fakeResponse() {
    const sent: { status: number; body: string } = { status: 0, body: '' };
    const response = {
        type: () => response,
        status: (code: number) => { sent.status = code; return response; },
        send: (value: string) => { sent.body = value ?? ''; return response; },
    };
    return { sent, response: response as unknown as Parameters<typeof callbackIncomingCall>[1] };
}

function signedWebhook(path: string, body: Record<string, string>) {
    return fakeRequest({ signature: twilioSignature(AUTH_TOKEN, `${LEGACY_BASE}/${path}`, body), body });
}

/**
 * Inbound calls ring only the devices whose OWN user is entitled — the line's
 * trial, or the device's subscription pointer — each under its own identity, so
 * an unsubscribed co-user isn't rung while subscribed users on the line are.
 */
describe('callbackIncomingCall rings entitled devices only', () => {
    async function incomingCall(): Promise<string> {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const { sent, response } = fakeResponse();
        await callbackIncomingCall(signedWebhook('twilioIncomingCall', { AccountSid: 'AC1', From: '+321', To: '+322' }), response);
        return sent.body;
    }

    it('during the trial rings every device, plus the legacy shared identity for not-yet-updated apps', async () => {
        await seedLine({ trialExpiresAt: Date.now() + DAY, devices: { devA: {}, devB: {} } });
        const twiml = await incomingCall();
        expect(twiml).toContain('<Client>AC1</Client>');
        expect(twiml).toContain('<Client>AC1_devA</Client>');
        expect(twiml).toContain('<Client>AC1_devB</Client>');
    });

    it('after the trial rings the subscribed user but not the unsubscribed co-user on the same line', async () => {
        await seedLine({
            trialExpiresAt: Date.now() - DAY,
            devices: { paying: { subscription: 'subscriptions/apple/orig1' }, freeloader: {} },
            subscriptions: { 'subscriptions/apple/orig1': Date.now() + DAY },
        });
        const twiml = await incomingCall();
        expect(twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Client>AC1_paying</Client></Dial></Response>');
    });

    it('stops ringing a device whose subscription record has expired (renewals/refunds apply without check-in)', async () => {
        await seedLine({
            trialExpiresAt: Date.now() - DAY,
            devices: { lapsed: { subscription: 'subscriptions/google/tokA' } },
            subscriptions: { 'subscriptions/google/tokA': Date.now() - 1 },
        });
        expect(await incomingCall()).toContain('This number is temporarily unavailable.');
    });

    it('never rings the legacy shared identity after the trial (it cannot be gated per person)', async () => {
        await seedLine({ trialExpiresAt: Date.now() - DAY });
        expect(await incomingCall()).toContain('This number is temporarily unavailable.');
    });

    it('ignores devices not seen for over a year', async () => {
        await seedLine({ trialExpiresAt: Date.now() + DAY, devices: { gone: { lastSeen: Date.now() - 400 * DAY } } });
        expect(await incomingCall()).not.toContain('AC1_gone');
    });

    it('rings at most 10 clients, most recently seen first', async () => {
        const devices: Record<string, { lastSeen: number }> = {};
        for (let i = 0; i < 12; i++) devices[`dev${i}`] = { lastSeen: Date.now() - i * 1000 };
        await seedLine({ trialExpiresAt: Date.now() + DAY, devices });
        const twiml = await incomingCall();
        expect((twiml.match(/<Client>/g) ?? []).length).toBe(10);
        expect(twiml).toContain('<Client>AC1_dev0</Client>');
        expect(twiml).not.toContain('AC1_dev9<');
    });

    it('still requires a valid Twilio signature', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const body = { AccountSid: 'AC1', From: '+321', To: '+322' };
        const { sent, response } = fakeResponse();
        await callbackIncomingCall(fakeRequest({ signature: twilioSignature('forged', `${LEGACY_BASE}/twilioIncomingCall`, body), body }), response);
        expect(sent.status).toBe(403);
    });
});

/** Same per-device rule for SMS pushes: subscribed users keep notifications, an unsubscribed co-user loses them. */
describe('callbackIncomingMessage notifies entitled devices only', () => {
    let sendMock: jest.Mock;

    beforeEach(() => {
        sendMock = jest.fn().mockResolvedValue('projects/x/messages/1');
        (admin as unknown as { messaging: () => unknown }).messaging = () => ({ send: sendMock });
    });

    async function incomingSms() {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const { sent, response } = fakeResponse();
        await callbackIncomingMessage(
            signedWebhook('twilioIncomingMessage', { AccountSid: 'AC1', From: '+321', To: '+322', Body: 'hi', MessageSid: 'SM1' }),
            response,
        );
        return { sent, tokens: sendMock.mock.calls.map(([message]) => message.token).sort() };
    }

    it('during the trial pushes to every device and to legacy registrations', async () => {
        await seedLine({ trialExpiresAt: Date.now() + DAY, devices: { devA: { fcmToken: 'fcmA' } }, legacyTokens: ['fcmOld'] });
        expect((await incomingSms()).tokens).toEqual(['fcmA', 'fcmOld']);
    });

    it('after the trial pushes to the subscribed user only — not the co-user, not legacy registrations', async () => {
        await seedLine({
            trialExpiresAt: Date.now() - DAY,
            devices: { paying: { subscription: 'subscriptions/apple/orig1', fcmToken: 'fcmPay' }, freeloader: { fcmToken: 'fcmFree' } },
            subscriptions: { 'subscriptions/apple/orig1': Date.now() + DAY },
            legacyTokens: ['fcmOld'],
        });
        const { sent, tokens } = await incomingSms();
        expect(tokens).toEqual(['fcmPay']);
        expect(sent.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    });

    it('pushes a token registered under two device records only once', async () => {
        await seedLine({ trialExpiresAt: Date.now() + DAY, devices: { oldUid: { fcmToken: 'same' }, newUid: { fcmToken: 'same' } } });
        expect((await incomingSms()).tokens).toEqual(['same']);
    });

    it('clears a device\'s token that FCM reports as unregistered', async () => {
        await seedLine({ trialExpiresAt: Date.now() + DAY, devices: { devA: { fcmToken: 'dead' } } });
        sendMock.mockRejectedValue({ code: 'messaging/registration-token-not-registered' });
        await incomingSms();
        expect(dbTree().twilio.AC1.devices.devA.fcmToken).toBeUndefined();
        expect(dbTree().twilio.AC1.devices.devA.lastSeen).toEqual(expect.any(Number));
    });
});

describe('device registry writes', () => {
    it('recordDeviceCheckIn stores the pointer and lastSeen without touching the FCM token', async () => {
        await admin.database().ref('/twilio/AC1/devices/devA').set({ fcmToken: 'fcmA', lastSeen: 1 });
        await lastValueFrom(recordDeviceCheckIn('AC1', 'devA', 'subscriptions/apple/orig1'));
        expect(dbTree().twilio.AC1.devices.devA).toEqual({
            fcmToken: 'fcmA', subscription: 'subscriptions/apple/orig1', lastSeen: expect.any(Number),
        });
    });

    it('registerMessagingDevice stores the token on the device and migrates it off the legacy registry', async () => {
        await admin.database().ref('/twilio/AC1/messaging-tokens/fcmA').set(true);
        await admin.database().ref('/twilio/AC1/devices/devA').set({ subscription: 'subscriptions/apple/orig1', lastSeen: 1 });
        await lastValueFrom(registerMessagingDevice('AC1', 'devA', 'fcmA'));
        expect(dbTree().twilio.AC1.devices.devA).toEqual({
            subscription: 'subscriptions/apple/orig1', fcmToken: 'fcmA', lastSeen: expect.any(Number),
        });
        expect(dbTree().twilio.AC1['messaging-tokens']?.fcmA).toBeUndefined();
    });
});

describe('verifyTwilioCredentials', () => {
    function rejectingClient() {
        const client = fakeTwilioClient();
        client.accountFetch.mockRejectedValue(Object.assign(new Error('Authenticate'), { status: 401 }));
        return client;
    }

    it('accepts the stored token without a Twilio round-trip', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        await expect(verifyTwilioCredentials('AC1', AUTH_TOKEN)).resolves.toBeUndefined();
        expect(twilioFactory()).not.toHaveBeenCalled();
    });

    it('rejects a token Twilio refuses — e.g. another tenant\'s AccountSid with a guessed token', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        twilioFactory().mockReturnValue(rejectingClient());
        await expect(verifyTwilioCredentials('AC1', 'guessed')).rejects.toBeInstanceOf(InvalidTwilioCredentialsError);
        expect(dbTree().twilio.AC1.secret.authToken).toBe(AUTH_TOKEN);
    });

    it('accepts and stores a rotated token once Twilio confirms it', async () => {
        await seedAuthToken('AC1', 'old-token');
        twilioFactory().mockReturnValue(fakeTwilioClient());
        await verifyTwilioCredentials('AC1', 'new-token');
        expect(twilioFactory()).toHaveBeenCalledWith('AC1', 'new-token');
        expect(dbTree().twilio.AC1.secret.authToken).toBe('new-token');
    });

    it('verifies with Twilio when nothing is stored yet', async () => {
        const client = fakeTwilioClient();
        twilioFactory().mockReturnValue(client);
        await verifyTwilioCredentials('AC1', AUTH_TOKEN);
        expect(client.accountFetch).toHaveBeenCalled();
        expect(dbTree().twilio.AC1.secret.authToken).toBe(AUTH_TOKEN);
    });

    it('rejects missing credentials outright', async () => {
        await expect(verifyTwilioCredentials('AC1', '')).rejects.toBeInstanceOf(InvalidTwilioCredentialsError);
        expect(twilioFactory()).not.toHaveBeenCalled();
    });

    it('propagates non-auth Twilio errors instead of calling them invalid credentials', async () => {
        const client = fakeTwilioClient();
        client.accountFetch.mockRejectedValue(Object.assign(new Error('Service unavailable'), { status: 503 }));
        twilioFactory().mockReturnValue(client);
        await expect(verifyTwilioCredentials('AC1', AUTH_TOKEN)).rejects.toThrow('Service unavailable');
    });
});

describe('Voice tokens', () => {
    function decodeVoiceToken(jwt: string) {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
        return { payload, voice: payload.grants.voice, ttl: payload.exp - payload.iat };
    }

    beforeEach(async () => {
        // Warm caches: a verified API key, the push credential and the outgoing TwiML App.
        await admin.database().ref('/twilio/AC1/api-key').set({ sid: 'SK1', secret: 'api-secret' });
        await admin.database().ref('/twilio/AC1/push-credential/android').set('CR1');
        await seedTwimlApps('AC1', { outgoing: 'AP-out' });
        twilioFactory().mockReturnValue(fakeTwilioClient());
    });

    it('carries this device\'s own identity, so inbound calls can ring entitled devices only', async () => {
        const { payload, voice, ttl } = decodeVoiceToken(await lastValueFrom(accessToken('AC1', AUTH_TOKEN, '+321', 'devA')));
        expect(payload.grants.identity).toBe('AC1_devA');
        expect(voice.outgoing).toMatchObject({ application_sid: 'AP-out' });
        expect(voice.incoming).toEqual({ allow: true });
        expect(voice.push_credential_sid).toBe('CR1');
        expect(ttl).toBe(600);
    });
});
