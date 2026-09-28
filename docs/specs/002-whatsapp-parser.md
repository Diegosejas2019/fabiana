# Spec 002 - Parser de WhatsApp

## Objetivo

Transformar el archivo `.txt` exportado por WhatsApp en registros normalizados.

## Formato observado

```text
30/12/2023, 18:50 - Mensaje de sistema
31/12/2023, 13:09 - Fabiana Sejas: Mensaje
31/12/2023, 11:49 - : Mensaje con autor vacío
```

## Registro normalizado

```json
{
  "id": "msg_000001",
  "kind": "message",
  "timestamp": "2023-12-31T16:09:00.000Z",
  "localDate": "31/12/2023",
  "localTime": "13:09",
  "author": "Fabiana Sejas",
  "body": "Mensaje",
  "media": null,
  "sourceLineStart": 10,
  "sourceLineEnd": 10
}
```

## Requisitos

- Soportar fechas `d/m/yyyy` y `dd/mm/yyyy`.
- Soportar hora de 24 horas.
- Soportar mensajes multilínea.
- Soportar mensajes de sistema sin autor.
- Soportar autor vacío como `null`.
- Detectar referencias a medios comunes: `.opus`, `.ogg`, `.m4a`, `.jpg`, `.jpeg`, `.png`, `.webp`, `.mp4`, `.pdf`, `.vcf`.
- Comparar medios referenciados en el chat contra entradas presentes en el ZIP.
- No imprimir contenidos reales por defecto en herramientas de resumen.

## Criterios de aceptación

- Tests cubren mensajes normales, multilínea, sistema, autor vacío y multimedia.
- El parser puede procesar el chat real y producir estadísticas.
- La verificación de medios informa coincidencias y faltantes sin mostrar cuerpos de mensajes.
- El resumen no expone cuerpos de mensajes.
