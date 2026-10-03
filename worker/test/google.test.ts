import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseServiceAccount, signAssertion } from '../src/google';

describe('signAssertion', () => {
    it('produces an RS256 JWT Google can verify, with the expected claims', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        const account = { client_email: 'sa@p.iam.gserviceaccount.com', private_key: privateKey, private_key_id: 'kid1' };
        const jwt = await signAssertion(account, 1_000_000);
        const [header, claims, signature] = jwt.split('.');

        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${header}.${claims}`);
        expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid1' });
        expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
            iss: 'sa@p.iam.gserviceaccount.com',
            scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email ' +
                'https://www.googleapis.com/auth/firebase.messaging',
            aud: 'https://oauth2.googleapis.com/token',
            iat: 1_000_000,
            exp: 1_003_600,
        });
    });
});

describe('parseServiceAccount', () => {
    it('rejects a missing or incomplete secret with a clear error', () => {
        expect(() => parseServiceAccount(undefined)).toThrow('not set');
        expect(() => parseServiceAccount('{"client_email":"x"}')).toThrow('missing client_email/private_key');
    });
});
