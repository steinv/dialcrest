import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../l10n/generated/app_localizations.dart';
import '../models/call.dart';
import '../services/storage_service.dart';
import '../services/contacts_service.dart';
import '../services/twilio_service.dart';
import '../utils/time_format.dart';

/// The actions offered by the long-press/tap sheet on a call-history row.
enum _CallAction { addContact, message, call, delete }

/// Call history pulled page-by-page from the Twilio REST API, with infinite
/// scroll (loads the next page as the user nears the bottom) and pull-to-refresh.
class CallHistoryScreen extends StatefulWidget {
  final TwilioService twilioService;
  final void Function(String number) onCall;
  final void Function(String number) onMessage;

  const CallHistoryScreen({
    super.key,
    required this.twilioService,
    required this.onCall,
    required this.onMessage,
  });

  @override
  CallHistoryScreenState createState() => CallHistoryScreenState();
}

class CallHistoryScreenState extends State<CallHistoryScreen> {
  final ScrollController _scrollController = ScrollController();
  final List<PhoneCall> _calls = [];

  String? _nextPageUrl;
  bool _loadingFirst = false;
  bool _loadingMore = false;
  bool _hasError = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    // Show the last fetched page instantly (and offline), then refresh.
    _calls.addAll(Provider.of<StorageService>(context, listen: false).calls);
    _loadFirstPage();
    Provider.of<ContactsService>(context, listen: false).ensureLoaded();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    // Start loading the next page a little before the very bottom.
    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 300) {
      _loadMore();
    }
  }

  /// (Re)loads the first page, replacing the list. Exposed so the parent can
  /// trigger a refresh from the app bar.
  Future<void> refresh() => _loadFirstPage();

  Future<void> _loadFirstPage() async {
    setState(() {
      _loadingFirst = true;
      _hasError = false;
    });
    try {
      final page = await widget.twilioService.getCallHistory();
      if (!mounted) return;
      setState(() {
        _calls
          ..clear()
          ..addAll(page.calls);
        _nextPageUrl = page.nextPageUrl;
        _loadingFirst = false;
      });
      // Cache the first page for instant display next time.
      await Provider.of<StorageService>(context, listen: false)
          .setCalls(page.calls);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingFirst = false;
        _hasError = _calls.isEmpty; // only block the screen if we have nothing
      });
      _showError(e);
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || _loadingFirst || _nextPageUrl == null) return;
    setState(() => _loadingMore = true);
    try {
      final page =
          await widget.twilioService.getCallHistory(pageUrl: _nextPageUrl);
      if (!mounted) return;
      setState(() {
        final seen = _calls.map((c) => c.id).toSet();
        _calls.addAll(page.calls.where((c) => !seen.contains(c.id)));
        _nextPageUrl = page.nextPageUrl;
        _loadingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
      _showError(e);
    }
  }

  void _showError(Object e) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context)!.failedToLoadCallHistory(e.toString()),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_calls.isEmpty) {
      if (_loadingFirst) {
        return const Center(child: CircularProgressIndicator());
      }
      if (_hasError) return _buildError();
      return _buildEmpty();
    }

    // Listen to the contacts so names resolve (and re-resolve) live.
    final contacts = context.watch<ContactsService>();

    return RefreshIndicator(
      onRefresh: _loadFirstPage,
      child: ListView.builder(
        controller: _scrollController,
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: _calls.length + 1, // trailing footer
        itemBuilder: (context, index) {
          if (index == _calls.length) return _buildFooter();
          return _buildCallTile(contacts, _calls[index]);
        },
      ),
    );
  }

  Widget _buildFooter() {
    if (_loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    // Spacer at the end of the list (also when all pages are loaded).
    return const SizedBox(height: 24);
  }

  Widget _buildEmpty() {
    final l10n = AppLocalizations.of(context)!;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.call, size: 80, color: Colors.grey[400]),
          const SizedBox(height: 16),
          Text(
            l10n.noCallHistory,
            style: TextStyle(fontSize: 18, color: Colors.grey[600]),
          ),
        ],
      ),
    );
  }

  Widget _buildError() {
    final l10n = AppLocalizations.of(context)!;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.error_outline, size: 80, color: Colors.grey[400]),
          const SizedBox(height: 16),
          Text(
            l10n.couldNotLoadCallHistory,
            style: TextStyle(fontSize: 18, color: Colors.grey[600]),
          ),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            onPressed: _loadFirstPage,
            icon: const Icon(Icons.refresh),
            label: Text(l10n.retry),
          ),
        ],
      ),
    );
  }

  /// Formats a call duration into a compact human string ("45s", "2m 05s",
  /// "1h 03m"). Returns an empty string for calls that never connected.
  String _formatDuration(AppLocalizations l10n, int seconds) {
    if (seconds <= 0) return '';
    final d = Duration(seconds: seconds);
    final h = d.inHours;
    final m = d.inMinutes.remainder(60);
    final s = d.inSeconds.remainder(60);
    if (h > 0) {
      return l10n.durationHoursMinutes(h, m.toString().padLeft(2, '0'));
    }
    if (m > 0) {
      return l10n.durationMinutesSeconds(m, s.toString().padLeft(2, '0'));
    }
    return l10n.durationSeconds(s);
  }

  Widget _buildCallTile(ContactsService contacts, PhoneCall call) {
    final l10n = AppLocalizations.of(context)!;
    final contactName = contacts.getContactName(call.phoneNumber);
    final formattedDate = formatDateTime(context, call.timestamp);
    final typeLabel = call.isIncoming
        ? (call.isMissed ? l10n.callTypeMissed : l10n.callTypeIncoming)
        : l10n.callTypeOutgoing;
    final durationText = _formatDuration(l10n, call.duration);
    final subtitle = [
      typeLabel,
      formattedDate,
      if (durationText.isNotEmpty) durationText,
    ].join(' · ');

    return ListTile(
      leading: CircleAvatar(
        backgroundColor: call.isIncoming
            ? (call.isMissed
                ? Colors.red
                : Theme.of(context).colorScheme.tertiary)
            : Theme.of(context).colorScheme.secondary,
        child: Icon(
          call.isIncoming
              ? (call.isMissed ? Icons.call_missed : Icons.call_received)
              : Icons.call_made,
          color: Colors.white,
        ),
      ),
      title: Text(contactName ?? call.phoneNumber),
      subtitle: Text(subtitle),
      trailing: IconButton(
        icon: Icon(Icons.call, color: Theme.of(context).colorScheme.secondary),
        onPressed: () => widget.onCall(call.phoneNumber),
      ),
      onTap: () => _showCallActions(call, contactName, subtitle),
    );
  }

  /// Tapping a call opens this action sheet (mirrors the message-bubble one):
  /// Add contact (only when the number isn't already a contact), Message, Call,
  /// and Delete from history. Delete is the only action that then asks for
  /// confirmation, since it permanently removes the call from Twilio.
  Future<void> _showCallActions(
    PhoneCall call,
    String? contactName,
    String subtitle,
  ) async {
    final l10n = AppLocalizations.of(context)!;
    final colorScheme = Theme.of(context).colorScheme;
    final action = await showModalBottomSheet<_CallAction>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(contactName ?? call.phoneNumber),
              subtitle: Text(subtitle),
            ),
            const Divider(height: 1),
            if (contactName == null)
              ListTile(
                leading: const Icon(Icons.person_add_alt_1_outlined),
                title: Text(l10n.addToContacts),
                onTap: () => Navigator.of(context).pop(_CallAction.addContact),
              ),
            ListTile(
              leading: const Icon(Icons.message_outlined),
              title: Text(l10n.message),
              onTap: () => Navigator.of(context).pop(_CallAction.message),
            ),
            ListTile(
              leading: const Icon(Icons.call_outlined),
              title: Text(l10n.call),
              onTap: () => Navigator.of(context).pop(_CallAction.call),
            ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: colorScheme.error),
              title: Text(
                l10n.deleteFromHistory,
                style: TextStyle(color: colorScheme.error),
              ),
              onTap: () => Navigator.of(context).pop(_CallAction.delete),
            ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;
    switch (action) {
      case _CallAction.addContact:
        Provider.of<ContactsService>(context, listen: false)
            .openAddContact(call.phoneNumber);
      case _CallAction.message:
        widget.onMessage(call.phoneNumber);
      case _CallAction.call:
        widget.onCall(call.phoneNumber);
      case _CallAction.delete:
        // Only here does the destructive-delete warning appear.
        await _deleteCall(call);
    }
  }

  /// Confirmation gate for the permanent delete. Deletion goes straight to
  /// Twilio and can't be undone (see [TwilioService.deleteCall]), so it's
  /// always gated behind this. Returns whether the user confirmed.
  Future<bool> _confirmDelete(String title, String message) async {
    final l10n = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(context).colorScheme.error,
            ),
            child: Text(l10n.delete),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  /// Permanently deletes a call from Twilio (after confirmation), then removes
  /// it from the in-memory list and the offline cache.
  Future<void> _deleteCall(PhoneCall call) async {
    final l10n = AppLocalizations.of(context)!;
    if (!await _confirmDelete(l10n.deleteFromHistory, l10n.deleteCallConfirm)) {
      return;
    }
    try {
      await widget.twilioService.deleteCall(call.id);
      if (!mounted) return;
      setState(() => _calls.removeWhere((c) => c.id == call.id));
      await Provider.of<StorageService>(context, listen: false).setCalls(_calls);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(l10n.callDeleted)));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.failedToDeleteCall(e.toString()))),
      );
    }
  }
}
