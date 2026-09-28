# Spec 001 - Base del Proyecto

## Objetivo

Crear una base local, simple y verificable para desarrollar el proyecto por etapas.

## Decisiones iniciales

- Usar Node.js para herramientas de ingesta y parsing.
- Mantener datos reales en `data/`, ignorados por git.
- Usar `node:test` para evitar dependencias innecesarias en la primera etapa.
- Documentar privacidad y flujo de trabajo en `AGENTS.md`.

## Criterios de aceptación

- Existe `package.json` raíz.
- Existe `AGENTS.md`.
- Existe `.gitignore` para datos reales.
- Existe al menos una spec posterior para el parser.
- `npm test` funciona.

