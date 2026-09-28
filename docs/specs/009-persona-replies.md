# 009 - Respuestas persona con fuentes

## Objetivo

La interfaz debe responder con una sintesis conversacional atribuida a la persona objetivo, no con el texto tecnico del recuperador.

## Reglas

- Usar mensajes y transcripciones de `targetPerson` como evidencia de hechos.
- Usar esos mismos textos como guia de estilo cuando se genere una respuesta nueva.
- No inventar recuerdos, pedidos, promesas, fechas ni hechos que no esten apoyados por fuentes recuperadas.
- Mantener las fuentes visibles para auditoria.
- Marcar la respuesta como sintesis.
- Si no hay evidencia suficiente, responder con cautela en vez de fabricar contenido.

## Generacion

- `reply` contiene la respuesta final para la UI.
- `draft` queda como diagnostico tecnico del motor.
- Si Ollama esta disponible, se usa un LLM local con las fuentes recuperadas en el prompt.
- Si Ollama no esta disponible, se usa un generador local `fallback`.
