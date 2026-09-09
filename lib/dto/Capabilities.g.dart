// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'Capabilities.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Capabilities _$CapabilitiesFromJson(Map<String, dynamic> json) => Capabilities(
  json['fax'] as bool,
  json['mms'] as bool,
  json['sms'] as bool,
  json['voice'] as bool,
);

Map<String, dynamic> _$CapabilitiesToJson(Capabilities instance) =>
    <String, dynamic>{
      'fax': instance.fax,
      'mms': instance.mms,
      'sms': instance.sms,
      'voice': instance.voice,
    };
