class PhoneCall {
  final String id;
  final String phoneNumber;
  final DateTime timestamp;
  final bool isIncoming;
  final bool isMissed;
  final int duration;
  final String? contactName;

  /// The account's own Twilio number this call used (the `to` on an inbound
  /// call, the `from` on an outbound one) — as opposed to [phoneNumber], the
  /// remote party. Used to scope call history to the currently selected
  /// outgoing number. Empty for calls cached before this field existed.
  final String localNumber;

  PhoneCall({
    required this.id,
    required this.phoneNumber,
    required this.timestamp,
    required this.isIncoming,
    this.isMissed = false,
    this.duration = 0,
    this.contactName,
    this.localNumber = '',
  });

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'phoneNumber': phoneNumber,
      'timestamp': timestamp.millisecondsSinceEpoch,
      'isIncoming': isIncoming,
      'isMissed': isMissed,
      'duration': duration,
      'contactName': contactName,
      'localNumber': localNumber,
    };
  }

  factory PhoneCall.fromJson(Map<String, dynamic> json) {
    return PhoneCall(
      id: json['id'],
      phoneNumber: json['phoneNumber'],
      timestamp: DateTime.fromMillisecondsSinceEpoch(json['timestamp']),
      isIncoming: json['isIncoming'],
      isMissed: json['isMissed'] ?? false,
      duration: json['duration'] ?? 0,
      contactName: json['contactName'],
      localNumber: json['localNumber'] ?? '',
    );
  }
}