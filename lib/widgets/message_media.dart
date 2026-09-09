import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import '../l10n/generated/app_localizations.dart';
import '../models/message.dart';
import '../services/twilio_service.dart';

/// Renders one MMS attachment inside a message bubble, dispatching to an
/// image, video, or audio widget by content type. Falls back to a generic
/// "attachment" chip for anything else (e.g. vCards).
class MessageMediaView extends StatelessWidget {
  final MessageMedia media;
  final TwilioService twilioService;
  final bool isMe;

  const MessageMediaView({
    super.key,
    required this.media,
    required this.twilioService,
    required this.isMe,
  });

  @override
  Widget build(BuildContext context) {
    if (media.isImage) {
      return _ImageAttachment(media: media, twilioService: twilioService);
    }
    if (media.isVideo) {
      return _VideoAttachment(media: media, twilioService: twilioService);
    }
    if (media.isAudio) {
      return _AudioAttachment(
          media: media, twilioService: twilioService, isMe: isMe);
    }
    return _UnsupportedAttachment(media: media, isMe: isMe);
  }
}

/// A thumbnail that opens the full-resolution image full-screen on tap.
class _ImageAttachment extends StatelessWidget {
  final MessageMedia media;
  final TwilioService twilioService;

  const _ImageAttachment({required this.media, required this.twilioService});

  @override
  Widget build(BuildContext context) {
    final headers = twilioService.mediaHeaders;
    return GestureDetector(
      onTap: () => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => _FullScreenImage(url: media.url, headers: headers),
      )),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 200, minWidth: 120),
          child: Image.network(
            media.url,
            headers: headers,
            fit: BoxFit.cover,
            loadingBuilder: (context, child, progress) {
              if (progress == null) return child;
              return const SizedBox(
                height: 120,
                width: 120,
                child: Center(child: CircularProgressIndicator()),
              );
            },
            errorBuilder: (context, error, stackTrace) => const SizedBox(
              height: 120,
              width: 120,
              child: Center(child: Icon(Icons.broken_image, color: Colors.grey)),
            ),
          ),
        ),
      ),
    );
  }
}

class _FullScreenImage extends StatelessWidget {
  final String url;
  final Map<String, String> headers;

  const _FullScreenImage({required this.url, required this.headers});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
      ),
      body: Center(
        child: InteractiveViewer(
          child: Image.network(url, headers: headers),
        ),
      ),
    );
  }
}

/// Plays an MMS video in place, streaming directly from Twilio's Media URL
/// (video_player supports custom request headers, so no download is needed).
class _VideoAttachment extends StatefulWidget {
  final MessageMedia media;
  final TwilioService twilioService;

  const _VideoAttachment({required this.media, required this.twilioService});

  @override
  State<_VideoAttachment> createState() => _VideoAttachmentState();
}

class _VideoAttachmentState extends State<_VideoAttachment> {
  late final VideoPlayerController _controller;
  bool _ready = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _controller = VideoPlayerController.networkUrl(
      Uri.parse(widget.media.url),
      httpHeaders: widget.twilioService.mediaHeaders,
    );
    _controller.initialize().then((_) {
      if (!mounted) return;
      setState(() => _ready = true);
    }).catchError((_) {
      if (!mounted) return;
      setState(() => _failed = true);
    });
    _controller.addListener(() {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _togglePlayback() {
    if (_controller.value.isPlaying) {
      _controller.pause();
    } else {
      _controller.play();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) {
      return const SizedBox(
        height: 120,
        width: 160,
        child: Center(child: Icon(Icons.error_outline, color: Colors.grey)),
      );
    }
    if (!_ready) {
      return const SizedBox(
        height: 160,
        width: 160,
        child: Center(child: CircularProgressIndicator()),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 220),
        child: AspectRatio(
          aspectRatio: _controller.value.aspectRatio,
          child: GestureDetector(
            onTap: _togglePlayback,
            child: Stack(
              alignment: Alignment.center,
              children: [
                VideoPlayer(_controller),
                if (!_controller.value.isPlaying)
                  Container(
                    decoration: const BoxDecoration(
                      color: Colors.black38,
                      shape: BoxShape.circle,
                    ),
                    padding: const EdgeInsets.all(12),
                    child: const Icon(Icons.play_arrow,
                        color: Colors.white, size: 36),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Plays an MMS audio attachment. audioplayers' UrlSource can't carry the
/// Basic Auth header Twilio's Media resource requires, so the bytes are
/// downloaded (via TwilioService, which already carries that header) on
/// first play and handed to the player as a BytesSource.
class _AudioAttachment extends StatefulWidget {
  final MessageMedia media;
  final TwilioService twilioService;
  final bool isMe;

  const _AudioAttachment({
    required this.media,
    required this.twilioService,
    required this.isMe,
  });

  @override
  State<_AudioAttachment> createState() => _AudioAttachmentState();
}

class _AudioAttachmentState extends State<_AudioAttachment> {
  final AudioPlayer _player = AudioPlayer();
  bool _loading = false;
  bool _playing = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _player.onPlayerStateChanged.listen((state) {
      if (!mounted) return;
      setState(() => _playing = state == PlayerState.playing);
    });
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_playing) {
      await _player.pause();
      return;
    }
    if (_player.source != null) {
      await _player.resume();
      return;
    }
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final bytes = await widget.twilioService.downloadMedia(widget.media.url);
      await _player.play(BytesSource(bytes));
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.isMe ? Colors.white : Colors.black87;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          onPressed: _loading ? null : _toggle,
          icon: _loading
              ? SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: color),
                )
              : Icon(
                  _failed
                      ? Icons.error_outline
                      : (_playing ? Icons.pause_circle : Icons.play_circle),
                  color: color,
                  size: 32,
                ),
        ),
        Text(AppLocalizations.of(context)!.audioMessage, style: TextStyle(color: color)),
      ],
    );
  }
}

class _UnsupportedAttachment extends StatelessWidget {
  final MessageMedia media;
  final bool isMe;

  const _UnsupportedAttachment({required this.media, required this.isMe});

  @override
  Widget build(BuildContext context) {
    final color = isMe ? Colors.white : Colors.black87;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.attach_file, color: color, size: 20),
        const SizedBox(width: 4),
        Text(AppLocalizations.of(context)!.attachment, style: TextStyle(color: color)),
      ],
    );
  }
}
