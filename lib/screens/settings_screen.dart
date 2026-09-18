import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../dto/IncomingPhoneNumbers.dart';
import '../l10n/generated/app_localizations.dart';
import '../models/subscription_status.dart';
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
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  List<IncomingPhoneNumbers> _numbers = [];
  String? _incomingAppSid;
  bool _isLoading = true;
  String? _error;
  String? _selectedNumber;
  bool _isSwitching = false;
  Set<String> _pendingConfigureSids = {};
  bool _vacationMode = false;
  bool _isTogglingVacationMode = false;
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
    _loadData();
    _loadSubscription();
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
      final appSidFuture = widget.twilioService.getIncomingAppSid();
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

  Future<void> _logout() async {
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

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return RefreshIndicator(
      onRefresh: () => Future.wait([_loadData(), _loadSubscription()]),
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 10),
        children: [
          ..._buildLicenseSection(),
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
          const SizedBox(height: 24),
          _buildSectionHeader(
            icon: Icons.call_made,
            title: l10n.outgoingTitle,
            subtitle: l10n.outgoingSubtitle,
          ),
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
          else ...[
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
          ],
          const Divider(height: 32),
          ListTile(
            leading: const Icon(Icons.logout, color: Colors.red),
            title: Text(l10n.logOut, style: const TextStyle(color: Colors.red)),
            onTap: _logout,
          ),
        ],
      ),
    );
  }
}
