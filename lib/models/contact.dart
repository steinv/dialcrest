class Contact {
  final String id;
  final String name;
  final String phoneNumber;
  final String? notes;

  Contact({
    required this.id,
    required this.name,
    required this.phoneNumber,
    this.notes,
  });

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'phoneNumber': phoneNumber,
      'notes': notes,
    };
  }

  factory Contact.fromJson(Map<String, dynamic> json) {
    return Contact(
      id: json['id'],
      name: json['name'],
      phoneNumber: json['phoneNumber'],
      notes: json['notes'],
    );
  }
}