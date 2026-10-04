import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../l10n/generated/app_localizations.dart';
import '../models/subscription_status.dart';
import '../services/subscription_service.dart';

/// The monthly/yearly purchase buttons with the free-trial notice and a
/// "Restore purchases" action — shared by the Settings license section and the
/// onboarding license step. Reports a verified, active license through
/// [onLicensed]. [products] come from [SubscriptionService.loadProducts]
/// (loaded by the parent, which also needs them to know the store answered).
class LicensePurchaseButtons extends StatefulWidget {
  final SubscriptionService subscriptionService;
  final List<ProductDetails> products;
  final ValueChanged<SubscriptionStatus> onLicensed;

  const LicensePurchaseButtons({
    super.key,
    required this.subscriptionService,
    required this.products,
    required this.onLicensed,
  });

  @override
  State<LicensePurchaseButtons> createState() => _LicensePurchaseButtonsState();
}

class _LicensePurchaseButtonsState extends State<LicensePurchaseButtons> {
  bool _isPurchasing = false;

  /// Looks up [productId] among the store-loaded products and starts a
  /// purchase for it. Shows an error instead of purchasing if the store
  /// hasn't returned that product yet (e.g. still loading, or misconfigured).
  Future<void> _purchase(String productId, String fallbackLabel) async {
    if (_isPurchasing) return;
    final available = widget.products.any((p) => p.id == productId);
    if (!available) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!.planUnavailableError(fallbackLabel),
          ),
        ),
      );
      return;
    }
    setState(() => _isPurchasing = true);
    try {
      final status = await widget.subscriptionService.purchase(productId);
      if (!mounted) return;
      setState(() => _isPurchasing = false);
      widget.onLicensed(status);
    } on PurchaseCanceledException {
      if (!mounted) return;
      setState(() => _isPurchasing = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context)!.purchaseCanceled),
        ),
      );
    } catch (e) {
      // A purchase can fail because the store considers the user already
      // subscribed to the SAME plan (e.g. it auto-renewed but the app hadn't
      // noticed). Rather than surface that as an error, re-verify the existing
      // entitlement — if it's active for the plan just attempted, this is
      // really a success. Only checking the plan match keeps an unrelated
      // failure (e.g. a failed upgrade from monthly to yearly) from being
      // masked by the still-active old plan.
      final recovered = await _recoverExistingSubscription();
      final expectedPlan =
          productId == SubscriptionService.yearlyProductId ? 'yearly' : 'monthly';
      if (!mounted) return;
      setState(() => _isPurchasing = false);
      if (recovered != null && recovered.plan == expectedPlan) {
        widget.onLicensed(recovered);
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!.purchaseFailed(e.toString()),
          ),
        ),
      );
    }
  }

  /// Re-verifies this device's stored paid entitlement and returns it if
  /// active, else null. Used to turn an "already subscribed" purchase failure
  /// into a success and to back the "Restore purchases" action.
  Future<SubscriptionStatus?> _recoverExistingSubscription() async {
    try {
      final status = await widget.subscriptionService.refreshPaidStatus();
      return (status != null && status.isActive) ? status : null;
    } catch (_) {
      return null;
    }
  }

  /// Asks the store to re-deliver past purchases, then re-verifies the
  /// recovered entitlement. Reports the recovered subscription on success, or
  /// shows a "nothing to restore" notice if the store had no active purchase.
  Future<void> _restorePurchases() async {
    if (_isPurchasing) return;
    setState(() => _isPurchasing = true);
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.subscriptionService.restorePurchases();
      // restorePurchases replays purchases through the stream asynchronously;
      // poll the cheap local cache until it lands rather than guessing a fixed
      // delay (~3s max — mirrors SubscriptionService.recoverEntitlement).
      for (
        var i = 0;
        i < 10 && widget.subscriptionService.currentEntitlement.isEmpty;
        i++
      ) {
        await Future.delayed(const Duration(milliseconds: 300));
      }
      final recovered = await _recoverExistingSubscription();
      if (!mounted) return;
      setState(() => _isPurchasing = false);
      if (recovered != null) widget.onLicensed(recovered);
      messenger.showSnackBar(SnackBar(
        content: Text(
          recovered != null ? l10n.purchasesRestored : l10n.noPurchasesToRestore,
        ),
      ));
    } catch (e) {
      if (!mounted) return;
      setState(() => _isPurchasing = false);
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.purchaseFailed(e.toString()))),
      );
    }
  }

  /// The store's localized price for [productId] with a "/month" or "/year"
  /// suffix, or [fallback] while the store hasn't returned it yet. Price and
  /// currency vary by region/store, so this never falls back to a hardcoded
  /// amount — only to a plan name.
  String _priceLabel(String productId, String fallback) {
    final matches = widget.products.where((p) => p.id == productId);
    if (matches.isEmpty) return fallback;
    final suffix = productId == SubscriptionService.yearlyProductId
        ? AppLocalizations.of(context)!.perYearSuffix
        : AppLocalizations.of(context)!.perMonthSuffix;
    return '${matches.first.price}$suffix';
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.subscriptionService.freeTrialOffered) ...[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.card_giftcard,
                size: 20,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              Expanded(child: Text(l10n.licenseFreeTrialOffer)),
            ],
          ),
          const SizedBox(height: 12),
        ],
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _isPurchasing
                    ? null
                    : () => _purchase(
                        SubscriptionService.monthlyProductId,
                        l10n.monthly,
                      ),
                child: Text(
                  _priceLabel(SubscriptionService.monthlyProductId, l10n.monthly),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: FilledButton(
                onPressed: _isPurchasing
                    ? null
                    : () => _purchase(
                        SubscriptionService.yearlyProductId,
                        l10n.yearly,
                      ),
                child: Text(
                  _priceLabel(SubscriptionService.yearlyProductId, l10n.yearly),
                ),
              ),
            ),
          ],
        ),
        if (_isPurchasing) ...[
          const SizedBox(height: 8),
          const Center(
            child: SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ],
        // Lets a subscriber who reinstalled (and so lost the locally stored
        // entitlement) recover their paid subscription from the store.
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: _isPurchasing ? null : _restorePurchases,
            child: Text(l10n.restorePurchases),
          ),
        ),
      ],
    );
  }
}
