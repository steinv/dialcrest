// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Spanish Castilian (`es`).
class AppLocalizationsEs extends AppLocalizations {
  AppLocalizationsEs([String locale = 'es']) : super(locale);

  @override
  String get authSubtitle =>
      'Introduce tus credenciales de Twilio para empezar a realizar y recibir llamadas y mensajes.';

  @override
  String get accountSidLabel => 'Account SID';

  @override
  String get accountSidValidatorError => 'Introduce tu Account SID';

  @override
  String get authTokenLabel => 'Auth Token';

  @override
  String get authTokenValidatorError => 'Introduce tu Auth Token';

  @override
  String get connect => 'Conectar';

  @override
  String get consoleHelpText =>
      'Encontrarás tu Account SID y tu Auth Token en tu Twilio Console.';

  @override
  String get invalidCredentialsError =>
      'Account SID o Auth Token no válidos, o cuenta suspendida. Revisa tu Twilio Console e inténtalo de nuevo.';

  @override
  String credentialsCheckError(Object error) {
    return 'No se pudieron verificar las credenciales (revisa tu conexión): $error';
  }

  @override
  String get noCallHistory => 'Sin historial de llamadas';

  @override
  String get couldNotLoadCallHistory =>
      'No se pudo cargar el historial de llamadas';

  @override
  String get retry => 'Reintentar';

  @override
  String failedToLoadCallHistory(Object error) {
    return 'Error al cargar el historial de llamadas: $error';
  }

  @override
  String get callTypeMissed => 'Perdida';

  @override
  String get callTypeIncoming => 'Entrante';

  @override
  String get callTypeOutgoing => 'Saliente';

  @override
  String get addToContacts => 'Añadir a contactos';

  @override
  String get message => 'Mensaje';

  @override
  String get call => 'Llamar';

  @override
  String get deleteFromHistory => 'Eliminar del historial';

  @override
  String get deleteCallConfirm =>
      '¿Eliminar permanentemente esta llamada de Twilio? Esta acción no se puede deshacer.';

  @override
  String get callDeleted => 'Llamada eliminada';

  @override
  String failedToDeleteCall(Object error) {
    return 'Error al eliminar la llamada: $error';
  }

  @override
  String durationHoursMinutes(Object hours, Object minutes) {
    return '$hours h $minutes min';
  }

  @override
  String durationMinutesSeconds(Object minutes, Object seconds) {
    return '$minutes min $seconds s';
  }

  @override
  String durationSeconds(Object seconds) {
    return '$seconds s';
  }

  @override
  String couldNotStartCall(Object number) {
    return 'No se pudo iniciar la llamada a $number';
  }

  @override
  String connectingTo(Object number) {
    return 'Conectando con $number…';
  }

  @override
  String failedToMakeCall(Object error) {
    return 'Error al realizar la llamada: $error';
  }

  @override
  String get contactsPermissionDenied =>
      'Se denegó el acceso a los contactos. Los nombres de contacto no se mostrarán hasta que se conceda el permiso en Ajustes > Aplicaciones.';

  @override
  String failedToSwitchNumber(Object error) {
    return 'Error al cambiar de número: $error';
  }

  @override
  String get incomingCallTitle => 'Llamada entrante';

  @override
  String incomingCallBody(Object name) {
    return 'De: $name';
  }

  @override
  String get newMessageTitle => 'Nuevo mensaje';

  @override
  String get newConversationTitle => 'Nueva conversación';

  @override
  String get phoneNumberOrContactHint =>
      'Número de teléfono o nombre de contacto';

  @override
  String get cancel => 'Cancelar';

  @override
  String get start => 'Iniciar';

  @override
  String get newConversationTooltip => 'Nueva conversación';

  @override
  String get contactsTitle => 'Contactos';

  @override
  String get searchContactsHint => 'Buscar contactos';

  @override
  String get noContactsFound => 'No se encontraron contactos';

  @override
  String get dialerTabLabel => 'Teclado';

  @override
  String get callsTabLabel => 'Llamadas';

  @override
  String get messagesTabLabel => 'Mensajes';

  @override
  String get settingsTabLabel => 'Ajustes';

  @override
  String get appBarTitleCallHistory => 'Historial de llamadas';

  @override
  String get appBarTitleDefault => 'Twilio Softphone';

  @override
  String get switchOutgoingNumberTooltip => 'Cambiar número saliente';

  @override
  String switchOutgoingNumberTooltipWithCurrent(Object number) {
    return 'Cambiar número saliente (actual: $number)';
  }

  @override
  String get somethingWentWrong => 'Algo salió mal';

  @override
  String failedToLoadMessages(Object error) {
    return 'Error al cargar los mensajes: $error';
  }

  @override
  String failedToLoadMoreMessages(Object error) {
    return 'Error al cargar más mensajes: $error';
  }

  @override
  String failedToSendMessage(Object error) {
    return 'Error al enviar el mensaje: $error';
  }

  @override
  String get delete => 'Eliminar';

  @override
  String get share => 'Compartir';

  @override
  String get copy => 'Copiar';

