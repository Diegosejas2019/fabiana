# Spec 008 - Motor de Respuesta con Fuentes

## Objetivo

Crear un paquete de respuesta basado solo en recuerdos recuperados localmente.

Esta etapa todavia no intenta imitar la voz de la persona. Primero garantiza que una pregunta produzca evidencia trazable y una conclusion prudente.

## Entradas

- Consulta del usuario.
- `data/processed/memory/chunks.jsonl`
- `data/processed/rag/embeddings.npy`
- `data/processed/rag/embedding-metadata.jsonl`

## Salidas

Un JSON privado opcional dentro de `data/processed/answers/`:

```json
{
  "query": "te acordas de Cordoba?",
  "confidence": "medium",
  "draft": "Encontre algunos recuerdos relacionados...",
  "evidenceCount": 8,
  "sources": []
}
```

## Reglas

- No inventar recuerdos.
- Si no hay evidencia suficiente, responder que no hay recuerdos suficientes.
- Devolver siempre fuentes: `messageId`, fecha, rol, tipo de fuente y evidencia.
- No imprimir texto privado salvo con `--show-text`.
- Filtrar por `targetPerson` por defecto para evitar mezclar estilo de otras personas.

## Niveles de evidencia

- `high`: score alto y varios recuerdos relevantes.
- `medium`: recuerdos relacionados pero no concluyentes.
- `none`: no hay evidencia suficiente.

## Criterios de aceptación

- Genera un borrador prudente.
- Guarda un paquete de respuesta opcional.
- Las fuentes conservan evidencia.
- Puede incluir texto privado solo bajo bandera explícita.

