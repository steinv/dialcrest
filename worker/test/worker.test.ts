import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { Env, resetAuthTokenCacheForTests } from '../src/index';
import { resetGoogleTokenCacheForTests } from '../src/google';
import { DATABASE_URL, SERVICE_ACCOUNT_JSON, installFakeGoogle } from './fakeGoogle';

const require = createRequire(import.meta.url);
const { getExpectedTwilioSignature } = require('../../functions/node_modules/twilio/lib/webhooks/webhooks.js') as {
    getExpectedTwilioSignature: (authToken: string, url: string, params: Record<string, string>) => string;
};

const BASE = 'https://dialcrest-hooks.peblet.be';
const SID = 'AC' + 'a1'.repeat(16);
const TOKEN = 'tenant-auth-token';

function env(overrides: Partial<Env> = {}): Env {
    return {
        PUBLIC_BASE_URL: BASE,
        FIREBASE_PROJECT_ID: 'twilio-phone-peblet',
        FIREBASE_DATABASE_URL: DATABASE_URL,
        TWILIO_SIGNATURE_FAIL_CLOSED: 'false',
        GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
        ...overrides,
    };
}

function post(path: string, params: Record<string, string>, opts: { token?: string | null; signedUrl?: string; method?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (opts.token !== null) {
        headers['X-Twilio-Signature'] = getExpectedTwilioSignature(opts.token ?? TOKEN, opts.signedUrl ?? `${BASE}/${path}`, params);
    }
    const method = opts.method ?? 'POST';
    return new Request(`${BASE}/${path}`, { method, headers, body: method === 'GET' ? undefined : new URLSearchParams(params).toString() });
}

let google: ReturnType<typeof installFakeGoogle>;

beforeEach(() => {
    google = installFakeGoogle();
    google.rtdb.set(`/twilio/${SID}/secret/authToken`, TOKEN);
    resetAuthTokenCacheForTests();
    resetGoogleTokenCacheForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('routing', () => {
    it('404s unknown paths', async () => {
        expect((await worker.fetch(post('admin', { AccountSid: SID }), env())).status).toBe(404);
    });

    it('405s non-POST', async () => {
        expect((await worker.fetch(post('twilioOutgoingCall', {}, { method: 'GET', token: null }), env())).status).toBe(405);
    });

    it('rejects a malformed AccountSid before touching RTDB', async () => {
        const res = await worker.fetch(post('twilioOutgoingCall', { AccountSid: '../secret', To: '+1' }), env());
        expect(res.status).toBe(403);
        expect(google.state.rtdbReads).toEqual([]);
    });
});

describe('authentication', () => {
    it('rejects a missing signature for a tenant with a stored token', async () => {
        expect((await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }, { token: null }), env())).status).toBe(403);
    });

    it('rejects a signature made with another token', async () => {
        expect((await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }, { token: 'forged' }), env())).status).toBe(403);
    });

    it('rejects a signature for the functions host (validates PUBLIC_BASE_URL, not the request)', async () => {
        const signedUrl = 'https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioOutgoingCall';
        expect((await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }, { signedUrl }), env())).status).toBe(403);
    });

    it('allows a tokenless tenant while fail-closed is off', async () => {
        google.rtdb.delete(`/twilio/${SID}/secret/authToken`);
        expect((await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }, { token: null }), env())).status).toBe(200);
        expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'twilio_webhook_tokenless', knownTenant: false, outcome: 'allowed' }));
    });

    it('rejects a tokenless tenant when TWILIO_SIGNATURE_FAIL_CLOSED is "true"', async () => {
        google.rtdb.delete(`/twilio/${SID}/secret/authToken`);
        google.rtdb.set(`/twilio/${SID}/createdAt`, 1);
        const res = await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }), env({ TWILIO_SIGNATURE_FAIL_CLOSED: 'true' }));
        expect(res.status).toBe(403);
        expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'twilio_webhook_tokenless', knownTenant: true, outcome: 'rejected' }));
    });

    it('fails open on an RTDB outage, like the functions', async () => {
        google.state.rtdbDown = true;
        expect((await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }, { token: null }), env())).status).toBe(200);
    });

    it('does NOT fail open when RTDB refuses the service account (misconfiguration → 500)', async () => {
        google.state.rtdbForbidden = true;
        expect((await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }, { token: null }), env())).status).toBe(500);
    });

    it('caches the Auth Token and the Google access token across requests', async () => {
        await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }), env());
        await worker.fetch(post('twilioCallStatusChanges', { AccountSid: SID, CallStatus: 'ringing' }), env());
        expect(google.state.rtdbReads.filter((p) => p.endsWith('/secret/authToken'))).toHaveLength(1);
        expect(google.state.tokenRequests).toBe(1);
    });
});

