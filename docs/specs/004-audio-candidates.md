# Spec 004 - Inventario de Audios Candidatos

## Objetivo

Preparar una lista local de audios candidatos para transcripción sin extraer archivos pesados ni llamar a proveedores externos.

## Entradas

- `data/processed/ingest/messages.jsonl`

## Salidas

En un directorio privado dentro de `data/processed/`:

- `audio-candidates.jsonl`: un audio candidato por línea.
- `audio-manifest.json`: resumen sin texto de mensajes.

## Registro candidato

```json
{
  "id": "audio_msg_000123",
  "messageId": "msg_000123",
  "timestamp": "2024-01-01T04:13:00.000Z",
  "localDate": "1/1/2024",
  "localTime": "01:13",
  "role": "targetPerson",
  "participantId": "participant_target",
  "filename": "PTT-20240101-WA0018.opus",
  "extension": "opus",
  "zipEntryName": "PTT-20240101-WA0018.opus",
  "bytes": 64507,
  "mediaStatus": "matched",
  "priority": 100,
  "source": {
    "messageId": "msg_000123",
    "lineStart": 120,
    "lineEnd": 120
  }
}
```

## Prioridad inicial

- `100`: audio disponible de `targetPerson`.
- `60`: audio disponible de `self`.
- `40`: audio disponible de `other`.
- `0`: audio faltante o no usable.

## Criterios de aceptación

- Solo incluye extensiones de audio soportadas: `.opus`, `.ogg`, `.m4a`.
- No incluye cuerpos de mensajes.
- Conserva referencia al mensaje original.
- Produce conteos por rol, extension y estado.
- No extrae archivos del ZIP ni transcribe audio.

