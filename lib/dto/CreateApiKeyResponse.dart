import 'package:json_annotation/json_annotation.dart';
part 'CreateApiKeyResponse.g.dart';

@JsonSerializable()
class CreateApiKeyResponse {
  final String sid;
  // final String? friendly_name;
  // final String date_created;
  // final String date_updated;
  final String secret;

  CreateApiKeyResponse(this.sid, this.secret);

  factory CreateApiKeyResponse.fromJson(Map<String, dynamic> json) => _$CreateApiKeyResponseFromJson(json);
  Map<String, dynamic> toJson() => _$CreateApiKeyResponseToJson(this);
}