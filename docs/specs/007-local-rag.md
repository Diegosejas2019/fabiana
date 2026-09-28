# Spec 007 - Embeddings y Busqueda Local

## Objetivo

Crear un índice vectorial local a partir de `chunks.jsonl` y permitir búsquedas semánticas con evidencia.

## Entradas

- `data/processed/memory/chunks.jsonl`

## Salidas

En un directorio privado dentro de `data/processed/`:

- `embeddings.npy`: matriz local de vectores.
- `embedding-metadata.jsonl`: metadata por vector, sin duplicar texto.
- `embedding-manifest.json`: resumen del índice.

## Modelo

Modelo inicial:

`minishlab/potion-multilingual-128M`

Razones:

- multilingüe;
- corre local con ONNX/FastEmbed;
- vectores pequeños de 256 dimensiones;
- no requiere enviar recuerdos a APIs externas.

## Busqueda

La búsqueda debe:

- calcular embedding local de la consulta;
- hacer similitud coseno contra `embeddings.npy`;
- devolver `chunkId`, `memoryId`, `messageId`, score y evidencia;
- permitir filtrar por rol y tipo de fuente;
- no imprimir texto privado salvo con `--show-text`.

## Criterios de aceptación

- El índice cubre todos los chunks.
- El manifest incluye modelo, dimensión y conteos.
- Una búsqueda local devuelve resultados con evidencia.
- Tests existentes siguen pasando.
