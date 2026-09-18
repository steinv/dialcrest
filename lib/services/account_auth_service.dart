import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';

/// Owns the app's Firebase identity, which exists purely to authorize
/// account-scoped RTDB access (see database.rules.json). The identity is an
/// anonymous Firebase user carrying a custom `accountSid` claim, stamped
/// server-side by the twilioLinkAccount function once the Twilio credentials are
/// verified. RTDB rules then authorize reads/writes with
/// `auth.token.accountSid === $accountSid`.
///
/// The identity is deliberately disposable: nothing is ever stored under its
/// uid (all data is keyed by accountSid), and Firebase's anonymous-account
/// auto-cleanup deletes anon users ~30 days after creation regardless of
/// activity. So this service re-establishes the identity on demand — if the user
/// is signed out, the token lacks the expected `accountSid` claim, or the anon
/// account was auto-deleted, it signs in anonymously again and re-links using
/// the (separately stored, persistent) Twilio credentials. All of this is
/// transparent to the user, who never re-enters anything.
///
/// A singleton because the Firebase identity is process-global and several
/// services ([TwilioService], [SubscriptionService], startup in main) need to
/// gate their RTDB access on it.
class AccountAuthService {
  AccountAuthService._();
  static final AccountAuthService instance = AccountAuthService._();

  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFunctions _functions =
      FirebaseFunctions.instanceFor(region: 'europe-west1');

  /// The account the last/in-flight link targeted, and its creds, so recovery
  /// (after an auto-cleanup deletion, or any dropped claim) can re-link without
  /// the caller having to re-supply them.
  String? _accountSid;
  String? _authToken;

  /// De-dupes concurrent link attempts for the same account.
  Future<void>? _linkInFlight;

  /// FirebaseAuth error codes that mean the current anonymous account is gone or
  /// no longer usable — e.g. deleted by the 30-day auto-cleanup — and the right
  /// response is to create a fresh anonymous identity and re-link.
  static const _recoverableIdentityErrors = {
    'user-not-found',
    'user-token-expired',
    'user-disabled',
    'user-token-revoked',
    'invalid-user-token',
  };

  /// Ensures an anonymous Firebase identity exists. Idempotent; safe to call
  /// before any RTDB access. Does not itself set the account claim.
  Future<void> ensureSignedIn() async {
    if (_auth.currentUser == null) {
      await _auth.signInAnonymously();
    }
  }

  /// Binds the current identity to [accountSid] for RTDB authorization: verifies
  /// the creds and stamps the claim server-side (twilioLinkAccount), then
  /// refreshes the ID token so the claim is live. Remembers the creds for later
  /// transparent recovery. Overwrites any previous binding, so switching Twilio
  /// accounts is just another link. Concurrent calls for the same account share
  /// one in-flight attempt.
  Future<void> link(String accountSid, String authToken) {
    if (_accountSid == accountSid && _linkInFlight != null) {
      return _linkInFlight!;
    }
    _accountSid = accountSid;
    _authToken = authToken;
    return _linkInFlight =
        _runLink(accountSid, authToken).whenComplete(() => _linkInFlight = null);
  }

  Future<void> _runLink(String accountSid, String authToken) async {
    await ensureSignedIn();
    try {
      await _callLinkFunction(accountSid, authToken);
    } on FirebaseAuthException catch (e) {
      if (!_recoverableIdentityErrors.contains(e.code)) rethrow;
      // The anon account was deleted/disabled (most likely the 30-day
      // auto-cleanup). Recreate it and link once more — transparent to the user.
      debugPrint('Anon identity invalid (${e.code}); recreating and re-linking.');
      await _auth.signOut();
      await _auth.signInAnonymously();
      await _callLinkFunction(accountSid, authToken);
    }
  }

  Future<void> _callLinkFunction(String accountSid, String authToken) async {
    await _functions.httpsCallable('twilioLinkAccount').call({
      'accountSid': accountSid,
      'authToken': authToken,
    });
    // Force-refresh so the freshly-set claim is present in the cached token that
    // RTDB will use. Throws (recoverably) if the identity was deleted.
    await _auth.currentUser!.getIdToken(true);
  }

  /// Guarantees the current token carries the `accountSid` claim for
  /// [accountSid], (re-)linking — and re-signing-in if the anon account was
  /// auto-deleted — when it doesn't. Callers await this before reading or
  /// writing account-scoped RTDB nodes.
  ///
  /// [accountSid]/[authToken] may be omitted once [link] has been called this
  /// session (the remembered creds are reused); they are required otherwise.
  Future<void> ensureLinked([String? accountSid, String? authToken]) async {
    final sid = accountSid ?? _accountSid;
    final token = authToken ?? _authToken;
    if (sid == null || token == null) {
      throw StateError('ensureLinked called before any account was linked');
    }
    // Ride out an in-flight link for this account before inspecting the token.
    if (_accountSid == sid && _linkInFlight != null) {
      await _linkInFlight;
    }
    if (await _hasClaim(sid)) return;
    await link(sid, token);
  }

  /// Whether the *current, cached* token already asserts [accountSid]. Reads the
  /// token without forcing a network refresh, so the common already-linked path
  /// stays cheap; a still-valid cached token for a since-deleted account is
  /// honored by Firebase until it expires, at which point a refresh fails and
  /// the next [ensureLinked] recovers.
  Future<bool> _hasClaim(String accountSid) async {
    final user = _auth.currentUser;
    if (user == null) return false;
    try {
      final result = await user.getIdTokenResult();
      return result.claims?['accountSid'] == accountSid;
    } catch (e) {
      debugPrint('Could not read ID token claims: $e');
      return false;
    }
  }

  /// On logout: drop the identity so its claim can't be reused by the next user,
  /// and forget the remembered creds.
  Future<void> signOut() async {
    _accountSid = null;
    _authToken = null;
    _linkInFlight = null;
    try {
      await _auth.signOut();
    } catch (e) {
      debugPrint('Error signing out anonymous identity: $e');
    }
  }
}
