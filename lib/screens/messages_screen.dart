import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import 'package:share_plus/share_plus.dart';
import '../l10n/generated/app_localizations.dart';
import '../models/message.dart';
import '../services/storage_service.dart';
import '../services/contacts_service.dart';
import '../services/twilio_service.dart';
import '../widgets/message_media.dart';
import '../widgets/linkified_text.dart';
import '../utils/time_format.dart';

/// The actions offered by the long-press sheet on a message bubble.
enum _MessageAction { share, copy, delete }

/// The actions offered by the long-press sheet on a conversation row.
enum _ConversationAction { addContact, open, call, delete }

/// Messages pulled page-by-page from the Twilio REST API, grouped into
/// conversations by the remote number. The conversation list has infinite
/// scroll (loads the next page as the user nears the bottom) and pull-to-refresh;
/// tapping a conversation opens its thread.
class MessagesScreen extends StatefulWidget {
  final TwilioService twilioService;

  /// The conversation currently open (a remote phone number), or null to show
  /// the conversation list. Owned by the parent so the app bar can reflect it.
  final String? selectedContact;

  /// The channel of the open conversation (SMS or WhatsApp). Null when the
  /// conversation list is showing. A number can have both an SMS and a WhatsApp
  /// thread, so this disambiguates which one is open.
  final Channel? selectedChannel;

  /// Opens (number, channel) as the active conversation, or (null, null) to
  /// return to the list. Owned by the parent so the app bar can reflect it.
  final void Function(String? number, Channel? channel) onSelectConversation;

  /// Invoked from the empty state to start a new conversation (the parent
  /// switches to the dialer).
  final VoidCallback onStartConversation;

  /// Places a call to the given number (the parent switches to the dialer and
  /// dials).
  final void Function(String number) onCall;

  const MessagesScreen({
    super.key,
    required this.twilioService,
    required this.selectedContact,
    required this.selectedChannel,
    required this.onSelectConversation,
    required this.onStartConversation,
    required this.onCall,
  });

  @override
  MessagesScreenState createState() => MessagesScreenState();
}

class MessagesScreenState extends State<MessagesScreen> {
  final ScrollController _scrollController = ScrollController();
  final ScrollController _threadScrollController = ScrollController();
  final TextEditingController _messageController = TextEditingController();
  final List<Message> _messages = [];

  String? _nextPageUrl;
  bool _loadingFirst = false;
  bool _loadingMore = false;
  bool _hasError = false;
  bool _sending = false;

