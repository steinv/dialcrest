import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:twilio_voice/twilio_voice.dart';
import '../l10n/generated/app_localizations.dart';
import '../models/call.dart';
import '../services/account_auth_service.dart';
import '../services/storage_service.dart';
import '../services/twilio_service.dart';
import '../services/subscription_service.dart';
import '../services/contacts_service.dart';
import '../widgets/dialer.dart';
import '../widgets/notification_overlay.dart';
import 'call_history_screen.dart';
import 'messages_screen.dart';
import 'settings_screen.dart';
import '../models/message.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  _HomeScreenState createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  int _selectedIndex = 0;
  late TwilioService _twilioService;
  late SubscriptionService _subscriptionService;
  bool _showNotification = false;
  String _notificationTitle = '';
  String _notificationBody = '';
  bool _isCallNotification = false;
  Function? _notificationAction;
  String? _selectedContact;

  /// True from the moment an outgoing call is placed until it either connects
  /// (native call UI takes over) or fails/ends. Drives the dialer's spinner and
  /// blocks a second call from being started.
  bool _isConnecting = false;
  StreamSubscription<CallEvent>? _callEventsSub;
  Timer? _connectTimeout;

  /// The number of the call currently being connected, so a connect-failure
  /// event (which carries no number) can name it in the error message.
  String? _connectingNumber;

  /// Lets the app bar's refresh button drive the call-history screen's reload.
  final GlobalKey<CallHistoryScreenState> _callHistoryKey = GlobalKey();

  /// Lets the app bar's refresh button drive the messages screen's reload.
  final GlobalKey<MessagesScreenState> _messagesKey = GlobalKey();

  /// The account's phone numbers, for the app bar's quick outgoing-number
  /// switcher. Loaded once the Twilio service is up; empty until then, which
  /// just hides that button rather than showing an empty menu.
  List<String> _outgoingNumbers = [];

  /// Guards [_notifyIfContactsPermissionDenied] so it only fires once per app
  /// session, no matter how many times contacts get (re)loaded.
  bool _contactsDenialShown = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _callEventsSub = TwilioVoicePlatform.instance.callEventsListener.listen(
      _onCallEvent,
    );
    // Contacts (and the READ_CONTACTS prompt) are loaded lazily, from
    // wherever contact data is actually needed (dial-pad search, call
    // history, messages, "new conversation") — not here at startup. Just
    // listen for that first load finishing, to surface a denial notice.
    Provider.of<ContactsService>(context, listen: false).addListener(_onContactsChanged);
    _initializeTwilioService();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    Provider.of<ContactsService>(context, listen: false).removeListener(_onContactsChanged);
    _callEventsSub?.cancel();
    _connectTimeout?.cancel();
    _twilioService.dispose();
    _subscriptionService.dispose();
    super.dispose();
  }

  void _onContactsChanged() {
    final contactsService = Provider.of<ContactsService>(context, listen: false);
    if (contactsService.loaded && !contactsService.permissionGranted) {
      _notifyIfContactsPermissionDenied();
    }
  }

  /// Resolves the connecting state from Twilio call-state events. The spinner
  /// keeps running through `ringing`, and clears once the call goes active
  /// (`connected`/`reconnected`) or terminates (`callEnded`/`declined`/
  /// `missedCall`/`connectFailure`).
  void _onCallEvent(CallEvent event) {
    if (!_isConnecting) return;
    switch (event) {
      case CallEvent.connected:
      case CallEvent.reconnected:
        _clearConnecting();
        break;
      case CallEvent.callEnded:
      case CallEvent.declined:
      case CallEvent.missedCall:
        _clearConnecting();
        break;
      default:
        // Any event that arrives while still connecting but isn't one we treat
        // as terminal. Logged so an unexpected failure mode (e.g. a plugin
        // build that surfaces connect failures under a different event) is
        // visible instead of only manifesting as a spinner that hangs until
        // the safety timeout.
        debugPrint('Unhandled call event while connecting: $event');
        break;
    }
  }

  void _clearConnecting() {
    _connectTimeout?.cancel();
    _connectTimeout = null;
    _connectingNumber = null;
    if (mounted && _isConnecting) {
      setState(() => _isConnecting = false);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _twilioService.startPollingForIncomingCommunications();
      // Pick up contacts added/edited in the OS Contacts app while we were
      // away — but only if contacts were actually loaded already; otherwise
      // this would turn every resume into a surprise permission prompt for a
      // user who's never touched a contacts-dependent feature.
      final contactsService = Provider.of<ContactsService>(context, listen: false);
      if (contactsService.loaded) contactsService.load();
    } else if (state == AppLifecycleState.paused) {
      _twilioService.stopPollingForIncomingCommunications();
    }
  }

  /// ContactsService.load() requests contacts permission silently; if denied,
  /// contact names and the new-conversation picker just show nothing with no
  /// explanation. Surface that explicitly, once, the first time a
  /// contacts-dependent feature actually triggers a load.
  void _notifyIfContactsPermissionDenied() {
    if (!mounted || _contactsDenialShown) return;
    _contactsDenialShown = true;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(AppLocalizations.of(context)!.contactsPermissionDenied),
        duration: const Duration(seconds: 6),
      ),
    );
  }

  void _initializeTwilioService() {
    final storageService = Provider.of<StorageService>(context, listen: false);

    if (storageService.accountSid != null && storageService.authToken != null) {
      // Bind the anonymous Firebase identity to this account so account-scoped
      // RTDB reads/writes are authorized. Re-linking here (not just at first
      // startup) is what lets a user log out and into a different Twilio account.
      // Fire-and-forget: RTDB readers ensureLinked before their own access.
      // Best-effort like the startup link in main.dart — swallow errors so a
      // transient link failure (offline, functions error) doesn't escape as an
      // uncaught async error; the recovery path in _runLink only handles
      // FirebaseAuthException, not FirebaseFunctionsException.
      unawaited(
        AccountAuthService.instance
            .link(storageService.accountSid!, storageService.authToken!)
            .catchError(
              (Object e) => debugPrint('Skipping account link on init: $e'),
            ),
      );
      _subscriptionService = SubscriptionService(
        accountSid: storageService.accountSid!,
        storageService: storageService,
      );
      _twilioService = TwilioService(
        accountSid: storageService.accountSid!,
        authToken: storageService.authToken!,
        storageService: storageService,
        entitlementProvider: () => _subscriptionService.currentEntitlement,
        entitlementRecovery: _subscriptionService.recoverEntitlement,
      );

      // Set up callbacks for incoming communications
      _twilioService.onIncomingCall = (from) {
        _showIncomingCallNotification(from);
      };

      _twilioService.onIncomingMessage = (from, body) {
        _showIncomingMessageNotification(from, body);
      };

      // A notification was tapped (app was backgrounded/killed) — no banner
      // moment, just open the conversation directly.
      _twilioService.onOpenConversation = (from, body) {
        _handleIncomingMessage(from, body);
      };

      // Start polling for incoming communications
      _twilioService.startPollingForIncomingCommunications();
      _loadOutgoingNumbers();
    }
  }

  /// Loads the account's phone numbers for the app bar's quick outgoing-number
  /// switcher. Waits for the startup caller-id resolution first, so the menu's
  /// checkmark reflects the actually-resolved current number rather than a
  /// still-blank one.
  Future<void> _loadOutgoingNumbers() async {
    try {
      await _twilioService.ensureCurrentPhoneNumberResolved();
      final numbers = await _twilioService.getPhoneNumbers();
      if (!mounted) return;
      setState(() => _outgoingNumbers = numbers ?? []);
    } catch (e) {
      debugPrint('Error loading outgoing numbers for quick switcher: $e');
    }
  }

  /// Switches the outgoing caller-id number from the app bar's quick switcher.
  Future<void> _switchOutgoingNumber(String number) async {
    if (number == _twilioService.currentPhoneNumber) return;
    try {
      await _twilioService.switchOutgoingNumber(number);
      if (!mounted) return;
      setState(() {});
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!.failedToSwitchNumber(e.toString()),
          ),
        ),
      );
    }
  }

  void _showIncomingCallNotification(String from) {
    final contactName =
        Provider.of<ContactsService>(
          context,
          listen: false,
        ).getContactName(from) ??
        from;
    final l10n = AppLocalizations.of(context)!;

    setState(() {
      _showNotification = true;
      _isCallNotification = true;
      _notificationTitle = l10n.incomingCallTitle;
      _notificationBody = l10n.incomingCallBody(contactName);
      _notificationAction = () {
        _handleIncomingCall(from);
      };
    });
  }

  void _showIncomingMessageNotification(String from, String body) {
    final contactName =
        Provider.of<ContactsService>(
          context,
          listen: false,
        ).getContactName(from) ??
        from;

    setState(() {
      _showNotification = true;
      _isCallNotification = false;
      _notificationTitle = AppLocalizations.of(context)!.newMessageTitle;
      _notificationBody =
          '$contactName: ${body.length > 30 ? '${body.substring(0, 30)}...' : body}';
      _notificationAction = () {
        _handleIncomingMessage(from, body);
      };
    });
  }

  void _handleIncomingCall(String from) {
    // In a real implementation, this would answer the call
    final storageService = Provider.of<StorageService>(context, listen: false);

    // Add to call history
    final call = PhoneCall(
      id: UniqueKey().toString(),
      phoneNumber: from,
      timestamp: DateTime.now(),
      isIncoming: true,
      isMissed: false,
    );

    storageService.addCall(call);

    setState(() {
      _showNotification = false;
      _selectedIndex = 1; // Switch to call history tab
    });
  }

  void _handleIncomingMessage(String from, String body) {
    final storageService = Provider.of<StorageService>(context, listen: false);

    // Add to message history
    final message = Message(
      id: UniqueKey().toString(),
      phoneNumber: from,
      content: body,
      timestamp: DateTime.now(),
      isIncoming: true,
    );

    storageService.addMessage(message);
    // If the Messages tab is already open (on this or another conversation),
    // switching _selectedIndex/_selectedContact below won't recreate
    // MessagesScreen, so it wouldn't otherwise pick up the new message.
    _messagesKey.currentState?.refresh();

    setState(() {
      _showNotification = false;
      _selectedIndex = 2; // Switch to messages tab
      _selectedContact = from;
    });
  }

  void _dismissNotification() {
    setState(() {
      _showNotification = false;
    });
  }

  Future<void> _makeCall(String number) async {
    // Ignore taps while a call is already being connected.
    if (_isConnecting) return;

    _connectingNumber = number;
    setState(() => _isConnecting = true);
    // Safety net: if no call-state event ever arrives (e.g. the platform fails
    // silently), stop showing the spinner instead of hanging forever.
    _connectTimeout?.cancel();
    _connectTimeout = Timer(const Duration(seconds: 60), _clearConnecting);

    try {
      _twilioService.getPhoneNumbers();
      final placed = await _twilioService.makeCall(number);

      if (!mounted) return;
      if (placed == false) {
        _clearConnecting();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppLocalizations.of(context)!.couldNotStartCall(number),
            ),
          ),
        );
        return;
      }

      // Call was placed; keep the spinner until _onCallEvent resolves it from
      // a connected/ended/declined event.
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context)!.connectingTo(number))),
      );
    } catch (e) {
      _clearConnecting();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context)!.failedToMakeCall(e.toString()),
          ),
        ),
      );
    }
  }

  /// Prompts for a phone number — or lets the user pick an existing contact —
  /// and opens a (possibly empty) thread for it, so the user can message a
  /// number they haven't talked to yet.
  void _startNewConversation() {
    final phoneController = TextEditingController();
    // Contacts are only needed once the user actually opens this picker, so
    // kick off the (permission-requesting) load here instead of at startup.
    Provider.of<ContactsService>(context, listen: false).ensureLoaded();

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      // Consumer (rather than listen:false) so the picker repopulates itself
      // if the load kicked off above is still in flight when the sheet opens.
      builder: (context) => Consumer<ContactsService>(
        builder: (context, contactsService, _) => StatefulBuilder(
        builder: (context, setSheetState) {
          final matches = contactsService.search(phoneController.text);
          final l10n = AppLocalizations.of(context)!;

          return SafeArea(
            child: Padding(
              padding: EdgeInsets.only(
                left: 16,
                right: 16,
                top: 16,
                bottom: MediaQuery.of(context).viewInsets.bottom + 16,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(context).size.height * 0.8,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      l10n.newConversationTitle,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: phoneController,
                      autofocus: false,
                      keyboardType: TextInputType.text,
                      decoration: InputDecoration(
                        labelText: l10n.phoneNumberOrContactHint,
                        // hintText: '+1234567890',
                        border: const OutlineInputBorder(),
                      ),
                      onChanged: (_) => setSheetState(() {}),
                      onSubmitted: (_) =>
                          _openNewConversation(phoneController.text),
                    ),
                    if (matches.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Flexible(
                        child: ListView.builder(
                          shrinkWrap: true,
                          itemCount: matches.length,
                          itemBuilder: (context, index) {
                            final contact = matches[index];
                            return ListTile(
                              leading: CircleAvatar(
                                backgroundColor: Theme.of(
                                  context,
                                ).colorScheme.primary,
                                child: Text(
                                  contact.name.isNotEmpty
                                      ? contact.name[0].toUpperCase()
                                      : '?',
                                  style: const TextStyle(color: Colors.white),
                                ),
                              ),
                              title: Text(contact.name),
                              subtitle: Text(contact.number),
                              onTap: () => _openNewConversation(contact.number),
                            );
                          },
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: () => Navigator.pop(context),
                          child: Text(l10n.cancel),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                          onPressed: () =>
                              _openNewConversation(phoneController.text),
                          child: Text(l10n.start),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
        ),
      ),
    );
  }

  void _openNewConversation(String number) {
    final trimmed = number.trim();
    if (trimmed.isEmpty) return;
    Navigator.pop(context);
    setState(() {
      _selectedIndex = 2; // Messages tab
      _selectedContact = trimmed;
    });
  }

  /// Opens the Messages thread for [number] — e.g. from the call-history
  /// action sheet's "Message" option. Unlike [_openNewConversation] this
  /// assumes no sheet is still on the navigation stack (the caller pops its
  /// own), so it only switches tabs.
  void _openConversation(String number) {
    final trimmed = number.trim();
    if (trimmed.isEmpty) return;
    setState(() {
      _selectedIndex = 2; // Messages tab
      _selectedContact = trimmed;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: (_selectedIndex == 2 && _selectedContact != null)
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => setState(() => _selectedContact = null),
              )
            : null,
        title: _buildAppBarTitle(),
        actions: [..._buildOutgoingNumberSwitcher(), ..._buildAppBarActions()],
      ),
      body: Stack(
        children: [
          _buildBody(),
          if (_showNotification)
            NotificationOverlay(
              title: _notificationTitle,
              body: _notificationBody,
              isCall: _isCallNotification,
              onAccept: _notificationAction as void Function()?,
              onDismiss: _dismissNotification,
            ),
        ],
      ),
      floatingActionButton: (_selectedIndex == 2 && _selectedContact == null)
          ? FloatingActionButton(
              onPressed: _startNewConversation,
              tooltip: AppLocalizations.of(context)!.newConversationTooltip,
              child: const Icon(Icons.add_comment),
            )
          : null,
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _selectedIndex,
        onTap: (index) {
          setState(() {
            _selectedIndex = index;
            _selectedContact =
                null; // Reset selected contact when changing tabs
          });
        },
        type: BottomNavigationBarType.fixed,
        items: [
          BottomNavigationBarItem(
            icon: const Icon(Icons.dialpad),
            label: AppLocalizations.of(context)!.dialerTabLabel,
          ),
          BottomNavigationBarItem(
            icon: const Icon(Icons.call),
            label: AppLocalizations.of(context)!.callsTabLabel,
          ),
          BottomNavigationBarItem(
            icon: const Icon(Icons.message),
            label: AppLocalizations.of(context)!.messagesTabLabel,
          ),
          BottomNavigationBarItem(
            icon: const Icon(Icons.settings),
            label: AppLocalizations.of(context)!.settingsTabLabel,
          ),
        ],
      ),
    );
  }

  Widget _buildAppBarTitle() {
    final l10n = AppLocalizations.of(context)!;
    switch (_selectedIndex) {
      case 0:
        return Text(l10n.dialerTabLabel);
      case 1:
        return Text(l10n.appBarTitleCallHistory);
      case 2:
        return _selectedContact == null
            ? Text(l10n.messagesTabLabel)
            : Consumer<ContactsService>(
                builder: (context, contacts, child) {
                  final contactName =
                      contacts.getContactName(_selectedContact!) ??
                      _selectedContact;
                  return Text(contactName!);
                },
              );
      case 3:
        return Text(l10n.settingsTabLabel);
      default:
        return Text(l10n.appBarTitleDefault);
    }
  }

  /// Quick outgoing-number switcher for the app bar: a button showing the
  /// current caller-id number that expands into a menu of the account's other
  /// numbers when tapped. Hidden on the Settings tab, which already has the
  /// full picker, and while there's only zero/one number to choose from.
  List<Widget> _buildOutgoingNumberSwitcher() {
    if (_selectedIndex == 3 || _outgoingNumbers.length < 2) return [];
    final current = _twilioService.currentPhoneNumber;
    final l10n = AppLocalizations.of(context)!;
    return [
      PopupMenuButton<String>(
        tooltip: current != null
            ? l10n.switchOutgoingNumberTooltipWithCurrent(current)
            : l10n.switchOutgoingNumberTooltip,
        onSelected: _switchOutgoingNumber,
        itemBuilder: (context) => _outgoingNumbers
            .map(
              (number) => CheckedPopupMenuItem<String>(
                value: number,
                checked: number == current,
                child: Text(number),
              ),
            )
            .toList(),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.swap_horiz),
              const SizedBox(width: 4),
              Text(
                _lastDigits(current),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        ),
      ),
    ];
  }

  /// The last 4 digits of [number], for a compact app bar label — the full
  /// number is still in the tooltip and the expanded menu.
  String _lastDigits(String? number) {
    if (number == null) return '';
    return number.length > 4 ? number.substring(number.length - 4) : number;
  }

  List<Widget> _buildAppBarActions() {
    switch (_selectedIndex) {
      case 1: // Call history tab
        return [
          IconButton(
            icon: Icon(Icons.refresh),
            onPressed: () => _callHistoryKey.currentState?.refresh(),
          ),
        ];
      case 2: // Messages tab
        return _selectedContact == null
            ? [
                IconButton(
                  icon: Icon(Icons.refresh),
                  onPressed: () => _messagesKey.currentState?.refresh(),
                ),
              ]
            : [
                IconButton(
                  icon: Icon(Icons.call),
                  onPressed: () => _makeCall(_selectedContact!),
                ),
              ];
      default:
        return [];
    }
  }

  Widget _buildBody() {
    switch (_selectedIndex) {
      case 0:
        return Dialer(onCall: _makeCall, isConnecting: _isConnecting);
      case 1:
        return CallHistoryScreen(
          key: _callHistoryKey,
          twilioService: _twilioService,
          onCall: _makeCall,
          onMessage: _openConversation,
        );
      case 2:
        return MessagesScreen(
          key: _messagesKey,
          twilioService: _twilioService,
          selectedContact: _selectedContact,
          onSelectContact: (number) =>
              setState(() => _selectedContact = number),
          onStartConversation: _startNewConversation,
          onCall: _makeCall,
        );
      case 3:
        return SettingsScreen(
          twilioService: _twilioService,
          subscriptionService: _subscriptionService,
        );
      default:
        return Center(
          child: Text(AppLocalizations.of(context)!.somethingWentWrong),
        );
    }
  }
}
