# Plan: JMX-QUERY MCP Server (Node.js/TypeScript) via HTTP + SSE (On-Prem Basic)

Ziel: Ein **externer** MCP Server (eigenes Node.js Projekt, nicht dieses Repo) stellt JMX-QUERY Funktionen aus Business Central (BC) über MCP Tools bereit. Die Tools rufen die OData V4 Actions der Codeunits **JMXQ_ApiService** (ExecuteScript) und **JMXQ_ApiInfoService** (Describe*/Get*) auf.

Dieser Plan ist so geschrieben, dass Google Antigravity Agents daraus ein **lauffähiges** Projekt scaffolden und implementieren können.

---

## 0) Rahmenbedingungen (fixiert aus unserem Gespräch)

- OS: Windows
- Transport: HTTP + SSE
  - SSE-Endpoint: `GET /mcp/sse`
  - Message-Endpoint: `POST /mcp/messages`
- BC Auth: On-Prem **Basic Auth**
- Company wird als Query Parameter `?company=` verwendet
- Write Safety: **keine zusätzliche Blockade im MCP Server** (Execution Context ist das Gate)
- MCP Server selbst: **keine zusätzliche Absicherung** (kein API-Key/Basic/IP-Allowlist), da nur intern betrieben
- Multi-Client: **ja** (mehrere gleichzeitige SSE Clients) → **Session/ClientId Mapping erforderlich** (kein Broadcast)

---

## 1) Background: Relevante BC APIs (Contract)

### 1.1 Services (OData V4 Actions)

**Primary (Execution):**
- Service Name: `JMXQ_ApiService` (codeunit 59650)
- Action:
  - `ExecuteScript(executionContextCode, script)`

**Helper/Discovery:**
- Service Name: `JMXQ_ApiInfoService` (codeunit 59660)
- Actions:
  - `DescribeExecutionContext(executionContextCode)`
  - `DescribeTableFields(executionContextCode, tableRef)`
  - `GetGrammar()`
  - `GetReadmeApi()`
  - `GetExamples()`

Hinweis: In AL wird explizit erwähnt, dass JSON request keys **lower-camel-case** sein müssen.

### 1.2 OData URL Pattern

On-Prem ODataV4 Action URL:

- `BC_ODATA_BASE_URL` muss auf die ODataV4 Base zeigen (Ende idealerweise `/ODataV4/`).
- Action URLs:
  - `${BC_ODATA_BASE_URL}JMXQ_ApiService_ExecuteScript?company=${urlencode(BC_COMPANY)}`
  - `${BC_ODATA_BASE_URL}JMXQ_ApiInfoService_GetGrammar?company=${urlencode(BC_COMPANY)}`
  - etc.

HTTP Method: `POST`

Headers:
- `Content-Type: application/json`
- `Accept: application/json`
- `Authorization: Basic <base64(user:pass)>`

### 1.2.1 API-Aufrufbeispiele (wie `ShowApiInfoCallTemplate`, On-Prem Basic)

Diese Beispiele entsprechen dem, was die AL-Funktion `ShowApiInfoCallTemplate()` (codeunit **JMXQ_ApiInfoService**) beschreibt – nur hier direkt im Plan, damit der API-Aufruf sehr konkret ist.

**Beispielwerte (ersetzen):**
- `BC_ODATA_BASE_URL`: `http://bc-server:7048/BC220/ODataV4/`
- `BC_COMPANY`: `CRONUS Deutschland GmbH` (URL-encoded als `%20` usw.)
- Credentials: `BCUser:BCPassword`

**Helper: Company URL Encoding (PowerShell)**
Wenn du unsicher bist, wie der Company-Name encoded aussieht (z.B. `%20` für Leerzeichen), nutze diesen Befehl in PowerShell:
`[Uri]::EscapeDataString("CRONUS Deutschland GmbH")`
Output: `CRONUS%20Deutschland%20GmbH` -> Dies ist dein `${BC_COMPANY_URLENC}`.

**Endpoints (Pattern):**
- `.../ODataV4/JMXQ_ApiInfoService_DescribeExecutionContext?company=<Company>`
- `.../ODataV4/JMXQ_ApiInfoService_DescribeTableFields?company=<Company>`
- `.../ODataV4/JMXQ_ApiInfoService_GetGrammar?company=<Company>`
- `.../ODataV4/JMXQ_ApiInfoService_GetReadmeApi?company=<Company>`
- `.../ODataV4/JMXQ_ApiInfoService_GetExamples?company=<Company>`
- `.../ODataV4/JMXQ_ApiService_ExecuteScript?company=<Company>`