  // Tracks the open thread so we only auto-scroll to the newest message when
  // the conversation changes or a message is added, not on every rebuild.
  String? _threadKey;
  int _threadMessageCount = 0;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    // Show the last cached messages instantly (and offline), then refresh.
    _messages.addAll(Provider.of<StorageService>(context, listen: false).messages);
    _loadFirstPage();
    Provider.of<ContactsService>(context, listen: false).ensureLoaded();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _threadScrollController.dispose();
    _messageController.dispose();
    super.dispose();
  }

  void _scrollThreadToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_threadScrollController.hasClients) return;
      _threadScrollController.jumpTo(_threadScrollController.position.maxScrollExtent);
    });
  }

  void _onScroll() {
    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 300) {
      _loadMore();
    }
  }

  /// Reduces a number to its trailing significant digits so the same contact
  /// groups together regardless of formatting / country prefix.
  String _key(String number) {
    final digits = number.replaceAll(RegExp(r'\D'), '');
    return digits.length > 9 ? digits.substring(digits.length - 9) : digits;
  }

  /// The grouping key for a conversation: the number key plus the channel, so
  /// the SMS thread and the WhatsApp thread to the same number stay separate
  /// (and opening one keeps you in that technology).
  String _convKey(String number, Channel channel) =>
      '${channel.name}|${_key(number)}';

  /// (Re)loads the first page, replacing the list. Exposed so the parent can
  /// trigger a refresh from the app bar.
  Future<void> refresh() => _loadFirstPage();

  /// Delivers an incoming push message into the in-memory list in real time so
  /// the UI updates live whether the Messages tab is showing the matching thread
  /// (new bubble + auto-scroll via [_buildThread]) or the conversation list (the
  /// preview updates and the conversation moves to the top via
  /// [_groupConversations]). Persistence to the offline cache is owned by the
  /// caller (HomeScreen), which saves the message regardless of the active tab.
  ///
  /// Returns true only when the message belongs to the thread currently open, so
  /// the parent can suppress the interrupting banner; false otherwise (the
  /// conversation list or a different thread is open) so the parent still shows
  /// the banner while the list refreshes underneath.
  ///
  /// The message is keyed by its Twilio SID (see [_showIncomingMessageNotification]),
  /// which matches the id the REST list uses, so the id dedup below drops it if a
  /// [refresh] already pulled it — no duplicate. (A push missing its SID falls
  /// back to a synthetic id and is instead replaced wholesale by the next
  /// [refresh], which clears and re-pulls the list.)
  bool addIncomingMessage(Message message) {
    // Scope to the selected outgoing number, exactly as the REST list does: a
    // message that arrived on a different Twilio number would otherwise show
    // under the current number and then vanish on the next refresh. Leave those
    // to the banner/tap flow. Persistence is owned by the caller (HomeScreen),
    // so this only updates the live in-memory list.
    if (!widget.twilioService.matchesCurrentNumber(message)) {
      return false;
    }
    if (!_messages.any((m) => m.id == message.id)) {
      setState(() => _messages.add(message));
    }
    final openContact = widget.selectedContact;
    final openChannel = widget.selectedChannel;
    return openContact != null &&
        openChannel == message.channel &&
        _key(openContact) == _key(message.phoneNumber);
  }

  Future<void> _loadFirstPage() async {
    setState(() {
      _loadingFirst = true;
      _hasError = false;
    });
    try {
      final page = await widget.twilioService.getMessages();
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(page.messages);
        _nextPageUrl = page.nextPageUrl;
        _loadingFirst = false;
      });
      // Cache this page so recent messages are available offline next time.
      await Provider.of<StorageService>(context, listen: false)
          .setMessages(page.messages);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingFirst = false;
        _hasError = _messages.isEmpty;
      });
      _showError(
        AppLocalizations.of(context)!.failedToLoadMessages(e.toString()),
      );
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || _loadingFirst || _nextPageUrl == null) return;
    setState(() => _loadingMore = true);
    try {
      final page = await widget.twilioService.getMessages(pageUrl: _nextPageUrl);
      if (!mounted) return;
      setState(() {
        final seen = _messages.map((m) => m.id).toSet();
        _messages.addAll(page.messages.where((m) => !seen.contains(m.id)));
        _nextPageUrl = page.nextPageUrl;
        _loadingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
      _showError(
        AppLocalizations.of(context)!.failedToLoadMoreMessages(e.toString()),
      );
    }
  }

  Future<void> _send(String number, Channel channel) async {
    final text = _messageController.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final message =
          await widget.twilioService.sendMessage(number, text, channel: channel);
      if (!mounted) return;
      setState(() {
        _messages.add(message);
        _messageController.clear();
        _sending = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _sending = false);
      _showError(
        AppLocalizations.of(context)!.failedToSendMessage(e.toString()),
      );
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  void _showInfo(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  /// Confirmation gate for a destructive delete. Deletion goes straight to
  /// Twilio and is permanent (see [TwilioService.deleteMessage]), so it's
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

  /// Re-persists the (now smaller) in-memory list so a deletion survives the
  /// next launch instead of the cache silently re-showing the removed message.
  Future<void> _persistMessages() =>
      Provider.of<StorageService>(context, listen: false).setMessages(_messages);

  /// If the open thread has no messages left after a delete, drop back to the
  /// conversation list (its tile is gone too).
  void _leaveThreadIfEmpty() {
    final contact = widget.selectedContact;
    final channel = widget.selectedChannel;
    if (contact == null || channel == null) return;
    if (!_messages.any((m) =>
        m.channel == channel && _key(m.phoneNumber) == _key(contact))) {
      widget.onSelectConversation(null, null);
    }
  }

  /// Long-pressing a bubble opens this action sheet. Copy and Share only
  /// appear when the message has text to act on; Delete is always offered and
  /// is the only action that then asks for confirmation, since it's permanent
  /// (see [_deleteMessage]).
  Future<void> _showMessageActions(
      Message message, BuildContext bubbleContext) async {
    final l10n = AppLocalizations.of(context)!;
    final colorScheme = Theme.of(context).colorScheme;
    final hasText = message.content.isNotEmpty;
    // The bubble's global rect, used to anchor the share sheet on iPad (a
    // popover that must point at its origin). Captured before the sheet opens,
    // while the bubble is guaranteed laid out; null on other platforms, where
    // it's ignored.
    final box = bubbleContext.findRenderObject() as RenderBox?;
    final shareOrigin = (box != null && box.hasSize)
        ? box.localToGlobal(Offset.zero) & box.size
        : null;
    final action = await showModalBottomSheet<_MessageAction>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (hasText)
              ListTile(
                leading: const Icon(Icons.share_outlined),
                title: Text(l10n.share),
                onTap: () => Navigator.of(context).pop(_MessageAction.share),
              ),
            if (hasText)
              ListTile(
                leading: const Icon(Icons.copy_outlined),
                title: Text(l10n.copy),
                onTap: () => Navigator.of(context).pop(_MessageAction.copy),
              ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: colorScheme.error),
              title: Text(
                l10n.deleteMessage,
                style: TextStyle(color: colorScheme.error),
              ),
              onTap: () => Navigator.of(context).pop(_MessageAction.delete),
            ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;
    switch (action) {
      case _MessageAction.share:
        await SharePlus.instance.share(
          ShareParams(text: message.content, sharePositionOrigin: shareOrigin),
        );
      case _MessageAction.copy:
        await Clipboard.setData(ClipboardData(text: message.content));
        _showInfo(l10n.copiedToClipboard);
      case _MessageAction.delete:
        // Only here does the destructive-delete warning appear.
        await _deleteMessage(message);
    }
  }

  /// Permanently deletes a single message from Twilio (after confirmation),
  /// then removes it from the in-memory list and the offline cache.
  Future<void> _deleteMessage(Message message) async {
    final l10n = AppLocalizations.of(context)!;
    if (!await _confirmDelete(l10n.deleteMessage, l10n.deleteMessageConfirm)) {
      return;
    }
    try {
      await widget.twilioService.deleteMessage(message.id);
      if (!mounted) return;
      setState(() => _messages.removeWhere((m) => m.id == message.id));
      await _persistMessages();
      if (!mounted) return;
      _showInfo(l10n.messageDeleted);
      _leaveThreadIfEmpty();
    } catch (e) {
      if (!mounted) return;
      _showError(l10n.failedToDeleteMessage(e.toString()));
    }
  }

  /// Opens a bottom sheet of actions for a conversation row: add the number to
  /// contacts (only when it isn't already one), open the thread, or delete the
  /// whole conversation.
  Future<void> _showConversationActions(Conversation conversation) async {
    final l10n = AppLocalizations.of(context)!;
    final colorScheme = Theme.of(context).colorScheme;
    final isContact = conversation.contactName != null;
    final action = await showModalBottomSheet<_ConversationAction>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(conversation.contactName ?? conversation.phoneNumber),
              subtitle: isContact ? Text(conversation.phoneNumber) : null,
            ),
            const Divider(height: 1),
            if (!isContact)
              ListTile(
                leading: const Icon(Icons.person_add_alt_1_outlined),
                title: Text(l10n.addToContacts),
                onTap: () =>
                    Navigator.of(context).pop(_ConversationAction.addContact),
              ),
            ListTile(
              leading: const Icon(Icons.message_outlined),
              title: Text(l10n.openConversation),
              onTap: () => Navigator.of(context).pop(_ConversationAction.open),
            ),
            ListTile(
              leading: const Icon(Icons.call_outlined),
              title: Text(l10n.call),
              onTap: () => Navigator.of(context).pop(_ConversationAction.call),
            ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: colorScheme.error),
              title: Text(
                l10n.deleteConversation,
                style: TextStyle(color: colorScheme.error),
              ),
              onTap: () => Navigator.of(context).pop(_ConversationAction.delete),
            ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;
    switch (action) {
      case _ConversationAction.addContact:
        await Provider.of<ContactsService>(context, listen: false)
            .openAddContact(conversation.phoneNumber);
      case _ConversationAction.open:
        widget.onSelectConversation(
            conversation.phoneNumber, conversation.channel);
      case _ConversationAction.call:
        widget.onCall(conversation.phoneNumber);
      case _ConversationAction.delete:
        await _deleteConversation(conversation);
    }
  }

  /// Permanently deletes a whole conversation from Twilio (after
  /// confirmation) — every currently-loaded message to/from that number.
  /// Whatever actually got deleted is pruned from the cache even if Twilio
  /// rejects one partway through, then any failure is surfaced.
  Future<void> _deleteConversation(Conversation conversation) async {
    final l10n = AppLocalizations.of(context)!;
    final sids = conversation.messages.map((m) => m.id).toList();
    if (!await _confirmDelete(
      l10n.deleteConversation,
      l10n.deleteConversationConfirm(sids.length),
    )) {
      return;
    }
    final result = await widget.twilioService.deleteMessages(sids);
    if (!mounted) return;
    final deleted = result.deleted.toSet();
    setState(() => _messages.removeWhere((m) => deleted.contains(m.id)));
    await _persistMessages();
    if (!mounted) return;
    if (result.hadError) {
      _showError(l10n.failedToDeleteMessage(result.error!));
    } else {
      _showInfo(l10n.conversationDeleted);
    }
    _leaveThreadIfEmpty();
  }

  /// Groups the fetched messages into conversations, newest-activity first.
  /// Keyed by number *and* channel, so a number reached over both SMS and
  /// WhatsApp appears as two separate threads.
  List<Conversation> _groupConversations(ContactsService contacts) {
    final byKey = <String, List<Message>>{};
    for (final m in _messages) {
      byKey.putIfAbsent(_convKey(m.phoneNumber, m.channel), () => []).add(m);
    }
    final conversations = byKey.values.map((msgs) {
      msgs.sort((a, b) => a.timestamp.compareTo(b.timestamp));
      final number = msgs.last.phoneNumber;
      return Conversation(
        phoneNumber: number,
        messages: msgs,
        contactName: contacts.getContactName(number),
        lastMessageTime: msgs.last.timestamp,
        channel: msgs.last.channel,
      );
    }).toList()
      ..sort((a, b) => b.lastMessageTime.compareTo(a.lastMessageTime));
    return conversations;
  }

  @override
  Widget build(BuildContext context) {
    if (widget.selectedContact != null && widget.selectedChannel != null) {
      return SafeArea(
        child: _buildThread(widget.selectedContact!, widget.selectedChannel!),
      );
    }
    // Listen to the contacts so names resolve (and re-resolve) live.
    final contacts = context.watch<ContactsService>();
    return SafeArea(child: _buildConversationList(contacts));
  }

  // ---- Conversation list -------------------------------------------------

  Widget _buildConversationList(ContactsService contacts) {
    final conversations = _groupConversations(contacts);

    if (conversations.isEmpty) {
      if (_loadingFirst) {
        return const Center(child: CircularProgressIndicator());
      }
      if (_hasError) return _buildError();
      return _buildEmpty();
    }

    return RefreshIndicator(
      onRefresh: _loadFirstPage,
      child: ListView.builder(
        controller: _scrollController,
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: conversations.length + 1, // trailing footer
        itemBuilder: (context, index) {
          if (index == conversations.length) return _buildFooter();
          return _buildConversationTile(conversations[index]);
        },
      ),
    );
  }

  Widget _buildConversationTile(Conversation conversation) {
    final title = conversation.contactName ?? conversation.phoneNumber;
    final isWhatsapp = conversation.channel == Channel.whatsapp;
    return ListTile(
      leading: CircleAvatar(
        backgroundColor: Theme.of(context).colorScheme.primary,
        child: Text(
          title.isNotEmpty ? title[0].toUpperCase() : '?',
          style: const TextStyle(color: Colors.white),
        ),
      ),
      title: Row(
        children: [
          Flexible(child: Text(title, overflow: TextOverflow.ellipsis)),
          if (isWhatsapp) ...[
            const SizedBox(width: 6),
            const _WhatsappBadge(),
          ],
        ],
      ),
      subtitle: Text(
        conversation.previewText,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Text(
        DateFormat.yMMMd().format(conversation.lastMessageTime),
        style: const TextStyle(color: Colors.grey),
      ),
      onTap: () => widget.onSelectConversation(
          conversation.phoneNumber, conversation.channel),
      // Long-press opens a sheet of actions for the whole conversation.
      onLongPress: () => _showConversationActions(conversation),
    );
  }

  Widget _buildFooter() {
    if (_loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    return const SizedBox(height: 24);
  }

  Widget _buildEmpty() {
    final l10n = AppLocalizations.of(context)!;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.message, size: 80, color: Colors.grey[400]),
          const SizedBox(height: 16),
          Text(
            l10n.noMessagesYet,
            style: TextStyle(fontSize: 18, color: Colors.grey[600]),
          ),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            onPressed: widget.onStartConversation,
            icon: const Icon(Icons.add),
            label: Text(l10n.startAConversation),
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
            l10n.couldNotLoadMessages,
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

  // ---- Thread ------------------------------------------------------------

  Widget _buildThread(String contact, Channel channel) {
    final convKey = _convKey(contact, channel);
    final messages = _messages
        .where((m) => _convKey(m.phoneNumber, m.channel) == convKey)
        .toList()
      ..sort((a, b) => a.timestamp.compareTo(b.timestamp));

    if (convKey != _threadKey || messages.length != _threadMessageCount) {
      _threadKey = convKey;
      _threadMessageCount = messages.length;
      _scrollThreadToBottom();
    }

    return Column(
      children: [
        Expanded(
          child: messages.isEmpty
              ? Center(
                  child: Text(AppLocalizations.of(context)!.noMessagesYet,
                      style: const TextStyle(color: Colors.grey)),
                )
              : ListView.builder(
                  controller: _threadScrollController,
                  itemCount: messages.length,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  itemBuilder: (context, index) =>
                      _buildBubble(messages[index]),
                ),
        ),
        _buildComposer(contact, channel),
      ],
    );
  }

  Widget _buildBubble(Message message) {
    final isMe = !message.isIncoming;
    final colorScheme = Theme.of(context).colorScheme;
    final bubbleColor =
        isMe ? colorScheme.secondary : colorScheme.surfaceContainerHighest;
    final textColor = isMe ? colorScheme.onSecondary : colorScheme.onSurface;
    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      // Long-press a bubble for Share / Copy / Delete. Wrapped in a Builder so
      // the callback gets a context whose RenderBox is this bubble — used as
      // the iPad share-sheet anchor (sharePositionOrigin).
      child: Builder(
        builder: (bubbleContext) => GestureDetector(
          onLongPress: () => _showMessageActions(message, bubbleContext),
        child: Container(
          margin: EdgeInsets.only(
            top: 8,
            bottom: 8,
            left: isMe ? 64 : 0,
            right: isMe ? 0 : 64,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: bubbleColor,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final media in message.media) ...[
                MessageMediaView(
                  media: media,
                  twilioService: widget.twilioService,
                  isMe: isMe,
                ),
                const SizedBox(height: 8),
              ],
              if (message.content.isNotEmpty)
                LinkifiedText(
                  text: message.content,
                  style: TextStyle(color: textColor, fontSize: 16),
                ),
              const SizedBox(height: 4),
              Text(
                formatClockTime(context, message.timestamp),
                style: TextStyle(
                  color: textColor.withValues(alpha: 0.7),
                  fontSize: 12,
                ),
              ),
            ],
          ),
          ),
        ),
      ),
    );
  }

  Widget _buildComposer(String contact, Channel channel) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: colorScheme.surface,
        boxShadow: const [
          BoxShadow(color: Colors.black12, offset: Offset(0, -1), blurRadius: 4),
        ],
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _messageController,
              decoration: InputDecoration(
                hintText: AppLocalizations.of(context)!.typeMessageHint,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide.none,
                ),
                filled: true,
                fillColor: colorScheme.surfaceContainerHighest,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              ),
              maxLines: null,
              textCapitalization: TextCapitalization.sentences,
              onSubmitted: (_) => _send(contact, channel),
            ),
          ),
          const SizedBox(width: 8),
          CircleAvatar(
            backgroundColor: colorScheme.surfaceContainerHighest,
            child: IconButton(
              icon: _sending
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        valueColor:
                            AlwaysStoppedAnimation<Color>(colorScheme.primary),
                      ),
                    )
                  : Icon(Icons.send, color: colorScheme.primary),
              onPressed: _sending ? null : () => _send(contact, channel),
            ),
          ),
        ],
      ),
    );
  }
}

/// A compact "WhatsApp" chip shown on a conversation row so WhatsApp threads
/// are distinguishable from SMS threads in the single mixed list.
class _WhatsappBadge extends StatelessWidget {
  const _WhatsappBadge();

  static const _whatsappGreen = Color(0xFF25D366);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: _whatsappGreen.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
      ),
      child: const Text(
        'WhatsApp',
        style: TextStyle(
          color: _whatsappGreen,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
