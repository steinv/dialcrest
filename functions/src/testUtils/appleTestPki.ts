import * as crypto from 'crypto';

/**
 * A throwaway three-level PKI shaped like Apple's App Store signing chain, for
 * exercising verifyAppleNotificationSignature (app-store-server-library's
 * SignedDataVerifier) offline: the intermediate carries Apple's WWDR marker OID
 * 1.2.840.113635.100.6.2.1 and the leaf the App Store receipt-signing OID
 * 1.2.840.113635.100.6.11.1, which the library requires. Valid for 100 years.
 * Generated with openssl; these keys sign nothing but test fixtures.
 */
const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBqTCCAU+gAwIBAgIUMiXGgPRj6+SFO2giSZpsdG0uqikwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWRGlhbGNyZXN0IFRlc3QgUm9vdCBDQTAgFw0yNjEwMDMwNjM1
NDFaGA8yMTI2MDkwOTA2MzU0MVowITEfMB0GA1UEAwwWRGlhbGNyZXN0IFRlc3Qg
Um9vdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABE0OXPv3YvMkDqwruQAX
mrSmrFnmAPZX/MvG1AXy44eViXn38NwmHOsSwp8WPXqpmnm4pyoNazJDd0PMUHxW
VMqjYzBhMB0GA1UdDgQWBBRuUm1GSerpP5LRmUcaWAg3MgDQHjAfBgNVHSMEGDAW
gBRuUm1GSerpP5LRmUcaWAg3MgDQHjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB
/wQEAwIBBjAKBggqhkjOPQQDAgNIADBFAiEAoqGNVKfvoew69NVhVDxUlkvJPEI3
hdzaA677QzZFvUwCIHg3PyFQNOm2WT02wkl4PEMcSGUcjY9SaUHNkRCehXpF
-----END CERTIFICATE-----`;

const INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBwDCCAWagAwIBAgIUAyjzxRwmCDMjtlIKhSxMNI0pXFowCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWRGlhbGNyZXN0IFRlc3QgUm9vdCBDQTAgFw0yNjEwMDMwNjM1
NDFaGA8yMTI2MDkwOTA2MzU0MVowJjEkMCIGA1UEAwwbRGlhbGNyZXN0IFRlc3Qg
SW50ZXJtZWRpYXRlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8MjUs6Naj3UD
iU5MY1pu5XXSmFnCJgobRPYn2heL2oYixt+htOjbV09uFlD9FVfO4pGLKLIxkpFi
CtVOyusnTqN1MHMwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwEAYK
KoZIhvdjZAYCAQQCBQAwHQYDVR0OBBYEFPiPDziIHCnpggMx+XWWLnMCldU2MB8G
A1UdIwQYMBaAFG5SbUZJ6uk/ktGZRxpYCDcyANAeMAoGCCqGSM49BAMCA0gAMEUC
IQDOAQZ32RbjuhvruwQ8bU/8gL218Wmf9LHfCYY0DoF/awIgTqFw7ZOWv1ja54P/
+KnIrKKcZQ47q8MtCiglHXNY0GQ=
-----END CERTIFICATE-----`;

const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBuzCCAWCgAwIBAgIUAS3UUmtpjMYQvLAqJfend4xqKvcwCgYIKoZIzj0EAwIw
JjEkMCIGA1UEAwwbRGlhbGNyZXN0IFRlc3QgSW50ZXJtZWRpYXRlMCAXDTI2MTAw
MzA2MzU0MVoYDzIxMjYwOTA5MDYzNTQxWjAeMRwwGgYDVQQDDBNEaWFsY3Jlc3Qg
VGVzdCBMZWFmMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcCg5wwvbJi5/UT2U
sy0C6EbE8H6kGm0jIO7BHXNfSYyyCg5To3b6TA1/fsBeOFRoHRUPDK72zkWBo8Hx
Z1N4W6NyMHAwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEAYKKoZIhvdj
ZAYLAQQCBQAwHQYDVR0OBBYEFHoW5722uBQD7xhp9QNJfIHTFCDEMB8GA1UdIwQY
MBaAFPiPDziIHCnpggMx+XWWLnMCldU2MAoGCCqGSM49BAMCA0kAMEYCIQCDT+rt
VHxSsJwA1ieRVGnjBtTYD5w9BJn7iv/qWIRTxwIhAJ8T/w0buSq3cEWBFMQR7Dv4
+01sDD+gtnfhRM3hVVoE
-----END CERTIFICATE-----`;

const LEAF_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJ2x9Udy4EoklsUj0
X1cgBDvDPvV84/b+xjHRGVfU14ehRANCAARwKDnDC9smLn9RPZSzLQLoRsTwfqQa
bSMg7sEdc19JjLIKDlOjdvpMDX9+wF44VGgdFQ8MrvbORYGjwfFnU3hb
-----END PRIVATE KEY-----`;

function der(pemText: string): Buffer {
    return new crypto.X509Certificate(pemText).raw;
}

/** DER root to trust in place of Apple Root CA - G3 (see setAppleVerificationForTests). */
export const testAppleRootCertificate: Buffer = der(ROOT_PEM);

/**
 * Signs `payload` as an App Store JWS: ES256 over `header.payload`, with the
 * test chain in the x5c header — what Apple sends, but under the test root.
 */
export function appleSignedJws(payload: object): string {
    const header = { alg: 'ES256', x5c: [LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM].map((p) => der(p).toString('base64')) };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: LEAF_PRIVATE_KEY_PEM, dsaEncoding: 'ieee-p1363' });
    return `${signingInput}.${signature.toString('base64url')}`;
}
