# Reglas para Codex

Este proyecto trabaja con material personal y sensible.

## Privacidad

- No imprimir mensajes completos del chat en respuestas, logs o documentación.
- Usar estadísticas, conteos y fragmentos sintéticos para tests.
- Mantener `data/raw`, `data/processed` y archivos multimedia fuera de commits futuros.
- No enviar el archivo de WhatsApp, audios, imágenes ni transcripciones a servicios externos sin una decisión explícita.

## Desarrollo

- Implementar una etapa por vez.
- Leer primero la spec correspondiente en `docs/specs`.
- Agregar o actualizar tests por cada cambio de comportamiento.
- No avanzar a voz, RAG o UI hasta que el parser y la ingesta estén verificados.

## Calidad de memoria

- Preservar siempre la referencia al mensaje original.
- Guardar evidencia usada para cualquier respuesta generada en etapas futuras.
- Si no hay evidencia suficiente, el sistema debe poder decirlo.

