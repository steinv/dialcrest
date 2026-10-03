import admin from 'firebase-admin';
import twilio from 'twilio';
import { backfillTenant } from './backfillWebhooks';

jest.mock('firebase-admin');
jest.mock('twilio', () => {
    const actual = jest.requireActual('twilio');
    const factory = jest.fn();
    return Object.assign(factory, actual, { __esModule: true, default: factory });
});

const LEGACY_BASE = 'https://europe-west1-twilio-phone-peblet.cloudfunctions.net';
const EDGE_BASE = 'https://dialcrest-hooks.peblet.be';
const SID = 'AC' + '0'.repeat(31) + '1';

interface FakeNumber { sid: string; voiceApplicationSid: string; smsUrl: string; statusCallback: string }

/** The slice of the Twilio REST client the backfill uses, recording every update. */
function fakeTwilioClient(opts: { apps?: Record<string, string>; numbers?: FakeNumber[] } = {}) {
    const appUpdates: Array<{ sid: string; params: Record<string, unknown> }> = [];
    const numberUpdates: Array<{ sid: string; params: Record<string, unknown> }> = [];
    const appFetch = jest.fn(async (sid: string) => {
        const voiceUrl = opts.apps?.[sid];
        if (voiceUrl === undefined) throw Object.assign(new Error('not found'), { code: 20404 });
        return { sid, voiceUrl };
    });
    const numbersList = jest.fn(async () => opts.numbers ?? []);
    const client = {
        applications: (sid: string) => ({
            fetch: () => appFetch(sid),
            update: async (params: Record<string, unknown>) => appUpdates.push({ sid, params }),
        }),
        incomingPhoneNumbers: Object.assign(
            (sid: string) => ({ update: async (params: Record<string, unknown>) => numberUpdates.push({ sid, params }) }),
            { list: numbersList },
        ),
    };
    (twilio as unknown as jest.Mock).mockReturnValue(client);
    return { appUpdates, numberUpdates, appFetch, numbersList };
}

function dbTree(): any {
    return (admin as unknown as { __getDatabaseTree: () => any }).__getDatabaseTree();
}

function seedTenant(apps: { outgoing?: string; incoming?: string }) {
    return admin.database().ref(`/twilio/${SID}`).update({ 'secret': { authToken: 'tok' }, 'twiml-app-sid': apps });
}

const legacyNumber: FakeNumber = {
    sid: 'PN1', voiceApplicationSid: 'AP-in',
    smsUrl: `${LEGACY_BASE}/twilioIncomingMessage`, statusCallback: `${LEGACY_BASE}/twilioCallStatusChanges`,
};

beforeEach(() => {
    (admin as unknown as { __resetDatabase: () => void }).__resetDatabase();
    (twilio as unknown as jest.Mock).mockReset();
});

