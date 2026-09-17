import * as crypto from 'crypto';
import { AppleConfig } from '../subscription';

function base64url(input: string): string {
    return Buffer.from(input).toString('base64url');
}

/**
 * Builds a fake Apple-signed JWS: `header.payload.signature` with a real
 * payload but a throwaway signature. subscription.ts's decodeAppleSignedPayload
 * never verifies the signature (see its docstring — trust comes from the
 * transport, not the signature, for values we fetch ourselves from Apple), so
 * this is all tests need to exercise that decoding path.
 */
export function signedPayload(payload: object): string {
    const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
    const body = base64url(JSON.stringify(payload));
    return `${header}.${body}.fake-signature`;
}

/** A syntactically valid ES256 key pair, good enough for signAppleServerJwt to sign with. */
const keyPair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const testAppleConfig: AppleConfig = {
    issuerId: 'test-issuer',
    keyId: 'test-key-id',
    privateKey: keyPair.privateKey,
    bundleId: 'be.peblet.dialcrest',
};

/** Builds the `GET /inApps/v1/subscriptions/{id}` response body Apple's server API returns. */
export function appleSubscriptionStatusesResponse(
    transactions: Array<{ transactionId: string; originalTransactionId: string; productId: string; expiresDate: number; autoRenewStatus: 0 | 1 }>,
) {
    return {
        data: [
            {
                lastTransactions: transactions.map((tx) => ({
                    signedTransactionInfo: signedPayload({
                        transactionId: tx.transactionId,
                        originalTransactionId: tx.originalTransactionId,
                        productId: tx.productId,
                        expiresDate: tx.expiresDate,
                    }),
                    signedRenewalInfo: signedPayload({ autoRenewStatus: tx.autoRenewStatus }),
                })),
            },
        ],
    };
}

function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

/**
 * Installs a global.fetch mock that answers Apple's "get subscription
 * statuses" endpoint. `bases` controls which of the production/sandbox base
 * URLs (tried in that order by fetchAppleSubscriptionStatuses) resolves, and
 * with what.
 */
export function mockAppleFetch(bases: { production?: { status: number; body?: unknown }; sandbox?: { status: number; body?: unknown } }) {
    const fetchMock = jest.fn(async (url: string) => {
        if (url.startsWith('https://api.storekit.itunes.apple.com')) {
            const p = bases.production;
            if (!p) return jsonResponse(404, 'not found');
            return jsonResponse(p.status, p.body ?? {});
        }
        if (url.startsWith('https://api.storekit-sandbox.itunes.apple.com')) {
            const s = bases.sandbox;
            if (!s) return jsonResponse(404, 'not found');
            return jsonResponse(s.status, s.body ?? {});
        }
        throw new Error(`Unexpected fetch URL in test: ${url}`);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}
