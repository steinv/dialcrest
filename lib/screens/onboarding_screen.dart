import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../dto/IncomingPhoneNumbers.dart';
import '../l10n/generated/app_localizations.dart';
import '../services/storage_service.dart';
import '../services/twilio_service.dart';

/// First-run setup wizard, shown once per account on this device to a brand-new
/// user (see StorageService.getOnboardingCompleted / HomeScreen). It front-loads
/// the OS permissions the app otherwise requests lazily — explaining why each is
/// needed and, crucially, what the user must do — and then picks/wires the Twilio
/// number so the user can actually receive calls when they finish.
///
/// Skippable at any time via the top-right button; skipping is permanent (it
/// marks onboarding complete) so the wizard never nags. Reuses the existing
/// [TwilioService] instance owned by HomeScreen rather than creating its own.
class OnboardingScreen extends StatefulWidget {
  final TwilioService twilioService;

  const OnboardingScreen({super.key, required this.twilioService});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen>
    with WidgetsBindingObserver {
  static const int _stepWelcome = 0;
  static const int _stepPermissions = 1;
  static const int _stepNumber = 2;
  static const int _stepDone = 3;
  static const int _stepCount = 4;

  int _currentStep = _stepWelcome;

  // Live permission statuses. null = not requested / unknown yet. Contacts is
  // deliberately excluded — it can't be queried without prompting, so it shows
  // guidance only, with no granted/denied chip.
  bool? _micGranted;
  bool? _notificationsGranted;
  bool? _callingAccountEnabled; // Android only.

  // Phone-number step state.
  bool _numbersLoading = false;
  String? _numbersError;
  List<IncomingPhoneNumbers>? _numbers;
  String? _selectedNumber;
  bool _configuring = false;

  bool get _isAndroid => Platform.isAndroid;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refreshStatuses();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The Android calling-account toggle and "grant after denial in system
    // settings" both happen outside the app, so re-check whenever we return.
    if (state == AppLifecycleState.resumed) _refreshStatuses();
  }

  /// Re-reads the permissions we can query without prompting, so the status
  /// chips reflect reality (including changes made in system settings).
  Future<void> _refreshStatuses() async {
    // Any of these native permission queries can throw on a platform without
    // the plugin (e.g. desktop); fall back to the previous value rather than
    // letting an unhandled async error escape.
    final mic = await _safe(widget.twilioService.hasMicrophonePermission, _micGranted);
    final notifications = await _readNotificationStatus();
    final callingAccount = _isAndroid
        ? await _safe(widget.twilioService.isCallingAccountEnabled, _callingAccountEnabled)
        : null;
    if (!mounted) return;
    setState(() {
      _micGranted = mic;
      _notificationsGranted = notifications;
      _callingAccountEnabled = callingAccount;
    });
  }

  /// Runs [query], returning [fallback] if it throws (e.g. plugin unavailable).
  Future<bool?> _safe(Future<bool> Function() query, bool? fallback) async {
    try {
      return await query();
    } catch (_) {
      return fallback;
    }
  }

  Future<bool> _readNotificationStatus() async {
    try {
      final settings = await FirebaseMessaging.instance.getNotificationSettings();
      final status = settings.authorizationStatus;
      return status == AuthorizationStatus.authorized ||
          status == AuthorizationStatus.provisional;
    } catch (_) {
      return false;
    }
  }

  Future<void> _grantMic() async {
    final granted = await _safe(
      widget.twilioService.requestMicrophonePermission,
      _micGranted,
    );
    if (!mounted) return;
    setState(() => _micGranted = granted);
  }

  Future<void> _grantNotifications() async {
    // Goes through TwilioService so the push token is (re)registered right after
    // the user allows notifications, not just on the next launch.
    final granted = await _safe(
      widget.twilioService.requestNotificationPermission,
      _notificationsGranted,
    );
    if (!mounted) return;
    setState(() => _notificationsGranted = granted);
  }

