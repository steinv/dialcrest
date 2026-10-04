import { twiml } from 'twilio';
import {
    DEVICE_STALE_MS,
    emptyMessagingTwiml,
    entitledDevices,
    incomingCallIdentities,
    incomingCallTwiml,
    incomingMessageTargets,
    outgoingCallTwiml,
    subscriptionsToCheck,
} from './webhooks';

/**
 * The shared TwiML builders replace the twilio package's VoiceResponse /
 * MessagingResponse in both the functions and the Worker (which can't bundle the
 * twilio package). They must emit exactly what the package emits.
 */
const NASTY = 'a&b<c>d"e\'f\tg\nh';

describe('shared TwiML builders match the twilio package byte-for-byte', () => {
    it('incoming call ringing several clients', () => {
        const expected = new twiml.VoiceResponse();
        const dial = expected.dial();
        dial.client('AC1_devA');
        dial.client('AC1_devB');
        expect(incomingCallTwiml(['AC1_devA', 'AC1_devB'])).toBe(expected.toString());
    });

    it('incoming call with nobody to ring', () => {
        const expected = new twiml.VoiceResponse();
        expected.say('This number is temporarily unavailable.');
        expect(incomingCallTwiml([])).toBe(expected.toString());
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


describe('per-device entitlement rules', () => {
    const NOW = 1_000_000_000_000;
    const PAID = 'subscriptions/apple/orig1';
    const devices = {
        paying: { subscription: PAID, fcmToken: 'fcmPay', lastSeen: NOW - 10 },
        free: { subscription: null, fcmToken: 'fcmFree', lastSeen: NOW - 5 },
        stale: { subscription: PAID, fcmToken: 'fcmStale', lastSeen: NOW - DEVICE_STALE_MS - 1 },
    };

    it('needs no subscription reads while the license override is live', () => {
        expect(subscriptionsToCheck(devices, NOW + 1, NOW)).toEqual([]);
    });

    it('reads each distinct subscription of fresh devices once the override is over', () => {
        expect(subscriptionsToCheck(devices, NOW - 1, NOW)).toEqual([PAID]);
    });

    it('entitles every fresh device while the override is live, most recent first', () => {
        expect(entitledDevices(devices, NOW + 1, {}, NOW).map((d) => d.uid)).toEqual(['free', 'paying']);
    });

    it('entitles only devices with a live subscription without an override', () => {
        expect(entitledDevices(devices, NOW - 1, { [PAID]: NOW + 1 }, NOW).map((d) => d.uid)).toEqual(['paying']);
        expect(entitledDevices(devices, NOW - 1, { [PAID]: NOW - 1 }, NOW)).toEqual([]);
        expect(entitledDevices(devices, null, { [PAID]: NOW + 1 }, NOW).map((d) => d.uid)).toEqual(['paying']);
    });

    it('treats a non-number override as none (it is hand-edited in the console)', () => {
        expect(subscriptionsToCheck(devices, true as unknown as number, NOW)).toEqual([PAID]);
        expect(entitledDevices(devices, String(NOW + 1) as unknown as number, {}, NOW)).toEqual([]);
    });

    it('rings the legacy identity only while the override is live', () => {
        const entitled = [{ uid: 'paying' }];
        expect(incomingCallIdentities('AC1', entitled, NOW + 1, NOW)).toEqual(['AC1', 'AC1_paying']);
        expect(incomingCallIdentities('AC1', entitled, NOW - 1, NOW)).toEqual(['AC1_paying']);
    });

    it('pushes SMS to entitled devices, and to legacy tokens only while the override is live', () => {
        const entitled = entitledDevices(devices, NOW - 1, { [PAID]: NOW + 1 }, NOW);
        expect(incomingMessageTargets('AC1', entitled, { fcmOld: true }, NOW - 1, NOW).map((t) => t.fcmToken)).toEqual(['fcmPay']);
        expect(incomingMessageTargets('AC1', entitled, { fcmOld: true }, NOW + 1, NOW).map((t) => t.fcmToken)).toEqual(['fcmPay', 'fcmOld']);
    });
});
