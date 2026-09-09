/// Mirrors the shape returned by the twilioVerifyApplePurchase/
/// twilioVerifyGooglePurchase Cloud Functions (see functions/src/
/// subscription.ts SubscriptionStatus) after a purchase is verified.
class SubscriptionStatus {
  final String plan; // 'trial' | 'monthly' | 'yearly'
  final DateTime expiresAt;
  final bool autoRenew;
  final bool isActive;

  const SubscriptionStatus({
    required this.plan,
    required this.expiresAt,
    required this.autoRenew,
    required this.isActive,
  });

  factory SubscriptionStatus.fromJson(Map<dynamic, dynamic> json) {
    return SubscriptionStatus(
      plan: json['plan'] as String,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(
        (json['expiresAt'] as num).toInt(),
      ),
      autoRenew: json['autoRenew'] as bool,
      isActive: json['isActive'] as bool,
    );
  }

  /// Builds from the raw /twilio/{accountSid}/subscription RTDB record (read
  /// directly by SubscriptionService.fetchStatus — see database.rules.json).
  /// That record has no `isActive` field, so it's derived here from
  /// `expiresAt` against the device's current time.
  factory SubscriptionStatus.fromRecord(Map<dynamic, dynamic> record) {
    final expiresAt = DateTime.fromMillisecondsSinceEpoch(
      (record['expiresAt'] as num).toInt(),
    );
    return SubscriptionStatus(
      plan: record['plan'] as String,
      expiresAt: expiresAt,
      autoRenew: record['autoRenew'] as bool? ?? false,
      isActive: expiresAt.isAfter(DateTime.now()),
    );
  }

  bool get isTrial => plan == 'trial';

  /// Whole days remaining until [expiresAt], floored at 0 once it's passed.
  int get daysRemaining {
    final remaining = expiresAt.difference(DateTime.now()).inHours / 24;
    return remaining > 0 ? remaining.ceil() : 0;
  }
}
