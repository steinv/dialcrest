/// A single MMS media attachment on a [Message]: where to fetch its bytes
/// from (Twilio's Media resource, which requires Basic Auth) and its MIME
/// type, which decides how it's rendered (image/video/audio).
class MessageMedia {
  final String url;
  final String contentType;

  MessageMedia({required this.url, required this.contentType});

  bool get isImage => contentType.startsWith('image/');
  bool get isVideo => contentType.startsWith('video/');
  bool get isAudio => contentType.startsWith('audio/');

  Map<String, dynamic> toJson() => {
        'url': url,
        'contentType': contentType,
      };

  factory MessageMedia.fromJson(Map<String, dynamic> json) => MessageMedia(
        url: json['url'],
        contentType: json['contentType'] ?? 'application/octet-stream',
      );
}

class Message {
  final String id;
  final String phoneNumber;
  final String content;
  final DateTime timestamp;
  final bool isIncoming;
  final String? contactName;
  final List<MessageMedia> media;

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
    );
  }
}

class Conversation {
  final String phoneNumber;
  final List<Message> messages;
  final String? contactName;
  final DateTime lastMessageTime;

  Conversation({
    required this.phoneNumber,
    required this.messages,
    this.contactName,
    required this.lastMessageTime,
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
