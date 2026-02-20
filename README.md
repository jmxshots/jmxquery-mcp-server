# JMX-QUERY MCP Server

This is a Model Context Protocol (MCP) server that exposes JMX-QUERY functions from Microsoft Business Central (On-Premise) to AI agents.

## Features

- **Three Transport Modes**: Supports **Stdio**, **SSE**, and the new high-performance **Streamable HTTP** transport.
- **Parallel Support**: Run different transports simultaneously (e.g., Stdio for the local CLI and SSE for a web dashboard).
- **Multi-Client**: Supports multiple concurrent AI clients via session management.
- **BC Integration**: Optimized for Business Central OData V4 Actions with "double-parsing" support for complex results.
- **JMX-QUERY Tools**:
  - `jmxq_ping`
  - `jmxq_getGrammar`, `jmxq_getExamples`, `jmxq_getReadmeApi`
  - `jmxq_listExecutionContexts`, `jmxq_describeExecutionContext`, `jmxq_describeTableFields`
  - `jmxq_executeScript` (Executes scripts and returns formatted results)

## Configuration (.env)

The server is configured via environment variables in a `.env` file.

| Variable | Description | Example |
| :--- | :--- | :--- |
| `BC_ODATA_BASE_URL` | The base URL of your BC OData V4 service. | `http://bc-server:7048/BC220/ODataV4/` |
| `BC_COMPANY` | The name of the BC company to connect to. | `CRONUS Deutschland GmbH` |
| `BC_AUTH_TYPE` | Authentication method: `BASIC`, `NTLM`, or `SSO`. | `NTLM` |
| `BC_USERNAME` | Username for BC authentication (not needed for SSO). | `domain\user` |
| `BC_PASSWORD` | Password for BC authentication (not needed for SSO). | `your_password` |
| `JMXQ_EXECUTION_CONTEXT_CODE` | Default context code for JMX-QUERY. | `DEFAULT` |
| `MCP_HOST` | Host the MCP server should bind to. | `127.0.0.1` |
| `MCP_PORT` | Port for the main server (includes SSE). | `5000` |
| `MCP_STREAMABLE_PORT` | **Optional**: Dedicated port for Streamable HTTP. | `5001` |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`). | `info` |
| `MCP_API_KEY` | **Optional**: API key for securing SSE/HTTP access. | `your-secret-key` |

## Windows Service Integration

The server can be registered as a Windows service to run in the background and start automatically.

> [!IMPORTANT]
> Running the service management scripts requires **Administrator privileges**.

### Install the Service
1. **Build the project**: `npm run build`
2. **Install**: Run `npm run service:install` as **Administrator**.

### Windows Service User (Service Account)

For **On-Premise Business Central** with NTLM authentication, the service must often run under a specific user account that has permission to access the BC server.

1.  Open **Services Manager** (`services.msc`).
2.  Locate **"JMX-QUERY MCP Server"**.
3.  Right-click and select **Properties**.
4.  Switch to the **Log On** tab.
5.  Select **This account** and enter the domain credentials (e.g., `DOMAIN\ServiceUser`).
6.  Restart the service.

> [!TIP]
> If you use `BC_AUTH_TYPE=SSO`, the server will attempt to use the identity of the user running the service process to authenticate against Business Central.

### Uninstall the Service
Run `npm run service:uninstall` as **Administrator**.

## Test Client

A web-based test client is available in the `test-client` directory to verify the MCP server functionality via SSE.

### Run the Test Client
1. **Navigate to the test-client directory**:
   ```bash
   cd test-client
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Start the development server**:
   ```bash
   npm run dev
   ```
4. **Open in Browser**: Navigate to `http://localhost:5173`.

## Supported Transports

The server supports three distinct ways for AI clients to connect:

1.  **Stdio**: Best for local command-line tools and IDE extensions (Cline, Roo Code).
2.  **SSE (Server-Sent Events)**: Classical web-compatible streaming. Best for browser-based clients.
3.  **Streamable HTTP**: The modern, high-performance binary-friendly transport from the MCP SDK. Best for VS Code native MCP support.

## API Endpoints

- **Streamable HTTP**: `ANY /mcp/stream` (Uses `MCP_STREAMABLE_PORT`)
- **SSE Connection**: `GET /mcp/sse` (Uses `MCP_PORT`)
- **SSE Messages**: `POST /mcp/messages?sessionId=<id>`

## Client Integration Examples

### 1. Stdio (Cline / Roo Code / Claude Desktop)

Used when the agent starts the server as a local child process. Add this to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "jmxq-bc": {
      "command": "node",
      "args": ["c:/Entwicklung/Antigravity/JS-JMXQuery-MCPServer/build/index.js"],
      "env": {
        "BC_ODATA_BASE_URL": "http://bc-server:22048/BC22/ODataV4/",
        "BC_COMPANY": "CRONUS",
        "BC_AUTH_TYPE": "NTLM",
        "BC_USERNAME": "domain\\user",
        "BC_PASSWORD": "password"
      }
    }
  }
}
```

### 2. Streamable HTTP (VS Code Native / Modern Clients)

Best performance. Requires the server to be running (e.g., as a Windows Service).

```json
{
  "mcpServers": {
    "JMXQuery": {
      "url": "http://127.0.0.1:5001/mcp/stream",
      "type": "http"
    }
  }
}
```

### 3. SSE (Legacy / Web Clients)

Reliable streaming over standard HTTP.

```json
{
  "mcpServers": {
    "JMXQuery-SSE": {
      "url": "http://127.0.0.1:5000/mcp/sse",
      "type": "sse"
    }
  }
}
```

## Testing with MCP Inspector

The [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is an interactive tool for testing Model Context Protocol servers.

### Run with compiled server
1. Build the project: `npm run build`
2. Run the inspector: `npm run inspect`

### Run in development mode (TypeScript)
This runs the server directly using `tsx` without a separate build step:
`npm run inspect:dev`

### Run against running SSE server
If your server is already running (e.g., via `npm run dev` or as a service), you can connect the inspector via SSE:
`npm run inspect:sse`

> [!NOTE]
> Authentication for SSE/HTTP is supported via two methods:
> 1. **Query Parameter**: Provide `apiKey` in the URL (e.g., `?apiKey=your-key`). This is case-sensitive.
> 2. **Authorization Header**: Send a `Bearer your-key` token in the `Authorization` header.
>
> The server automatically advertises the query parameter to clients like the MCP Inspector, but you can also manually configure headers in the Inspector UI if preferred.

The inspector will open a web interface in your browser (usually at `http://localhost:5173`) where you can list and test the available tools and resources.

## Testing with cURL

See `MCP_SERVER_PLAN.md` for detailed cURL commands to smoke test the SSE and Message endpoints.

