import { generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';

/**
 * A fake of the three Google endpoints the Worker calls — OAuth token exchange,
 * RTDB REST, FCM v1 — installed as global fetch. RTDB is a flat map of path →
 * value (paths as in shared/webhooks.ts dbPaths).
 */
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'hooks@twilio-phone-peblet.iam.gserviceaccount.com',
    private_key: privateKey,
    private_key_id: 'kid1',
});

export const DATABASE_URL = 'https://db.example.firebasedatabase.app';

export function installFakeGoogle() {
    const rtdb = new Map<string, unknown>();
    const fcmSent: Array<{ token: string; data: Record<string, string>; message: unknown }> = [];
    const unregisteredTokens = new Set<string>();
    const state = { rtdbDown: false, rtdbForbidden: false, tokenRequests: 0, rtdbReads: [] as string[] };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = init?.method ?? 'GET';
        if (url.href === 'https://oauth2.googleapis.com/token') {
            state.tokenRequests += 1;
            return Response.json({ access_token: 'google-token', expires_in: 3600 });
        }
        const auth = new Headers(init?.headers).get('Authorization');
        if (auth !== 'Bearer google-token') return new Response('unauthorized', { status: 401 });
        if (url.origin === DATABASE_URL) {
            if (state.rtdbDown) return new Response('unavailable', { status: 503 });
            if (state.rtdbForbidden) return new Response('permission denied', { status: 403 });
            const path = decodeURIComponent(url.pathname.replace(/\.json$/, ''));
            if (method === 'GET') {
                state.rtdbReads.push(path);
                return Response.json(rtdb.has(path) ? rtdb.get(path) : null);
            }
            if (method === 'DELETE') {
                rtdb.delete(path);
                const parent = path.slice(0, path.lastIndexOf('/'));
                const child = path.slice(path.lastIndexOf('/') + 1);
                const siblings = rtdb.get(parent) as Record<string, unknown> | undefined;
                if (siblings) delete siblings[child];
                return Response.json(null);
            }
        }
        if (url.href === 'https://fcm.googleapis.com/v1/projects/twilio-phone-peblet/messages:send') {
            const { message } = JSON.parse(String(init?.body));
            if (unregisteredTokens.has(message.token)) {
                return Response.json({ error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 });
            }
            fcmSent.push({ token: message.token, data: message.data, message });
            return Response.json({ name: 'projects/x/messages/1' });
        }
        throw new Error(`Unexpected fetch in test: ${method} ${url.href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { rtdb, fcmSent, unregisteredTokens, state, fetchMock };
}