  @override
  String get copiedToClipboard => 'Copiado al portapapeles';

  @override
  String get deleteMessage => 'Eliminar mensaje';

  @override
  String get deleteConversation => 'Eliminar conversación';

  @override
  String get openConversation => 'Abrir conversación';

  @override
  String get deleteMessageConfirm =>
      '¿Eliminar permanentemente este mensaje de Twilio? Esta acción no se puede deshacer.';

  @override
  String deleteConversationConfirm(Object count) {
    return '¿Eliminar permanentemente toda esta conversación ($count mensajes) de Twilio? Esta acción no se puede deshacer.';
  }

  @override
  String get messageDeleted => 'Mensaje eliminado';

  @override
  String get conversationDeleted => 'Conversación eliminada';

  @override
  String failedToDeleteMessage(Object error) {
    return 'Error al eliminar el mensaje: $error';
  }

  @override
  String get noMessagesYet => 'Aún no hay mensajes';

  @override
  String get couldNotLoadMessages => 'No se pudieron cargar los mensajes';

  @override
  String get startAConversation => 'Iniciar una conversación';

  @override
  String get typeMessageHint => 'Escribe un mensaje...';

  @override
  String planUnavailableError(Object plan) {
    return 'El plan $plan no está disponible en la tienda en este momento. Inténtalo de nuevo más tarde.';
  }

  @override
  String couldNotLoadSubscription(Object error) {
    return 'No se pudo cargar el estado de la suscripción: $error';
  }

  @override
  String purchaseFailed(Object error) {
    return 'Error en la compra: $error';
  }

  @override
  String get purchaseCanceled => 'Compra cancelada';

  @override
  String get restorePurchases => 'Restaurar compras';

  @override
  String get purchasesRestored => 'Suscripción restaurada';

  @override
  String get noPurchasesToRestore =>
      'No se encontró ninguna suscripción activa para restaurar';

  @override
  String failedToUpdateMode(Object error) {
    return 'Error al actualizar el modo: $error';
  }

  @override
  String couldNotLoadPhoneNumbers(Object error) {
    return 'No se pudieron cargar los números de teléfono: $error';
  }

  @override
  String failedToUpdateNumberConfig(Object error) {
    return 'Error al actualizar la configuración del número: $error';
  }

  @override
  String get twilioAccountError =>
      'Revisa tu cuenta de Twilio por si hay problemas (suspensión, restricciones de prueba, credenciales no válidas).';

  @override
  String get noInternetConnection =>
      'Sin conexión a internet. Revisa tu wifi o tus datos móviles e inténtalo de nuevo.';

  @override
  String get logOut => 'Cerrar sesión';

  @override
  String get logOutConfirmMessage =>
      'Esto elimina tu Account SID y tu Auth Token de Twilio de este dispositivo. Puedes volver a conectarte en cualquier momento.';

  @override
  String get licenseTitle => 'Licencia';

  @override
  String get licensePlanMonthly =>
      'Licencia de Dialcrest — Suscripción mensual';

  @override
  String get licensePlanYearly => 'Licencia de Dialcrest — Suscripción anual';

  @override
  String get purchasingUnavailable =>
      'Las compras no están disponibles en esta plataforma.';

  @override
  String get trialExpired => 'Prueba caducada';

  @override
  String get subscriptionExpired => 'Suscripción caducada';

  @override
  String trialDaysLeft(num days) {
    String _temp0 = intl.Intl.pluralLogic(
      days,
      locale: localeName,
      other: 'días',
      one: 'día',
    );
    return 'Prueba: quedan $days $_temp0';
  }

  @override
  String renewsOn(Object date) {
    return 'Se renueva el $date';
  }

  @override
  String expiresOnAutoRenewOff(Object date) {
    return 'Caduca el $date — la renovación automática está desactivada';
  }

  @override
  String get monthly => 'Mensual';

  @override
  String get yearly => 'Anual';

  @override
  String get perMonthSuffix => '/mes';

  @override
  String get perYearSuffix => '/año';

  @override
  String get modeTitle => 'Modo';

  @override
  String get modeSubtitleVacation =>
      'Este dispositivo no sonará con las llamadas entrantes ni te avisará de nuevos mensajes.';

  @override
  String get modeSubtitleOnline =>
      'Este dispositivo suena con normalidad con las llamadas entrantes y te avisa de nuevos mensajes.';

  @override
  String get onlineMode => 'Modo en línea';

  @override
  String get vacationMode => 'Modo vacaciones';

  @override
  String get phoneNumberTitle => 'Número de teléfono';

  @override
  String get selectNumber => 'Selecciona un número';

  @override
  String get advancedTitle => 'Avanzado';

  @override
  String get outgoingTitle => 'Saliente';

  @override
  String get outgoingSubtitle =>
      'El número usado como identificador de llamada al hacer una llamada o enviar un mensaje.';

  @override
  String get noPhoneNumbersFound =>
      'No se encontraron números de teléfono en esta cuenta de Twilio.';

  @override
  String get incomingTitle => 'Entrante';

