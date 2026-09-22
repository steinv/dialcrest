/// The transport a message or call uses. SMS/voice is the app's original,
/// implicit channel; WhatsApp is layered on top as an extra channel on the same
/// Twilio rails (see docs/whatsapp-integration-plan.md). Every message, call and
/// conversation carries one so the mixed lists can render both and so a
/// conversation stays in its own technology.
enum Channel {
  sms,
  whatsapp;

  /// Serialized form for the offline cache and push payloads. Kept stable
  /// (matches the enum name) so cached entries survive across launches.
  String get wire => name;

  /// Parses the serialized form, defaulting to [Channel.sms] for values written
  /// before this field existed (or anything unrecognized).
  static Channel fromWire(Object? value) {
    return Channel.values.firstWhere(
      (c) => c.name == value,
      orElse: () => Channel.sms,
    );
  }
}

/// Twilio addresses a WhatsApp participant as `whatsapp:+E164` on the Messages
/// API, versus a bare `+E164` for SMS. These helpers convert between a bare
/// number + [Channel] and the wire address Twilio expects.
class ChannelAddress {
  static const _whatsappPrefix = 'whatsapp:';

  /// Whether [address] (a Twilio `from`/`to`) is a WhatsApp address.
  static bool isWhatsapp(String address) =>
      address.startsWith(_whatsappPrefix);

  /// The [Channel] an incoming Twilio `from`/`to` address belongs to.
  static Channel channelOf(String address) =>
      isWhatsapp(address) ? Channel.whatsapp : Channel.sms;

  /// Strips the `whatsapp:` prefix (if any) to leave the bare phone number.
  static String stripPrefix(String address) => isWhatsapp(address)
      ? address.substring(_whatsappPrefix.length)
      : address;

  /// Wraps a bare phone number in the address form Twilio expects for [channel].
  static String forChannel(String number, Channel channel) =>
      channel == Channel.whatsapp ? '$_whatsappPrefix$number' : number;
}
