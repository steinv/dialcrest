import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../l10n/generated/app_localizations.dart';
import '../models/message.dart';
import '../services/storage_service.dart';
import '../services/contacts_service.dart';
import '../services/twilio_service.dart';
import '../widgets/message_media.dart';

/// Messages pulled page-by-page from the Twilio REST API, grouped into
/// conversations by the remote number. The conversation list has infinite
/// scroll (loads the next page as the user nears the bottom) and pull-to-refresh;
/// tapping a conversation opens its thread.
class MessagesScreen extends StatefulWidget {
  final TwilioService twilioService;

  /// The conversation currently open (a remote phone number), or null to show
  /// the conversation list. Owned by the parent so the app bar can reflect it.
  final String? selectedContact;
  final ValueChanged<String?> onSelectContact;

  /// Invoked from the empty state to start a new conversation (the parent
  /// switches to the dialer).
  final VoidCallback onStartConversation;

  const MessagesScreen({
    super.key,
    required this.twilioService,
    required this.selectedContact,
    required this.onSelectContact,
    required this.onStartConversation,
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
  String? _threadContact;
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

  /// (Re)loads the first page, replacing the list. Exposed so the parent can
  /// trigger a refresh from the app bar.
  Future<void> refresh() => _loadFirstPage();

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

  Future<void> _send(String number) async {
    final text = _messageController.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final message = await widget.twilioService.sendMessage(number, text);
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

  /// Groups the fetched messages into conversations, newest-activity first.
  List<Conversation> _groupConversations(ContactsService contacts) {
    final byKey = <String, List<Message>>{};
    for (final m in _messages) {
      byKey.putIfAbsent(_key(m.phoneNumber), () => []).add(m);
    }
    final conversations = byKey.values.map((msgs) {
      msgs.sort((a, b) => a.timestamp.compareTo(b.timestamp));
      final number = msgs.last.phoneNumber;
      return Conversation(
        phoneNumber: number,
        messages: msgs,
        contactName: contacts.getContactName(number),
        lastMessageTime: msgs.last.timestamp,
      );
    }).toList()
      ..sort((a, b) => b.lastMessageTime.compareTo(a.lastMessageTime));
    return conversations;
  }

  @override
  Widget build(BuildContext context) {
    if (widget.selectedContact != null) {
      return SafeArea(child: _buildThread(widget.selectedContact!));
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
    return ListTile(
      leading: CircleAvatar(
        backgroundColor: Theme.of(context).colorScheme.primary,
        child: Text(
          title.isNotEmpty ? title[0].toUpperCase() : '?',
          style: const TextStyle(color: Colors.white),
        ),
      ),
      title: Text(title),
      subtitle: Text(
        conversation.previewText,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Text(
        DateFormat.yMMMd().format(conversation.lastMessageTime),
        style: const TextStyle(color: Colors.grey),
      ),
      onTap: () => widget.onSelectContact(conversation.phoneNumber),
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

  Widget _buildThread(String contact) {
    final key = _key(contact);
    final messages = _messages
        .where((m) => _key(m.phoneNumber) == key)
        .toList()
      ..sort((a, b) => a.timestamp.compareTo(b.timestamp));

    if (contact != _threadContact || messages.length != _threadMessageCount) {
      _threadContact = contact;
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
        _buildComposer(contact),
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
              Text(
                message.content,
                style: TextStyle(color: textColor, fontSize: 16),
              ),
            const SizedBox(height: 4),
            Text(
              DateFormat.jm().format(message.timestamp),
              style: TextStyle(
                color: textColor.withValues(alpha: 0.7),
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildComposer(String contact) {
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
              onSubmitted: (_) => _send(contact),
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
              onPressed: _sending ? null : () => _send(contact),
            ),
          ),
        ],
      ),
    );
  }
}
