# Spec 009 - Interfaz Local de Chat

## Objetivo

Crear una interfaz local para consultar la memoria y revisar fuentes usadas.

## Requisitos

- Correr en `localhost`.
- No depender de servicios externos.
- Usar el índice local de `data/processed/rag`.
- Mostrar confianza y fuentes.
- Permitir expandir recuerdos usados.
- Mantener evidencia: `messageId`, fecha, rol, tipo de fuente y score.

## Fuera de alcance

- Login.
- Deployment.
- Generación con LLM.
- Voz sintetizada.

## Criterios de aceptación

- La pantalla carga en navegador.
- Se puede enviar una pregunta.
- La API local devuelve borrador y fuentes.
- Se pueden expandir fuentes en la UI.
- No hay errores de consola críticos.