describe('twilioIncomingCall', () => {
    it('rings the tenant\'s client while the subscription is active', async () => {
        google.rtdb.set(`/twilio/${SID}/trial/expiresAt`, Date.now() + 60_000);
        const res = await worker.fetch(post('twilioIncomingCall', { AccountSid: SID, From: '+321', To: '+322' }), env());
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/xml');
        expect(await res.text()).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Client>${SID}</Client></Dial></Response>`);
    });

    it('announces unavailability once expired', async () => {
        google.rtdb.set(`/twilio/${SID}/trial/expiresAt`, Date.now() - 1);
        const res = await worker.fetch(post('twilioIncomingCall', { AccountSid: SID }), env());
        expect(await res.text()).toContain('<Say>This number is temporarily unavailable.</Say>');
    });

    it('does not leak the expiry read result when the signature is bad', async () => {
        const res = await worker.fetch(post('twilioIncomingCall', { AccountSid: SID }, { token: 'forged' }), env());
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('Invalid Twilio signature');
    });
});

describe('twilioOutgoingCall', () => {
    it('dials To with From as caller id', async () => {
        const res = await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, From: '+3210000000', To: '+3220000000' }), env());
        expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+3210000000">+3220000000</Dial></Response>');
    });
});

describe('twilioCallStatusChanges', () => {
    it('logs and answers 202', async () => {
        const res = await worker.fetch(post('twilioCallStatusChanges', { AccountSid: SID, CallSid: 'CA1', CallStatus: 'completed' }), env());
        expect(res.status).toBe(202);
        expect(console.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'twilio_call_status', CallSid: 'CA1' }));
    });
});

describe('twilioIncomingMessage', () => {
    const sms = { AccountSid: SID, From: '+321', To: '+322', Body: 'hi & bye', MessageSid: 'SM1' };

    it('pushes the shared data payload to every device and replies with an empty MessagingResponse', async () => {
        google.rtdb.set(`/twilio/${SID}/messaging-tokens`, { 'tok:A': true, 'tok:B': true });
        const res = await worker.fetch(post('twilioIncomingMessage', sms), env());
        expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
        expect(google.fcmSent.map((s) => s.token).sort()).toEqual(['tok:A', 'tok:B']);
        expect(google.fcmSent[0].data).toEqual({
            dialcrest_type: 'incoming_message', accountSid: SID, from: '+321', to: '+322', body: 'hi & bye', messageSid: 'SM1',
        });
        expect(google.fcmSent[0].message).toMatchObject({
            android: { priority: 'HIGH' },
            apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1 } } },
        });
    });

    it('drops tokens FCM reports as unregistered and keeps the rest', async () => {
        google.rtdb.set(`/twilio/${SID}/messaging-tokens`, { 'tok:A': true, 'tok:dead': true });
        google.rtdb.set(`/twilio/${SID}/messaging-tokens/tok:dead`, true);
        google.unregisteredTokens.add('tok:dead');
        await worker.fetch(post('twilioIncomingMessage', sms), env());
        expect(google.rtdb.get(`/twilio/${SID}/messaging-tokens`)).toEqual({ 'tok:A': true });
    });

    it('sends nothing for a forged message', async () => {
        google.rtdb.set(`/twilio/${SID}/messaging-tokens`, { 'tok:A': true });
        const res = await worker.fetch(post('twilioIncomingMessage', sms, { token: 'forged' }), env());
        expect(res.status).toBe(403);
        expect(google.fcmSent).toEqual([]);
    });
});

describe('errors', () => {
    it('answers 500 when the service account secret is missing', async () => {
        const res = await worker.fetch(post('twilioOutgoingCall', { AccountSid: SID, To: '+1' }), env({ GOOGLE_SERVICE_ACCOUNT_JSON: '' }));
        expect(res.status).toBe(500);
    });
});
