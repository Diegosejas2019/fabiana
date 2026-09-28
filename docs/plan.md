# Plan de Desarrollo

## MVP 1

Objetivo: importar WhatsApp, reconocer autores, vincular multimedia y permitir consultas futuras con fuentes reales.

### Etapa 0 - Base

- Crear estructura del proyecto.
- Definir reglas de privacidad.
- Agregar tests mínimos.
- Documentar decisiones.

### Etapa 1 - Parser WhatsApp

- Leer el `.txt` exportado.
- Parsear fecha, hora, autor y contenido.
- Soportar mensajes multilínea.
- Detectar mensajes de sistema.
- Detectar referencias a archivos multimedia.
- Permitir autor vacío o desconocido.

### Etapa 2 - Inventario Multimedia

- Leer el ZIP sin extraer todo por defecto.
- Inventariar audios, imágenes, videos, contactos y documentos.
- Vincular referencias del chat con entradas del ZIP.

### Etapa 2b - Ingesta Normalizada

- Convertir mensajes parseados a JSONL privado.
- Asignar roles `targetPerson`, `self`, `other` y `system`.
- Guardar participantes detectados.
- Guardar manifest con conteos y rango temporal.
- Reportar medios faltantes sin exponer cuerpos de mensajes.

### Etapa 3 - Pipeline de Audios

- Detectar mensajes con audios `.opus`, `.ogg` y `.m4a`.
- Crear inventario de candidatos para transcripción.
- Priorizar audios de la persona objetivo.
- No extraer ni transcribir audios hasta elegir metodo.

### Etapa 4 - Preparación de Transcripción

- Extraer solo audios necesarios.
- Crear lote de transcripción con estado `pending`.
- Verificar herramientas locales disponibles.
- Transcribir localmente o con proveedor elegido explícitamente en una etapa posterior.
- Guardar transcripción vinculada al mensaje original.

## Después del MVP 1

- RAG con fuentes.
- Sistema anti-alucinaciones.
- Interfaz tipo chat.
- Estilo personal.
- Voz sintetizada marcada como tal.
