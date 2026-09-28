# Spec 003 - Ingesta Normalizada

## Objetivo

Convertir el chat parseado y el inventario multimedia en archivos internos preparados para futuras etapas de memoria semántica, transcripción y UI.

## Entradas

- `data/raw/chat.txt`
- `data/processed/zip-inventory.json`
- Nombre de la persona objetivo, por ejemplo `Fabiana Sejas`
- Etiqueta opcional para el autor vacío/self

## Salidas

En un directorio privado dentro de `data/processed/`:

- `messages.jsonl`: un mensaje normalizado por línea.
- `participants.json`: participantes y roles detectados.
- `manifest.json`: resumen de ingesta sin cuerpos de mensajes.
- `media-missing.json`: referencias a medios que no están presentes en el ZIP.

## Registro normalizado

```json
{
  "id": "msg_000001",
  "kind": "message",
  "timestamp": "2023-12-31T16:09:00.000Z",
  "localDate": "31/12/2023",
  "localTime": "13:09",
  "participantId": "participant_target",
  "role": "targetPerson",
  "author": "Fabiana Sejas",
  "text": "Contenido privado",
  "textLength": 16,
  "media": null,
  "source": {
    "format": "whatsapp_export",
    "lineStart": 10,
    "lineEnd": 10
  }
}
```

## Roles

- `targetPerson`: la persona cuya memoria se quiere construir.
- `self`: mensajes propios cuando WhatsApp exporta autor vacío.
- `other`: otros participantes si aparecen.
- `system`: avisos de WhatsApp.

## Criterios de aceptación

- La ingesta genera todos los archivos esperados.
- El manifest no contiene cuerpos de mensajes.
- `messages.jsonl` conserva texto privado para futuras etapas locales.
- Cada mensaje tiene rol y referencia de fuente.
- Cada medio queda marcado como `matched` o `missing`.

