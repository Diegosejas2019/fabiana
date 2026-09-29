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

Para correr otro modelo sin pisar resultados:

```bash
npm run transcription:run-local -- --jobs data/processed/transcription/transcription-jobs.jsonl --model small --items-dir-name items-small --manifest-name transcription-run-small.json
```

Para comparar dos pasadas sin imprimir transcripciones:

```bash
npm run transcription:compare -- data/processed/transcription/items data/processed/transcription/items-small
```

Para crear memoria normalizada usando las transcripciones `small`:

```bash
npm run memory:build -- data/processed/ingest/messages.jsonl data/processed/transcription/items-small data/processed/memory
```

Esto genera `memories.jsonl` y `memory-manifest.json`, ambos privados e ignorados por git.

Para importar mensajes de Facebook/Messenger de Fabiana:

```powershell
npm run facebook:import -- -ZipPath "C:\Users\Diego\Downloads\facebook-DiegoSejas11-28_09_2026-KRVypEGw.zip" -OutputDir data/processed/facebook -TargetName "Fabiana Sejas" -SelfName "Diego Sejas"
```

Para combinar WhatsApp + Facebook:

```bash
npm run memory:merge -- data/processed/combined-memory/memories.jsonl data/processed/memory/memories.jsonl data/processed/facebook/memories.jsonl
```

La interfaz local usa `data/processed/combined-memory` y `data/processed/combined-rag` automaticamente cuando existen; si no existen, vuelve a la memoria original de WhatsApp.

Para preparar chunks para embeddings/RAG:

```bash
npm run memory:chunk -- data/processed/memory/memories.jsonl data/processed/memory
```

Esto genera `chunks.jsonl` y `chunk-manifest.json`.

Para crear el perfil de estilo de la persona objetivo:

```bash
npm run persona:style -- data/processed/memory/memories.jsonl data/processed/persona/persona-style.json --role targetPerson --sample-size 600
```

Esto genera un perfil privado con rasgos de forma de hablar. El perfil se usa solo como guia de estilo; los hechos siguen viniendo de fuentes recuperadas.
Si ya combinaste WhatsApp + Facebook, usa `data/processed/combined-memory/memories.jsonl` como entrada.

Para guardar datos confirmados por Diego desde la app local, escribe una frase con intencion de guardado:

```text
dato: los hijos de Fabiana se llaman ...
recorda que ...
te confirmo que ...
```

La app guarda esos datos como `user_assertion`, los convierte en memoria privada, recompone `data/processed/combined-memory` y vuelve a crear embeddings. Esos datos aparecen como fuente manual confirmada y se usan para preguntas de hechos basicos, pero no se usan como muestra de estilo de Fabiana.

Para crear embeddings locales:

```bash
npm run rag:embed -- --chunks data/processed/memory/chunks.jsonl --output-dir data/processed/rag
```

Para buscar recuerdos:

```bash
npm run rag:search -- --query "vacaciones en Cordoba" --chunks data/processed/memory/chunks.jsonl --index-dir data/processed/rag --top-k 8
```

Por defecto la búsqueda no imprime texto privado; agrega `--show-text` si quieres inspeccionar resultados.
Puedes filtrar con `--role targetPerson` y `--source-type audio_transcript`.

Para preparar una respuesta con fuentes:

```bash
npm run answer:draft -- --query "te acordas de Cordoba?" --chunks data/processed/memory/chunks.jsonl --index-dir data/processed/rag --output data/processed/answers/cordoba.json
```

El motor clasifica la evidencia, guarda fuentes y devuelve `reply` como respuesta sintetizada de persona. `draft` queda como diagnostico tecnico.
Por defecto no imprime texto privado en consola.

Si Ollama esta disponible en `http://localhost:11434`, el motor intenta usar un LLM local para redactar `reply` con los mensajes recuperados como hechos y guia de estilo. Si no hay Ollama o el modelo no responde, vuelve al generador local `fallback`.

Modelos locales sugeridos:

```powershell
ollama run llama3.2
```

Tambien puedes probar `qwen2.5` o `gemma3` cambiando el modelo:

```powershell
$env:OLLAMA_MODEL="qwen2.5"
npm run chat:local
```

Para abrir la interfaz local:

```bash
npm run chat:local
```

Luego abre `http://localhost:4173`.
