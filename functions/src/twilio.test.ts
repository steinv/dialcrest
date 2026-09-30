import { createHmac } from 'crypto';
import { lastValueFrom } from 'rxjs';
import admin from 'firebase-admin';
import { isValidTwilioSignature, rememberAuthToken } from './twilio';

jest.mock('firebase-admin');

/**
 * isValidTwilioSignature is the authentication for the four public, App-Check-
 * exempt Twilio webhooks (see index.ts / twilio.ts). The real twilio
 * validateRequest is exercised here — we sign with Twilio's documented algorithm
 * (HMAC-SHA1 over the URL followed by the alphabetically-sorted POST params,
 * base64-encoded) and assert validation accepts a genuine signature and rejects
 * every way a forgery differs.
 */

const WEBHOOK_URL = 'https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioCallStatusChanges';
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

beforeEach(() => {
    (admin as unknown as { __resetDatabase: () => void }).__resetDatabase();
});

describe('isValidTwilioSignature', () => {
    it('accepts a request signed with the tenant\'s stored Auth Token', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_URL)).toBe(true);
    });

    it('rejects a signature made with a different token (spoofed caller)', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature('a-different-token', WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_URL)).toBe(false);
    });

    it('rejects a tampered body even with an otherwise valid signature', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        const tampered = { ...PARAMS, To: '+3299999999' };
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: tampered }), WEBHOOK_URL)).toBe(false);
    });

    it('rejects a signature computed for a different URL', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL + 'X', PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_URL)).toBe(false);
    });

    it('rejects when the X-Twilio-Signature header is missing', async () => {
        await seedAuthToken('AC1', AUTH_TOKEN);
        expect(await isValidTwilioSignature(fakeRequest({ body: PARAMS }), WEBHOOK_URL)).toBe(false);
    });

    it('fails open (skips the check) when no Auth Token is stored for the AccountSid', async () => {
        // No seedAuthToken: the tenant registered before validation shipped.
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, PARAMS);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: PARAMS }), WEBHOOK_URL)).toBe(true);
    });

    it('fails open for an un-stored tenant even with no signature header at all', async () => {
        expect(await isValidTwilioSignature(fakeRequest({ body: PARAMS }), WEBHOOK_URL)).toBe(true);
    });

    it('rejects when the request carries no AccountSid to look up', async () => {
        const bodyWithoutSid = { From: '+3210000000', To: '+3220000000', CallStatus: 'completed' };
        const signature = twilioSignature(AUTH_TOKEN, WEBHOOK_URL, bodyWithoutSid);
        expect(await isValidTwilioSignature(fakeRequest({ signature, body: bodyWithoutSid }), WEBHOOK_URL)).toBe(false);
    });
});

describe('rememberAuthToken', () => {
    it('stores a valid Auth Token under the tenant\'s secret node', async () => {
        await lastValueFrom(rememberAuthToken('AC1', 'the-token'));
        expect(dbTree().twilio.AC1.secret.authToken).toBe('the-token');
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

    it('leaves an unchanged token in place', async () => {
        await seedAuthToken('AC1', 'tok');
        await lastValueFrom(rememberAuthToken('AC1', 'tok'));
        expect(dbTree().twilio.AC1.secret.authToken).toBe('tok');
    });
});
