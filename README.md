# jmxquery-mcp-server

This is a Model Context Protocol (MCP) server that exposes JMX-QUERY functions from Microsoft Business Central (On-Premise **and** SaaS/Online) to AI agents.

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

## Installation (Clean Windows)

This section describes the minimal prerequisites and steps to install and run the MCP server on a fresh Windows machine.

### Prerequisites

- **Windows**: Windows 10/11 or Windows Server.
- **Node.js (LTS)**: Install a current **Node.js LTS** release (includes `npm`).
  - Install options:
    - **winget** (recommended on modern Windows): `winget install --id OpenJS.NodeJS.LTS -e`
    - **MSI installer**: download from https://nodejs.org and run the LTS installer
  - Verify:
    - `node --version`
    - `npm --version`
- **Git** (recommended): For cloning/updating the repository.
  - Alternative: Download the repository as a ZIP and extract it.
- **Administrator privileges**: Only required if you want to **install/manage Windows services** (`npm run service:setup`, `npm run service:install`, `npm run service:uninstall`).
- **Network/Firewall**:
  - Ensure the machine can reach your Business Central OData endpoint (On-Prem) or the internet (SaaS).
  - Open the ports you configure (defaults: `5000` for SSE and `5001` for Streamable HTTP).

### Installation Steps

1. Get the sources:
   - Clone (recommended):
     ```bash
     git clone <repo-url>
     cd jmxquery-mcp-server
     ```
   - Or download ZIP and `cd` into the extracted folder.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the server:
   ```bash
   npm run build
   ```
4. Create an instance configuration (`.env`):
   - Recommended: run the guided setup wizard (run PowerShell **as Administrator** if you want it to install the Windows service):
     ```bash
     npm run service:setup
     ```
   - The wizard writes an `.env` file (default: `instances/<label>.env`) and can optionally install/start the service.
5. Run the server:
   - Interactive/console (uses environment variables you provide):
     ```bash
     npm start
     ```
   - Or run as a Windows service (recommended for always-on usage):
     - Use the wizard in step 4, or see “Manual Install / Uninstall” below.

## Configuration (.env)

The server is configured via environment variables in a `.env` file.

### Authentication Recommendations

- **SaaS / Business Central Online**: Use **`BC_AUTH_TYPE=OAUTH`** (client credentials). This is the intended and most robust option for cloud environments.
- **On-Premise (domain joined)**: Prefer **`BC_AUTH_TYPE=SSO`** if the server runs under a domain account that can access Business Central.
- **On-Premise (no SSO possible)**: Use **`BC_AUTH_TYPE=NTLM`** as a fallback (requires credentials in the `.env`).
- **`BASIC`**: Only recommended for controlled **lab/proxy** scenarios (always over TLS). In most real setups SSO or OAuth is preferable.

### On-Premise

| Variable | Description | Example |
| :--- | :--- | :--- |
| `BC_ODATA_BASE_URL` | The base URL of your BC OData V4 service. | `http://bc-server:7048/BC220/ODataV4/` |
| `BC_COMPANY` | The name of the BC company to connect to. | `CRONUS Deutschland GmbH` |
| `BC_AUTH_TYPE` | Authentication method: `BASIC`, `NTLM`, or `SSO`. | `NTLM` |
| `BC_USERNAME` | Username for BC authentication (not needed for SSO). | `domain\user` |
| `BC_PASSWORD` | Password for BC authentication (not needed for SSO). | `your_password` |

#### On-Premise SSO Setup (Integrated Windows Authentication)

`BC_AUTH_TYPE=SSO` uses the **Windows identity of the running process** to authenticate against the Business Central OData endpoint.
In this project, SSO calls are executed via a small PowerShell bridge using `Invoke-RestMethod -UseDefaultCredentials`.

This mode is usually the best choice for **domain-joined On-Premise** setups because you avoid storing passwords in the `.env` file.

##### A) Prerequisites

