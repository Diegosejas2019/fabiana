# 010 - Perfil de estilo

## Objetivo

Construir una capa separada para aproximar la forma de hablar de la persona objetivo sin usar ese perfil como fuente de hechos.

## Entradas

- `data/processed/memory/memories.jsonl`
- rol objetivo, por defecto `targetPerson`

## Salida privada

- `data/processed/persona/persona-style.json`

## Reglas

- El perfil resume longitud tipica, palabras frecuentes, frases frecuentes, emojis y pistas de tono.
- El perfil no debe decidir recuerdos, fechas, pedidos ni eventos.
- El motor de respuesta puede usarlo para redaccion, pero debe tomar los hechos desde fuentes recuperadas.
- La UI puede mostrar que el perfil esta activo mediante conteos, sin exponer el contenido del perfil.

## Comando

```bash
npm run persona:style -- data/processed/memory/memories.jsonl data/processed/persona/persona-style.json --role targetPerson --sample-size 600
```
