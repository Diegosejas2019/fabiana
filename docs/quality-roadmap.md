# Roadmap de calidad de respuestas

## Etapa 1: evaluacion repetible

Objetivo: convertir errores observados por Diego en casos de prueba locales.

- Detectar sujeto invertido en temas de salud.
- Evitar que tokens de la pregunta se tomen como nombres propios.
- Verificar preferencias confirmadas.
- Evitar respuestas con formato de reporte o citas cuando se pide una conversacion.

Comando:

```bash
npm run quality:evaluate
```

Los resultados privados se escriben en `data/processed/evaluations`.

## Etapa 2: busqueda mas precisa

Objetivo: mejorar las fuentes antes de generar la respuesta.

- Recuperar mas candidatos iniciales.
- Combinar busqueda semantica, palabras exactas y fechas.
- Reordenar candidatos con reglas locales o un reranker opcional.
- Dar prioridad temporal cuando la pregunta diga "ultimo", "reciente" o "ultimo año".

## Etapa 3: validador de respuesta

Objetivo: revisar la respuesta antes de mostrarla.

- Detectar contradicciones con datos confirmados.
- Detectar citas textuales no solicitadas.
- Detectar tono de reporte.
- Reintentar o degradar a una respuesta prudente si falla.

## Etapa 4: aprendizaje con aprobaciones

Objetivo: usar feedback de Diego para mejorar sin mezclar recuerdos.

- Guardar respuestas aprobadas como ejemplos de calidad.
- Agregar rechazos con motivo.
- Permitir correccion manual de una respuesta mala.
- Usar aprobaciones como ejemplos de estilo, no como hechos nuevos.

## Etapa 5: proveedores externos opcionales

Objetivo: sumar calidad generativa sin perder control local.

- Mantener Ollama como modo local.
- Agregar selector de proveedor: local, OpenAI, Gemini o Claude.
- Usar servicios externos solo para generacion o reranking, segun configuracion.
- Requerir claves por `.env`, sin subir datos ni claves al repositorio.