1. Your Business Central On-Prem environment must be reachable from the machine running this MCP server.
2. The OData V4 endpoint must support Windows authentication for the account you will run under.
3. Decide which Windows identity will run the MCP server:
   - **Interactive/dev**: the current logged-in Windows user.
   - **Windows service**: a dedicated **domain service account** (recommended).

##### B) Create/Configure the identity in Business Central

1. Create or choose a Windows/domain account (e.g. `DOMAIN\svc-jmxq-mcp`).
2. In Business Central, open **Users** and create a user for this Windows account.
   - Use the Windows login / authentication type appropriate for your BC version.
3. Assign permission sets to this BC user.
   - Recommended: `JMXQ_JMXQUERY` (least privilege)
   - Fallback/testing: `SUPER` (not recommended for production)

##### C) Configure the MCP server `.env`

Example SSO config:

```ini
BC_AUTH_TYPE=SSO
BC_ODATA_BASE_URL=http://bc-server:7048/BC220/ODataV4/
BC_COMPANY=CRONUS Deutschland GmbH

MCP_HOST=127.0.0.1
MCP_PORT=5000
MCP_STREAMABLE_PORT=5001
```

Notes:
- For SSO you normally do **not** set `BC_USERNAME` / `BC_PASSWORD`.
- `BC_ODATA_BASE_URL` must include the trailing `/ODataV4/` segment (the server normalizes a missing trailing slash).

##### D) If running as a Windows Service (important)

If you run SSO as a Windows service, you must change the service **Log On** user.

1. Open **Services** (`services.msc`).
2. Find your service (e.g. `JMX-QUERY MCP - P4E_DE_22`).
3. Open **Properties → Log On**.
4. Select **This account** and enter your domain account (e.g. `DOMAIN\svc-jmxq-mcp`).
5. Restart the service.

> [!WARNING]
> SSO will typically fail under `LocalSystem` because it cannot authenticate to remote servers as a real domain identity.

##### Troubleshooting

- **401 / Authentication_InvalidCredentials**
  - Ensure the service is running under the intended domain account (see section D).
  - Ensure that account exists as a user in Business Central and has the required permission sets.
- **Works in console, fails as service**
  - That almost always means the console user has permissions, but the service account does not.
- **Connectivity/timeouts**
  - Verify the URL in `BC_ODATA_BASE_URL` is reachable from the MCP server machine.
  - Increase `HTTP_TIMEOUT_MS` if your on-prem environment is slow.

### SaaS / Business Central Online (OAuth 2.0)

Set `BC_AUTH_TYPE=OAUTH` and provide the following Azure AD App Registration values.
`BC_ODATA_BASE_URL` is **not required** — the OData URL is auto-constructed as  
`https://api.businesscentral.dynamics.com/v2.0/{BC_TENANT_ID}/{BC_ENVIRONMENT}/ODataV4/`.

| Variable | Description | Example |
| :--- | :--- | :--- |
| `BC_AUTH_TYPE` | Must be `OAUTH` for SaaS. | `OAUTH` |
| `BC_TENANT_ID` | Azure AD Tenant ID (GUID or domain). | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `BC_CLIENT_ID` | App registration Client ID. | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `BC_CLIENT_SECRET` | Client Secret created in the App registration. | `your-client-secret` |
| `BC_ENVIRONMENT` | Name of the BC environment to connect to. Defaults to `Production`. | `Sandbox` |
| `BC_COMPANY` | The name of the BC company to connect to. | `CRONUS International Ltd.` |

#### Azure App Registration Setup

This MCP server uses **OAuth 2.0 client credentials** against Business Central SaaS.
That means you need (A) an **Entra ID App Registration** and (B) a corresponding **Microsoft Entra application user** in Business Central with permission sets.

##### A) Create the Entra ID App Registration

