import 'dart:async';
import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:flutter/foundation.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

import '../models/subscription_status.dart';
import 'storage_service.dart';

/// Thrown by [SubscriptionService.purchase] when the user cancels the store's
/// purchase flow rather than the purchase failing outright, so callers can
/// show a plain "canceled" message instead of an error.
class PurchaseCanceledException implements Exception {
  const PurchaseCanceledException();
}

/// Per-accountSid subscription: a 30-day trial (started server-side the first
/// time this account registers — see functions/src/subscription.ts
/// ensureTrialStarted), then an auto-renewing purchase of one of
/// [monthlyProductId]/[yearlyProductId]. Purchases are made through the
/// platform store (required for digital subscriptions sold in-app on
/// Android/iOS) and verified server-side against the Apple/Google server
/// APIs — this class never decides subscription state on its own, it only
/// relays the store purchase to the Cloud Function that does.
///
/// Billing is Android/iOS only; [isSupported] is false on Linux, where the
/// Settings screen shows trial/expiry status with no purchase UI.
class SubscriptionService {
  /// These plan ids double as the App Store Connect product ids (Apple has no
  /// "base plan" concept, so iOS just has two separate products with these
  /// ids) and as the Google Play base plan ids under [_androidProductId]
  /// (Play Billing groups both plans into one product with multiple base
  /// plans, so the store-level product id can't tell them apart on Android).
  static const String monthlyProductId = 'monthly-dialcrest-license';
  static const String yearlyProductId = 'yearly-dialcrest-license';
  static const Set<String> productIds = {monthlyProductId, yearlyProductId};

  /// The single Play Billing product both Android base plans live under.
  static const String _androidProductId = 'dialcrest';

  final String accountSid;
  final StorageService _storageService;
  final FirebaseFunctions _firebaseFunctions = FirebaseFunctions.instanceFor(
    region: 'europe-west1',
  );
  final InAppPurchase _inAppPurchase = InAppPurchase.instance;

  StreamSubscription<List<PurchaseDetails>>? _purchaseSubscription;

  /// The store-native product for each plan id, as returned by
  /// [loadProducts] — kept around so [purchase] can hand the real
  /// [GooglePlayProductDetails]/offer token back to the store rather than the
  /// id-normalized copy exposed to the UI.
  final Map<String, ProductDetails> _storeProducts = {};

  /// Resolves the in-flight purchase started by [purchase]. Only one
  /// purchase is expected at a time — the Settings screen disables the buy
  /// buttons while a purchase is pending — which is just as well, since
  /// Android's purchase updates report the underlying store product id
  /// ('dialcrest' for both plans), not the plan id, so there's no reliable
  /// key to map purchase updates back to a specific pending purchase.
  Completer<SubscriptionStatus>? _pendingPurchase;

  bool get isSupported => Platform.isAndroid || Platform.isIOS;

  SubscriptionService({
    required this.accountSid,
    required StorageService storageService,
  }) : _storageService = storageService {
    if (!isSupported) return;
    _purchaseSubscription = _inAppPurchase.purchaseStream.listen(
      _onPurchaseUpdate,
      onError: (e) => debugPrint('Subscription purchase stream error: $e'),
    );
  }

  /// The store entitlement to attach to a gated backend call (twilioAccessToken
  /// / twilioRefreshSubscription), or null if this device has only ever
  /// trialed. The backend re-verifies whatever token this returns against the
  /// store, so a persisted-but-stale token is fine — it names the subscription,
  /// the store reports its current state. Deliberately does not query the store
  /// (which can prompt for sign-in), so trialing users hit no store friction.
  ///
  /// TODO(ios): on iOS, StoreKit 2's Transaction.currentEntitlements could
  /// recover a paid entitlement after a reinstall WITHOUT a sign-in prompt
  /// (unlike restorePurchases), letting us auto-detect it here instead of
  /// requiring the explicit "Restore purchases" button. The current design
  /// doesn't use that path — it relies on the button — so a reinstalled iOS
  /// subscriber still has to tap Restore until this is wired up.
  Map<String, String> get currentEntitlement {
    final store = _storageService.paidEntitlementStore;
    final token = _storageService.paidEntitlementToken;
    if (store == null || token == null) return const {};
    return store == 'app_store'
        ? {'signedTransactionInfo': token}
        : {'purchaseToken': token};
  }

