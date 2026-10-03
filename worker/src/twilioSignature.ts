/**
 * X-Twilio-Signature validation with WebCrypto — a port of twilio-node's
 * validateRequest (the Worker can't bundle the twilio package). Twilio signs
 * base64(HMAC-SHA1(authToken, url + each param name followed by its value,
 * params in name order)); a repeated param contributes each distinct value, in
 * sorted order. https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */

/** The string Twilio HMACs for `url` and the POSTed form params. */
export function signatureBase(url: string, params: URLSearchParams): string {
    const names = [...new Set(params.keys())].sort();
    return names.reduce((acc, name) => {
        const values = params.getAll(name);
        const ordered = values.length > 1 ? [...new Set(values)].sort() : values;
        return acc + ordered.map((value) => name + value).join('');
    }, url);
}

/**
 * The URL spellings to try. Like twilio-node, accept the signature computed with
 * or without the scheme's default port, since Twilio isn't consistent about it.
 * (twilio-node's legacy-querystring variants don't apply: our URLs have none.)
 */
function urlVariants(url: string): string[] {
    const parsed = new URL(url);
    const withoutPort = new URL(url);
    withoutPort.port = '';
    const withPort = `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}` +
        `${parsed.pathname}${parsed.search}`;
    return [...new Set([withoutPort.toString(), withPort])];
}

function base64ToBytes(value: string): Uint8Array | null {
    try {
        return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

/**
 * True iff `signature` is Twilio's signature for (`url`, `params`) under
 * `authToken`. Uses crypto.subtle.verify, which compares in constant time.
 */
export async function isValidTwilioSignature(
    authToken: string, signature: string, url: string, params: URLSearchParams,
): Promise<boolean> {
    const signatureBytes = base64ToBytes(signature);
    if (signatureBytes === null || signatureBytes.length !== 20) return false; // SHA-1 MAC is 20 bytes
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['verify']);
    for (const candidate of urlVariants(url)) {
        if (await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(signatureBase(candidate, params)))) {
            return true;
        }
    }
    return false;
}
