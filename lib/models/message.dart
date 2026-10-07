import 'channel.dart';

export 'channel.dart';

/// A single MMS media attachment on a [Message]: where to fetch its bytes
/// from (Twilio's Media resource, which requires Basic Auth) and its MIME
/// type, which decides how it's rendered (image/video/audio).
class MessageMedia {
  final String url;
  final String contentType;

  /// A path to the attachment's bytes on this device, set only on an
  /// optimistic just-sent message (the file the user picked/recorded) so it
  /// renders instantly without a network round-trip. Device-transient and
  /// never serialized: after the next history fetch the message is replaced by
  /// Twilio's stored copy, which renders from [url] like inbound media.
  final String? localPath;

  MessageMedia({required this.url, required this.contentType, this.localPath});

  bool get isImage => contentType.startsWith('image/');
  bool get isVideo => contentType.startsWith('video/');
  bool get isAudio => contentType.startsWith('audio/');

  /// Whether this attachment should render from [localPath] (an optimistic
  /// send) rather than fetching [url] behind Twilio's Basic Auth.
  bool get isLocal => localPath != null;

  Map<String, dynamic> toJson() => {
        'url': url,
        'contentType': contentType,
      };

  factory MessageMedia.fromJson(Map<String, dynamic> json) => MessageMedia(
        url: json['url'],
        contentType: json['contentType'] ?? 'application/octet-stream',
      );
}

/// The delivery state of a message, mirroring Twilio's Message `status` field
/// (https://www.twilio.com/docs/sms/api/message-resource#message-status-values).
/// Only the distinctions the UI cares about are modelled; every other Twilio
/// status (and any value from a message cached before this field existed) maps
/// to [unknown], which renders no indicator.
enum MessageStatus {
  /// Accepted/queued/scheduled by Twilio but not yet handed to the carrier.
  queued('queued'),

  /// Twilio is actively sending it to the carrier.
  sending('sending'),

  /// Handed to the carrier; no delivery confirmation (yet).
  sent('sent'),

  /// The carrier confirmed delivery to the handset.
  delivered('delivered'),

  /// WhatsApp only: the recipient opened the message.
  read('read'),

  /// The carrier reported it could not be delivered (e.g. unreachable handset).
  undelivered('undelivered'),

  /// Sending failed outright (e.g. invalid number, account/config error).
  failed('failed'),

  /// Any other / absent status — no delivery indicator is shown.
  unknown('unknown');

  const MessageStatus(this.wire);

  /// The value persisted in the offline cache (see [Message.toJson]).
  final String wire;

  /// Whether this message failed to reach the recipient and should carry a
  /// "not delivered" indicator in the chat. Both of Twilio's terminal error
  /// states qualify.
  bool get isFailed =>
      this == MessageStatus.undelivered || this == MessageStatus.failed;

  /// Maps a Twilio `status` string (or a cached [wire] value) to a status,
  /// defaulting to [unknown] for anything unrecognized or null.
  static MessageStatus fromWire(String? value) {
    switch (value) {
      case 'accepted':
      case 'scheduled':
      case 'queued':
        return MessageStatus.queued;
      case 'sending':
        return MessageStatus.sending;
      case 'sent':
        return MessageStatus.sent;
      case 'delivered':
        return MessageStatus.delivered;
      case 'read':
        return MessageStatus.read;
      case 'undelivered':
        return MessageStatus.undelivered;
      case 'failed':
        return MessageStatus.failed;
      default:
        return MessageStatus.unknown;
    }
  }
}

class Message {
  final String id;
  final String phoneNumber;
  final String content;
  final DateTime timestamp;
  final bool isIncoming;
  final String? contactName;
  final List<MessageMedia> media;

  /// Delivery state of this (outgoing) message. Drives the "not delivered"
  /// indicator in the chat; see [MessageStatus]. Always [MessageStatus.unknown]
  /// for incoming messages and for entries cached before this field existed.
  final MessageStatus status;

  /// Twilio's human-readable reason a message failed, when one is available
  /// (e.g. "Message blocked", an invalid-number description). Null unless
  /// [status] is a failure; shown when the user taps the indicator.
  final String? errorMessage;

  /// The transport this message used. Derived from the `whatsapp:` prefix on
  /// the Twilio address (see [ChannelAddress]); defaults to [Channel.sms] for
  /// entries cached before this field existed.
  final Channel channel;

  /// The account's own Twilio number this message used (the `to` on an
  /// inbound message, the `from` on an outbound one) — as opposed to
  /// [phoneNumber], the remote party. Used to scope the message list to the
  /// currently selected outgoing number. Empty for messages cached before
  /// this field existed.
  final String localNumber;

  Message({
    required this.id,
    required this.phoneNumber,
    required this.content,
    required this.timestamp,
    required this.isIncoming,
    this.contactName,
    this.media = const [],
    this.localNumber = '',
    this.channel = Channel.sms,
    this.status = MessageStatus.unknown,
    this.errorMessage,
  });

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'phoneNumber': phoneNumber,
      'content': content,
      'timestamp': timestamp.millisecondsSinceEpoch,
      'isIncoming': isIncoming,
      'contactName': contactName,
      'media': media.map((m) => m.toJson()).toList(),
      'localNumber': localNumber,
      'channel': channel.wire,
      'status': status.wire,
      'errorMessage': errorMessage,
    };
  }

  factory Message.fromJson(Map<String, dynamic> json) {
    final rawMedia = json['media'] as List<dynamic>? ?? [];
    return Message(
      id: json['id'],
      phoneNumber: json['phoneNumber'],
      content: json['content'],
      timestamp: DateTime.fromMillisecondsSinceEpoch(json['timestamp']),
      isIncoming: json['isIncoming'],
      contactName: json['contactName'],
      media: rawMedia
          .cast<Map<String, dynamic>>()
          .map(MessageMedia.fromJson)
          .toList(),
      localNumber: json['localNumber'] ?? '',
      channel: Channel.fromWire(json['channel']),
      status: MessageStatus.fromWire(json['status'] as String?),
      errorMessage: json['errorMessage'] as String?,
    );
  }
}

class Conversation {
  final String phoneNumber;
  final List<Message> messages;
  final String? contactName;
  final DateTime lastMessageTime;

  /// The transport of this thread. A number can have both an SMS and a WhatsApp
  /// conversation; they group separately (see MessagesScreen), and opening one
  /// stays in its own channel.
  final Channel channel;

  Conversation({
    required this.phoneNumber,
    required this.messages,
    this.contactName,
    required this.lastMessageTime,
    this.channel = Channel.sms,
  });

  String get previewText {
    if (messages.isEmpty) return '';
    final lastMessage = messages.last;
    if (lastMessage.content.isNotEmpty) {
      return lastMessage.content.length > 40
          ? '${lastMessage.content.substring(0, 40)}...'
          : lastMessage.content;
    }
    if (lastMessage.media.isEmpty) return '';
    final first = lastMessage.media.first;
    if (first.isImage) return 'Photo';
    if (first.isVideo) return 'Video';
    if (first.isAudio) return 'Audio message';
    return 'Attachment';
  }
}