  void dispose() {
    _purchaseSubscription?.cancel();
  }

  /// Current subscription status (trial countdown, active plan, or expired)
  /// for display in Settings. Read directly from RTDB rather than through a
  /// Cloud Function — database.rules.json opens read access to exactly this
  /// child node. `isActive` is derived on-device from `expiresAt`, which is
  /// only as fresh as the last write from twilioRegister/twilioAccessToken/a
  /// purchase verification; the authoritative, re-verified check that
  /// actually gates calling still lives server-side in twilioAccessToken.
  Future<SubscriptionStatus> fetchStatus() async {
    final snapshot = await FirebaseDatabase.instanceFor(
      app: Firebase.app(),
      databaseURL:
          'https://twilio-phone-peblet-default-rtdb.europe-west1.firebasedatabase.app',
    ).ref('/twilio/$accountSid/subscription').get();
    final record = snapshot.value;
    if (record == null) {
      // twilioRegister hasn't run yet (e.g. first launch, still offline) —
      // report an already-expired trial rather than crashing Settings.
      return SubscriptionStatus(
        plan: 'trial',
        expiresAt: DateTime.fromMillisecondsSinceEpoch(0),
        autoRenew: false,
        isActive: false,
      );
    }
    return SubscriptionStatus.fromRecord(record as Map);
  }

  /// Queries the store for the two subscription plans' localized prices.
  /// Returns an empty list (rather than throwing) if the store can't be
  /// reached or the products aren't configured yet, so Settings can fall
  /// back to a plain plan name instead of failing to load entirely.
  Future<List<ProductDetails>> loadProducts() async {
    if (!isSupported) return [];
    try {
      final available = await _inAppPurchase.isAvailable();
      if (!available) return [];
      _storeProducts.clear();
      return Platform.isAndroid
          ? await _loadAndroidProducts()
          : await _loadStoreProducts(productIds);
    } catch (e) {
      debugPrint('Error loading subscription products: $e');
      return [];
    }
  }

  Future<List<ProductDetails>> _loadStoreProducts(Set<String> ids) async {
    final response = await _inAppPurchase.queryProductDetails(ids);
    if (response.error != null) {
      debugPrint('queryProductDetails error: ${response.error}');
    }
    for (final product in response.productDetails) {
      _storeProducts[product.id] = product;
    }
    return response.productDetails;
  }

  /// Play Billing returns one [GooglePlayProductDetails] per base
  /// plan/offer under the single [_androidProductId] product, all sharing
  /// `id == _androidProductId` — so they're re-keyed here by base plan id
  /// (matching [monthlyProductId]/[yearlyProductId]) to line up with the
  /// rest of the app, which otherwise treats Android like iOS's two
  /// separate product ids. Discounted offers (`offerId != null`) are
  /// skipped in favor of the plain base plan.
  Future<List<ProductDetails>> _loadAndroidProducts() async {
    final response = await _inAppPurchase.queryProductDetails({
      _androidProductId,
    });
    if (response.error != null) {
      debugPrint('queryProductDetails error: ${response.error}');
    }
    final byBasePlan = <String, GooglePlayProductDetails>{};
    for (final product in response.productDetails) {
      if (product is! GooglePlayProductDetails) continue;
      final index = product.subscriptionIndex;
      final offers = product.productDetails.subscriptionOfferDetails;
      if (index == null || offers == null) continue;
      final offer = offers[index];
      if (offer.offerId != null) continue;
      byBasePlan[offer.basePlanId] = product;
    }
    final result = <ProductDetails>[];
    for (final planId in productIds) {
      final match = byBasePlan[planId];
      if (match == null) continue;
      _storeProducts[planId] = match;
      result.add(
        ProductDetails(
          id: planId,
          title: match.title,
          description: match.description,
          price: match.price,
          rawPrice: match.rawPrice,
          currencyCode: match.currencyCode,
          currencySymbol: match.currencySymbol,
        ),
      );
    }
    return result;
  }