**Bodies (Dateien anlegen, empfohlen):**

`body_ctx.json`
```json
{ "executionContextCode": "<YOUR_CONTEXT_CODE>" }
```

`body_table.json`
```json
{ "executionContextCode": "<YOUR_CONTEXT_CODE>", "tableRef": "#18" }
```

`body_empty.json`
```json
{}
```

`body_exec.json`
```json
{
  "executionContextCode": "<YOUR_CONTEXT_CODE>",
  "script": "FROM Customer AS c | SELECT c.\"No.\" AS No, c.Name | LIMIT 1"
}
```

**cURL (On-Prem, Basic Auth):**

1) DescribeExecutionContext

```bat
curl.exe -X POST "${BC_ODATA_BASE_URL}JMXQ_ApiInfoService_DescribeExecutionContext?company=${BC_COMPANY_URLENC}" -u "BCUser:BCPassword" -H "Content-Type: application/json" -H "Accept: application/json" -d @body_ctx.json
```

2) DescribeTableFields

```bat
curl.exe -X POST "${BC_ODATA_BASE_URL}JMXQ_ApiInfoService_DescribeTableFields?company=${BC_COMPANY_URLENC}" -u "BCUser:BCPassword" -H "Content-Type: application/json" -H "Accept: application/json" -d @body_table.json
```

3) GetGrammar

```bat
curl.exe -X POST "${BC_ODATA_BASE_URL}JMXQ_ApiInfoService_GetGrammar?company=${BC_COMPANY_URLENC}" -u "BCUser:BCPassword" -H "Content-Type: application/json" -H "Accept: application/json" -d @body_empty.json
```

4) GetReadmeApi

```bat
curl.exe -X POST "${BC_ODATA_BASE_URL}JMXQ_ApiInfoService_GetReadmeApi?company=${BC_COMPANY_URLENC}" -u "BCUser:BCPassword" -H "Content-Type: application/json" -H "Accept: application/json" -d @body_empty.json
```

5) GetExamples

```bat
curl.exe -X POST "${BC_ODATA_BASE_URL}JMXQ_ApiInfoService_GetExamples?company=${BC_COMPANY_URLENC}" -u "BCUser:BCPassword" -H "Content-Type: application/json" -H "Accept: application/json" -d @body_empty.json
```

6) ExecuteScript (PRIMARY)

```bat
curl.exe -X POST "${BC_ODATA_BASE_URL}JMXQ_ApiService_ExecuteScript?company=${BC_COMPANY_URLENC}" -u "BCUser:BCPassword" -H "Content-Type: application/json" -H "Accept: application/json" -d @body_exec.json
```

**Wichtige Notes:**
- JSON Keys müssen **lower-camel-case** sein: `executionContextCode`, `tableRef`, `script`.
- `tableRef` ist **Text** (z.B. `"#18"` oder `"Customer"`).
- OData liefert `Text` i.d.R. als `{ "value": "<JSON-String>" }` → im Client **zweifach parsen**.
- Wenn du kein `body_*.json` verwenden willst, musst du in Windows/`cmd` Escapes sehr sauber setzen; mit Datei ist es deutlich robuster.

### 1.3 Response-Format: „Double JSON Parse“

Die Actions geben in AL `Text` zurück. In OData V4 werden Text-Returns üblicherweise als JSON mit `value` geliefert:

```json
{
  "@odata.context": ".../$metadata#Edm.String",
  "value": "{\"result\":[...],\"message\":\"...\"}"
}
```

Client/MCP Server muss deshalb:
1) HTTP JSON parsen
2) `value` extrahieren
3) `value` (String) nochmals als JSON parsen (falls möglich)

### 1.4 Fehlerformat

Die AL-Codeunits bauen Fehler typischerweise so:

```json
{"error": {"code": "JMXQ_Error", "message": "..."}}
```

Der MCP Server soll das als Tool-Error zurückgeben (oder als strukturierte Error-Response im Tool-Result, je nach SDK Pattern).

### 1.5 Multi-Script / Commit-Semantik

