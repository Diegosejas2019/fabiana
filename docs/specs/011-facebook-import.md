# 011 - Importacion Facebook/Messenger

## Objetivo

Sumar chats de Facebook/Messenger donde participa Fabiana Sejas a la memoria local, sin reemplazar la fuente de WhatsApp.

## Entrada

- ZIP de exportacion de Facebook.
- Nombre objetivo: `Fabiana Sejas`.
- Nombre propio: `Diego Sejas`.

## Salida privada

- `data/processed/facebook/messages.jsonl`
- `data/processed/facebook/memories.jsonl`
- `data/processed/facebook/manifest.json`

## Reglas

- Importar hilos donde la persona objetivo figure como participante o titulo directo.
- Mantener roles: `targetPerson`, `self`, `other`.
- Usar `sourceType=facebook_text` para no confundirlo con WhatsApp.
- No exponer cuerpos de mensajes en consola.
- Fusionar con otras fuentes en `data/processed/combined-memory`.

## Flujo

```powershell
npm run facebook:import -- -ZipPath "<backup-facebook.zip>" -OutputDir data/processed/facebook -TargetName "Fabiana Sejas" -SelfName "Diego Sejas"
```

```bash
npm run memory:merge -- data/processed/combined-memory/memories.jsonl data/processed/memory/memories.jsonl data/processed/facebook/memories.jsonl
npm run memory:chunk -- data/processed/combined-memory/memories.jsonl data/processed/combined-memory
npm run rag:embed -- --chunks data/processed/combined-memory/chunks.jsonl --output-dir data/processed/combined-rag
npm run persona:style -- data/processed/combined-memory/memories.jsonl data/processed/persona/persona-style.json --role targetPerson --sample-size 900
```
