import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../dto/IncomingPhoneNumbers.dart';
import '../l10n/generated/app_localizations.dart';
import '../models/subscription_status.dart';
import '../services/account_auth_service.dart';
import '../services/storage_service.dart';
import '../services/subscription_service.dart';
import '../services/twilio_service.dart';
import 'auth_screen.dart';

/// Lets the user pick which of their Twilio account's phone numbers is used
/// as the caller id for outgoing calls/texts, choose which numbers ring this
/// app for incoming calls/texts, see/purchase their subscription, and log
/// out of the connected Twilio account.
class SettingsScreen extends StatefulWidget {
  final TwilioService twilioService;
  final SubscriptionService subscriptionService;

  const SettingsScreen({
    super.key,
    required this.twilioService,
    required this.subscriptionService,
  });

  @override
  State<SettingsScreen> createState() => SettingsScreenState();
}

class SettingsScreenState extends State<SettingsScreen> {
  List<IncomingPhoneNumbers> _numbers = [];
  String? _incomingAppSid;
  bool _isLoading = true;
  String? _error;
  String? _selectedNumber;
  bool _isSwitching = false;
  Set<String> _pendingConfigureSids = {};
  bool _vacationMode = false;
  bool _isTogglingVacationMode = false;
  /// When false (the default), Settings shows a single dropdown that sets one
  /// number for both incoming and outgoing. When true, the incoming/outgoing
  /// split is shown instead. Account-level, stored in RTDB and read/written via
  /// TwilioService.get/setAdvancedNumberConfig (not per-device).
  bool _advanced = false;
  /// Whether [_loadAdvanced] has resolved. The toggle stays disabled until it
  /// has, so a user can't flip it before the initial RTDB load completes — that
  /// still-in-flight load would otherwise land afterwards and overwrite the
  /// just-set value with the stale pre-toggle one.
  bool _advancedLoaded = false;
  SubscriptionStatus? _subscriptionStatus;
  List<ProductDetails> _products = [];
  bool _isLoadingSubscription = true;
  String? _subscriptionError;
  bool _isPurchasing = false;

  List<String> get _phoneNumbers =>
      _numbers.map((number) => number.phone_number).toList();

  /// Sids of numbers currently pointed at this app's incoming TwiML App.
  Set<String> get _configuredSids => _numbers
      .where(
        (number) =>
            number.voice_application_sid != null &&
            number.voice_application_sid == _incomingAppSid,
      )
      .map((number) => number.sid)
      .toSet();

  @override
  void initState() {
    super.initState();
    _selectedNumber = widget.twilioService.currentPhoneNumber;
    _vacationMode = widget.twilioService.isVacationMode;
    _loadAdvanced();
    _loadData();
    _loadSubscription();
  }

  /// Loads the account-level advanced-config flag (RTDB, via TwilioService) into
  /// local UI state. Defaults to false until it resolves.
  Future<void> _loadAdvanced() async {
    final advanced = await widget.twilioService.getAdvancedNumberConfig();
    if (!mounted) return;
    setState(() {
      _advanced = advanced;
      _advancedLoaded = true;
    });
  }

  Future<void> _loadSubscription() async {
    setState(() {
      _isLoadingSubscription = true;
      _subscriptionError = null;
    });
    try {
      // Kick all off before awaiting so they run concurrently. The trial side
      // is read from RTDB (fetchStatus); the paid side is re-verified against
      // the store (refreshPaidStatus) so it self-heals after a renewal. A paid
      // refresh failure (offline, no entitlement) must not fail the whole
      // screen, so it degrades to null and we fall back to the trial record.
      final trialFuture = widget.subscriptionService.fetchStatus();
      final paidFuture = widget.subscriptionService
          .refreshPaidStatus()
          .catchError((_) => null as SubscriptionStatus?);
      final productsFuture = widget.subscriptionService.loadProducts();
      final trial = await trialFuture;
      final paid = await paidFuture;
      final products = await productsFuture;
      if (!mounted) return;
      setState(() {
        _subscriptionStatus = _effectiveStatus(trial, paid);
        _products = products;
        _isLoadingSubscription = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _subscriptionError = AppLocalizations.of(context)!
            .couldNotLoadSubscription(describeTwilioError(e));
        _isLoadingSubscription = false;
      });
    }
  }

