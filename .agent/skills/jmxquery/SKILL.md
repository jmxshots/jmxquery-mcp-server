---
name: "JMXQuery Agent Skill"
description: "Spezialisierter Skill für JMXQuery-Abfragen und Business Central Integration."
---
# JMXQuery Agent Skill

Dieser Skill formalisiert den Zugriff auf den JMXQuery MCP-Server und Business Central.

## Kernprinzipien
- Alle Datenzugriffe erfolgen über JMXQuery-Skripte.
- Sicherheit: Frage IMMER nach dem `executionContextCode`, wenn dieser nicht eindeutig ist.
- Validierung: Nutze Schema-Informationen (`describeTableFields`) vor jeder Abfrage.

## Workflow
1. **Discovery**: Nutze `jmxq_describeExecutionContext` für verfügbare Tabellen.
2. **Analysis**: Nutze `jmxq_describeTableFields` für Felddefinitionen.
3. **Synthesis**: Erstelle Skripte gemäß der `jmxq_getGrammar`.
4. **Execution**: Führe Skripte mit `jmxq_executeScript` aus.

## Syntax-Check
Stelle sicher, dass:
- Aliase verwendet werden (`FROM Table AS alias`).
- Feldnamen in Anführungszeichen stehen (`alias."Field"`).
- Filter-Logik korrekt ist (FLOWFILTER für FlowFilter, FILTER für Rest).
