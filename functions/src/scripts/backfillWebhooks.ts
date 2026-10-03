/**
 * Admin backfill: point every tenant's Twilio webhooks at one webhook host
 * (docs/edge-hardening-plan.md §7). Changing WEBHOOK_PUBLIC_BASE_URL only affects
 * TwiML Apps and numbers configured AFTER the change; this moves existing ones.
 *
 *   npm run build
 *   node lib/scripts/backfillWebhooks.js --to <base-url> [--account <AccountSid>] [--apply]
 *
 * Dry run unless --apply (it still reads from Twilio, to report what would
 * change). --to must be one of our hosts (edge.ts). --account limits it to one
 * tenant, e.g. a test tenant first. Uses Application Default Credentials
 * (`gcloud auth application-default login`) for the Realtime Database, and each
 * tenant's stored Auth Token for Twilio.
 *
 * Only touches what is ours: the cached outgoing/incoming TwiML Apps, and on
 * numbers routed to our incoming app only the statusCallback/smsUrl fields that
 * still point at one of our known hosts (a webhook the tenant pointed elsewhere
 * by hand is left alone). The numbers/<sid>/original restore snapshot is never
 * touched. Safe to re-run: anything already on --to is skipped.
 */

// Must be first, like index.ts: twilio/firebase-admin read buffer.SlowBuffer at load time.
import '../slowBufferShim';
import admin from 'firebase-admin';
import twilio, { Twilio } from 'twilio';
import { EDGE_BASE_URL, FUNCTIONS_BASE_URL, isKnownWebhookUrl } from '../edge';
import { ACCOUNT_SID, WEBHOOK_PATHS, dbPaths } from '../shared/webhooks';

const DATABASE_URL = 'https://twilio-phone-peblet-default-rtdb.europe-west1.firebasedatabase.app';
const KNOWN_BASES = [FUNCTIONS_BASE_URL, EDGE_BASE_URL];

export type TenantResult =
    | { accountSid: string; status: 'current' | 'updated'; changes: string[] }
    | { accountSid: string; status: 'skipped'; reason: string }
    | { accountSid: string; status: 'failed'; error: unknown };

interface Change { description: string; apply: () => Promise<unknown> }

function twimlAppSidRef(accountSid: string, direction: 'outgoing' | 'incoming') {
    return admin.database().ref(`/twilio/${accountSid}/twiml-app-sid/${direction}`);
}

/** Point one tenant's webhooks at `base`; with `apply` false only reports what it would change. */
export async function backfillTenant(accountSid: string, base: string, apply: boolean): Promise<TenantResult> {
    try {
        const authToken = (await admin.database().ref(dbPaths.authToken(accountSid)).once('value')).val();
        if (typeof authToken !== 'string' || authToken === '') {
            return { accountSid, status: 'skipped', reason: 'no stored Auth Token' };
        }
        const client = twilio(accountSid, authToken);
        const changes = await planChanges(client, accountSid, base);
        if (apply) {
            for (const change of changes) await change.apply();
            // Marker of the removed self-heal (ensureWebhooksCurrent); nothing reads it anymore.
            await admin.database().ref(`/twilio/${accountSid}/webhook-base-url`).remove();
        }
        const descriptions = changes.map((c) => c.description);
        return { accountSid, status: descriptions.length === 0 ? 'current' : 'updated', changes: descriptions };
    } catch (error) {
        if ((error as { status?: number })?.status === 401) {
            return { accountSid, status: 'skipped', reason: 'Twilio rejected the stored Auth Token' };
        }
        return { accountSid, status: 'failed', error };
    }
}

