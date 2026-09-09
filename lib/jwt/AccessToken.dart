import 'package:dart_jsonwebtoken/dart_jsonwebtoken.dart';

class AccessToken {
  static const String defaultAlgorithm = 'HS256';
  static const List<String> algorithms = ['HS256', 'HS384', 'HS512'];

  final String accountSid;
  final String keySid;
  final String secret;
  final int ttl;
  final String identity;
  final int? nbf;
  final String? region;
  final List<Grant> grants = [];

  AccessToken({
    required this.accountSid,
    required this.keySid,
    required this.secret,
    required this.identity,
    this.ttl = 3600,
    this.nbf,
    this.region,
  });

  void addGrant(Grant grant) {
    grants.add(grant);
  }

  String toJwt({String algorithm = defaultAlgorithm}) {
    if (!algorithms.contains(algorithm)) {
      throw ArgumentError('Unsupported algorithm. Allowed: ${algorithms.join(", ")}');
    }

    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final Map<String, dynamic> grantsPayload = {'identity': identity};

    for (var grant in grants) {
      grantsPayload[grant.key] = grant.toPayload();
    }

    final payload = {
      'jti': '$keySid-$now',
      'grants': grantsPayload,
      if (nbf != null) 'nbf': nbf,
    };

    final header = {
      'cty': 'twilio-fpa;v=1',
      'typ': 'JWT',
      if (region != null) 'twr': region,
    };

    final jwt = JWT(
      payload,
      issuer: keySid,
      subject: accountSid,
      header: header,
    );

    return jwt.sign(
        SecretKey(secret),
        algorithm: JWTAlgorithm.fromName(algorithm),
        expiresIn: Duration(seconds: ttl),
        notBefore: nbf != null ? Duration(seconds: nbf!) : null
    );
  }
}

abstract class Grant {
  String get key;
  Map<String, dynamic> toPayload();
}

// Grant: TaskRouter
class TaskRouterGrant implements Grant {
  @override
  final String key = 'task_router';
  final String? workspaceSid;
  final String? workerSid;
  final String? role;

  TaskRouterGrant({this.workspaceSid, this.workerSid, this.role});

  @override
  Map<String, dynamic> toPayload() => {
    if (workspaceSid != null) 'workspace_sid': workspaceSid,
    if (workerSid != null) 'worker_sid': workerSid,
    if (role != null) 'role': role,
  };
}

// Grant: Chat
class ChatGrant implements Grant {
  @override
  final String key = 'chat';
  final String? serviceSid;
  final String? endpointId;
  final String? deploymentRoleSid;
  final String? pushCredentialSid;

  ChatGrant({
    this.serviceSid,
    this.endpointId,
    this.deploymentRoleSid,
    this.pushCredentialSid,
  });

  @override
  Map<String, dynamic> toPayload() => {
    if (serviceSid != null) 'service_sid': serviceSid,
    if (endpointId != null) 'endpoint_id': endpointId,
    if (deploymentRoleSid != null) 'deployment_role_sid': deploymentRoleSid,
    if (pushCredentialSid != null) 'push_credential_sid': pushCredentialSid,
  };
}

// Grant: Video
class VideoGrant implements Grant {
  @override
  final String key = 'video';
  final String? room;

  VideoGrant({this.room});

  @override
  Map<String, dynamic> toPayload() => {
    if (room != null) 'room': room,
  };
}

// Grant: Sync
class SyncGrant implements Grant {
  @override
  final String key = 'data_sync';
  final String? serviceSid;
  final String? endpointId;

  SyncGrant({this.serviceSid, this.endpointId});

  @override
  Map<String, dynamic> toPayload() => {
    if (serviceSid != null) 'service_sid': serviceSid,
    if (endpointId != null) 'endpoint_id': endpointId,
  };
}

// Grant: Voice
class VoiceGrant implements Grant {
  @override
  final String key = 'voice';
  final bool? incomingAllow;
  final String? outgoingApplicationSid;
  final Map<String, dynamic>? outgoingApplicationParams;
  final String? pushCredentialSid;
  final String? endpointId;

  VoiceGrant({
    this.incomingAllow,
    this.outgoingApplicationSid,
    this.outgoingApplicationParams,
    this.pushCredentialSid,
    this.endpointId,
  });

  @override
  Map<String, dynamic> toPayload() {
    final Map<String, dynamic> payload = {};

    if (incomingAllow == true) {
      payload['incoming'] = {'allow': true};
    }

    if (outgoingApplicationSid != null) {
      payload['outgoing'] = {
        'application_sid': outgoingApplicationSid,
        if (outgoingApplicationParams != null) 'params': outgoingApplicationParams
      };
    }

    if (pushCredentialSid != null) {
      payload['push_credential_sid'] = pushCredentialSid;
    }

    if (endpointId != null) {
      payload['endpoint_id'] = endpointId;
    }

    return payload;
  }
}

// Grant: Playback
class PlaybackGrant implements Grant {
  @override
  final String key = 'player';
  final Map<String, dynamic>? grant;

  PlaybackGrant({this.grant});

  @override
  Map<String, dynamic> toPayload() => grant ?? {};
}