# Spec 005 - Preparación de Transcripción

## Objetivo

Extraer localmente los audios priorizados y preparar un lote de transcripción sin enviar audio a servicios externos.

## Entradas

- `data/processed/audio/audio-candidates.jsonl`
- ZIP original exportado de WhatsApp
- Rol a extraer, por defecto `targetPerson`

## Salidas

Archivos privados dentro de `data/processed/`:

- audios extraídos localmente
- `extraction-manifest.json`
- `transcription-jobs.jsonl`
- `transcription-manifest.json`

## Registro de trabajo de transcripción

```json
{
  "id": "transcript_audio_msg_000123",
  "audioCandidateId": "audio_msg_000123",
  "messageId": "msg_000123",
  "role": "targetPerson",
  "localAudioPath": "data/processed/audio/extracted-target/PTT-20240101-WA0018.opus",
  "status": "pending",
  "engine": null,
  "language": "es",
  "transcriptPath": "data/processed/transcription/items/audio_msg_000123.json",
  "source": {
    "messageId": "msg_000123",
    "lineStart": 120,
    "lineEnd": 120
  }
}
```

## Requisitos

- No imprimir ni guardar cuerpos de mensajes en archivos de transcripción pendientes.
- No extraer audios que no estén en el inventario como `matched`.
- Mantener referencia al mensaje original.
- Permitir correr primero solo audios de `targetPerson`.
- No invocar APIs externas sin una decisión explícita.

## Criterios de aceptación

- El script de extracción genera manifest con conteos.
- El lote de transcripción genera un job por audio extraído.
- Los jobs quedan en estado `pending`.
- Tests cubren la generación del lote sin texto privado.

## Transcripción local

La transcripción local usa `faster-whisper` dentro de `.venv`. El modelo puede descargarse desde Hugging Face, pero los audios no se suben a proveedores externos.

El runner debe:

- leer `transcription-jobs.jsonl`;
- procesar solo jobs `pending`;
- permitir `--limit` para smoke tests;
- guardar cada resultado en `items/<audioCandidateId>.json`;
- guardar `transcription-run-manifest.json`;
- no imprimir el texto transcripto en consola.