  /// Combines the two subscription axes for display: a live paid subscription
  /// wins (show the plan + renewal date); otherwise a still-live trial covers
  /// the user; otherwise show whichever lapsed record they actually have (a
  /// paid record → "subscription expired", else the trial → "trial expired").
  SubscriptionStatus _effectiveStatus(
    SubscriptionStatus trial,
    SubscriptionStatus? paid,
  ) {
    if (paid != null && paid.isActive) return paid;
    if (trial.isActive) return trial;
    return paid ?? trial;
  }

  /// Looks up [productId] among the store-loaded products and starts a
  /// purchase for it. Shows an error instead of purchasing if the store
  /// hasn't returned that product yet (e.g. still loading, or misconfigured).
  Future<void> _purchase(String productId, String fallbackLabel) async {
    if (_isPurchasing) return;
    final available = _products.any((p) => p.id == productId);
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
      setState(() {
        _subscriptionStatus = status;
        _isPurchasing = false;
      });
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
      if (recovered != null && recovered.plan == expectedPlan) {
        setState(() {
          _subscriptionStatus = recovered;
          _isPurchasing = false;
        });
        return;
      }
      setState(() => _isPurchasing = false);
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

  /// The store's localized price for [productId] with a "/month" or "/year"
  /// suffix, or [fallback] while the store hasn't returned it yet. Price and
  /// currency vary by region/store, so this never falls back to a hardcoded
  /// amount — only to a plan name.
  String _priceLabel(String productId, String fallback) {
    final matches = _products.where((p) => p.id == productId);
    if (matches.isEmpty) return fallback;
    final suffix = productId == SubscriptionService.yearlyProductId
        ? AppLocalizations.of(context)!.perYearSuffix
        : AppLocalizations.of(context)!.perMonthSuffix;
    return '${matches.first.price}$suffix';
  }

  /// Flips this device's vacation mode. Purely local/per-device — see
  /// TwilioService.setVacationMode — so it never touches which numbers ring
  /// the app for other clients sharing the same Twilio account.
  Future<void> _setVacationMode(bool vacationMode) async {
    if (vacationMode == _vacationMode || _isTogglingVacationMode) return;
    setState(() => _isTogglingVacationMode = true);
    try {
      await widget.twilioService.setVacationMode(vacationMode);
      if (!mounted) return;
      setState(() {
        _vacationMode = vacationMode;
        _isTogglingVacationMode = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isTogglingVacationMode = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!.failedToUpdateMode(e.toString()),
          ),
        ),
      );
    }
  }

