import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  /// Shared with Android's MainActivity (same name, see TwilioService); on iOS
  /// it only carries missed-call notification taps.
  private static let notificationChannelName = "be.peblet.twilio_phone/incoming_message"

  private var notificationChannel: FlutterMethodChannel?

  /// A missed-call notification tap Dart hasn't acted on yet — still set when the
  /// tap arrives before the engine/Dart handler is up (cold start), consumed once
  /// by `getInitialOpenCallHistory`.
  private var pendingOpenCallHistory = false

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Without this, firebase_messaging installs itself as the notification-center
    // delegate with nothing to forward to, so taps on flutter_local_notifications'
    // incoming-message notifications (and twilio_voice's missed-call ones) never
    // reach the app and it just opens on the dialer. As the delegate,
    // FlutterAppDelegate forwards to every plugin (firebase_messaging included).
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "DialcrestNotificationTaps") else {
      return
    }
    let channel = FlutterMethodChannel(
      name: AppDelegate.notificationChannelName,
      binaryMessenger: registrar.messenger()
    )
    channel.setMethodCallHandler { [weak self] call, result in
      switch call.method {
      case "getInitialOpenCallHistory":
        result(self?.pendingOpenCallHistory ?? false)
        self?.pendingOpenCallHistory = false
      case "getInitialIncomingMessage":
        // Android-only: iOS message taps arrive via flutter_local_notifications.
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    notificationChannel = channel
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    // twilio_voice's own handler would call the missed caller straight back;
    // open the call history instead, so it's not forwarded to the plugins.
    if response.notification.request.content.userInfo["type"] as? String == "twilio-missed-call" {
      pendingOpenCallHistory = true
      // Cleared once Dart confirms it navigated; otherwise (handler not set up
      // yet) it waits for getInitialOpenCallHistory.
      notificationChannel?.invokeMethod("onOpenCallHistory", arguments: nil) { [weak self] result in
        if result as? Bool == true { self?.pendingOpenCallHistory = false }
      }
      completionHandler()
      return
    }
    super.userNotificationCenter(center, didReceive: response, withCompletionHandler: completionHandler)
  }
}
