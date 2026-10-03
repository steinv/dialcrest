import { googleAccessToken, ServiceAccount, UpstreamError } from './google';

/**
 * The slice of Firebase the webhooks need, over REST: RTDB reads/deletes and FCM
 * HTTP v1 sends, authenticated with the service account's OAuth token. Paths come
 * from functions/src/shared/webhooks.ts dbPaths, so they match the functions.
 */
export interface FirebaseConfig {
    account: ServiceAccount;
    databaseUrl: string;
    projectId: string;
}

/** `/a/b:c` → `/a/b%3Ac` — each segment encoded, so a key can never alter the path or add a query. */
function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

async function rtdbFetch(config: FirebaseConfig, path: string, init: RequestInit = {}): Promise<Response> {
    const token = await googleAccessToken(config.account);
    const response = await fetch(`${config.databaseUrl.replace(/\/+$/, '')}${encodePath(path)}.json`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new UpstreamError(`RTDB ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`, response.status);
    }
    return response;
}

/** The value at `path`, or null when nothing is stored there. Throws on a failed read. */
export async function rtdbGet<T>(config: FirebaseConfig, path: string): Promise<T | null> {
    return (await (await rtdbFetch(config, path)).json()) as T | null;
}

export async function rtdbDelete(config: FirebaseConfig, path: string): Promise<void> {
    await rtdbFetch(config, path, { method: 'DELETE' });
}

export type FcmResult = 'sent' | 'unregistered' | 'failed';

/**
 * Sends a silent/data-only push — the REST form of the message
 * callbackIncomingMessage sends through firebase-admin: high priority on Android,
 * `content-available` + priority 10 on APNs. 'unregistered' means FCM no longer
 * knows the token (uninstalled app / stale token) and it should be dropped.
 */
export async function sendDataMessage(config: FirebaseConfig, token: string, data: Record<string, string>): Promise<FcmResult> {
    const accessToken = await googleAccessToken(config.account);
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
            message: {
                token,
                data,
                android: { priority: 'HIGH' },
                apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1 } } },
            },
        }),
    });
    if (response.ok) return 'sent';
    const text = await response.text();
    // https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode — UNREGISTERED
    // is what firebase-admin surfaces as messaging/registration-token-not-registered.
    if (text.includes('"UNREGISTERED"')) return 'unregistered';
    console.error({ event: 'fcm_send_failed', status: response.status, body: text });
    return 'failed';
}
