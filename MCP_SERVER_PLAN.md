# Plan: JMX-QUERY MCP Server (Node.js/TypeScript) - Final Implementation

Dieses Dokument beschreibt die tatsächlich umgesetzte Architektur des JMX-QUERY MCP Servers.

## 0) Rahmenbedingungen (Status: Implementiert)

- **OS**: Windows
- **Transport**: **Dual-Mode** (Gleichzeitig Stdio + SSE/HTTP)
  - **Stdio**: Für Claude Desktop, Cline, Roo Code.
  - **SSE (HTTP)**: Für Cursor, React Test-Client, Remote-Zugriff.
- **BC Auth Support**:
  - **SSO**: Über PowerShell Bridge (Invoke-RestMethod -UseDefaultCredentials).
  - **NTLM**: Über `node-client-ntlm`.
  - **BASIC**: Über Standard HTTP `Authorization` Header.
- **Logging**: Alle System-Logs werden nach `stderr` umgeleitet, um den Stdio-Kanal für JSON-RPC freizuhalten.

---

## 1) API-Konfiguration (ENV)

Die Konfiguration erfolgt über die `.env` Datei oder Umgebungsvariablen:

- `BC_ODATA_BASE_URL`: Basis-URL zum ODataV4 Service (z.B. `http://server:7048/BC/ODataV4/`).
- `BC_COMPANY`: Der BC Mandant.
- `BC_AUTH_TYPE`: `SSO`, `NTLM` oder `BASIC`.
- `BC_USERNAME` / `BC_PASSWORD`: Erforderlich bei NTLM/BASIC.
- `MCP_PORT`: Standardmäßig `4000`.
- `LOG_LEVEL`: `info`, `debug`, `error`.

---

## 2) Implementierte Komponenten

### 2.1 Server (`src/index.ts`)
Nutzt **Fastify 5** für den HTTP/SSE Teil.
- **SSE Endpoint**: `GET /mcp/sse` (Hijacks the response for raw event-stream control).
- **Message Endpoint**: `POST /mcp/messages` (Standard JSON-RPC POST).
- **Stdio**: Startet parallel den `StdioServerTransport` für KI-Agenten.

### 2.2 BC Client (`src/bcClient.ts`)
- Behandelt das **"Double JSON Parse"** Problem: OData-Methoden liefern oft einen JSON-String innerhalb des `value`-Keys zurück. Der Client extrahiert und parst diesen automatisch.
- **PowerShell Bridge**: Führt für SSO-Calls ein PowerShell-Skript im Hintergrund aus (Base64-kodiert), um NT-Authentifizierung sauber zu handhaben.

---

## 3) Bereitgestellte Tools

| Tool Name | Beschreibung | BC Action |
| :--- | :--- | :--- |
| `jmxq_getGrammar` | Holt die aktuelle JMXQuery EBNF Grammatik. | `GetGrammar` |
| `jmxq_getExamples` | Zeigt Skript-Beispiele. | `GetExamples` |
| `jmxq_getReadmeApi` | Holt die entwicklerorientierte Dokumentation. | `GetReadmeApi` |
| `jmxq_describeExecutionContext` | Details zu einem Kontext (Tabellen, Rechte). | `DescribeExecutionContext` |
| `jmxq_describeTableFields` | Holt alle Felder und Typen einer BC Tabelle. | `DescribeTableFields` |
| `jmxq_executeScript` | Führt ein JMXQuery Skript aus. | `ExecuteScript` |

---

## 4) Integration in AI-Agenten

### Claude Desktop / Cline (Stdio)
```json
{
  "command": "node",
  "args": ["C:/Pfad/zu/jmxq-mcp-server/build/index.js"],
  "env": {
    "BC_ODATA_BASE_URL": "...",
    "BC_AUTH_TYPE": "SSO",
    "BC_COMPANY": "..."
  }
}
```

### Cursor (SSE)
- Typ: `SSE`
- URL: `http://localhost:4000/mcp/sse`

---

## 5) Build & Run
- **Build**: `npm run build` (erzeugt den `build/` Ordner).
- **Development**: `npm run dev` (nutzt `tsx` für Hot-Reload).
- **Standard Start**: `npm start`.

---

## 6) Referenzen (AL-Ebene)
- `JMXQ_ApiService` (CU 59650): Haupt-Einstiegspunkt für Skripte.
- `JMXQ_ApiInfoService` (CU 59660): Metadaten und Hilfefunktionen.
