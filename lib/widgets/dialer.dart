import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/generated/app_localizations.dart';
import '../services/contacts_service.dart';

class Dialer extends StatefulWidget {
  final void Function(String) onCall;

  /// Whether a call placed from this dialer is currently being connected.
  /// Driven by the parent from Twilio call-state events; while true the call
  /// button shows a spinner and ignores taps.
  final bool isConnecting;

  const Dialer({super.key, required this.onCall, this.isConnecting = false});

  @override
  _DialerState createState() => _DialerState();
}

class _DialerState extends State<Dialer> {
  static const String _outputMask = "0000 00 00 00";

  /// Fixed height of a single contact-match row. The whole matches area below
  /// always reserves 2 of these (see [_buildMatches]), whether or not there
  /// are actually 0, 1 or 2 rows to show, so the number display and keypad
  /// don't jump around as matches appear/disappear while typing.
  static const double _matchTileHeight = 40.0;
  static const List<String> _keys = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "*",
    "0",
    "#",
  ];

  /// Maps each dial key to its pre-rendered dual-tone (DTMF) audio asset —
  /// the actual touch-tone frequency pair for that digit, not a generic click.
  static const Map<String, String> _dtmfAssets = {
    "1": "sounds/dtmf/dtmf_1.wav",
    "2": "sounds/dtmf/dtmf_2.wav",
    "3": "sounds/dtmf/dtmf_3.wav",
    "4": "sounds/dtmf/dtmf_4.wav",
    "5": "sounds/dtmf/dtmf_5.wav",
    "6": "sounds/dtmf/dtmf_6.wav",
    "7": "sounds/dtmf/dtmf_7.wav",
    "8": "sounds/dtmf/dtmf_8.wav",
    "9": "sounds/dtmf/dtmf_9.wav",
    "*": "sounds/dtmf/dtmf_star.wav",
    "0": "sounds/dtmf/dtmf_0.wav",
    "#": "sounds/dtmf/dtmf_pound.wav",
  };

  String _value = "";

  /// Dedicated low-latency player for key tones. Kept separate from any other
  /// audio in the app and reused across taps so rapid dialing doesn't stack up
  /// player-creation overhead.
  final AudioPlayer _dtmfPlayer = AudioPlayer()
    ..setPlayerMode(PlayerMode.lowLatency)
    ..setReleaseMode(ReleaseMode.stop);

  @override
  void dispose() {
    _dtmfPlayer.dispose();
    super.dispose();
  }

  /// Applies [_outputMask] to the raw [_value] for display only. A `0` in the
  /// mask is a placeholder for the next typed character; any other character is
  /// a literal separator. Digits beyond the mask length are appended verbatim.
  ///
  /// A leading `+` (only ever set by [_fillFromContact], since it's not a dial
  /// key) means [_value] is already a fully-qualified international number —
  /// the local mask doesn't apply, so it's shown as-is instead of being
  /// mangled by a mask built for a 10-digit national number.
  String get _maskedValue {
    if (_value.startsWith('+')) return _value;
    final buffer = StringBuffer();
    var vi = 0;
    for (var i = 0; i < _outputMask.length && vi < _value.length; i++) {
      if (_outputMask[i] == '0') {
        buffer.write(_value[vi]);
        vi++;
      } else {
        buffer.write(_outputMask[i]);
      }
    }
    if (vi < _value.length) buffer.write(_value.substring(vi));
    return buffer.toString();
  }

  void _onKeyPressed(String key) {
    final asset = _dtmfAssets[key];
    if (asset != null) {
      _dtmfPlayer.stop().then((_) => _dtmfPlayer.play(AssetSource(asset)));
    }
    if (_value.isEmpty) {
      context.read<ContactsService>().ensureLoaded();
    }
    setState(() => _value += key);
  }

  void _onBackspace() {
    if (_value.isEmpty) return;
    setState(() => _value = _value.substring(0, _value.length - 1));
  }

  /// Replaces the current input with [contact]'s number
  void _fillFromContact(ContactEntry contact) {
    final digits = contact.number.replaceAll(RegExp(r'[^0-9*#]'), '');
    final hasPlus = contact.number.trim().startsWith('+');
    setState(() => _value = hasPlus ? '+$digits' : digits);
  }

  /// Shows every filtered [matches] in a scrollable sheet; picking one fills
  /// the input the same way tapping the inline top hit does.
  void _showMoreResults(List<ContactEntry> matches) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.8,
          ),
          child: ListView.builder(
            shrinkWrap: true,
            itemCount: matches.length,
            itemBuilder: (context, index) {
              final contact = matches[index];
              return ListTile(
                leading: CircleAvatar(
                  backgroundColor: Theme.of(context).colorScheme.primary,
                  child: Text(
                    contact.name.isNotEmpty
                        ? contact.name[0].toUpperCase()
                        : '?',
                    style: const TextStyle(color: Colors.white),
                  ),
                ),
                title: Text(contact.name),
                subtitle: Text(contact.number),
                onTap: () {
                  Navigator.pop(context);
                  _fillFromContact(contact);
                },
              );
            },
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final screenSize = MediaQuery.of(context).size;
    final buttonTextColor = Theme.of(context).colorScheme.primary;
    final buttonColor = Theme.of(context).colorScheme.surfaceContainerHighest;
    final matches = _value.isEmpty
        ? const <ContactEntry>[]
        : context.watch<ContactsService>().searchByDigits(_value);

    return SafeArea(
      child: LayoutBuilder(
        builder: (context, constraints) {
          // The portrait-tuned ratio below can ask for more vertical space than
          // is actually available (e.g. landscape, where the Scaffold's AppBar
          // and BottomNavigationBar eat a much bigger share of the short screen
          // height), which overflows the Column. Derive a second estimate from
          // the real height this widget was given — text padding (40) + text
          // (sizeFactor/2) + 4 key rows + 3 inter-row gaps (12 each) + the extra
          // gap (15) before the call/backspace row (sizeFactor) — and use
          // whichever is smaller so buttons shrink to fit when space is tight.
          var sizeFactor = screenSize.height * 0.09852217;
          if (constraints.maxHeight.isFinite) {
            final fitted = (constraints.maxHeight - 40 - 3 * 12 - 15) / 5.5;
            sizeFactor = sizeFactor.clamp(0, fitted);
          }

          // The key rows below use spaceEvenly across 3 buttons, which leaves
          // an equal gap before the first button, between each pair, and
          // after the last — i.e. (rowWidth - 3 * sizeFactor) / 4. Match that
          // gap as horizontal padding on the contact matches so they start
          // flush with the first button and end flush with the last one,
          // instead of spanning the full (wider) row.
          final rowWidth = constraints.maxWidth.isFinite
              ? constraints.maxWidth
              : screenSize.width;
          final buttonInset = ((rowWidth - 3 * sizeFactor) / 4).clamp(
            0.0,
            rowWidth / 2,
          );

          return SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minHeight: constraints.maxHeight.isFinite
                    ? constraints.maxHeight
                    : 0,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.end,
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.all(20),
                    child: Text(
                      _maskedValue,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: sizeFactor / 2),
                    ),
                  ),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: buttonInset),
                    child: SizedBox(
                      height: _matchTileHeight * 2,
                      child: matches.isEmpty
                          ? null
                          : Column(
                              children: [
                                SizedBox(
                                  height: _matchTileHeight,
                                  child: ListTile(
                                    dense: true,
                                    visualDensity: VisualDensity.compact,
                                    contentPadding: EdgeInsets.zero,
                                    minLeadingWidth: 0,
                                    leading: CircleAvatar(
                                      radius: 14,
                                      backgroundColor: Theme.of(
                                        context,
                                      ).colorScheme.primary,
                                      child: Text(
                                        matches.first.name.isNotEmpty
                                            ? matches.first.name[0]
                                                  .toUpperCase()
                                            : '?',
                                        style: const TextStyle(
                                          color: Colors.white,
                                          fontSize: 12,
                                        ),
                                      ),
                                    ),
                                    title: Text(
                                      '${matches.first.name} · ${matches.first.number}',
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(fontSize: 14),
                                    ),
                                    onTap: () => _fillFromContact(
                                      matches.first,
                                    ),
                                  ),
                                ),
                                if (matches.length > 1)
                                  SizedBox(
                                    height: _matchTileHeight,
                                    child: ListTile(
                                      dense: true,
                                      visualDensity: VisualDensity.compact,
                                      contentPadding: EdgeInsets.zero,
                                      minLeadingWidth: 0,
                                      leading: const Icon(
                                        Icons.search,
                                        size: 20,
                                      ),
                                      title: Text(
                                        AppLocalizations.of(context)!
                                            .moreResults(matches.length),
                                        style: const TextStyle(fontSize: 14),
                                      ),
                                      trailing: const Icon(
                                        Icons.chevron_right,
                                        size: 18,
                                      ),
                                      onTap: () => _showMoreResults(matches),
                                    ),
                                  ),
                              ],
                            ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  for (var row = 0; row < 4; row++) ...[
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: <Widget>[
                        for (var col = 0; col < 3; col++)
                          _DialButton(
                            title: _keys[row * 3 + col],
                            color: buttonColor,
                            textColor: buttonTextColor,
                            size: sizeFactor,
                            onTap: _onKeyPressed,
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                  ],
                  const SizedBox(height: 15),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: <Widget>[
                      Expanded(child: Container()),
                      Expanded(
                        child: Center(
                          child: _DialButton(
                            icon: Icons.phone,
                            color: widget.isConnecting
                                ? Colors.green.shade300
                                : Colors.green,
                            iconColor: Colors.white,
                            size: sizeFactor,
                            loading: widget.isConnecting,
                            enabled: !widget.isConnecting && _value.isNotEmpty,
                            onTap: (_) => widget.onCall(_value),
                          ),
                        ),
                      ),
                      Expanded(
                        child: Padding(
                          padding: EdgeInsets.only(
                            right: screenSize.height * 0.03685504,
                          ),
                          child: IconButton(
                            icon: Icon(
                              Icons.backspace,
                              size: sizeFactor / 2,
                              color: _value.isNotEmpty
                                  ? Colors.red
                                  : Colors.white24,
                            ),
                            onPressed: _value.isEmpty ? null : _onBackspace,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _DialButton extends StatelessWidget {
  final String? title;
  final IconData? icon;
  final Color color;
  final Color? textColor;
  final Color? iconColor;
  final double size;
  final ValueSetter<String> onTap;
  final bool enabled;
  final bool loading;

  const _DialButton({
    this.title,
    this.icon,
    required this.color,
    this.textColor,
    this.iconColor,
    required this.size,
    required this.onTap,
    this.enabled = true,
    this.loading = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: enabled ? () => onTap(title ?? "") : null,
      child: ClipOval(
        child: Container(
          color: color,
          height: size,
          width: size,
          child: Center(
            child: loading
                ? SizedBox(
                    width: size / 2,
                    height: size / 2,
                    child: CircularProgressIndicator(
                      strokeWidth: 3,
                      valueColor: AlwaysStoppedAnimation<Color>(
                        iconColor ?? Colors.white,
                      ),
                    ),
                  )
                : icon != null
                ? Icon(icon, size: size / 2, color: iconColor ?? Colors.white)
                : Text(
                    title!,
                    style: TextStyle(
                      fontSize: size / 2,
                      color: textColor ?? Colors.black,
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}
