import 'package:json_annotation/json_annotation.dart';
import 'package:dialcrest/dto/Capabilities.dart';

part 'IncomingPhoneNumbers.g.dart';

@JsonSerializable()
class IncomingPhoneNumbers {
  final Capabilities capabilities;
  final String phone_number;
  final String status;
  final String sid;
  final String? voice_application_sid;

  IncomingPhoneNumbers(this.capabilities, this.phone_number, this.status, this.sid, this.voice_application_sid);
  factory IncomingPhoneNumbers.fromJson(Map<String, dynamic> json) => _$IncomingPhoneNumbersFromJson(json);
  Map<String, dynamic> toJson() => _$IncomingPhoneNumbersToJson(this);
}