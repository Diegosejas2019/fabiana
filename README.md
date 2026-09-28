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
