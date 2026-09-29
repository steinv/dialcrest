import '../models/call.dart';
import '../models/message.dart';

/// Store-listing screenshot mode. Build with `--dart-define=STORE_DEMO=true`
/// to replace call history, messages, contact names and the WhatsApp
/// capability with the fixed fake data below, so screenshots show a lived-in
/// app without touching (or exposing) a real Twilio account. Off in every
/// normal build.
class StoreDemo {
  StoreDemo._();

  static const enabled = bool.fromEnvironment('STORE_DEMO');

  static const contacts = <String, String>{
    '+14155550132': 'Emma Johnson',
    '+14155550178': 'Lucas Martin',
    '+32470123456': 'Sophie Dubois',
    '+14155550199': 'Northside Plumbing',
    '+442079460321': 'Oliver Bennett',
    '+14155550111': 'Mia Rodriguez',
    '+32485998877': 'Noah Peeters',
  };

  static DateTime _ago({int days = 0, int hours = 0, int minutes = 0}) =>
      DateTime.now()
          .subtract(Duration(days: days, hours: hours, minutes: minutes));

  static List<PhoneCall> calls(String? localNumber) {
    final local = localNumber ?? '';
    PhoneCall call(String id, String number, DateTime at,
            {bool incoming = false, bool missed = false, int duration = 0}) =>
        PhoneCall(
          id: 'CAdemo$id',
          phoneNumber: number,
          timestamp: at,
          isIncoming: incoming,
          isMissed: missed,
          duration: duration,
          localNumber: local,
        );
    return [
      call('1', '+14155550132', _ago(minutes: 12), incoming: true, duration: 734),
      call('2', '+14155550199', _ago(hours: 2, minutes: 5), duration: 188),
      call('3', '+32470123456', _ago(hours: 5), incoming: true, missed: true),
      call('4', '+442079460321', _ago(days: 1, hours: 1), duration: 1260),
      call('5', '+16505550147', _ago(days: 1, hours: 4), incoming: true, missed: true),
      call('6', '+14155550178', _ago(days: 2, hours: 3), incoming: true, duration: 312),
      call('7', '+14155550111', _ago(days: 3), duration: 95),
      call('8', '+32485998877', _ago(days: 4, hours: 2), incoming: true, duration: 541),
      call('9', '+14155550132', _ago(days: 5), duration: 67),
      call('10', '+14155550199', _ago(days: 6), incoming: true, duration: 402),
    ];
  }

  static List<Message> messages(String? localNumber) {
    final local = localNumber ?? '';
    var seq = 0;
    Message msg(String number, String body, DateTime at,
            {bool incoming = true,
            Channel channel = Channel.sms,
            List<MessageMedia> media = const []}) =>
        Message(
          id: 'SMdemo${seq++}',
          phoneNumber: number,
          content: body,
          timestamp: at,
          isIncoming: incoming,
          media: media,
          localNumber: local,
          channel: channel,
        );
    const wa = Channel.whatsapp;
    return [
      // Emma — WhatsApp thread with a photo and a voice note.
      msg('+14155550132', 'Hi! Are we still on for the site visit tomorrow?',
          _ago(minutes: 48), channel: wa),
      msg('+14155550132', 'Yes, 10am works. I\'ll bring the samples.',
          _ago(minutes: 44), incoming: false, channel: wa),
      msg('+14155550132', 'Here\'s the view from the new office 😍',
          _ago(minutes: 31),
          channel: wa,
          media: [
            MessageMedia(
                url: 'https://picsum.photos/id/1048/800/600',
                contentType: 'image/jpeg'),
          ]),
      msg('+14155550132', 'Wow, that looks amazing!', _ago(minutes: 29),
          incoming: false, channel: wa),
      msg('+14155550132', '', _ago(minutes: 27),
          channel: wa,
          media: [
            MessageMedia(
                url: 'https://example.invalid/voice.ogg',
                contentType: 'audio/ogg'),
          ]),
      msg('+14155550132', 'Perfect, see you at 10 👋', _ago(minutes: 20),
          incoming: false, channel: wa),
      // Northside Plumbing — SMS.
      msg('+14155550199', 'Your technician is on the way, ETA 25 min.',
          _ago(hours: 2, minutes: 30)),
      msg('+14155550199', 'Great, thanks! Gate code is 4821.',
          _ago(hours: 2, minutes: 20), incoming: false),
      // Sophie — WhatsApp.
      msg('+32470123456', 'Merci pour l\'appel ! Je t\'envoie le devis ce soir.',
          _ago(hours: 4), channel: wa),
      // Oliver — SMS.
      msg('+442079460321', 'Contract signed ✅ Speak Monday.',
          _ago(days: 1), incoming: false),
      // Unknown number — SMS.
      msg('+16505550147', 'Your verification code is 482 913',
          _ago(days: 1, hours: 3)),
      // Lucas — SMS.
      msg('+14155550178', 'Can you call me when you\'re free?',
          _ago(days: 2, hours: 5)),
      // Mia — WhatsApp.
      msg('+14155550111', 'Invoice received, paying today 👍',
          _ago(days: 3, hours: 1), channel: wa),
      // Noah — SMS.
      msg('+32485998877', 'See you at the conference!', _ago(days: 4)),
    ];
  }
}