  Future<void> _loadData() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      // Kick both off before awaiting so they run concurrently.
      final numbersFuture = widget.twilioService.getIncomingNumbers();
      final appSidFuture = widget.twilioService.getCachedIncomingAppSid();
      // Settings can open before the app's startup caller-id lookup finishes;
      // wait for it so _selectedNumber below reflects the resolved default
      // (falls back to the first number) instead of a still-blank value.
      await widget.twilioService.ensureCurrentPhoneNumberResolved();
      final numbers = await numbersFuture;
      final appSid = await appSidFuture;
      if (!mounted) return;
      setState(() {
        _numbers = numbers;
        _incomingAppSid = appSid;
        _selectedNumber = widget.twilioService.currentPhoneNumber;
        _isLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error =
            AppLocalizations.of(context)!.couldNotLoadPhoneNumbers(e.toString());
        _isLoading = false;
      });
    }
  }

  /// Toggles whether [number] rings this app, applying the change server-side
  /// (which snapshots/restores that number's webhook config) and updating the
  /// local checkbox state on success.
  Future<void> _toggleConfigured(
    IncomingPhoneNumbers number,
    bool configure,
  ) async {
    if (_pendingConfigureSids.contains(number.sid) || _incomingAppSid == null)
      return;

    final desired = _configuredSids;
    if (configure) {
      desired.add(number.sid);
    } else {
      desired.remove(number.sid);
    }

    setState(
      () => _pendingConfigureSids = {..._pendingConfigureSids, number.sid},
    );
    try {
      await widget.twilioService.configureNumbers(desired.toList());
      if (!mounted) return;
      setState(() {
        _numbers = _numbers
            .map(
              (n) => n.sid == number.sid
                  ? IncomingPhoneNumbers(
                      n.capabilities,
                      n.phone_number,
                      n.status,
                      n.sid,
                      configure ? _incomingAppSid : '',
                    )
                  : n,
            )
            .toList();
        _pendingConfigureSids = {..._pendingConfigureSids}..remove(number.sid);
      });
    } catch (e) {
      if (!mounted) return;
      setState(
        () =>
            _pendingConfigureSids = {..._pendingConfigureSids}
              ..remove(number.sid),
      );
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!
                .failedToUpdateNumberConfig(e.toString()),
          ),
        ),
      );
    }
  }

  Future<void> _selectNumber(String number) async {
    if (number == _selectedNumber || _isSwitching) return;
    setState(() => _isSwitching = true);
    try {
      await widget.twilioService.setCurrentPhoneNumber(number);
      if (!mounted) return;
      setState(() {
        _selectedNumber = number;
        _isSwitching = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isSwitching = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!.failedToSwitchNumber(e.toString()),
          ),
        ),
      );
    }
  }

  /// Returns [_numbers] with each entry's voice_application_sid rewritten so
  /// exactly [configuredSids] point at this app's incoming TwiML App — mirrors
  /// server-side state after a configureNumbers call, so [_configuredSids]
  /// (and the advanced view) stay in sync without a refetch.
  List<IncomingPhoneNumbers> _withConfiguredSids(Set<String> configuredSids) {
    return _numbers
        .map(
          (n) => IncomingPhoneNumbers(
            n.capabilities,
            n.phone_number,
            n.status,
            n.sid,
            configuredSids.contains(n.sid) ? _incomingAppSid : '',
          ),
        )
        .toList();
  }

  /// Simple-mode selection: makes [number] the single number used for both
  /// directions. Sets it as the outgoing caller id AND configures it (only it)
  /// for incoming — configureNumbers reverts every other number to its
  /// pre-app snapshot, so simple mode always means exactly one active number.
  Future<void> _selectSimpleNumber(String number) async {
    if (_isSwitching) return;
    final match = _numbers.where((n) => n.phone_number == number);
    if (match.isEmpty) return;
    final sid = match.first.sid;
    // Nothing to do if it's already the sole configured number and current.
    if (number == _selectedNumber &&
        _configuredSids.length == 1 &&
        _configuredSids.contains(sid)) {
      return;
    }
    await _applySingleNumber(number, sid, setOutgoing: true);
  }

  /// Shared body of the simple-mode single-number apply: marks switching,
  /// optionally re-points the outgoing caller id, configures [sid] as the sole
  /// incoming number, and syncs local state — with the common error snackbar.
  /// Callers ([_selectSimpleNumber], [_applySimpleConfig]) run their own
  /// guard/match first and skip the no-op case.
  Future<void> _applySingleNumber(
    String number,
    String sid, {
    required bool setOutgoing,
  }) async {
    setState(() => _isSwitching = true);
    try {
      if (setOutgoing) await widget.twilioService.setCurrentPhoneNumber(number);
      await widget.twilioService.configureNumbers([sid]);
      if (!mounted) return;
      setState(() {
        _selectedNumber = number;
        _numbers = _withConfiguredSids({sid});
        _isSwitching = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isSwitching = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!.failedToSwitchNumber(e.toString()),
          ),
        ),
      );
    }
  }

  /// Persists the advanced toggle. Turning it OFF re-enforces the single-number
  /// rule: the currently selected number is configured for incoming and every
  /// other number is reverted to its snapshot (see [_selectSimpleNumber]).
  Future<void> _setAdvanced(bool advanced) async {
    setState(() => _advanced = advanced);
    await widget.twilioService.setAdvancedNumberConfig(advanced);
    if (!advanced) await _applySimpleConfig();
  }

  /// Configures the selected number (only it) for incoming, reverting all
  /// others — used when leaving advanced mode so basic mode's guarantee holds.
  /// A no-op if it's already the sole configured number.
  Future<void> _applySimpleConfig() async {
    final selected = _selectedNumber;
    if (selected == null || _isSwitching) return;
    final match = _numbers.where((n) => n.phone_number == selected);
    if (match.isEmpty) return;
    final sid = match.first.sid;
    if (_configuredSids.length == 1 && _configuredSids.contains(sid)) return;
    // Outgoing already points at [selected]; only incoming needs re-pointing.
    await _applySingleNumber(selected, sid, setOutgoing: false);
  }

  /// Confirms, clears credentials, and returns to the auth screen. Public so
  /// the home screen's app-bar logout action (shown only on the Settings tab)
  /// can drive it via this screen's GlobalKey.
  Future<void> logout() async {
    final l10n = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.logOut),
        content: Text(l10n.logOutConfirmMessage),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(l10n.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(l10n.logOut),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    final storageService = Provider.of<StorageService>(context, listen: false);
    await storageService.clearCredentials();
    // Drop the anonymous Firebase identity so its account claim can't be reused
    // by whoever logs in next on this device.
    await AccountAuthService.instance.signOut();

    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const AuthScreen()),
      (route) => false,
    );
  }

  /// Section header used above both number lists: an icon, a bold title, and
  /// a muted explanation of exactly what the section controls.
  Widget _buildSectionHeader({
    required IconData icon,
    required String title,
    String? subtitle,
  }) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: const TextStyle(color: Colors.grey, fontSize: 13),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The "License" section: trial countdown / renewal date / expired notice,
  /// plus purchase buttons on platforms that support in-app purchase.
  List<Widget> _buildLicenseSection() {
    final l10n = AppLocalizations.of(context)!;
    final status = _subscriptionStatus;
    // Name the active paid plan in the header subtitle; a trial or lapsed
    // subscription has no plan to show, so the header stays title-only.
    final planSubtitle = (status != null && status.isActive && !status.isTrial)
        ? (status.plan == 'yearly'
              ? l10n.licensePlanYearly
              : l10n.licensePlanMonthly)
        : null;
    return [
      _buildSectionHeader(
        icon: Icons.workspace_premium,
        title: l10n.licenseTitle,
        subtitle: planSubtitle,
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: _isLoadingSubscription
            ? const Padding(
                padding: EdgeInsets.all(8),
                child: Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            : _subscriptionError != null
            ? Text(
                _subscriptionError!,
                style: const TextStyle(color: Colors.red),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildSubscriptionStatusText(_subscriptionStatus!),
                  if (!_subscriptionStatus!.isActive ||
                      _subscriptionStatus!.isTrial ||
                      !_subscriptionStatus!.autoRenew) ...[
                    const SizedBox(height: 12),
                    if (widget.subscriptionService.isSupported)
                      _buildPurchaseButtons()
                    else
                      Text(
                        l10n.purchasingUnavailable,
                        style: const TextStyle(color: Colors.grey),
                      ),
                  ],
                ],
              ),
      ),
    ];
  }

  Widget _buildSubscriptionStatusText(SubscriptionStatus status) {
    final l10n = AppLocalizations.of(context)!;
    if (!status.isActive) {
      return Text(
        status.isTrial ? l10n.trialExpired : l10n.subscriptionExpired,
        style: TextStyle(
          color: Theme.of(context).colorScheme.error,
          fontWeight: FontWeight.bold,
        ),
      );
    }
    if (status.isTrial) {
      return Text(l10n.trialDaysLeft(status.daysRemaining));
    }
    final formattedDate = DateFormat.yMMMd().format(status.expiresAt);
    return Text(
      status.autoRenew
          ? l10n.renewsOn(formattedDate)
          : l10n.expiresOnAutoRenewOff(formattedDate),
    );
  }

  Widget _buildPurchaseButtons() {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
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

  /// Asks the store to re-deliver past purchases, then re-verifies the
  /// recovered entitlement. Shows the recovered subscription on success, or a
  /// "nothing to restore" notice if the store had no active purchase.
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
      setState(() {
        if (recovered != null) _subscriptionStatus = recovered;
        _isPurchasing = false;
      });
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

  /// Simplified number config: one dropdown that sets a single number for both
  /// incoming and outgoing (see [_selectSimpleNumber]).
  List<Widget> _buildSimpleNumberConfig(AppLocalizations l10n) {
    return [
      _buildSectionHeader(
        icon: Icons.phone,
        title: l10n.phoneNumberTitle,
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
            child: Row(
              children: [
                Expanded(
                  child: DropdownButtonHideUnderline(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: _phoneNumbers.contains(_selectedNumber)
                          ? _selectedNumber
                          : null,
                      hint: Text(l10n.selectNumber),
                      items: _phoneNumbers
                          .map(
                            (number) => DropdownMenuItem<String>(
                              value: number,
                              child: Text(number),
                            ),
                          )
                          .toList(),
                      onChanged: _isSwitching
                          ? null
                          : (value) {
                              if (value != null) _selectSimpleNumber(value);
                            },
                    ),
                  ),
                ),
                if (_isSwitching) ...[
                  const SizedBox(width: 12),
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    ];
  }

  /// Advanced number config: the incoming/outgoing split — an outgoing caller
  /// id picker plus per-number "rings this app" checkboxes.
  List<Widget> _buildAdvancedNumberConfig(AppLocalizations l10n) {
    return [
      _buildSectionHeader(
        icon: Icons.call_made,
        title: l10n.outgoingTitle,
        subtitle: l10n.outgoingSubtitle,
      ),
      Card(
        margin: const EdgeInsets.symmetric(horizontal: 16),
        child: Column(
          children: _phoneNumbers
              .map(
                (number) => RadioListTile<String>(
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(number),
                  value: number,
                  groupValue: _selectedNumber,
                  onChanged: _isSwitching
                      ? null
                      : (value) => _selectNumber(value!),
                ),
              )
              .toList(),
        ),
      ),
      const SizedBox(height: 24),
      _buildSectionHeader(
        icon: Icons.call_received,
        title: l10n.incomingTitle,
        subtitle: l10n.incomingSubtitle,
      ),
      Card(
        margin: const EdgeInsets.symmetric(horizontal: 16),
        child: Column(
          children: _numbers.map((number) {
            final isConfigured = _configuredSids.contains(number.sid);
            final isPending = _pendingConfigureSids.contains(number.sid);
            return CheckboxListTile(
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(number.phone_number),
              value: isConfigured,
              onChanged: isPending
                  ? null
                  : (value) => _toggleConfigured(number, value ?? false),
              secondary: isPending
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : null,
            );
          }).toList(),
        ),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    // Device-wide clock-format preference (24-hour vs AM/PM); watched so the
    // segmented button reflects and drives StorageService.getUse24hTime.
    final use24h = context.watch<StorageService>().getUse24hTime();
    return RefreshIndicator(
      onRefresh: () => Future.wait([_loadData(), _loadSubscription()]),
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 10),
        children: [
          ..._buildLicenseSection(),
          const Divider(height: 32),
          _buildSectionHeader(
            icon: Icons.schedule,
            title: l10n.timeFormatTitle,
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: SegmentedButton<bool>(
              // Match the vacation-mode toggle: the segment icons already
              // distinguish the selection, so drop the redundant checkmark.
              showSelectedIcon: false,
              segments: [
                ButtonSegment(
                  value: true,
                  label: Text(l10n.timeFormat24h),
                  icon: const Icon(Icons.schedule),
                ),
                ButtonSegment(
                  value: false,
                  label: Text(l10n.timeFormat12h),
                  icon: const Icon(Icons.access_time),
                ),
              ],
              selected: {use24h},
              onSelectionChanged: (selection) =>
                  Provider.of<StorageService>(context, listen: false)
                      .setUse24hTime(selection.first),
            ),
          ),
          const Divider(height: 32),
          _buildSectionHeader(
            icon: _vacationMode
                ? Icons.beach_access
                : Icons.notifications_active,
            title: l10n.modeTitle,
            subtitle: _vacationMode
                ? l10n.modeSubtitleVacation
                : l10n.modeSubtitleOnline,
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: _isTogglingVacationMode
                ? const Padding(
                    padding: EdgeInsets.all(8),
                    child: Center(
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  )
                : SegmentedButton<bool>(
                    // The default selected checkmark animates in over the
                    // segment's icon and clips it mid-transition — cropping
                    // the bell clapper on Icons.notifications_active. The
                    // custom icons already distinguish the selected segment,
                    // so the checkmark is redundant; turning it off removes
                    // that clipping animation entirely.
                    showSelectedIcon: false,
                    segments: [
                      ButtonSegment(
                        value: false,
                        label: Text(l10n.onlineMode),
                        icon: const Icon(Icons.notifications_active),
                      ),
                      ButtonSegment(
                        value: true,
                        label: Text(l10n.vacationMode),
                        icon: const Icon(Icons.beach_access),
                      ),
                    ],
                    selected: {_vacationMode},
                    onSelectionChanged: (selection) =>
                        _setVacationMode(selection.first),
                  ),
          ),
          const Divider(height: 32),
          if (_isLoading)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Text(_error!, style: const TextStyle(color: Colors.red)),
            )
          else if (_phoneNumbers.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Text(l10n.noPhoneNumbersFound),
            )
          else if (_advanced)
            ..._buildAdvancedNumberConfig(l10n)
          else
            ..._buildSimpleNumberConfig(l10n),
          // Only offer the advanced split when there are numbers to configure;
          // with none, both modes collapse to the same "no numbers" message.
          if (_phoneNumbers.isNotEmpty) ...[
            const SizedBox(height: 16),
            SwitchListTile(
              secondary: const Icon(Icons.tune),
              title: Text(l10n.advancedTitle),
              value: _advanced,
              // Disabled mid-switch so a config apply can't race a toggle, and
              // until the initial load resolves so a toggle can't precede (and
              // then be clobbered by) that still-in-flight RTDB read.
              onChanged: (_isSwitching || !_advancedLoaded) ? null : _setAdvanced,
            ),
          ],
        ],
      ),
    );
  }
}
