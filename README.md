# JMX-QUERY MCP Server

JMX-QUERY MCP Server is a Windows-hosted Model Context Protocol server for Business Central. One running service manages multiple Business Central **Instances**, each with one technical Company used for API metadata calls. MCP agents select an Instance explicitly and choose an execution Company only when running a script.

The integrated Admin GUI at `/admin` manages connections, technical Companies, secrets, and audit logs. This document is the Admin and User Manual rendered by that GUI after Admin authentication.

## Architecture

- **Instance**: one Business Central connection profile. It owns the endpoint and authentication configuration.
- **Technical Company**: one Business Central `company` value stored on each Instance. The server uses it for API information, context, table, and metadata calls.
- **Execution Company**: a Company returned by an execution context. It is provided only to `jmxq_executeScript` and is validated by the server before script execution.
- **MCP target**: every Business Central MCP tool requires `bcInstance`; `jmxq_executeScript` additionally requires `executionContextCode` and `executionCompany`.
- **One service**: one Windows service exposes the SSE and Streamable HTTP MCP transports plus the Admin GUI. Stdio is available when an MCP client launches the server directly (`MCP_STDIO`).

The terms are deliberate: `tenantId` is only an Entra ID OAuth tenant identifier. It is not a Business Central Company.

## Prerequisites

