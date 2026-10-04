/// A device's license: a store subscription (shape returned by the
/// twilioVerifyApplePurchase/twilioVerifyGooglePurchase/twilioRefreshSubscription
/// Cloud Functions — see functions/src/subscription.ts SubscriptionStatus), or
/// the line's license override (read from RTDB by SubscriptionService.fetchOverride).
class SubscriptionStatus {
  final String plan; // 'override' | 'monthly' | 'yearly'
  final DateTime expiresAt;
  final bool autoRenew;

  /// In the store's free-trial period; [expiresAt] is then the trial's end.
  final bool freeTrial;
  final bool isActive;

  const SubscriptionStatus({
    required this.plan,
    required this.expiresAt,
    required this.autoRenew,
    this.freeTrial = false,
    required this.isActive,
  });

  factory SubscriptionStatus.fromJson(Map<dynamic, dynamic> json) {
    return SubscriptionStatus(
      plan: json['plan'] as String,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(
        (json['expiresAt'] as num).toInt(),
      ),
      autoRenew: json['autoRenew'] as bool,
      freeTrial: json['freeTrial'] as bool? ?? false,
      isActive: json['isActive'] as bool,
    );
  }

  /// The line's license override, valid until [until]. `isActive` is derived
  /// from the device's current time; the server enforces it independently.
  factory SubscriptionStatus.override(DateTime until) {
    return SubscriptionStatus(
      plan: 'override',
      expiresAt: until,
      autoRenew: false,
      isActive: until.isAfter(DateTime.now()),
    );
  }

  bool get isOverride => plan == 'override';

  /// Whole days remaining until [expiresAt], floored at 0 once it's passed.
  int get daysRemaining {
    final remaining = expiresAt.difference(DateTime.now()).inHours / 24;
    return remaining > 0 ? remaining.ceil() : 0;
  }
}