- `script` kann:
  - ein einzelner Script-Text sein
  - ein Multi-Script Text (wird serverseitig gesplittet)
  - oder (empfohlen) ein **JSON-Array als Text**, z.B. `"[\"FROM ...\",\"FROM ...\"]"`

- Batch Verhalten:
  - Ausführung stoppt beim ersten Fehler
  - Commit erfolgt **pro Script** (nicht atomar über alle Scripts)

---

## 2) Architektur-Vorschlag (Node.js Projekt)

### 2.1 Tech Stack (empfohlen)

- Language: TypeScript
- MCP SDK: `@modelcontextprotocol/sdk`
- HTTP Server: Fastify (alternativ Express)
- HTTP Client zu BC: `undici`
- Input Validation: `zod`
- Logging: `pino` (bei Fastify standard)

### 2.2 Komponenten

1) `config.ts`
- Liest ENV, validiert, gibt typed Config zurück

2) `bcClient.ts`
- Baut OData Action URL
- Setzt Basic Auth Header
- Macht POST
- Implementiert „double parse“ + error mapping

3) `mcpServer.ts`
- Registriert MCP Tools
- Implementiert HTTP + SSE Transport (`/mcp/sse`, `/mcp/messages`)

4) `connectionManager.ts` (neu für Multi-Client)
- Verwaltet Map `clientId -> SSE Response Object`
- Methoden: `register(id, res)`, `get(id)`, `remove(id)`

5) `tools/*.ts`
- Pro Tool eine Funktion + Zod Schema

---

## 3) Deliverables (was Antigravity erzeugen soll)

Ein neues Git-Repo / Projektordner (außerhalb dieses AL-Repos), z.B. `jmxq-mcp-server/` mit:

- `package.json` (scripts: `dev`, `build`, `start`)
- `tsconfig.json`
- `src/index.ts` (boot)
- `src/config.ts`
- `src/bcClient.ts`
- `src/mcp/httpSseTransport.ts` (falls nötig)
- `src/mcp/server.ts`
- `src/tools/`:
  - `getGrammar.ts`
  - `getExamples.ts`
  - `getReadmeApi.ts`
  - `describeExecutionContext.ts`
  - `describeTableFields.ts`
  - `executeScript.ts`
- `.env.example`
- `README.md` (Run + curl smoke tests)

---

## 4) Konfiguration (ENV)

Minimal (Pflicht):

- `BC_ODATA_BASE_URL` Beispiel: `http://bc-server:7048/BC220/ODataV4/`
- `BC_COMPANY` Beispiel: `CRONUS Deutschland GmbH`
- `BC_USERNAME` Beispiel: `BCUser`
- `BC_PASSWORD` Beispiel: `BCPassword`
- `JMXQ_EXECUTION_CONTEXT_CODE` Beispiel: `DEFAULT`

MCP Server:
- `MCP_HOST` Beispiel: `127.0.0.1`
- `MCP_PORT` Beispiel: `3000`

Optional (stabiler Betrieb):
- `HTTP_TIMEOUT_MS` (z.B. 60000)
- `HTTP_RETRY_COUNT` (z.B. 2)
- `LOG_LEVEL` (debug/info)

Wichtig (BC-seitig): In der aktuellen Implementierung wird `SUPER` geprüft. Die BC Credentials müssen die erforderlichen Rechte besitzen.

---

## 5) HTTP/SSE MCP Transport (konkret)

### 5.1 Endpoints

- `GET /mcp/sse`
  - Öffnet einen SSE Stream
  - Response Headers:
    - `Content-Type: text/event-stream`
    - `Cache-Control: no-cache`
    - `Connection: keep-alive`
  - Sendet Events im Format:
    - `data: {"jsonrpc":"2.0", ... }\n\n`

- `POST /mcp/messages`
  - Body: JSON-RPC Request/Notification
  - Der Server verarbeitet die Nachricht und schreibt Responses/Notifications über SSE an alle (oder die zugehörige) Verbindung.

### 5.2 Session/Zuordnung

Da mehrere gleichzeitige SSE Clients unterstützt werden sollen, muss der Server Responses **gezielt** an den passenden Client senden.

Empfohlenes, einfaches Mapping (robust für CLI-Tests und Multi-Client):

- Der Client öffnet SSE mit `clientId` als Query:
  - `GET /mcp/sse?clientId=<uuid>`