- Windows 10, Windows 11, or Windows Server.
- Current Node.js LTS with `npm`.
- Network access from the service machine to each Business Central OData endpoint or Business Central Online.
- Administrator rights only when installing or removing the Windows service.
- A Business Central user, application, or service account with the required JMX-QUERY permissions.
- The [JMX-QUERY Business Central app](https://github.com/jmxshots/AL-JMX.QUERY) installed in every target Business Central instance.

For SSO, the Windows account running the service must be an authorized Business Central user. `LocalSystem` usually cannot authenticate to a remote Business Central server with Integrated Windows Authentication.

## Install

1. Clone or extract the repository.

   ```powershell
   git clone <repository-url>
   Set-Location jmxquery-mcp-server
   ```

2. Open an elevated PowerShell in the repository and run the bootstrap.

```powershell
npm run bootstrap
```

The bootstrap interactively asks for the main and Streamable HTTP ports. For `ADMIN_API_KEY` and `JMXQ_MCPAPI_KEY`, choose whether to keep an existing value, generate a new value, or enter one manually. `INSTANCE_MASTER_KEY` is always generated automatically on first setup and is preserved on later runs so the encrypted Instance Store remains readable. Bootstrap checks the installed dependencies against both lockfiles and runs `npm ci` only when they are missing or outdated. It then enables LAN binding, adds the computer hostname to the browser CORS allowlist, and builds the server and Admin GUI.

Choose whether to install or update **JMX-QUERY MCP Server** as a Windows service. When declined, the build remains ready for an interactive session and Bootstrap prints `npm start` as the manual start command.

The completion summary displays the Admin URLs and ports. Keys are never written to the console; only their last four characters are shown so you can tell them apart. Bootstrap offers to copy `ADMIN_API_KEY` to the clipboard for the first Admin GUI login; otherwise read it from `.env`. Clear the clipboard after login if Windows clipboard history is enabled. After login, reveal or copy `JMXQ_MCPAPI_KEY` on the **Connect** page of the Admin GUI. Restrict inbound access to trusted networks with Windows Firewall.

An existing `.env` is validated before building. Existing keys and application settings are preserved; Bootstrap only changes a loopback `MCP_HOST` to `0.0.0.0` and adds the current computer hostname to `MCP_CORS_ORIGINS`. If the file still contains template placeholders, has a master key shorter than 32 characters, or enables the Admin API without an Admin key, Bootstrap stops before changing it.

3. Open the Admin GUI at the configured address, initially `http://127.0.0.1:5000/admin`, and enter the `ADMIN_API_KEY` from `.env`. Then create your first Instance and Company. Business Central endpoints, credentials, Companies, and execution contexts are configured only in the protected Admin GUI.

## Starting the Server Manually

To run the server interactively in the CLI without installing a Windows service:

```powershell
npm start
```

This starts the server in the current terminal with output visible. The server listens on the configured `MCP_PORT` and `MCP_STREAMABLE_PORT` from `.env`. The Admin GUI is available at the configured address.

Press `Ctrl+C` to stop the server.

### Troubleshooting Port Conflicts

If another process is already listening on the configured ports, use:

```powershell
npm start -- --force-ports
```

This Windows-only option automatically terminates all processes listening on `MCP_PORT` or `MCP_STREAMABLE_PORT` and then starts the server. Use with caution when shared ports are in use.

### Development Mode

For active development with automatic server restart on code changes:

```powershell
npm run dev
```

This uses `tsx watch` to monitor the TypeScript source files and restart the server when changes are detected.

### Manual or Recovery Installation

Use this sequence when recovering an invalid `.env` or when only the existing service installer should run:

```powershell
npm install
Copy-Item .env.example .env
```

Generate three distinct secrets. The following PowerShell command prints a 96-character random value.

```powershell
-join (1..48 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Set the values in `.env`:

- `INSTANCE_MASTER_KEY`: encrypts the complete Instance and Company store. It must have at least 32 characters.
- `ADMIN_API_KEY`: protects the Admin GUI and Admin API.
- `JMXQ_MCPAPI_KEY`: protects HTTP MCP clients.

Then build and install the service:

```powershell
npm run build
npm run service:install
```

For an interactive verification without installing a service, start the server with `npm start`. If a prior local server process is still listening on `MCP_PORT` or `MCP_STREAMABLE_PORT`, use `npm start -- --force-ports`; this Windows-only option forcefully terminates every process listening on the configured ports.

## Service Configuration

`.env` holds global service configuration only. Business Central endpoints, credentials, Companies, and execution contexts are created in the Admin GUI and stored in the encrypted Instance Store.

| Variable | Description | Default |
| --- | --- | --- |
| `MCP_HOST` | Interface on which the service listens. | `127.0.0.1` |
| `MCP_PORT` | Main HTTP port for Admin GUI and SSE MCP. | `5000` |
| `MCP_STREAMABLE_PORT` | Optional separate Streamable HTTP port. | unset |
| `MCP_CORS_ORIGINS` | Comma-separated browser origin allowlist. | local Vite origins |
| `JMXQ_MCPAPI_KEY` | Bearer key for HTTP MCP endpoints. | unset |
| `ADMIN_API_ENABLED` | Enables protected Admin API and GUI access. | `false` |
| `ADMIN_API_KEY` | Bearer key for Admin API and GUI login. Required when Admin API is enabled. | unset |
| `ADMIN_SESSION_IDLE_MINUTES` | Admin GUI session ends after this many minutes without an Admin API request (1-1440). | `60` |
| `ADMIN_SESSION_MAX_HOURS` | Admin GUI session ends this many hours after login, regardless of activity (1-168). | `12` |
| `MCP_STDIO` | Stdio MCP transport: `auto` starts it only when stdin is not a terminal (an MCP client launched the process); `on` or `off` force it. The Windows service always uses `off`. | `auto` |
| `INSTANCE_MASTER_KEY` | Master key for AES-256-GCM Instance Store encryption. Required. | unset |
| `INSTANCE_STORE_PATH` | Encrypted Instance Store path. | `./data/instances.enc` |
| `LOG_DIR` | Directory for rotated JSONL audit logs. | `./logs` |
| `LOG_RETENTION_DAYS` | Number of daily audit files to retain. | `30` |
| `LOG_SCRIPT_MAX_LENGTH` | Maximum stored JMX-QUERY script length. | `4000` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. | `info` |

Keep `MCP_HOST=127.0.0.1` when MCP clients run on the same computer as the service. To allow trusted clients in the local network, bind either the server's specific LAN address or `0.0.0.0`. Add a restrictive Windows Firewall inbound rule for the required MCP port, scoped to the Private profile and trusted LAN IP range. Do not expose the service to the internet.

## Windows Service

`npm run bootstrap` is the recommended installation command and performs the build and service installation. For a configured checkout, the service-only command remains available:

```powershell
npm run service:install
```

The service is named **JMX-QUERY MCP Server** and reads the repository-root `.env` file. Remove it with:

```powershell
npm run service:uninstall
```

For SSO, open `services.msc`, select **JMX-QUERY MCP Server**, open **Properties > Log On**, and configure an approved domain service account. Restart the service after changing the account.

## Admin GUI

Open `/admin` on the main service port. The login screen automatically uses the server that delivered the Admin GUI and requests only the Admin API key. After a successful login, the browser receives a server-issued `HttpOnly` session cookie, so reloading the page keeps the Admin session until **Sign out**, the server restarts, the session has been idle for `ADMIN_SESSION_IDLE_MINUTES` (default 60), or `ADMIN_SESSION_MAX_HOURS` (default 12) have passed since login. An open log stream ends with its session; after expiry the Admin GUI returns to the login screen. The Admin API key is not stored in browser storage; **Sign out** revokes and clears the session.

### Instances

An Instance is a connection profile. Select **New instance**, give it a stable name, then choose one authentication type:

| Authentication | Required fields |
| --- | --- |
| `BASIC` | Base URL, Username, Password |
| `NTLM` | Base URL, Username, Password |
| `SSO` | Base URL; the Windows service account authenticates |
| `OAUTH` | Tenant ID, Client ID, Client Secret, Environment |

For `BASIC`, `NTLM`, and `SSO`, enter the full Business Central OData V4 service root. The trailing slash is recommended and added automatically when omitted.

| Authentication | Base URL example |
| --- | --- |
| `BASIC` | `https://bc.example.com:7048/BC240/ODataV4/` |
| `NTLM` | `http://bc-internal:7048/BC240/ODataV4/` |
| `SSO` | `https://bc-internal.contoso.local:7049/Production/ODataV4/` |
| `OAUTH` | No Base URL field. The server builds `https://api.businesscentral.dynamics.com/v2.0/<tenantId>/<environment>/ODataV4/`. |

Replace the hostname, port, server instance, and environment values with the values from your Business Central deployment. Do not add a Company to the Base URL.

For OAuth, use the Entra ID directory ID as `tenantId` and the Business Central Online environment name as `environment`, for example `Production` or `Sandbox`. The server derives the Business Central OData V4 base URL from those values.

Use **Enable** or **Disable** to control whether an Instance can receive new MCP requests. Running requests are not aborted.

### Technical Company

Each Instance has one required **Technical company**. After entering the connection data, use **Test connection**. It validates the entered Base URL and authentication without saving the Instance. Once it succeeds, use **Load companies**; the server tests the connection again and reads the available Companies directly from Business Central. Select the technical Company from that list before creating or saving the Instance.

For OAuth, the Base URL is derived from the entered Tenant ID and Environment. The same test-and-select sequence applies to all authentication types.

The technical Company is the exact Business Central Company value that the server uses internally for OData API calls. The MCP client does not send this value.

Execution Companies are not configured here. They are returned by `jmxq_describeExecutionContext` and are validated immediately before `jmxq_executeScript` runs.

### Secrets

Stored Passwords and Client Secrets are masked in normal responses. Use the reveal icon only when needed. The GUI asks for the Admin API key again, reveals a single secret for 30 seconds, and does not persist it in browser storage.

### Tool Tester

The **Tools** view runs the registered JMX-QUERY MCP tools through the authenticated Admin API. Select an enabled Instance. For scripts, select an execution context, load its allowed execution Companies, then choose one. The server uses the same validation, comment stripping, and audit logging as an MCP client call.

Use **Get examples** to retrieve the JMX-QUERY examples published by the selected Business Central system. This is the source for version-specific scripts, including a read-only article-count example when one is available.

`jmxq_executeScript` requires a confirmation immediately before execution because a script can change Business Central data. The entered script remains available after a failed call. The result panel displays the server request ID, duration, effective execution context, and full tool response.

### Logs

The **Logs** view supports filters for Instance, Company, Tool, Status, Request ID, and time range. It displays counts, error totals, and average durations. Use **Refresh** to retrieve new records. **Clear logs** permanently removes stored daily log files while retaining the selected period, or removes all log files when **Delete all logs** is selected. This manual cleanup does not change `LOG_RETENTION_DAYS`.

Live browser events are intentionally not enabled because native browser `EventSource` cannot securely send the Admin bearer header. The server-side authenticated SSE endpoint remains available for a future client with an appropriate authenticated transport.

Tool logs are written as daily JSONL files. They include target metadata, timing, execution context, sanitized errors, and JMX-QUERY scripts for `jmxq_executeScript`. They never include Business Central responses, passwords, Client Secrets, tokens, or Authorization headers.

### Documentation

The **Documentation** view retrieves and renders this root `README.md` after Admin authentication. It supports GitHub Flavored Markdown, tables, heading links, and code blocks. Raw HTML is not rendered.

**Visual overview** opens `docs/jmxquery-mcp-overview.html` in a new browser tab: an illustrated summary of architecture, key concepts, setup flow, client configuration, agent workflow, and security layers. Like the README, it is served only to an authenticated Admin session, at `/admin/api/documentation/overview`.

## MCP Endpoints

| Transport | Endpoint |
| --- | --- |
| Streamable HTTP | `http://127.0.0.1:5000/mcp/stream` or the configured `MCP_STREAMABLE_PORT` |
| SSE connection | `http://127.0.0.1:5000/mcp/sse` |
| SSE messages | `http://127.0.0.1:5000/mcp/messages?sessionId=<id>` |
| Admin GUI | `http://127.0.0.1:5000/admin` |

When `JMXQ_MCPAPI_KEY` is configured, HTTP MCP clients must send `Authorization: Bearer <JMXQ_MCPAPI_KEY>`. This key is different from `ADMIN_API_KEY`.

## VS Code and GitHub Copilot

Open the Admin GUI and select **Connect** for a server-specific, copyable configuration. Choose **This MCP server** when VS Code runs on the computer hosting this service, or **Local network** when VS Code runs on another trusted LAN computer. For a loopback Admin URL, the Local network mode pre-fills a detected server LAN address and offers the server name and other detected LAN addresses. When authentication is enabled, **Show API key** opens a protected dialog that displays `JMXQ_MCPAPI_KEY` for 30 seconds and allows copying it. The key is not stored in browser storage. VS Code configurations continue to use a password prompt instead of embedding the key.

Use a Streamable HTTP MCP server entry in your VS Code MCP configuration. The exact configuration file location can vary with VS Code release and workspace policy; use the MCP configuration command exposed by VS Code, then add an entry equivalent to this same-computer example:

```json
{
  "inputs": [
    {
      "id": "jmxq-mcp-server-api-key",
      "type": "promptString",
      "description": "JMX-QUERY MCP API key",
      "password": true
    }
  ],
  "servers": {
    "jmxq-mcp-server": {
      "type": "http",
      "url": "http://127.0.0.1:5000/mcp/stream",
      "headers": {
        "Authorization": "Bearer ${input:jmxq-mcp-server-api-key}"
      }
    }
  }
}
```

Use `http://127.0.0.1:5001/mcp/stream` when `MCP_STREAMABLE_PORT=5001` is configured.

### Local Network Clients

For a client on another computer in the same local network:

1. Configure `MCP_HOST` with the server's LAN IP address, or use `0.0.0.0` to listen on all IPv4 interfaces.
2. Restart the server or Windows service.
3. Allow the MCP port through Windows Firewall only for the Private profile and the trusted client subnet or IP addresses. Allow `MCP_PORT` when no separate Streamable port is configured; otherwise allow `MCP_STREAMABLE_PORT`.
4. In **Connect**, choose **Local network** and use the server's LAN DNS name or IP address. Copy the generated configuration into VS Code on the client computer.

For example, a server named `bc-mcp-server` running on port `5000` uses `http://bc-mcp-server:5000/mcp/stream`. Do not use `127.0.0.1` or `localhost` from another computer: those addresses point to the client computer, not the MCP server.

## Cursor

In the Admin GUI, select **Connect**, choose **Cursor**, then choose the appropriate access location and copy the generated entry into Cursor's MCP configuration. Cursor uses the `mcpServers` format and connects through the same Streamable HTTP endpoint as VS Code.

When MCP authentication is enabled, replace the `<JMXQ_MCPAPI_KEY>` placeholder with the MCP API key before saving the configuration. Do not use the Admin API key.

```json
{
  "mcpServers": {
    "jmxq-mcp-server": {
      "url": "http://127.0.0.1:5000/mcp/stream",
      "headers": {
        "Authorization": "Bearer <JMXQ_MCPAPI_KEY>"
      }
    }
  }
}
```

## Other Harnesses

The **Connect** page also generates ready-to-paste configuration for Claude Code (`claude mcp add` command), Hermes Agent (`~/.hermes/config.yaml`), Codex CLI (`~/.codex/config.toml`) and Gemini CLI (`~/.gemini/settings.json`). They all use the Streamable HTTP endpoint; when `JMXQ_MCPAPI_KEY` is set, replace `<JMXQ_MCPAPI_KEY>` or provide it as an environment variable of the same name.

## Claude Desktop

In the Admin GUI, select **Connect** and choose **Claude Desktop**. The generated configuration starts a local Stdio-only process and is valid only on the computer where this repository and Node.js are installed. It does not use the HTTP endpoint, the LAN configuration, or `JMXQ_MCPAPI_KEY`.

Add the copied entry to Claude Desktop's MCP configuration file, then restart Claude Desktop. The entry uses `JMXQ_STDIO_ONLY=true` so the process does not start HTTP listeners or conflict with the running Windows service.

```json
{
  "mcpServers": {
    "jmxq-mcp-server": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["build/index.js"],
      "cwd": "C:\\path\\to\\jmxquery-mcp-server",
      "env": {
        "JMXQ_STDIO_ONLY": "true"
      }
    }
  }
}
```

The Admin guide substitutes the actual Node.js executable path and repository directory for this computer.

### Agent Workflow

The server returns workflow instructions during MCP initialization. The first Business Central action must identify an explicit target:

```json
{
  "name": "jmxq_listInstances",
  "arguments": {}
}
```

The response keeps the complete instance list in text content for compatibility and also returns structured content with this selection shape:

```json
{
  "enabledInstances": [
    {
      "bcInstance": "Production"
    }
  ],
  "instanceCount": 1,
  "selectionRequired": false
}
```

Disabled Instances are never included in `enabledInstances`. If exactly one Instance is enabled, use it automatically. If multiple Instances are enabled, ask the user which one to use. If none are enabled, tell the user that the server needs an enabled Instance with a technical Company.

Every Business Central tool requires the exact `bcInstance` value from `enabledInstances`:

```json
{
  "name": "jmxq_searchTables",
  "arguments": {
    "bcInstance": "Production",
    "executionContextCode": "ALL",
    "searchPattern": "*customer*"
  }
}
```

`executionContextCode` is required by context-dependent tools. Before script execution, describe the context and use one of its returned execution Companies.

```json
{
  "name": "jmxq_executeScript",
  "arguments": {
    "bcInstance": "Production",
    "executionContextCode": "ALL",
    "executionCompany": "Northwind",
    "script": "SELECT Customer WHERE Name LIKE '*Contoso*';"
  }
}
```

For unknown tables, call `jmxq_searchTables` followed by `jmxq_describeTableFields`. Use `jmxq_getGrammar` or `jmxq_getExamples` before composing unfamiliar or complex scripts.

Do not ask agents to retain an active Instance or execution Company between tool calls. Explicit targets prevent cross-request routing mistakes. `jmxq_executeScript` may run `INSERT`, `MODIFY`, `DELETE`, or `RUN CODEUNIT`; tool metadata therefore marks it as potentially destructive rather than read-only.

## Diagnostics

### Admin API smoke test

Use the Admin key only with Admin routes:

```powershell
curl.exe -i http://127.0.0.1:5000/admin/api/instances `
  -H "Authorization: Bearer <ADMIN_API_KEY>"
```

A successful response is `200 OK` and a JSON array. An invalid key returns `401 Unauthorized`.

### MCP Inspector

After building the project, inspect the local Stdio transport:

```powershell
npm run inspect
```

For a running HTTP service, use a recent MCP Inspector release and select **Streamable HTTP**, then connect to the configured `/mcp/stream` endpoint with the MCP bearer key. The Inspector transport options can change between releases; use its current documented HTTP configuration surface rather than placing the key in a URL.

## Backup, Restore, and Upgrades

1. Stop the Windows service.
2. Back up `.env`, `data/instances.enc`, and the complete `logs` directory if audit history is required.
3. Keep the exact `INSTANCE_MASTER_KEY`. Without it, the encrypted Instance Store cannot be restored.
4. Install updated dependencies and run `npm run build`.
5. Start the service and verify `/admin` plus `jmxq_listInstances`.

Never edit `instances.enc` manually. Restore it only with the matching master key.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server fails at startup | Ensure `INSTANCE_MASTER_KEY` has at least 32 characters. When `ADMIN_API_ENABLED=true`, configure `ADMIN_API_KEY`. |
| Admin login fails | Verify `ADMIN_API_ENABLED=true` and the Admin key. Do not use `JMXQ_MCPAPI_KEY` here. |
| MCP client receives `401` | Configure `JMXQ_MCPAPI_KEY` in the client Authorization header. |
| Agent cannot find a target | Create and enable an Instance and Company in the Admin GUI, then call `jmxq_listInstances`. |
| Instance is disabled | Enable the Instance. All of its Companies are blocked while disabled. |
| SSO works in a terminal but fails as a service | Configure the service Log On account as a Business Central-authorized domain account. |
| OAuth request fails | Check Tenant ID, Client ID, Client Secret, Environment, Entra consent, and the Business Central application user permissions. |
| Documentation is unavailable | Ensure the service process can read the repository-root `README.md`. |

## Security Notes

- Use different random values for the MCP key, Admin key, and Instance Store master key.
- Restrict file permissions on `.env`, `data/instances.enc`, and `logs`.
- Use a reverse proxy and TLS for any non-local deployment.
- Treat stored JMX-QUERY scripts as potentially sensitive business data.
- Rotate credentials by editing the relevant Instance in the Admin GUI. Replacing `INSTANCE_MASTER_KEY` requires re-encrypting or recreating the Instance Store.