1. Open the [Azure portal](https://portal.azure.com) (or Entra admin center) and go to **Microsoft Entra ID → App registrations → New registration**.
2. Name it (e.g. `JMXQuery MCP Server`) and register it.
  - Typically: **Single tenant** (same tenant as your Business Central environment).
3. Go to **Certificates & secrets → Client secrets → New client secret**.
  - Copy the secret value immediately and store it securely.
  - This becomes `BC_CLIENT_SECRET`.
4. Go to **API permissions → Add a permission**.
  - Select **Dynamics 365 Business Central**.
  - Choose **Application permissions** (not Delegated).
  - Add at least: `Financials.ReadWrite.All`.
5. Click **Grant admin consent** for your tenant.
6. From **Overview**, copy:
  - **Application (client) ID** → `BC_CLIENT_ID`
  - **Directory (tenant) ID** → `BC_TENANT_ID`

> [!NOTE]
> For SaaS, the server auto-constructs the OData base URL using `BC_TENANT_ID` + `BC_ENVIRONMENT`.
> You do **not** need to set `BC_ODATA_BASE_URL` for `BC_AUTH_TYPE=OAUTH`.

##### B) Create/Authorize the Application in Business Central (Microsoft Entra applications)

In Business Central you must create an **application user** for the App Registration and assign permission sets.

1. Open Business Central and search for the page **Microsoft Entra applications**.
  - Depending on your language/version it may also appear as **Azure AD applications**.
2. Create a new entry:
  - **Client ID**: paste the App Registration **Application (client) ID**.
  - Provide a meaningful description/name.
3. Assign permission sets to this application user.
  - For JMX-QUERY use one of:
    - `JMXQ_JMXQUERY` (recommended, least privilege)
    - `SUPER` (works but is not recommended for production)
4. Save the record.

> [!TIP]
> If you maintain multiple environments (e.g. Sandbox/Production), ensure `BC_ENVIRONMENT` matches the environment name in the Business Central URL.

##### C) Configure the MCP server `.env`

Minimum SaaS config:

```ini
BC_AUTH_TYPE=OAUTH
BC_TENANT_ID=<tenant-guid>
BC_CLIENT_ID=<app-registration-client-id>
BC_CLIENT_SECRET=<client-secret>
BC_ENVIRONMENT=Sandbox
BC_COMPANY=<exact company display name>
```

If OAuth fails with authorization errors, the two most common causes are:
- Missing **admin consent** for the Business Central API permissions in Entra ID.
- Missing/insufficient **permission sets** on the Business Central **Microsoft Entra application user**.

### Common Settings

| Variable | Description | Example |
| :--- | :--- | :--- |
| `JMXQ_EXECUTION_CONTEXT_CODE` | Default context code for JMX-QUERY. | `DEFAULT` |
| `MCP_HOST` | Host the MCP server should bind to. | `127.0.0.1` |
| `MCP_PORT` | Port for the main server (includes SSE). | `5000` |
| `MCP_STREAMABLE_PORT` | **Optional**: Dedicated port for Streamable HTTP. | `5001` |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`). | `info` |
| `HTTP_TIMEOUT_MS` | Timeout for outbound Business Central calls (HTTP / SSO bridge). | `60000` |
| `MCP_API_KEY` | **Optional**: API key for securing SSE/HTTP access. | `your-secret-key` |

## Windows Service Integration

The server can be registered as a Windows service to run in the background and start automatically.
Multiple instances can run in parallel — each pointing to a different BC instance on its own ports.

> [!IMPORTANT]
> Running the service management scripts requires **Administrator privileges**.

### Guided Setup (recommended)

The interactive setup wizard guides you through the full configuration, writes the `.env` file, and optionally installs the Windows service in one step:

```bash
npm run service:setup
```

The wizard will:
1. Ask for an **instance label** (suffix of the Windows service name, e.g. `CompanyA Prod`)
2. Let you choose the **authentication type** — and warn you if you choose NTLM (see note below)
3. Ask only the fields **relevant to the chosen auth type**
4. Show a **preview** of the generated `.env` file (secrets masked)
5. Write the `.env` file to a path of your choice (default: `instances/<sanitized-label>.env`)
6. Optionally **install and start the Windows service** immediately

The wizard also supports a **Delete mode** (uninstall service + remove `.env`).

After completion the wizard prints a summary (service name, ports, env file path).

### Manual Install / Uninstall

If you prefer to install manually, build first and then use the install script:

```bash
npm run build

# Single (default) instance — service name: "JMX-QUERY MCP - Server"
npm run service:install

# Named instance with a dedicated .env file
node scripts/install-service.js --instance "CompanyA Prod" --env-file "C:\configs\companyA.env"

# Uninstall
npm run service:uninstall
node scripts/uninstall-service.js --instance "CompanyA Prod"
```

| Argument | Description | Default |
| :--- | :--- | :--- |
| `--instance <label>` | Suffix of the Windows service name (`JMX-QUERY MCP - <label>`) | `Server` |
| `--env-file <path>` | Path to the `.env` file this instance should use | *(recommended)* |

### Running Multiple Instances in Parallel

Each instance needs its own `.env` file with **unique port numbers** and its own **Windows service name** (via `--instance`):

```bash
# Instance 1 — CompanyA Production
node scripts/install-service.js --instance "CompanyA Prod" --env-file "C:\configs\companyA-prod.env"

# Instance 2 — CompanyB Test
node scripts/install-service.js --instance "CompanyB Test" --env-file "C:\configs\companyB-test.env"
```

Example `companyA-prod.env`:
```ini
BC_AUTH_TYPE=OAUTH
BC_TENANT_ID=xxxxxxxx-...
BC_CLIENT_ID=xxxxxxxx-...
BC_CLIENT_SECRET=your-secret
BC_ENVIRONMENT=Production
BC_COMPANY=CRONUS International Ltd.
MCP_PORT=5000
MCP_STREAMABLE_PORT=5001
```

Example `companyB-test.env`:
```ini
BC_AUTH_TYPE=NTLM
BC_ODATA_BASE_URL=http://bc-server:7048/BC220/ODataV4/
BC_USERNAME=domain\user
BC_PASSWORD=your-password
BC_COMPANY=CRONUS DE
MCP_PORT=5002
MCP_STREAMABLE_PORT=5003
```

Both services appear in **Services Manager** (`services.msc`) as:
- `JMX-QUERY MCP - CompanyA Prod`
- `JMX-QUERY MCP - CompanyB Test`

### Windows Service User (Service Account)

For **On-Premise Business Central** with NTLM or SSO authentication, the service must run under a specific user account that has permission to access the BC server.

> [!WARNING]
> **SSO/Integrated Windows Authentication** will **FAIL** if the service runs under the default `LocalSystem` account. `LocalSystem` does not have an identity that can be used for network authentication against Business Central.
>
> **NTLM** requires explicit `BC_USERNAME` / `BC_PASSWORD` credentials in the `.env` file — it does **not** use the service account identity automatically. If the server runs under an AD account that has BC access, use **SSO** instead.

To configure the service account:
1.  Open **Services Manager** (`services.msc`).
2.  Locate the service (e.g., **"JMX-QUERY MCP - Server"**).
3.  Right-click and select **Properties**.
4.  Switch to the **Log On** tab.
5.  Select **This account** and enter the domain credentials (e.g., `DOMAIN\ServiceUser`).
6.  Restart the service.

> [!TIP]
> If you use `BC_AUTH_TYPE=SSO`, the server will attempt to use the identity of the user running the service process to authenticate against Business Central. Ensure this user is correctly set up as a user in Business Central.

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

**On-Premise (NTLM)**
```json
{
  "mcpServers": {
    "jmxq-bc": {
      "command": "node",
      "args": ["c:/Entwicklung/Antigravity/jmxquery-mcp-server/build/index.js"],
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

**SaaS / Business Central Online (OAuth 2.0)**
```json
{
  "mcpServers": {
    "jmxq-bc-saas": {
      "command": "node",
      "args": ["c:/Entwicklung/Antigravity/jmxquery-mcp-server/build/index.js"],
      "env": {
        "BC_AUTH_TYPE": "OAUTH",
        "BC_TENANT_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "BC_CLIENT_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "BC_CLIENT_SECRET": "your-client-secret",
        "BC_ENVIRONMENT": "Production",
        "BC_COMPANY": "CRONUS International Ltd."
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