- Der Client sendet Requests an `/mcp/messages` und liefert dieselbe `clientId`:
  - Header `X-MCP-ClientId: <uuid>` (alternativ Query `?clientId=<uuid>`)
- Der Server hält eine Map `clientId -> SSE connection`.
- Ein JSON-RPC Response (z.B. `id: 2`) wird nur an die Connection der `clientId` gesendet, die den Request geliefert hat.

Fallback (wenn `clientId` fehlt):
- Server kann eine neue `clientId` generieren und als **erste** SSE Message eine Notification senden, z.B.
  - `{"jsonrpc":"2.0","method":"notifications/mcp.clientId","params":{"clientId":"..."}}`
  - Danach muss der Client diese `clientId` bei POST Requests mitschicken.

---

## 6) MCP-Protokoll: Minimaler Message Flow

### 6.1 Initialize

Client sendet:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "clientInfo": {"name":"cli-test","version":"0.1.0"},
    "capabilities": {}
  }
}
```

Server antwortet (über SSE) mit `id:1` und `result` (serverInfo, capabilities, protocolVersion).

#### ProtocolVersion Handling (tolerant, empfohlen)

Da die erwartete `protocolVersion` von Antigravity aktuell unbekannt ist, sollte der MCP Server tolerant reagieren:

- Der Server hält eine Liste unterstützter Versionen, z.B. `SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05"]`.
- Beim `initialize` Request:
  - Wenn `params.protocolVersion` in `SUPPORTED_PROTOCOL_VERSIONS` ist: antworte mit genau dieser Version.
  - Wenn nicht unterstützt (oder fehlt):
    - Antworte trotzdem erfolgreich, aber setze `result.protocolVersion` auf die bevorzugte Server-Version (z.B. `"2024-11-05"`).
    - Logge eine Warnung (nur serverseitig), dass die Client-Version nicht erkannt wurde.
    - Falls Antigravity später strikt ist, kann man als Alternative bei nicht unterstützter Version mit JSON-RPC `error` antworten (Code/Message klar), aber für erste Tests ist „best effort“ sinnvoll.

Damit kann der CLI-Test und auch ein neuer Client meist sofort laufen, ohne dass man die genaue Version vorab kennt.

Danach Notification:

```json
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
```

### 6.2 Tools

- `tools/list`
- `tools/call` mit `{ name, arguments }`

---

## 7) MCP Tools (Names, Schemas, BC-Mapping)

### 7.1 Tool: `jmxq.getGrammar`

- Input: `{}`
- BC Call: `JMXQ_ApiInfoService_GetGrammar` mit `{}`
- Output: Text (EBNF)

### 7.2 Tool: `jmxq.getExamples`

- Input: `{}`
- BC Call: `JMXQ_ApiInfoService_GetExamples` mit `{}`
- Output: Text (example scripts)

### 7.3 Tool: `jmxq.getReadmeApi`

- Input: `{}`
- BC Call: `JMXQ_ApiInfoService_GetReadmeApi` mit `{}`
- Output: Text (API oriented readme)

### 7.4 Tool: `jmxq.describeExecutionContext`

- Input:
  - `executionContextCode?: string` (default aus ENV)
- BC Call: `JMXQ_ApiInfoService_DescribeExecutionContext`
- Payload (lowerCamelCase!):

```json
{ "executionContextCode": "DEFAULT" }
```

- Output: JSON object (inner JSON aus `value`) enthält typischerweise `{"result":{...}}` oder `{"error":{...}}`.

### 7.5 Tool: `jmxq.describeTableFields`

- Input:
  - `executionContextCode?: string` (default aus ENV)
  - `tableRef: string` (z.B. `"#18"` oder `"Customer"`)
- BC Call: `JMXQ_ApiInfoService_DescribeTableFields`
- Payload:

```json
{ "executionContextCode": "DEFAULT", "tableRef": "#18" }
```

- Output: JSON mit `result.table`, `result.primaryKey`, `result.fields`

### 7.6 Tool: `jmxq.executeScript`

- Input:
  - `executionContextCode?: string` (default aus ENV)
  - `script: string`
- BC Call: `JMXQ_ApiService_ExecuteScript`
- Payload:

```json
{ "executionContextCode": "DEFAULT", "script": "FROM Customer AS c | SELECT c.\"No.\" AS No" }
```

- Output:
  - Single script: `{"result":...,"message":"..."}` oder `{"error":...}`
  - Batch: `{"scriptCount":N,"executedCount":M,"results":[...]}` (stop on first error)

