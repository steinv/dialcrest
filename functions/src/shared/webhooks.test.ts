import { twiml } from 'twilio';
import { accountExpiresAt, emptyMessagingTwiml, incomingCallTwiml, outgoingCallTwiml } from './webhooks';

/**
 * The shared TwiML builders replace the twilio package's VoiceResponse /
 * MessagingResponse in both the functions and the Worker (which can't bundle the
 * twilio package). They must emit exactly what the package emits.
 */
const NASTY = 'a&b<c>d"e\'f\tg\nh';

describe('shared TwiML builders match the twilio package byte-for-byte', () => {
    it('incoming call, subscription active', () => {
        const expected = new twiml.VoiceResponse();
        expected.dial().client('AC1');
        expect(incomingCallTwiml('AC1', 2000, 1000)).toBe(expected.toString());
    });

    it('incoming call, expired or no expiry', () => {
        const expected = new twiml.VoiceResponse();
        expected.say('This number is temporarily unavailable.');
        expect(incomingCallTwiml('AC1', 1000, 1000)).toBe(expected.toString());
        expect(incomingCallTwiml('AC1', null, 1000)).toBe(expected.toString());
    });

    it('outgoing call with caller id', () => {
        const expected = new twiml.VoiceResponse();
        expected.dial({ callerId: '+3210000000' }, '+3220000000');
        expect(outgoingCallTwiml('+3220000000', '+3210000000')).toBe(expected.toString());
    });

    it('outgoing call without caller id', () => {
        const expected = new twiml.VoiceResponse();
        expected.dial({ callerId: undefined }, '+3220000000');
        expect(outgoingCallTwiml('+3220000000', undefined)).toBe(expected.toString());
    });

    it('outgoing call escapes text and attributes like the package', () => {
        const expected = new twiml.VoiceResponse();
        expected.dial({ callerId: NASTY }, NASTY);
        expect(outgoingCallTwiml(NASTY, NASTY)).toBe(expected.toString());
    });

    it('outgoing call with no destination', () => {
        const expected = new twiml.VoiceResponse();
        expected.say('No destination number was provided.');
        expect(outgoingCallTwiml(undefined, '+321')).toBe(expected.toString());
        expect(outgoingCallTwiml('', '+321')).toBe(expected.toString());
    });

    it('empty messaging response', () => {
        expect(emptyMessagingTwiml()).toBe(new twiml.MessagingResponse().toString());
    });
});

describe('accountExpiresAt (trial OR paid)', () => {
    it('takes the later of the two expiries', () => {
        expect(accountExpiresAt(100, 500)).toBe(500);
        expect(accountExpiresAt(500, 100)).toBe(500);
    });

    it('uses whichever one exists', () => {
        expect(accountExpiresAt(null, 500)).toBe(500);
        expect(accountExpiresAt(100, null)).toBe(100);
    });

    it('is null when neither exists', () => {
        expect(accountExpiresAt(null, null)).toBeNull();
    });
});