  /// Starts a purchase for the plan identified by [productId] (one of
  /// [monthlyProductId]/[yearlyProductId]) and resolves once it's been
  /// verified server-side and the subscription record updated. Throws if the
  /// user cancels, the store/verification reports an error, or [loadProducts]
  /// hasn't returned this plan yet.
  Future<SubscriptionStatus> purchase(String productId) {
    final product = _storeProducts[productId];
    if (product == null) {
      throw StateError('Product $productId is not available from the store.');
    }
    final completer = Completer<SubscriptionStatus>();
    _pendingPurchase = completer;
    final purchaseParam = product is GooglePlayProductDetails
        ? GooglePlayPurchaseParam(
            productDetails: product,
            offerToken: product.offerToken,
          )
        : PurchaseParam(productDetails: product);
    _inAppPurchase.buyNonConsumable(purchaseParam: purchaseParam).catchError((
      e,
    ) {
      _pendingPurchase = null;
      if (!completer.isCompleted) completer.completeError(e);
      return false;
    });
    return completer.future;
  }

  Future<void> _onPurchaseUpdate(List<PurchaseDetails> purchases) async {
    for (final purchase in purchases) {
      await _handlePurchase(purchase);
    }
  }

  Future<void> _handlePurchase(PurchaseDetails purchase) async {
    final completer = _pendingPurchase;
    try {
      switch (purchase.status) {
        case PurchaseStatus.pending:
          return;
        case PurchaseStatus.error:
          _pendingPurchase = null;
          completer?.completeError(
            Exception(purchase.error?.message ?? 'Purchase failed'),
          );
          return;
        case PurchaseStatus.canceled:
          _pendingPurchase = null;
          completer?.completeError(const PurchaseCanceledException());
          return;
        case PurchaseStatus.purchased:
        case PurchaseStatus.restored:
          final status = await _verifyPurchase(purchase);
          _pendingPurchase = null;
          completer?.complete(status);
          return;
      }
    } catch (e) {
      _pendingPurchase = null;
      if (completer != null && !completer.isCompleted) {
        completer.completeError(e);
      } else {
        debugPrint('Error handling purchase update: $e');
      }
    } finally {
      if (purchase.pendingCompletePurchase) {
        await _inAppPurchase.completePurchase(purchase);
      }
    }
  }

  /// Sends the store's verification data to the matching Cloud Function,
  /// which re-validates it against the Apple/Google server APIs (not just
  /// trusting this data) and persists the resulting expiry/auto-renew state.
  /// Android doesn't send a product id hint: with both plans living under one
  /// Play Billing product, `purchase.productID` is just `_androidProductId`
  /// for either plan, so the server derives the actual plan itself from the
  /// Play API's base plan id.
  Future<SubscriptionStatus> _verifyPurchase(PurchaseDetails purchase) async {
    final verificationData =
        purchase.verificationData.serverVerificationData;
    // Persist first so the entitlement survives even if verification fails
    // transiently — later token requests re-present it and the backend
    // re-verifies against the store.
    await _storageService.setPaidEntitlement(
      Platform.isIOS ? 'app_store' : 'play_store',
      verificationData,
    );
    final callable = Platform.isIOS
        ? 'twilioVerifyApplePurchase'
        : 'twilioVerifyGooglePurchase';
    final params = Platform.isIOS
        ? {'accountSid': accountSid, 'signedTransactionInfo': verificationData}
        : {'accountSid': accountSid, 'purchaseToken': verificationData};
    final response = await _firebaseFunctions
        .httpsCallable(callable)
        .call(params);
    return SubscriptionStatus.fromJson(
      Map<String, dynamic>.from(response.data as Map),
    );
  }

  /// Re-verifies this device's stored paid entitlement against the store and
  /// returns its current status, or null if the device has no paid entitlement
  /// (trial-only). Used by Settings so paid state self-heals after a renewal
  /// instead of relying on a stale cached expiry.
  Future<SubscriptionStatus?> refreshPaidStatus() async {
    final entitlement = currentEntitlement;
    if (entitlement.isEmpty) return null;
    final response = await _firebaseFunctions
        .httpsCallable('twilioRefreshSubscription')
        .call({'accountSid': accountSid, ...entitlement});
    return SubscriptionStatus.fromJson(
      Map<String, dynamic>.from(response.data as Map),
    );
  }

  /// Asks the store to re-deliver past purchases through the purchase stream,
  /// so a paid user who reinstalled (losing the locally stored entitlement) can
  /// recover it. This can prompt for store sign-in, so it's an explicit
  /// user-initiated action (a "Restore purchases" button), never automatic.
  Future<void> restorePurchases() async {
    if (!isSupported) return;
    await _inAppPurchase.restorePurchases();
  }
}