  Future<void> _openCallingAccount() async {
    // Returns true only if already enabled; the usual path opens system settings
    // and the resumed-lifecycle re-check flips the chip once the user returns.
    final enabled = await _safe(
      widget.twilioService.ensureCallingAccountEnabled,
      _callingAccountEnabled,
    );
    if (!mounted) return;
    setState(() => _callingAccountEnabled = enabled);
  }

  Future<void> _loadNumbers() async {
    setState(() {
      _numbersLoading = true;
      _numbersError = null;
    });
    try {
      // Wait for the startup caller-id resolution so the default selection
      // matches what the rest of the app already resolved to.
      await widget.twilioService.ensureCurrentPhoneNumberResolved();
      final numbers = await widget.twilioService.getIncomingNumbers();
      if (!mounted) return;
      final current = widget.twilioService.currentPhoneNumber;
      final available = numbers.map((n) => n.phone_number).toList();
      setState(() {
        _numbers = numbers;
        _selectedNumber = (current != null && available.contains(current))
            ? current
            : (available.isNotEmpty ? available.first : null);
        _numbersLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _numbersError = describeTwilioError(e);
        _numbersLoading = false;
      });
    }
  }

  /// Wires the chosen number to ring this app for incoming calls — the same
  /// finish-line the rest of the app uses — then seeds the auto-config flag so
  /// TwilioService's silent onboarding doesn't redo the work. Returns whether it
  /// succeeded (false leaves the user on the number step with an error).
  Future<bool> _applyNumberSelection() async {
    final numbers = _numbers;
    final selected = _selectedNumber;
    if (numbers == null || numbers.isEmpty || selected == null) {
      return true; // Nothing to configure; allow finishing anyway.
    }
    final match = numbers.where((n) => n.phone_number == selected);
    if (match.isEmpty) return true;

    final storage = context.read<StorageService>();
    setState(() => _configuring = true);
    try {
      await widget.twilioService.setCurrentPhoneNumber(selected);
      await widget.twilioService.configureNumbers([match.first.sid]);
      await storage.setIncomingAutoConfigured(
        widget.twilioService.accountSid,
        true,
      );
      if (!mounted) return true;
      setState(() => _configuring = false);
      return true;
    } catch (e) {
      if (!mounted) return false;
      setState(() => _configuring = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!
                .onboardingNumberSetupFailed(describeTwilioError(e)),
          ),
        ),
      );
      return false;
    }
  }

  Future<void> _complete() async {
    final storage = context.read<StorageService>();
    await storage.setOnboardingCompleted(widget.twilioService.accountSid, true);
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  Future<void> _goNext() async {
    switch (_currentStep) {
      case _stepWelcome:
        setState(() => _currentStep = _stepPermissions);
        break;
      case _stepPermissions:
        setState(() => _currentStep = _stepNumber);
        if (_numbers == null && !_numbersLoading) _loadNumbers();
        break;
      case _stepNumber:
        final ok = await _applyNumberSelection();
        if (!ok || !mounted) break;
        // Refresh so the summary reflects what the user actually granted
        // (e.g. after returning from the calling-account settings screen).
        await _refreshStatuses();
        if (mounted) setState(() => _currentStep = _stepDone);
        break;
      case _stepDone:
        await _complete();
        break;
    }
  }

  void _goBack() {
    if (_currentStep == _stepWelcome) return;
    setState(() => _currentStep = _currentStep - 1);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.onboardingStepLabel(_currentStep + 1, _stepCount)),
        actions: [
          if (_currentStep != _stepDone)
            TextButton(
              onPressed: _configuring ? null : _complete,
              child: Text(l10n.onboardingSkip),
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            LinearProgressIndicator(value: (_currentStep + 1) / _stepCount),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: _buildStep(l10n),
              ),
            ),
            _buildNavBar(l10n),
          ],
        ),
      ),
    );
  }

  Widget _buildStep(AppLocalizations l10n) {
    switch (_currentStep) {
      case _stepWelcome:
        return _buildWelcome(l10n);
      case _stepPermissions:
        return _buildPermissions(l10n);
      case _stepNumber:
        return _buildNumber(l10n);
      case _stepDone:
        return _buildDone(l10n);
      default:
        return const SizedBox.shrink();
    }
  }

  Widget _buildNavBar(AppLocalizations l10n) {
    final isLast = _currentStep == _stepDone;
    final busy = _configuring || (_currentStep == _stepNumber && _numbersLoading);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Row(
        children: [
          if (_currentStep != _stepWelcome)
            TextButton(
              onPressed: busy ? null : _goBack,
              child: Text(l10n.onboardingBack),
            ),
          const Spacer(),
          FilledButton(
            onPressed: busy ? null : _goNext,
            child: busy
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(isLast ? l10n.onboardingFinish : l10n.onboardingNext),
          ),
        ],
      ),
    );
  }

  Widget _buildWelcome(AppLocalizations l10n) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 24),
        Center(
          child: Icon(
            Icons.waving_hand,
            size: 72,
            color: Theme.of(context).colorScheme.primary,
          ),
        ),
        const SizedBox(height: 24),
        Text(
          l10n.onboardingWelcomeTitle,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 12),
        Text(
          l10n.onboardingWelcomeBody,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
      ],
    );
  }

  Widget _buildPermissions(AppLocalizations l10n) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l10n.onboardingPermissionsTitle,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          l10n.onboardingPermissionsSubtitle,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 16),
        _buildPermissionCard(
          icon: Icons.mic,
          title: l10n.onboardingMicTitle,
          why: l10n.onboardingMicWhy,
          granted: _micGranted,
          guidance: Text(l10n.onboardingMicHow),
          deniedText: l10n.onboardingMicDenied,
          actionLabel: l10n.onboardingGrant,
          onAction: _grantMic,
        ),
        _buildPermissionCard(
          icon: Icons.notifications_active,
          title: l10n.onboardingNotificationsTitle,
          why: l10n.onboardingNotificationsWhy,
          granted: _notificationsGranted,
          guidance: Text(l10n.onboardingNotificationsHow),
          deniedText: l10n.onboardingNotificationsDenied,
          actionLabel: l10n.onboardingGrant,
          onAction: _grantNotifications,
        ),
        // Android forces a manual "Calling accounts" toggle the app can't flip
        // itself — the one step the user must do by hand, so it gets a full
        // numbered walkthrough. Hidden on iOS, which has no such concept.
        if (_isAndroid)
          _buildPermissionCard(
            icon: Icons.phone_in_talk,
            title: l10n.onboardingCallingAccountTitle,
            why: l10n.onboardingCallingAccountWhy,
            granted: _callingAccountEnabled,
            guidance: _buildNumberedSteps([
              l10n.onboardingCallingAccountStep1,
              l10n.onboardingCallingAccountStep2,
              l10n.onboardingCallingAccountStep3,
              l10n.onboardingCallingAccountStep4,
            ]),
            deniedText: l10n.onboardingCallingAccountDenied,
            actionLabel: l10n.onboardingOpenSettings,
            onAction: _openCallingAccount,
          ),
      ],
    );
  }

  Widget _buildNumberedSteps(List<String> steps) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < steps.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${i + 1}.',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(steps[i])),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildPermissionCard({
    required IconData icon,
    required String title,
    required String why,
    required bool? granted,
    required Widget guidance,
    required String deniedText,
    required String actionLabel,
    required VoidCallback onAction,
  }) {
    final l10n = AppLocalizations.of(context)!;
    final isGranted = granted == true;
    final isDenied = granted == false;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 16,
                    ),
                  ),
                ),
                if (isGranted)
                  Row(
                    children: [
                      const Icon(Icons.check_circle,
                          color: Colors.green, size: 20),
                      const SizedBox(width: 4),
                      Text(
                        l10n.onboardingGranted,
                        style: const TextStyle(color: Colors.green),
                      ),
                    ],
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Text(why),
            if (!isGranted) ...[
              const SizedBox(height: 8),
              // Before any attempt, show what to do; after a denial, show how to
              // recover from system settings.
              isDenied
                  ? Text(
                      deniedText,
                      style: TextStyle(color: Theme.of(context).colorScheme.error),
                    )
                  : guidance,
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton(
                  onPressed: onAction,
                  child: Text(actionLabel),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildNumber(AppLocalizations l10n) {
    if (_numbersLoading) {
      return const Padding(
        padding: EdgeInsets.all(48),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_numbersError != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.onboardingNumberTitle,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 12),
          Text(
            l10n.couldNotLoadPhoneNumbers(_numbersError!),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: _loadNumbers,
            child: Text(l10n.retry),
          ),
        ],
      );
    }

    final numbers = _numbers ?? [];
    final available = numbers.map((n) => n.phone_number).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l10n.onboardingNumberTitle,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 12),
        if (available.isEmpty) ...[
          Text(l10n.onboardingNumberNone),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            icon: const Icon(Icons.open_in_new),
            onPressed: () => launchUrl(
              Uri.parse('https://console.twilio.com/'),
              mode: LaunchMode.externalApplication,
            ),
            label: Text(l10n.onboardingBuyNumber),
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: _loadNumbers,
            child: Text(l10n.retry),
          ),
        ] else if (available.length == 1) ...[
          Row(
            children: [
              const Icon(Icons.check_circle_outline, color: Colors.green),
              const SizedBox(width: 8),
              Expanded(
                child: Text(l10n.onboardingNumberSingleInfo(available.first)),
              ),
            ],
          ),
        ] else ...[
          Text(l10n.onboardingNumberChooseSubtitle),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  isExpanded: true,
                  value: available.contains(_selectedNumber)
                      ? _selectedNumber
                      : null,
                  hint: Text(l10n.selectNumber),
                  items: available
                      .map(
                        (number) => DropdownMenuItem<String>(
                          value: number,
                          child: Text(number),
                        ),
                      )
                      .toList(),
                  onChanged: _configuring
                      ? null
                      : (value) => setState(() => _selectedNumber = value),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildDone(AppLocalizations l10n) {
    final hasNumber = (_numbers?.isNotEmpty ?? false) && _selectedNumber != null;

    // What still stands between the user and actually making/receiving calls.
    // A null status counts as outstanding — we only claim success on a
    // confirmed grant. The calling account is Android-only.
    final outstanding = <String>[
      if (_micGranted != true) l10n.onboardingMicTitle,
      if (_notificationsGranted != true) l10n.onboardingNotificationsTitle,
      if (_isAndroid && _callingAccountEnabled != true)
        l10n.onboardingCallingAccountTitle,
      if (!hasNumber) l10n.onboardingNumberTitle,
    ];
    final allSet = outstanding.isEmpty;

    if (allSet) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 24),
          Center(
            child: Icon(
              Icons.check_circle,
              size: 72,
              color: Theme.of(context).colorScheme.primary,
            ),
          ),
          const SizedBox(height: 24),
          Text(
            l10n.onboardingDoneTitle,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 12),
          Text(
            l10n.onboardingDoneBody(_selectedNumber!),
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 24),
        Center(
          child: Icon(
            Icons.warning_amber_rounded,
            size: 72,
            color: Theme.of(context).colorScheme.tertiary,
          ),
        ),
        const SizedBox(height: 24),
        Text(
          l10n.onboardingDoneTitleIncomplete,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 12),
        Text(
          l10n.onboardingDoneIncompleteIntro,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        const SizedBox(height: 12),
        for (final item in outstanding)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.radio_button_unchecked,
                  size: 18,
                  color: Theme.of(context).colorScheme.tertiary,
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(item)),
              ],
            ),
          ),
        const SizedBox(height: 12),
        Text(
          l10n.onboardingDoneIncompleteHint,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ],
    );
  }
}