describe('backfillTenant', () => {
    it('re-points both TwiML Apps and our numbers\' webhooks', async () => {
        await seedTenant({ outgoing: 'AP-out', incoming: 'AP-in' });
        const client = fakeTwilioClient({
            apps: { 'AP-out': `${LEGACY_BASE}/twilioOutgoingCall`, 'AP-in': `${LEGACY_BASE}/twilioIncomingCall` },
            numbers: [legacyNumber],
        });

        const result = await backfillTenant(SID, EDGE_BASE, true);

        expect(result.status).toBe('updated');
        expect(twilio).toHaveBeenCalledWith(SID, 'tok');
        expect(client.appUpdates).toEqual([
            { sid: 'AP-out', params: { voiceUrl: `${EDGE_BASE}/twilioOutgoingCall`, voiceMethod: 'POST' } },
            { sid: 'AP-in', params: { voiceUrl: `${EDGE_BASE}/twilioIncomingCall`, voiceMethod: 'POST' } },
        ]);
        expect(client.numberUpdates).toEqual([{
            sid: 'PN1',
            params: {
                statusCallback: `${EDGE_BASE}/twilioCallStatusChanges`, statusCallbackMethod: 'POST',
                smsUrl: `${EDGE_BASE}/twilioIncomingMessage`, smsMethod: 'POST',
            },
        }]);
    });

    it('writes nothing in a dry run but reports what it would change', async () => {
        await seedTenant({ incoming: 'AP-in' });
        await admin.database().ref(`/twilio/${SID}/webhook-base-url`).set(LEGACY_BASE);
        const client = fakeTwilioClient({ apps: { 'AP-in': `${LEGACY_BASE}/twilioIncomingCall` }, numbers: [legacyNumber] });

        const result = await backfillTenant(SID, EDGE_BASE, false);

        expect(result).toEqual({
            accountSid: SID, status: 'updated',
            changes: ['incoming TwiML App AP-in: voiceUrl', 'number PN1: statusCallback, smsUrl'],
        });
        expect(client.appUpdates).toEqual([]);
        expect(client.numberUpdates).toEqual([]);
        expect(dbTree().twilio[SID]['webhook-base-url']).toBe(LEGACY_BASE);
    });

    it('reports a tenant already on the target host as current, without updating', async () => {
        await seedTenant({ incoming: 'AP-in' });
        const onEdge = { ...legacyNumber, smsUrl: `${EDGE_BASE}/twilioIncomingMessage`, statusCallback: `${EDGE_BASE}/twilioCallStatusChanges` };
        const client = fakeTwilioClient({ apps: { 'AP-in': `${EDGE_BASE}/twilioIncomingCall` }, numbers: [onEdge] });

        expect((await backfillTenant(SID, EDGE_BASE, true)).status).toBe('current');
        expect(client.appUpdates).toEqual([]);
        expect(client.numberUpdates).toEqual([]);
    });

    it('leaves numbers that are not ours, and webhooks the tenant pointed elsewhere, untouched', async () => {
        await seedTenant({ incoming: 'AP-in' });
        const foreignApp: FakeNumber = { ...legacyNumber, sid: 'PN2', voiceApplicationSid: 'AP-someone-else' };
        const customSms: FakeNumber = { ...legacyNumber, sid: 'PN3', smsUrl: 'https://tenant.example/sms' };
        const client = fakeTwilioClient({ apps: { 'AP-in': `${EDGE_BASE}/twilioIncomingCall` }, numbers: [foreignApp, customSms] });

        await backfillTenant(SID, EDGE_BASE, true);

        expect(client.numberUpdates).toEqual([{
            sid: 'PN3',
            params: { statusCallback: `${EDGE_BASE}/twilioCallStatusChanges`, statusCallbackMethod: 'POST' },
        }]);
    });

    it('never touches the restore snapshot, and removes the old self-heal marker', async () => {
        await seedTenant({ incoming: 'AP-in' });
        const original = { voiceUrl: 'https://tenant.example/voice', smsUrl: 'https://tenant.example/sms' };
        await admin.database().ref(`/twilio/${SID}/numbers/PN1/original`).set(original);
        await admin.database().ref(`/twilio/${SID}/webhook-base-url`).set(LEGACY_BASE);
        fakeTwilioClient({ apps: { 'AP-in': `${LEGACY_BASE}/twilioIncomingCall` }, numbers: [legacyNumber] });

        await backfillTenant(SID, EDGE_BASE, true);

        expect(dbTree().twilio[SID].numbers.PN1.original).toEqual(original);
        expect(dbTree().twilio[SID]['webhook-base-url']).toBeUndefined();
    });

    it('drops the cache of a TwiML App the tenant deleted (20404)', async () => {
        await seedTenant({ outgoing: 'AP-out' });
        fakeTwilioClient();

        expect((await backfillTenant(SID, EDGE_BASE, true)).status).toBe('updated');
        expect(dbTree().twilio[SID]['twiml-app-sid']?.outgoing).toBeUndefined();
    });

    it('moves tenants back to the functions host (rollback)', async () => {
        await seedTenant({ outgoing: 'AP-out' });
        const client = fakeTwilioClient({ apps: { 'AP-out': `${EDGE_BASE}/twilioOutgoingCall` } });

        await backfillTenant(SID, LEGACY_BASE, true);

        expect(client.appUpdates).toEqual([{ sid: 'AP-out', params: { voiceUrl: `${LEGACY_BASE}/twilioOutgoingCall`, voiceMethod: 'POST' } }]);
    });

    it('skips a tenant with no stored Auth Token without calling Twilio', async () => {
        await admin.database().ref(`/twilio/${SID}/twiml-app-sid`).set({ outgoing: 'AP-out' });

        expect(await backfillTenant(SID, EDGE_BASE, true)).toEqual({ accountSid: SID, status: 'skipped', reason: 'no stored Auth Token' });
        expect(twilio).not.toHaveBeenCalled();
    });

    it('skips a tenant whose stored Auth Token Twilio rejects', async () => {
        await seedTenant({ outgoing: 'AP-out' });
        const client = fakeTwilioClient();
        client.appFetch.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }));

        expect((await backfillTenant(SID, EDGE_BASE, true)).status).toBe('skipped');
    });

    it('reports a Twilio failure as failed, without applying any change', async () => {
        await seedTenant({ outgoing: 'AP-out', incoming: 'AP-in' });
        const client = fakeTwilioClient({ apps: { 'AP-out': `${LEGACY_BASE}/twilioOutgoingCall`, 'AP-in': `${LEGACY_BASE}/twilioIncomingCall` } });
        client.numbersList.mockRejectedValue(new Error('Twilio down'));

        expect((await backfillTenant(SID, EDGE_BASE, true)).status).toBe('failed');
        expect(client.appUpdates).toEqual([]);
    });
});
