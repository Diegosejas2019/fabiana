# Spec 006 - Construcción de Memoria

## Objetivo

Unificar mensajes escritos y audios transcritos en registros de memoria con fuente verificable.

## Entradas

- `data/processed/ingest/messages.jsonl`
- `data/processed/transcription/items-small/*.json`

## Salidas

En un directorio privado dentro de `data/processed/`:

- `memories.jsonl`: un recuerdo textual por línea.
- `memory-manifest.json`: resumen sin cuerpos de mensajes.

## Registro de memoria

```json
{
  "id": "mem_msg_000123_audio",
  "messageId": "msg_000123",
  "timestamp": "2024-01-01T04:13:00.000Z",
  "localDate": "1/1/2024",
  "localTime": "01:13",
  "role": "targetPerson",
  "participantId": "participant_target",
  "sourceType": "audio_transcript",
  "text": "Contenido privado",
  "textLength": 16,
  "eligibleForPersona": true,
  "evidence": {
    "kind": "audio_transcript",
    "messageId": "msg_000123",
    "transcriptPath": "data/processed/transcription/items-small/audio_msg_000123.json",
    "source": {
      "lineStart": 120,
      "lineEnd": 120
    }
  }
}
```

## Reglas

- No incluir mensajes de sistema.
- Usar transcripción de audio cuando exista.
- Incluir mensajes escritos que tengan texto útil.
- Marcar `eligibleForPersona` solo para `targetPerson`.
- Preservar evidencia y referencia de fuente.
- No imprimir texto privado en consola.

## Criterios de aceptación

- Genera memoria para mensajes escritos y audios transcritos.
- El manifest resume por rol y tipo de fuente.
- Tests cubren que se prefiera transcript para audio y que se omitan sistemas.

## Chunking

Antes de embeddings/RAG, `memories.jsonl` se transforma en `chunks.jsonl`.

Reglas iniciales:

- cada chunk conserva `memoryId`, `messageId`, `role`, `sourceType` y `evidence`;
- textos cortos producen un solo chunk;
- textos largos se dividen por longitud con solapamiento;
- no se generan embeddings en esta etapa.

