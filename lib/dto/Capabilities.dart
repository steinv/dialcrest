import 'package:json_annotation/json_annotation.dart';
part 'Capabilities.g.dart';

@JsonSerializable()
class Capabilities {
  final bool fax;
  final bool mms;
  final bool sms;
  final bool voice;

  Capabilities(this.fax, this.mms, this.sms, this.voice);

  factory Capabilities.fromJson(Map<String, dynamic> json) => _$CapabilitiesFromJson(json);
  Map<String, dynamic> toJson() => _$CapabilitiesToJson(this);
}