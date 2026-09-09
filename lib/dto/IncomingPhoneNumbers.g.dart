// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'IncomingPhoneNumbers.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IncomingPhoneNumbers _$IncomingPhoneNumbersFromJson(
  Map<String, dynamic> json,
) => IncomingPhoneNumbers(
  Capabilities.fromJson(json['capabilities'] as Map<String, dynamic>),
  json['phone_number'] as String,
  json['status'] as String,
  json['sid'] as String,
  json['voice_application_sid'] as String?,
);

Map<String, dynamic> _$IncomingPhoneNumbersToJson(
  IncomingPhoneNumbers instance,
) => <String, dynamic>{
  'capabilities': instance.capabilities,
  'phone_number': instance.phone_number,
  'status': instance.status,
  'sid': instance.sid,
  'voice_application_sid': instance.voice_application_sid,
};
