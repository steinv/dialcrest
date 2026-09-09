import 'package:flutter/material.dart';

class NotificationOverlay extends StatefulWidget {
  final String title;
  final String body;

  /// Whether this notification is for an incoming call (shows call-shaped
  /// actions) vs. a message (shows message-shaped actions).
  final bool isCall;
  final VoidCallback? onAccept;
  final VoidCallback onDismiss;

  const NotificationOverlay({
    super.key,
    required this.title,
    required this.body,
    required this.isCall,
    this.onAccept,
    required this.onDismiss,
  });

  @override
  _NotificationOverlayState createState() => _NotificationOverlayState();
}

class _NotificationOverlayState extends State<NotificationOverlay> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<Offset> _offsetAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 500),
      vsync: this,
    );
    _offsetAnimation = Tween<Offset>(
      begin: const Offset(0.0, -1.0),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOut,
    ));
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      child: SlideTransition(
        position: _offsetAnimation,
        child: Material(
          elevation: 8,
          child: Container(
            padding: EdgeInsets.only(
              top: MediaQuery.of(context).padding.top + 8,
              bottom: 12,
              left: 16,
              right: 16,
            ),
            color: Colors.grey[900],
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.title,
                            style: TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.bold,
                              fontSize: 16,
                            ),
                          ),
                          SizedBox(height: 4),
                          Text(
                            widget.body,
                            style: TextStyle(color: Colors.white70),
                          ),
                        ],
                      ),
                    ),
                    widget.isCall
                        ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: Icon(Icons.call_end, color: Colors.red),
                          onPressed: widget.onDismiss,
                        ),
                        if (widget.onAccept != null)
                          IconButton(
                            icon: Icon(Icons.call, color: Colors.green),
                            onPressed: widget.onAccept,
                          ),
                      ],
                    )
                        : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: Icon(Icons.close, color: Colors.white),
                          onPressed: widget.onDismiss,
                        ),
                        if (widget.onAccept != null)
                          IconButton(
                            icon: Icon(Icons.message, color: Colors.white),
                            onPressed: widget.onAccept,
                          ),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}