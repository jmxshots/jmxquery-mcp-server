# JMX-QUERY MCP Server

This is a Model Context Protocol (MCP) server that exposes JMX-QUERY functions from Microsoft Business Central (On-Premise) to AI agents.

## Features

- **SSE Transport**: Supports HTTP + Server-Sent Events for broad client compatibility.
- **Multi-Client**: Supports multiple concurrent AI clients via `clientId` mapping.
- **BC Integration**: Optimized for Business Central OData V4 Actions with "double-parsing" support.
- **JMX-QUERY Tools**:
  - `jmxq_getGrammar`
  - `jmxq_getExamples`
  - `jmxq_getReadmeApi`
  - `jmxq_describeExecutionContext`
  - `jmxq_describeTableFields`
  - `jmxq_executeScript`

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
| `MCP_PORT` | Port the MCP server should listen on. | `4000` |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`). | `info` |

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

## API Endpoints

- **SSE**: `GET /mcp/sse?clientId=<any-id>`
- **Messages**: `POST /mcp/messages` (requires `X-MCP-ClientId` header)

## Testing with cURL

See `MCP_SERVER_PLAN.md` for detailed cURL commands to smoke test the SSE and Message endpoints.

