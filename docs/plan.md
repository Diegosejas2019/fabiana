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

### Etapa 3 - Transcripción

- Extraer solo audios necesarios.
- Transcribir localmente o con proveedor elegido explícitamente.
- Guardar transcripción vinculada al mensaje original.

## Después del MVP 1

- RAG con fuentes.
- Sistema anti-alucinaciones.
- Interfaz tipo chat.
- Estilo personal.
- Voz sintetizada marcada como tal.

