/**
 * Google OAuth2 access tokens for a service account, minted with WebCrypto
 * (firebase-admin doesn't run in Workers): sign a JWT assertion with the key's
 * RS256 private key and exchange it at the token endpoint.
 * https://developers.google.com/identity/protocols/oauth2/service-account#httprest
 *
 * One token covers both RTDB REST and FCM v1. It's cached in the isolate's
 * global scope (reused across requests until shortly before it expires; gone on
 * the next cold isolate), and concurrent requests share one in-flight mint.
 */

/**
 * A failed call to Google. `transient` (5xx / rate limit) means an outage that
 * may fail open; anything else (bad key, missing IAM role, …) is a
 * misconfiguration that must never be mistaken for one.
 */
export class UpstreamError extends Error {
    readonly transient: boolean;

    constructor(message: string, readonly status: number) {
        super(message);
        this.transient = status >= 500 || status === 429;
    }
}

/** True for errors worth failing open on: a transient Google error, or a network failure (fetch threw). */
export function isTransient(error: unknown): boolean {
    return error instanceof UpstreamError ? error.transient : error instanceof TypeError;
}

export interface ServiceAccount {
    client_email: string;
    private_key: string;
    private_key_id?: string;
    token_uri?: string;
}

const SCOPES = [
    'https://www.googleapis.com/auth/firebase.database',
    'https://www.googleapis.com/auth/userinfo.email', // RTDB REST requires it alongside firebase.database
    'https://www.googleapis.com/auth/firebase.messaging',
].join(' ');

const TOKEN_LIFETIME_S = 3600;
/** Refresh this long before Google's expiry so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cached: { email: string; token: string; expiresAt: number } | null = null;
let inFlight: { email: string; promise: Promise<string> } | null = null;

/** Test-only: forget the cached token. */
export function resetGoogleTokenCacheForTests(): void {
    cached = null;
    inFlight = null;
}

export function parseServiceAccount(json: string | undefined): ServiceAccount {
    if (!json) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON secret is not set');
    const parsed = JSON.parse(json) as Partial<ServiceAccount>;
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email/private_key');
    }
    return parsed as ServiceAccount;
}

function base64url(input: ArrayBuffer | Uint8Array | string): string {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): ArrayBuffer {
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    return Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer;
}

/** The signed JWT assertion exchanged for an access token. */
export async function signAssertion(account: ServiceAccount, nowSeconds: number): Promise<string> {
    const header = { alg: 'RS256', typ: 'JWT', ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
    const claims = {
        iss: account.client_email,
        scope: SCOPES,
        aud: account.token_uri ?? 'https://oauth2.googleapis.com/token',
        iat: nowSeconds,
        exp: nowSeconds + TOKEN_LIFETIME_S,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const key = await crypto.subtle.importKey(
        'pkcs8', pemToPkcs8(account.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
    return `${signingInput}.${base64url(signature)}`;
}

async function mint(account: ServiceAccount): Promise<string> {
    const now = Date.now();
    const assertion = await signAssertion(account, Math.floor(now / 1000));
    const response = await fetch(account.token_uri ?? 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!response.ok) {
        throw new UpstreamError(`Google token exchange failed: ${response.status} ${await response.text()}`, response.status);
    }
    const body = await response.json() as { access_token: string; expires_in?: number };
    cached = {
        email: account.client_email,
        token: body.access_token,
        expiresAt: now + (body.expires_in ?? TOKEN_LIFETIME_S) * 1000 - REFRESH_MARGIN_MS,
    };
    return body.access_token;
}

export async function googleAccessToken(account: ServiceAccount): Promise<string> {
    if (cached && cached.email === account.client_email && cached.expiresAt > Date.now()) return cached.token;
    if (inFlight && inFlight.email === account.client_email) return inFlight.promise;
    const promise = mint(account).finally(() => {
        inFlight = null;
    });
    inFlight = { email: account.client_email, promise };
    return promise;
}
