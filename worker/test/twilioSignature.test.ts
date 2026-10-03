import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { isValidTwilioSignature, signatureBase } from '../src/twilioSignature';

// The reference implementation: twilio-node, as used by the Cloud Functions.
const require = createRequire(import.meta.url);
const twilioWebhooks = require('../../functions/node_modules/twilio/lib/webhooks/webhooks.js') as {
    getExpectedTwilioSignature: (authToken: string, url: string, params: Record<string, string | string[]>) => string;
    validateRequest: (authToken: string, signature: string, url: string, params: Record<string, string | string[]>) => boolean;
};

const TOKEN = 'the-tenant-auth-token';
const URL_ = 'https://dialcrest-hooks.peblet.be/twilioIncomingCall';

/** URLSearchParams → the object shape express's urlencoded parser hands twilio-node (repeats become arrays). */
function asExpressBody(params: URLSearchParams): Record<string, string | string[]> {
    const body: Record<string, string | string[]> = {};
    for (const name of new Set(params.keys())) {
        const values = params.getAll(name);
        body[name] = values.length > 1 ? values : values[0];
    }
    return body;
}

const CASES: Array<[string, URLSearchParams]> = [
    ['typical call params', new URLSearchParams({ AccountSid: 'AC' + '0'.repeat(32), From: '+3210000000', To: '+3220000000', CallStatus: 'ringing' })],
    ['unicode and symbols', new URLSearchParams({ Body: 'héllo & <bye> 👋 = ?', From: '+32 1' })],
    ['empty values', new URLSearchParams({ A: '', B: 'x' })],
    ['repeated param', new URLSearchParams([['MediaUrl', 'b'], ['MediaUrl', 'a'], ['MediaUrl', 'b'], ['Z', '1']])],
    ['no params', new URLSearchParams()],
];

describe('signature matches twilio-node', () => {
    it.each(CASES)('%s', async (_name, params) => {
        const expected = twilioWebhooks.getExpectedTwilioSignature(TOKEN, URL_, asExpressBody(params));
        expect(await isValidTwilioSignature(TOKEN, expected, URL_, params)).toBe(true);
        expect(twilioWebhooks.validateRequest(TOKEN, expected, URL_, asExpressBody(params))).toBe(true);
    });

    it('signature base orders params by name', () => {
        expect(signatureBase('U', new URLSearchParams([['b', '2'], ['a', '1']]))).toBe('Ua1b2');
    });
});

describe('isValidTwilioSignature rejects', () => {
    const params = CASES[0][1];
    const good = twilioWebhooks.getExpectedTwilioSignature(TOKEN, URL_, asExpressBody(params));

    it('a different token', async () => {
        expect(await isValidTwilioSignature('other-token', good, URL_, params)).toBe(false);
    });

    it('a tampered param', async () => {
        const tampered = new URLSearchParams(params);
        tampered.set('To', '+3299999999');
        expect(await isValidTwilioSignature(TOKEN, good, URL_, tampered)).toBe(false);
    });

    it('a signature for another path (cross-endpoint replay)', async () => {
        expect(await isValidTwilioSignature(TOKEN, good, URL_.replace('Incoming', 'Outgoing'), params)).toBe(false);
    });

    it('a signature for the old functions host', async () => {
        const legacy = twilioWebhooks.getExpectedTwilioSignature(
            TOKEN, 'https://europe-west1-twilio-phone-peblet.cloudfunctions.net/twilioIncomingCall', asExpressBody(params));
        expect(await isValidTwilioSignature(TOKEN, legacy, URL_, params)).toBe(false);
    });

    it('garbage and wrong-length signatures', async () => {
        expect(await isValidTwilioSignature(TOKEN, 'not base64 !!', URL_, params)).toBe(false);
        expect(await isValidTwilioSignature(TOKEN, btoa('short'), URL_, params)).toBe(false);
        expect(await isValidTwilioSignature(TOKEN, '', URL_, params)).toBe(false);
    });
});

describe('port variants (as twilio-node accepts)', () => {
    it('accepts a signature computed over the URL with the explicit default port', async () => {
        const params = CASES[0][1];
        const withPort = twilioWebhooks.getExpectedTwilioSignature(TOKEN, 'https://dialcrest-hooks.peblet.be:443/twilioIncomingCall', asExpressBody(params));
        expect(await isValidTwilioSignature(TOKEN, withPort, URL_, params)).toBe(true);
    });
});