async function planChanges(client: Twilio, accountSid: string, base: string): Promise<Change[]> {
    const url = (path: string) => `${base}/${path}`;
    const [outgoingAppSid, incomingAppSid] = await Promise.all([
        twimlAppSidRef(accountSid, 'outgoing').once('value').then((s) => s.val() as string | null),
        twimlAppSidRef(accountSid, 'incoming').once('value').then((s) => s.val() as string | null),
    ]);
    const changes: Change[] = [];

    for (const [direction, appSid, path] of [
        ['outgoing', outgoingAppSid, WEBHOOK_PATHS.outgoingCall],
        ['incoming', incomingAppSid, WEBHOOK_PATHS.incomingCall],
    ] as const) {
        if (!appSid) continue;
        const change = await planTwimlAppChange(client, accountSid, direction, appSid, url(path));
        if (change) changes.push(change);
    }
    if (!incomingAppSid) return changes; // no incoming app → no number of ours

    const desired = { statusCallback: url(WEBHOOK_PATHS.callStatusChanges), smsUrl: url(WEBHOOK_PATHS.incomingMessage) };
    const numbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
    for (const number of numbers.filter((n) => n.voiceApplicationSid === incomingAppSid)) {
        const update: { statusCallback?: string; statusCallbackMethod?: string; smsUrl?: string; smsMethod?: string } = {};
        if (number.statusCallback !== desired.statusCallback && isKnownWebhookUrl(number.statusCallback, WEBHOOK_PATHS.callStatusChanges)) {
            update.statusCallback = desired.statusCallback;
            update.statusCallbackMethod = 'POST';
        }
        if (number.smsUrl !== desired.smsUrl && isKnownWebhookUrl(number.smsUrl, WEBHOOK_PATHS.incomingMessage)) {
            update.smsUrl = desired.smsUrl;
            update.smsMethod = 'POST';
        }
        if (Object.keys(update).length === 0) continue;
        changes.push({
            description: `number ${number.phoneNumber ?? number.sid}: ${Object.keys(update).filter((k) => !k.endsWith('Method')).join(', ')}`,
            apply: () => client.incomingPhoneNumbers(number.sid).update(update),
        });
    }
    return changes;
}

/**
 * A cached TwiML App whose voiceUrl isn't `voiceUrl` yet. If the tenant deleted the
 * app in the console (20404), the change is dropping the stale cache instead:
 * getOrCreateTwimlApp recreates it, with the current URL, the next time it's needed.
 */
async function planTwimlAppChange(
    client: Twilio, accountSid: string, direction: 'outgoing' | 'incoming', appSid: string, voiceUrl: string,
): Promise<Change | null> {
    try {
        const app = await client.applications(appSid).fetch();
        if (app.voiceUrl === voiceUrl) return null;
        return {
            description: `${direction} TwiML App ${appSid}: voiceUrl`,
            apply: () => client.applications(appSid).update({ voiceUrl, voiceMethod: 'POST' }),
        };
    } catch (error) {
        if ((error as { code?: number })?.code !== 20404) throw error;
        return {
            description: `${direction} TwiML App ${appSid}: deleted in Twilio, drop cached SID`,
            apply: () => twimlAppSidRef(accountSid, direction).remove(),
        };
    }
}

/** Every AccountSid under /twilio, or just `only`. */
async function tenantSids(only: string | undefined): Promise<string[]> {
    if (only) return [only];
    const snapshot = await admin.database().ref('/twilio').once('value');
    return Object.keys(snapshot.val() ?? {}).filter((key) => ACCOUNT_SID.test(key)).sort();
}

function parseArgs(argv: string[]): { base: string; account?: string; apply: boolean } {
    const value = (flag: string) => {
        const i = argv.indexOf(flag);
        return i === -1 ? undefined : argv[i + 1];
    };
    const base = value('--to')?.trim().replace(/\/+$/, '');
    if (!base || !KNOWN_BASES.includes(base)) {
        throw new Error(`--to must be one of: ${KNOWN_BASES.join(', ')}`);
    }
    const account = value('--account');
    if (account !== undefined && !ACCOUNT_SID.test(account)) {
        throw new Error('--account must be an AccountSid (AC + 32 hex)');
    }
    return { base, account, apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
    const { base, account, apply } = parseArgs(process.argv.slice(2));
    admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
    console.log(`${apply ? 'Applying' : 'Dry run (pass --apply to write)'}: pointing webhooks at ${base}`);

    const results: TenantResult[] = [];
    for (const accountSid of await tenantSids(account)) {
        const result = await backfillTenant(accountSid, base, apply);
        results.push(result);
        if (result.status === 'updated') {
            console.log(`${accountSid} ${apply ? 'updated' : 'would update'}:\n  ${result.changes.join('\n  ')}`);
        } else if (result.status === 'skipped') {
            console.log(`${accountSid} skipped: ${result.reason}`);
        } else if (result.status === 'failed') {
            console.error(`${accountSid} FAILED:`, result.error);
        }
    }
    const count = (status: TenantResult['status']) => results.filter((r) => r.status === status).length;
    console.log(`\n${results.length} tenants: ${count('updated')} ${apply ? 'updated' : 'to update'}, ` +
        `${count('current')} already current, ${count('skipped')} skipped, ${count('failed')} failed`);
    if (count('failed') > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().then(() => process.exit(), (error) => {
        console.error(error);
        process.exit(1);
    });
}
