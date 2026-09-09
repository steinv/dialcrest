# Dialcrest

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/steinv)

Dialcrest is a mobile calling and texting app built on the Twilio Voice SDK.
The Flutter/Dart package name in this repo is still `twilio_phone` (its
original name, pre-rebrand) — the app itself now ships as Dialcrest.

## What's in this repo

- **`lib/`** — the Flutter app (iOS + Android). Screens for auth, home/dialer,
  call history, messages, and settings live in `lib/screens/`; Twilio, contacts,
  subscription, and secure-storage logic live in `lib/services/`.
- **`functions/`** — Firebase Cloud Functions (TypeScript) that back the app:
  issuing Twilio Voice access tokens, handling incoming/outgoing call and
  status callbacks, managing push credentials (FCM/APN), and verifying
  App Store/Play subscription purchases (`functions/src/twilio.ts`,
  `functions/src/subscription.ts`).
- **`public/`** — the small static site served by Firebase Hosting (currently
  just the privacy policy).
- **`store_assets/`** — screenshots/graphics for the App Store and Play Store
  listings.

The app talks to the Cloud Functions for anything that needs a Twilio auth
token or server-side secret; Firebase (Auth, Realtime Database, Cloud
Messaging, App Check) ties the two together.

## Getting started

Prerequisites: [Flutter SDK](https://docs.flutter.dev/get-started/install),
a Firebase project with the Functions/Auth/Database/Hosting products enabled,
and a Twilio account with a configured Voice-capable number/TwiML app.

```bash
# Flutter app
flutter pub get
flutter run

# Cloud Functions (from functions/)
npm install
npm run serve     # build + run against the Firebase emulators
npm run deploy     # deploy to the configured Firebase project
```

Firebase project IDs and app IDs are defined in `firebase.json`; regenerate
`lib/firebase_options.dart` and the platform config files with `flutterfire
configure` if you point this at a different Firebase project.

Localized strings live in `lib/l10n/*.arb` (English, German, French, Spanish,
Dutch) — run `flutter gen-l10n` after editing them to regenerate
`lib/l10n/generated/`.

## Enabling iOS push (incoming calls)

iOS push is **disabled by default**. Outgoing calls work without it, but to
**receive** incoming calls an iOS device must be woken by Apple's VoIP push
(PushKit), which Twilio can only do if an APN push credential exists in the
tenant's Twilio account.

The Cloud Function gates the iOS branch on having *both* an APN certificate and
an APN private key:

```ts
// functions/src/twilio.ts
const hasIos = Boolean(iosApnCertificate && iosApnPrivateKey);
```

When either is empty, `createOrUpdatePushCredentials` skips iOS entirely (this is
the current state). To enable it, supply both as described below.

> **Note:** A VoIP push credential can only be created/renewed under an **active
> Apple Developer Program membership** ($99/yr), and the certificate is tied to
> your app's bundle ID. VoIP push also **only works on a physical device** — the
> iOS Simulator can never receive push.

### 1. Create the VoIP Services Certificate (Apple)

1. **App ID** — In the [Apple Developer portal](https://developer.apple.com)
   → *Certificates, Identifiers & Profiles → Identifiers*, ensure your app's
   bundle ID is an **explicit** App ID (not a wildcard) with the **Push
   Notifications** capability enabled.
2. **Create a CSR** — On a Mac, open *Keychain Access → Certificate Assistant →
   Request a Certificate From a Certificate Authority*, choose "Saved to disk".
   This writes a `.certSigningRequest` file and stores a matching private key in
   your keychain.
3. **Issue the cert** — In the portal → *Certificates → ➕ → VoIP Services
   Certificate*, select your App ID, upload the CSR, and download
   `voip_services.cer`.

### 2. Export certificate + private key as PEM

Twilio wants both halves as PEM text. Import `voip_services.cer` into Keychain,
then export it **together with its private key** as a `.p12` (right-click →
Export, set a password). Then split it:

```bash
# Certificate (PEM) -> goes into IOS_APN_CERTIFICATE
openssl x509 -in voip_services.cer -inform DER -out apn_cert.pem -outform PEM

# Private key (PEM) -> goes into the ios_apn_pk field of TWILIO_PEBLET_SECRET
openssl pkcs12 -in VoIP.p12 -nocerts -nodes -out apn_key.pem
```

The certificate and private key are a **keypair** — they only work together.
Renewing the cert generally produces a new keypair, so replace *both* values
when you renew.

### 3. Configure the two values

| Value             | What it is                  | Where it goes                                    | Why there                                             |
| ----------------- | --------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `apn_cert.pem`    | Public VoIP certificate     | `IOS_APN_CERTIFICATE` string param (`functions/.env`) | Public, not secret — declared via `defineString`. |
| `apn_key.pem`     | Private key (sensitive)     | `ios_apn_pk` field inside `TWILIO_PEBLET_SECRET` | Secret — kept in Secret Manager via `defineSecret`.   |

**Certificate** — add it to `functions/.env` (gitignored). PEM is multi-line, so
quote it and use real newlines, e.g.:

```dotenv
IOS_APN_CERTIFICATE="-----BEGIN CERTIFICATE-----
MII...
-----END CERTIFICATE-----"
```

**Private key** — it lives alongside the FCM key inside the single
`TWILIO_PEBLET_SECRET` Secret Manager secret, which is JSON:

```json
{
  "android_fcm": { "<FCM v1 service-account JSON>": "..." },
  "ios_apn_pk": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
}
```

Set/rotate it with:

```bash
firebase functions:secrets:set TWILIO_PEBLET_SECRET   # set / rotate (paste the full JSON)
firebase functions:secrets:access TWILIO_PEBLET_SECRET # view current value
```

For local emulator runs, the same JSON is read from `functions/.secret.local`.

### 4. Deploy

```bash
firebase deploy --only functions
```

On the next app launch, `twilioRegister` will detect both values, create the APN
push credential in the tenant's Twilio account, and attach its SID to the Voice
access token — incoming calls will then ring on a physical iOS device.

## License

Dialcrest is open source, licensed under the
[GNU General Public License v3.0](LICENSE). This means anyone is free to use,
study, modify, and redistribute this code, but any distributed derivative
work must also be licensed under the GPLv3 and made available in source form.