---

## 8) BC Client Implementation Details (must-have)

### 8.1 URL Builder

- Normalisiere Base:
  - Wenn `BC_ODATA_BASE_URL` nicht mit `/` endet, hänge `/` an.
- URL:
  - `${base}${service}_${action}?company=${encodeURIComponent(company)}`

### 8.2 Basic Auth Header

- `Authorization: Basic ${Buffer.from(user + ':' + pass).toString('base64')}`

### 8.3 Double Parse + Error Handling

Pseudo:

1) `odata = JSON.parse(httpBody)`
2) `raw = odata.value ?? odata`
3) wenn `raw` string:
   - versuche `inner = JSON.parse(raw)`
   - wenn parse fail: inner = raw
4) wenn `inner.error` vorhanden:
   - mappe zu MCP error
5) return inner

Hinweis: “double parse” ist kritisch, sonst liefern Tools nur Strings.

---

## 9) Logging / Observability

- pro Tool Call `requestId` generieren
- loggen:
  - tool name
  - duration
  - BC action
  - HTTP status
- niemals loggen:
  - `Authorization` header
  - BC password
  - vollständige Scripts (optional nur length + hash)

---

## 10) CLI-only Smoke Tests (Windows)

### 10.1 SSE öffnen

Terminal A:

```bat
curl.exe -N "http://127.0.0.1:3000/mcp/sse?clientId=cli-1"
```

### 10.2 MCP Requests senden

Terminal B:

Initialize:

```bat
curl.exe -s -X POST "http://127.0.0.1:3000/mcp/messages" -H "Content-Type: application/json" -H "X-MCP-ClientId: cli-1" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"clientInfo\":{\"name\":\"cli-test\",\"version\":\"0.1.0\"},\"capabilities\":{}}}"
```

Initialized notification:

```bat
curl.exe -s -X POST "http://127.0.0.1:3000/mcp/messages" -H "Content-Type: application/json" -H "X-MCP-ClientId: cli-1" -d "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}"
```

Tools list:

```bat
curl.exe -s -X POST "http://127.0.0.1:3000/mcp/messages" -H "Content-Type: application/json" -H "X-MCP-ClientId: cli-1" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}"
```

Call getGrammar:

```bat
curl.exe -s -X POST "http://127.0.0.1:3000/mcp/messages" -H "Content-Type: application/json" -H "X-MCP-ClientId: cli-1" -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"jmxq.getGrammar\",\"arguments\":{}}}"
```

Call executeScript (harmlos):

```bat
curl.exe -s -X POST "http://127.0.0.1:3000/mcp/messages" -H "Content-Type: application/json" -H "X-MCP-ClientId: cli-1" -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"jmxq.executeScript\",\"arguments\":{\"executionContextCode\":\"DEFAULT\",\"script\":\"FROM Customer AS c | SELECT c.\\\"No.\\\" AS No, c.Name | LIMIT 1\"}}}"
```

Erwartung: Antworten erscheinen im SSE Terminal (Terminal A) als JSON-RPC `result` oder `error`.

---

## 11) Entscheidungen / Restfragen

Festgelegt:

1) Schutz des MCP Servers (nicht BC): **Nein** (kein API-Key/Basic/IP-Allowlist; nur intern betrieben).

2) Multi-Client: **Ja** (mehrere gleichzeitige SSE Clients) → der Server muss **Session-Mapping** implementieren.
  - Empfohlen: `clientId` über `GET /mcp/sse?clientId=...` + `X-MCP-ClientId` bei `POST /mcp/messages`.

Offen (optional):

3) Welche MCP protocolVersion erwartet Antigravity konkret?
  - Unbekannt; deshalb ist oben ein tolerantes Handling definiert.

---

## 12) Referenzen im AL Repo

- Helper API Codeunit: [Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ApiInfoService.al](Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ApiInfoService.al)
- Primary API Codeunit: [Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ApiService.al](Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ApiService.al)
- Splitter: [Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ScriptSplitter.al](Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ScriptSplitter.al)
- Runner/Batch semantics: [Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_QueryRunner.al](Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_QueryRunner.al)
- Execution context auth/guardrails: [Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ExecutionContextAuth.al](Source/Modules/JMX_QUERY/Functions/Cod.JMXQ_ExecutionContextAuth.al)