  @override
  String get incomingSubtitle =>
      'Solo los números marcados hacen sonar esta aplicación.';

  @override
  String moreResults(Object count) {
    return '$count resultados · Más resultados';
  }

  @override
  String get audioMessage => 'Mensaje de audio';

  @override
  String get attachment => 'Archivo adjunto';

  @override
  String get onboardingSkip => 'Omitir';

  @override
  String get onboardingNext => 'Siguiente';

  @override
  String get onboardingBack => 'Atrás';

  @override
  String get onboardingFinish => 'Finalizar';

  @override
  String onboardingStepLabel(Object current, Object total) {
    return 'Paso $current de $total';
  }

  @override
  String get onboardingWelcomeTitle => 'Bienvenido a Dialcrest';

  @override
  String get onboardingWelcomeBody =>
      'Vamos a configurarlo todo para que puedas hacer y recibir llamadas. Solo tarda un minuto, o puedes omitirlo y configurarlo más tarde en Ajustes.';

  @override
  String get onboardingPermissionsTitle => 'Permisos';

  @override
  String get onboardingPermissionsSubtitle =>
      'Dialcrest necesita algunos permisos para hacer llamadas y avisarte de las llamadas entrantes.';

  @override
  String get onboardingGrant => 'Conceder';

  @override
  String get onboardingGranted => 'Concedido';

  @override
  String get onboardingOpenSettings => 'Abrir ajustes';

  @override
  String get onboardingMicTitle => 'Micrófono';

  @override
  String get onboardingMicWhy =>
      'Necesario para que la otra persona pueda oírte durante una llamada.';

  @override
  String get onboardingMicHow =>
      'Toca Conceder y luego elige Permitir en el aviso que aparece.';

  @override
  String get onboardingMicDenied =>
      'Denegado. Abre Ajustes › Aplicaciones › Dialcrest › Permisos y activa el Micrófono.';

  @override
  String get onboardingNotificationsTitle => 'Notificaciones';

  @override
  String get onboardingNotificationsWhy =>
      'Para que se te avise cuando alguien te llame o te escriba.';

  @override
  String get onboardingNotificationsHow =>
      'Toca Conceder y luego elige Permitir notificaciones en el aviso.';

  @override
  String get onboardingNotificationsDenied =>
      'Denegado. Abre Ajustes › Aplicaciones › Dialcrest › Notificaciones y actívalas.';

  @override
  String get onboardingCallingAccountTitle => 'Teléfono y cuenta de llamadas';

  @override
  String get onboardingCallingAccountWhy =>
      'Android solo hace sonar esta aplicación para las llamadas entrantes cuando Dialcrest está activado como cuenta de llamadas.';

  @override
  String get onboardingCallingAccountStep1 => 'Toca Abrir ajustes más abajo.';

  @override
  String get onboardingCallingAccountStep2 =>
      'En la pantalla Cuentas de llamadas que se abre, busca Dialcrest.';

  @override
  String get onboardingCallingAccountStep3 =>
      'Activa el interruptor de Dialcrest.';

  @override
  String get onboardingCallingAccountStep4 =>
      'Pulsa atrás para volver aquí; este paso se pondrá verde cuando esté activado.';

  @override
  String get onboardingCallingAccountDenied =>
      'Aún no está activado. Abre Ajustes › Aplicaciones › Dialcrest › Cuentas de llamadas y activa Dialcrest.';

  @override
  String get onboardingNumberTitle => 'Tu número de teléfono';

  @override
  String get onboardingNumberChooseSubtitle =>
      'Elige el número de Twilio que usarás para hacer y recibir llamadas.';

  @override
  String onboardingNumberSingleInfo(Object number) {
    return 'Harás y recibirás llamadas en $number.';
  }

  @override
  String get onboardingNumberNone =>
      'No se encontraron números de teléfono en tu cuenta de Twilio. Compra un número compatible con voz en la Twilio Console y luego vuelve e inténtalo de nuevo.';

  @override
  String get onboardingBuyNumber => 'Abrir la Twilio Console';

  @override
  String onboardingConfiguringNumber(Object number) {
    return 'Configurando $number para recibir llamadas…';
  }

  @override
  String onboardingNumberSetupFailed(Object error) {
    return 'No se pudo terminar de configurar las llamadas entrantes: $error';
  }

  @override
  String get onboardingDoneTitle => 'Todo listo';

  @override
  String onboardingDoneBody(Object number) {
    return 'Ya puedes recibir llamadas en $number.';
  }

  @override
  String get onboardingDoneBodyNoNumber =>
      'Añade un número de teléfono en Ajustes cuando quieras empezar a recibir llamadas.';

  @override
  String get onboardingDoneTitleIncomplete => 'Casi listo';

  @override
  String get onboardingDoneIncompleteIntro =>
      'Puedes finalizar ahora, pero lo siguiente todavía necesita tu atención antes de poder hacer y recibir llamadas:';

  @override
  String get onboardingDoneIncompleteHint =>
      'Vuelve atrás para configurarlo ahora, o hazlo más tarde en Ajustes.';
}
