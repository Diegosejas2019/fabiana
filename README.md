# Memoria AI

Proyecto local para construir una memoria conversacional privada a partir de exportaciones reales de WhatsApp y notas de voz.

## Principios

- El material original queda local.
- Cada respuesta futura debe poder mostrar sus fuentes reales.
- El sistema debe distinguir entre recuerdo encontrado, inferencia y falta de evidencia.
- La voz sintetizada, si se agrega, debe quedar marcada como síntesis.

## Etapas actuales

1. Base del proyecto y reglas de trabajo.
2. Parser de WhatsApp con soporte para mensajes multilínea, sistema, multimedia y autores.

La IA, embeddings, transcripción y voz quedan fuera del primer bloque.

## Comandos

```bash
npm test
```

Para resumir un export ya extraído:

```bash
npm run parse:summary -- data/raw/chat.txt
```

Para crear una ingesta normalizada privada:

```bash
npm run ingest -- data/raw/chat.txt data/processed/zip-inventory.json data/processed/ingest --target "Fabiana Sejas" --self-label "Diego"
```

La salida queda en `data/processed/ingest`, que esta ignorado por git.

Para preparar el inventario de audios candidatos:

```bash
npm run audio:inventory -- data/processed/ingest/messages.jsonl data/processed/audio
```

Esto no transcribe ni extrae audios; solo prepara metadata privada para decidir el siguiente paso.

Para extraer solo audios candidatos desde el ZIP:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\extract-audio-candidates.ps1 -ZipPath "C:\Users\Diego\Downloads\Chat de WhatsApp con Fabiana Sejas.zip" -CandidatesPath data/processed/audio/audio-candidates.jsonl -OutputDir data/processed/audio/extracted-target -Role targetPerson
```

Para preparar el lote de transcripcion local:

```bash
npm run transcription:batch -- data/processed/audio/audio-candidates.jsonl data/processed/audio/extracted-target/extraction-manifest.json data/processed/transcription
```

Esto deja trabajos en estado `pending`; no llama a ningun proveedor externo.

Para transcribir localmente con `faster-whisper`:

```bash
npm run transcription:run-local -- --jobs data/processed/transcription/transcription-jobs.jsonl --model tiny --limit 1
```

El comando guarda transcripciones privadas en `data/processed/transcription/items`. La salida de consola solo muestra conteos.
