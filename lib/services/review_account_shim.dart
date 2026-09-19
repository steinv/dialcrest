import 'package:dialcrest/dto/Capabilities.dart';
import 'package:dialcrest/dto/IncomingPhoneNumbers.dart';

/// Google Play review shim — keep everything review-account-specific in this
/// one file so it's easy to find and update.
///
/// ## Why this exists
/// App review (Google Play) needs to sign in and exercise the app without us
/// exposing real Twilio credentials or risking billing, so the review account
/// is a Twilio **trial** account. A trial number, however, is never returned by
/// the `IncomingPhoneNumbers` list API — it has no listable/fetchable resource
/// (the list comes back empty and a `GET .../IncomingPhoneNumbers/PN....json`
/// 404s), even though the number works as an outbound caller ID. Without this
/// shim the reviewer is stuck forever on the onboarding "no number / buy one"
/// screen. [apply] injects a synthetic number for the review account only, and
/// only when the account genuinely owns no listable number, so real numbers are
/// never masked and real trial users still get the correct "buy a number"
/// prompt.
///
/// ## Updating this shim (new/replacement review account)
/// Replace [accountSid], the phone number, and its `PN...` sid below. Find them
/// with (set `SID`/`TOKEN` to the review account's credentials):
///
/// 1. Confirm the trial number is hidden from the list API (expect an empty
///    `incoming_phone_numbers` array):
///    ```
///    curl -s -u "$SID:$TOKEN" \
///      "https://api.twilio.com/2010-04-01/Accounts/$SID/IncomingPhoneNumbers.json"
///    ```
///
/// 2. The trial `+1...` number itself is shown on the Twilio Console dashboard
///    (Console home / Phone Numbers). To get its hidden `PN...` sid:
///
///    2a. If the account already has call history, read it from a past outbound
///        call — no new call placed:
///        ```
///        curl -s -u "$SID:$TOKEN" \
///          "https://api.twilio.com/2010-04-01/Accounts/$SID/Calls.json?PageSize=20" \
///          | python3 -c 'import sys,json; [print(c["from"], c["phone_number_sid"]) for c in json.load(sys.stdin)["calls"] if c.get("phone_number_sid")]'
///        ```
///
///    2b. Otherwise place one throwaway outbound call and read `from` +
///        `phone_number_sid` from the response. NOTE: this places a REAL call;
///        on a trial account `To` must be a verified number (use your own):
///        ```
///        curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/$SID/Calls.json" \
///          --data-urlencode "To=+32478000000" \
///          --data-urlencode "From=+17372508034" \
///          --data-urlencode "Url=https://webhooks.twilio.com/v1/Voice/Template/voice_speech_recognition" \
///          -u "$SID:$TOKEN" \
///          | python3 -c 'import sys,json; d=json.load(sys.stdin); print("from:", d.get("from")); print("phone_number_sid:", d.get("phone_number_sid"))'
///        ```
class ReviewAccountShim {
  ReviewAccountShim._();

  /// The Twilio (trial) account SID used for Google Play app review.
  static const accountSid = 'AC6b8f384de9c850305ac0200c90d1472e';

  /// Synthetic stand-in for the review account's trial number, matching the
  /// shape [IncomingPhoneNumbers] callers expect. The sid is the `PN...` that
  /// Twilio reports as the number's `phone_number_sid` on outbound calls (even
  /// though the resource itself isn't fetchable); capabilities are voice/sms
  /// (+mms), no fax — enough for the reviewer to place a trial outbound call.
  static final _number = IncomingPhoneNumbers(
    Capabilities(false, true, true, true), // fax, mms, sms, voice
    '+17372508034',
    'in-use',
    'PNee172b5339bf2a8f710029b08568deea',
    null,
  );

  /// Returns [numbers] unchanged for every account except the review account.
  /// For the review account, when Twilio reports no listable number, returns a
  /// single synthetic entry so the reviewer isn't stuck on onboarding.
  static List<IncomingPhoneNumbers> apply(
    String currentAccountSid,
    List<IncomingPhoneNumbers> numbers,
  ) {
    if (numbers.isEmpty && currentAccountSid == accountSid) {
      return [_number];
    }
    return numbers;
  }
}
