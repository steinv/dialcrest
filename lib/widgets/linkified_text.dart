import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Renders a string as selectable text, but with URLs, phone numbers and email
/// addresses turned into tappable links. Tapping a link opens it with the
/// platform's default handler (browser, dialer or mail app); long-press/drag
/// selects the text as usual.
///
/// This is intentionally dependency-free: it scans the text with a single
/// regular expression and builds a [SelectableText.rich] out of alternating
/// plain and linked spans.
class LinkifiedText extends StatefulWidget {
  final String text;
  final TextStyle style;

  const LinkifiedText({super.key, required this.text, required this.style});

  @override
  State<LinkifiedText> createState() => _LinkifiedTextState();
}

class _LinkifiedTextState extends State<LinkifiedText> {
  // Recognizers hold gesture state, so they must be created once and disposed
  // rather than rebuilt inline on every paint.
  final List<TapGestureRecognizer> _recognizers = [];

  // URL (http/https or a bare www.), then email, then phone number. Order
  // matters: the engine tries alternatives left to right, so digit-heavy URLs
  // and emails win over the phone-number pattern.
  static final RegExp _pattern = RegExp(
    r'(?<url>(?:https?://|www\.)[^\s]+)'
    r'|(?<email>[\w.+-]+@[\w-]+\.[\w.-]+)'
    r'|(?<phone>\+?\d[\d\s().-]{5,}\d)',
    caseSensitive: false,
  );

  // Punctuation that commonly trails a link in prose but is not part of it.
  static const String _trailingPunctuation = '.,;:!?)]}\'"';

  @override
  void dispose() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    super.dispose();
  }

  void _resetRecognizers() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    _recognizers.clear();
  }

  Future<void> _launch(Uri uri) async {
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      // Fall back to the default mode; some handlers reject externalApplication.
      await launchUrl(uri);
    }
  }

  Uri? _uriFor(String type, String value) {
    switch (type) {
      case 'url':
        return Uri.parse(
          value.startsWith('www.') ? 'https://$value' : value,
        );
      case 'email':
        return Uri(scheme: 'mailto', path: value);
      case 'phone':
        return Uri(scheme: 'tel', path: value.replaceAll(' ', ''));
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    _resetRecognizers();

    // Keep the link the same color as the surrounding text so it stays legible
    // on whatever surface the bubble uses; the underline marks it as tappable.
    final linkStyle = widget.style.copyWith(
      decoration: TextDecoration.underline,
    );

    final spans = <InlineSpan>[];
    var index = 0;

    for (final match in _pattern.allMatches(widget.text)) {
      if (match.start > index) {
        spans.add(TextSpan(text: widget.text.substring(index, match.start)));
      }

      final type = match.namedGroup('url') != null
          ? 'url'
          : match.namedGroup('email') != null
              ? 'email'
              : 'phone';
      var value = match.group(0)!;

      // Trailing punctuation is rendered as plain text, not part of the link.
      var trailing = '';
      while (value.isNotEmpty &&
          _trailingPunctuation.contains(value[value.length - 1])) {
        trailing = value[value.length - 1] + trailing;
        value = value.substring(0, value.length - 1);
      }

      final uri = _uriFor(type, value);
      if (uri == null || value.isEmpty) {
        spans.add(TextSpan(text: match.group(0)));
      } else {
        final recognizer = TapGestureRecognizer()..onTap = () => _launch(uri);
        _recognizers.add(recognizer);
        spans.add(TextSpan(text: value, style: linkStyle, recognizer: recognizer));
        if (trailing.isNotEmpty) spans.add(TextSpan(text: trailing));
      }

      index = match.end;
    }

    if (index < widget.text.length) {
      spans.add(TextSpan(text: widget.text.substring(index)));
    }

    return SelectableText.rich(TextSpan(style: widget.style, children: spans));
  }
}
