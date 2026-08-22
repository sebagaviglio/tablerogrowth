/* ============================================================
   Agregar esto al Apps Script que YA tenés desplegado como Web App
   (el mismo que expone doGet ?tab=... para el resto del tablero).
   NO reemplaza nada existente — es una función nueva, aparte.

   Qué hace: cuando api/growth-report.js le manda un POST con los
   comentarios/insights que cargaron los PO antes de generar el
   informe semanal, esta función los agrega como filas nuevas en una
   pestaña "Comentarios PO" del mismo Sheet (la crea sola la primera
   vez si no existe).

   Una vez que exista esa pestaña, NO hace falta tocar nada más para
   poder leerla: el doGet genérico que ya tenés (?tab=Comentarios PO)
   la sirve como CSV igual que cualquier otra pestaña — por eso
   growth-data.js puede leer comentarios de semanas anteriores sin
   código nuevo del lado de Google.

   Pasos:
   1. En el Sheet: Extensiones → Apps Script.
   2. Pegá esta función al final del archivo (no borres lo que ya
      tenías — si ya existe un doPost en tu script, hay que fusionar
      la lógica a mano en vez de pegar esto tal cual, avisame si es
      el caso).
   3. Implementar → Administrar implementaciones → ✏️ (editar la
      implementación existente) → Nueva versión → Implementar.
      (Tiene que ser una versión NUEVA de la MISMA implementación
      para que la URL /exec que ya tenés en Vercel siga funcionando).
   ============================================================ */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action !== 'saveWeeklyComments') {
      return ContentService
        .createTextOutput('ERROR: acción desconocida')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Comentarios PO');
    if (!sheet) {
      sheet = ss.insertSheet('Comentarios PO');
      sheet.appendRow(['Fecha de registro', 'Semana del informe', 'Squad', 'Comentario del PO']);
      sheet.setFrozenRows(1);
    }

    var comments = body.comments || [];
    comments.forEach(function (c) {
      sheet.appendRow([new Date(), body.weekLabel || '', c.squad || '', c.texto || '']);
    });

    return ContentService
      .createTextOutput('OK: ' + comments.length + ' comentario(s) guardado(s)')
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    return ContentService
      .createTextOutput('ERROR: ' + err.message)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}
