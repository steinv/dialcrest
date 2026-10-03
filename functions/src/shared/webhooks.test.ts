import { twiml } from 'twilio';
import { emptyMessagingTwiml, incomingCallTwiml, outgoingCallTwiml } from './webhooks';

/**
 * The shared TwiML builders replace the twilio package's VoiceResponse /
 * MessagingResponse in both the functions and the Worker (which can't bundle the
 * twilio package). They must emit exactly what the package emits.
 */
const NASTY = 'a&b<c>d"e\'f\tg\nh';

describe('shared TwiML builders match the twilio package byte-for-byte', () => {
    it('incoming call', () => {
        const expected = new twiml.VoiceResponse();
        expected.dial().client('AC1');
        expect(incomingCallTwiml('AC1')).toBe(expected.toString());
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

