import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type FormEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import {
  BookOpen,
  Building2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  KeyRound,
  ListFilter,
  LogOut,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Network,
  Sun,
  Terminal,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import "./App.css";
import { BaseUrlDialog } from "./BaseUrlDialog";

type View = "instances" | "tools" | "logs" | "connection" | "documentation";
type Theme = "light" | "dark";
type AuthType = "BASIC" | "NTLM" | "SSO" | "OAUTH";
type SecretField = "password" | "clientSecret";
type LogTimeRange = "all" | "5m" | "10m" | "1h" | "6h" | "24h" | "3d" | "custom";
type ConnectionLocation = "local" | "lan";
type Harness =
  | "vscode"
  | "cursor"
  | "claudeDesktop"
  | "claudeCode"
  | "hermes"
  | "codex"
  | "gemini";
const harnessMeta: Record<Harness, { label: string; stdio?: boolean; hint: string }> = {
  vscode: {
    label: "VS Code / GitHub Copilot",
    hint: "Open the MCP configuration command in VS Code and add this server entry. The API key is requested securely when the client connects.",
  },
  cursor: {
    label: "Cursor",
    hint: "Open Cursor's MCP configuration (~/.cursor/mcp.json or .cursor/mcp.json) and add this server entry.",
  },
  claudeDesktop: {
    label: "Claude Desktop",
    stdio: true,
    hint: "Open Claude Desktop's configuration file and add this local server entry. Restart Claude Desktop after saving.",
  },
  claudeCode: {
    label: "Claude Code",
    hint: "Run this command in a terminal. Add --scope user to make the server available in all projects, or --scope project to write it to .mcp.json.",
  },
  hermes: {
    label: "Hermes Agent",
    hint: "Add this block to ~/.hermes/config.yaml. Hermes expands ${VAR} from ~/.hermes/.env, so store the API key there as JMXQ_MCPAPI_KEY. Run /reload-mcp in an active session afterwards.",
  },
  codex: {
    label: "Codex CLI",
    hint: "Add this table to ~/.codex/config.toml. Codex reads the API key from the environment variable named in bearer_token_env_var.",
  },
  gemini: {
    label: "Gemini CLI",
    hint: "Add this entry to ~/.gemini/settings.json (or .gemini/settings.json in a project) and restart Gemini CLI.",
  },
};
interface Instance {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  timeoutMs: number;
  authType: AuthType;
  baseUrl?: string;
  username?: string;
  tenantId?: string;
  clientId?: string;
  environment?: string;
  hasPassword?: boolean;
  hasClientSecret?: boolean;
  technicalCompany: string;
}
interface LogRecord {
  timestamp: string;
  instanceName: string | null;
  companyName: string | null;
  tool: string;
  status: "success" | "error";
  durationMs: number;
  requestId: string;
  executionContextCode: string | null;
  errorType: string | null;
  errorMessage: string | null;
  script?: string;
}
interface Metrics {
  total: number;
  success: number;
  error: number;
  averageDurationMs: number;
}
interface LogFilterOptions {
  instances: string[];
  companies: Array<{ instanceName: string; companyName: string }>;
  tools: string[];
}
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  requestId: string;
  durationMs: number;
  executionContextCode?: string;
}
interface ExecutionContextOption {
  code: string;
  description?: string;
}
interface Session {
  serverUrl: string;
}
interface McpConnectionInfo {
  streamablePort: number | null;
  apiKeyRequired: boolean;
  hostname: string;
  lanAddresses: string[];
  workingDirectory?: string;
  nodePath?: string;
}
interface McpApiKeyResponse {
  value: string;
}
interface InstanceFormData {
  name: string;
  description: string;
  enabled: boolean;
  timeoutMs: string;
  authType: AuthType;
  baseUrl: string;
  username: string;
  password: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  environment: string;
  technicalCompany: string;
}
interface ConnectionTestResponse {
  status: "ok";
  durationMs: number;
  requestId?: string;
}
interface AvailableCompany {
  name: string;
  displayName?: string;
}
interface CompanyDiscoveryResponse {
  companies: AvailableCompany[];
  durationMs: number;
  requestId?: string;
}
interface ConnectionTestDialog {
  target: string;
  succeeded: boolean;
  durationMs?: number;
  error?: string;
  errorType?: string;
  requestId?: string;
}
interface RevealedSecretDialog {
  label: string;
  value: string;
}
interface ApiErrorResponse {
  error?: string;
  detail?: string;
  errorType?: string;
  durationMs?: number;
  requestId?: string;
}
class ApiRequestError extends Error {
  readonly detail?: string;
  readonly errorType?: string;
  readonly durationMs?: number;
  readonly requestId?: string;

  constructor(message: string, response: ApiErrorResponse) {
    super(message);
    this.detail = response.detail;
    this.errorType = response.errorType;
    this.durationMs = response.durationMs;
    this.requestId = response.requestId;
  }
}

const emptyInstanceForm = (): InstanceFormData => ({
  name: "",
  description: "",
  enabled: true,
  timeoutMs: "60000",
  authType: "BASIC",
  baseUrl: "",
  username: "",
  password: "",
  tenantId: "",
  clientId: "",
  clientSecret: "",
  environment: "Production",
  technicalCompany: "",
});
const adminServerUrl = import.meta.env.DEV
  ? "http://127.0.0.1:5000"
  : window.location.origin;
const isLoopbackHostname = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
const toConnectionEndpoint = (hostname: string, protocol: string, port: number) => {
  const endpoint = new URL(`${protocol}//${hostname}`);
  endpoint.port = String(port);
  endpoint.pathname = "/mcp/stream";
  return endpoint.toString();
};
const themeStorageKey = "jmx-query-admin-theme";
const initialTheme = (): Theme => {
  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
  } catch {
    // Theme preference is optional when browser storage is unavailable.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};
const baseUrlExamples: Record<Exclude<AuthType, "OAUTH">, string> = {
  BASIC: "https://bc.example.com:7048/BC240/ODataV4/",
  NTLM: "http://bc-internal:7048/BC240/ODataV4/",
  SSO: "https://bc-internal.contoso.local:7049/Production/ODataV4/",
};
const getBaseUrlExample = (authType: AuthType) =>
  authType === "OAUTH" ? "" : baseUrlExamples[authType];
const getExecutionContextOptions = (
  toolResult: ToolExecutionResult,
): ExecutionContextOption[] => {
  const resultText = toolResult.content.map((item) => item.text).join("\n");
  try {
    const response: unknown = JSON.parse(resultText);
    const contexts = response && typeof response === "object" && "result" in response
      ? (response as { result?: unknown }).result
      : undefined;
    if (!Array.isArray(contexts)) return [];

    return contexts.flatMap((context): ExecutionContextOption[] => {
      if (!context || typeof context !== "object") return [];
      const { code, description } = context as {
        code?: unknown;
        description?: unknown;
      };
      return typeof code === "string" && code.trim()
        ? [{ code: code.trim(), description: typeof description === "string" ? description : undefined }]
        : [];
    });
  } catch {
    return [];
  }
};
const getExecutionCompanies = (toolResult: ToolExecutionResult): string[] => {
  const resultText = toolResult.content.map((item) => item.text).join("\n");
  try {
    const response = JSON.parse(resultText) as { result?: { companies?: unknown } };
    const companies = response.result?.companies;
    return Array.isArray(companies)
      ? companies.filter((company): company is string => typeof company === "string" && company.trim().length > 0)
      : [];
  } catch {
    return [];
  }
};
const resolveEffectiveBaseUrl = (form: InstanceFormData) => {
  const baseUrl = form.authType === "OAUTH"
    ? `https://api.businesscentral.dynamics.com/v2.0/${form.tenantId.trim()}/${form.environment.trim()}/ODataV4/`
    : form.baseUrl.trim();

  return baseUrl ? (baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`) : "";
};
const articleCountScript = [
  "FROM Item AS i",
  "| SELECT COUNT(*) AS ArticleCount",
].join("\n");
const instanceToForm = (instance: Instance): InstanceFormData => ({
  name: instance.name,
  description: instance.description,
  enabled: instance.enabled,
  timeoutMs: String(instance.timeoutMs),
  authType: instance.authType,
  baseUrl: instance.baseUrl || "",
  username: instance.username || "",
  password: "",
  tenantId: instance.tenantId || "",
  clientId: instance.clientId || "",
  clientSecret: "",
  environment: instance.environment || "Production",
  technicalCompany: instance.technicalCompany,
});
const emptyLogFilterOptions = (): LogFilterOptions => ({
  instances: [],
  companies: [],
  tools: [],
});
const isInternationalDate = (value: string) => {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return (
    date.getFullYear() === Number(year) &&
    date.getMonth() + 1 === Number(month) &&
    date.getDate() === Number(day)
  );
};
const toLogTimestamp = (value: string, endOfDay = false) => {
  const [year, month, day] = value.split("/").map(Number);
  return new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  ).toISOString();
};
const logTimeRangeMinutes: Partial<Record<LogTimeRange, number>> = {
  "5m": 5,
  "10m": 10,
  "1h": 60,
  "6h": 360,
  "24h": 1440,
  "3d": 4320,
};
const formatLogTimestamp = (timestamp: string) => {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>("instances");
  const [adminKey, setAdminKey] = useState("");
  const [loginError, setLoginError] = useState("");
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Theme preference is optional when browser storage is unavailable.
    }
  }, [theme]);
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const response = await fetch(`${adminServerUrl}/admin/api/session`, {
          credentials: "include",
        });
        if (response.ok) {
          setSession({ serverUrl: adminServerUrl });
        }
      } catch {
        // A new login is required when the prior server is unreachable.
      } finally {
        setRestoringSession(false);
      }
    };
    void restoreSession();
  }, []);
  const request = useCallback(
    async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
      if (!session) throw new Error("No active admin session.");
      const response = await fetch(`${session.serverUrl}/admin/api${path}`, {
        ...options,
        credentials: "include",
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });
      if (response.status === 401) {
        setSession(null);
      }
      if (!response.ok) {
        let message = `Request failed with HTTP ${response.status}.`;
        let errorResponse: ApiErrorResponse = {};
        try {
          errorResponse = (await response.json()) as ApiErrorResponse;
          if (errorResponse.error) message = errorResponse.error;
        } catch {
          /* preserve HTTP status */
        }
        throw new ApiRequestError(message, errorResponse);
      }
      if (response.status === 204) return undefined as T;
      if (response.headers.get("content-type")?.includes("application/json")) {
        return response.json() as Promise<T>;
      }
      return response.text() as Promise<T>;
    },
    [session],
  );
  const loadInstances = useCallback(async () => {
    setLoadingInstances(true);
    try {
      setInstances(await request<Instance[]>("/instances"));
    } finally {
      setLoadingInstances(false);
    }
  }, [request]);
  useEffect(() => {
    if (session) void loadInstances();
  }, [session, loadInstances]);
  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    const candidateAdminKey = adminKey.trim();
    if (!candidateAdminKey) {
      setLoginError("Enter the Admin API key.");
      return;
    }
    setLoginError("");
    try {
      const response = await fetch(
        `${adminServerUrl}/admin/api/session`,
        {
          method: "POST",
          credentials: "include",
          headers: { Authorization: `Bearer ${candidateAdminKey}` },
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "The Admin API key was rejected."
            : `Server returned HTTP ${response.status}.`,
        );
      setAdminKey("");
      setSession({ serverUrl: adminServerUrl });
    } catch (error) {
      setLoginError(
        error instanceof Error
          ? error.message
          : "Unable to reach the Admin API.",
      );
    }
  };
  const signOut = async () => {
    if (!session) return;
    try {
      const response = await fetch(
        `${session.serverUrl}/admin/api/session/logout`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) throw new Error("Unable to sign out.");
      setSession(null);
      setInstances([]);
      setAdminKey("");
    } catch (error) {
      setLoginError(
        error instanceof Error ? error.message : "Unable to sign out.",
      );
    }
  };
  if (restoringSession) return null;
  if (!session)
    return (
      <LoginScreen
        adminKey={adminKey}
        error={loginError}
        onAdminKey={setAdminKey}
        onSubmit={signIn}
        theme={theme}
        onThemeChange={() => setTheme(theme === "light" ? "dark" : "light")}
      />
    );
  return (
    <main className="admin-shell">
      <aside className="sidebar" aria-label="Admin navigation">
        <div className="product-mark">
          <Server size={22} aria-hidden="true" />
          <span>JMX Query</span>
          <small>Admin</small>
        </div>
        <div className="sidebar-footer">
          <ThemeToggle
            theme={theme}
            onToggle={() => setTheme(theme === "light" ? "dark" : "light")}
          />
          <button
            className="icon-button"
            type="button"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => void signOut()}
          >
            <LogOut size={18} />
          </button>
        </div>
        <nav>
          <NavigationButton
            active={view === "instances"}
            icon={<Building2 size={18} />}
            label="Instances"
            onClick={() => setView("instances")}
          />
          <NavigationButton
            active={view === "tools"}
            icon={<Terminal size={18} />}
            label="Tools"
            onClick={() => setView("tools")}
          />
          <NavigationButton
            active={view === "logs"}
            icon={<FileText size={18} />}
            label="Logs"
            onClick={() => setView("logs")}
          />
          <NavigationButton
            active={view === "connection"}
            icon={<Network size={18} />}
            label="Connect"
            onClick={() => setView("connection")}
          />
          <NavigationButton
            active={view === "documentation"}
            icon={<BookOpen size={18} />}
            label="Documentation"
            onClick={() => setView("documentation")}
          />
        </nav>
      </aside>
      <section className="workspace">
        {view === "instances" && (
          <InstancesView
            instances={instances}
            loading={loadingInstances}
            reload={loadInstances}
            request={request}
          />
        )}
        {view === "tools" && (
          <ToolsView instances={instances} request={request} />
        )}
        {view === "logs" && <LogsView request={request} />}
        {view === "connection" && (
          <ConnectionGuideView session={session} request={request} />
        )}
        {view === "documentation" && (
          <DocumentationView session={session} request={request} />
        )}
      </section>
    </main>
  );
}

function LoginScreen({
  adminKey,
  error,
  onAdminKey,
  onSubmit,
  theme,
  onThemeChange,
}: {
  adminKey: string;
  error: string;
  onAdminKey: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  theme: Theme;
  onThemeChange: () => void;
}) {
  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={onSubmit}>
        <div className="login-heading">
          <ShieldCheck size={30} aria-hidden="true" />
          <div>
            <h1>JMX Query Admin</h1>
            <p>Sign in to manage service instances.</p>
          </div>
          <ThemeToggle theme={theme} onToggle={onThemeChange} />
        </div>
        <label>
          Admin API key
          <input
            type="password"
            value={adminKey}
            title="Admin API key configured in the server .env file"
            onChange={(event) => onAdminKey(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button"
          type="submit"
          title="Authenticate with the configured Admin API key"
        >
          <KeyRound size={17} aria-hidden="true" />
          Sign in
        </button>
        <p className="memory-note">
          Credentials remain in this browser tab only.
        </p>
      </form>
    </main>
  );
}

function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: Theme;
  onToggle: () => void;
}) {
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      className="icon-button theme-toggle"
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={isDark}
      onClick={onToggle}
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function NavigationButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`nav-button ${active ? "active" : ""}`}
      title={`Open ${label}`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function InstancesView({
  instances,
  loading,
  reload,
  request,
}: {
  instances: Instance[];
  loading: boolean;
  reload: () => Promise<void>;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [instanceForm, setInstanceForm] = useState<InstanceFormData | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealedSecret, setRevealedSecret] =
    useState<RevealedSecretDialog | null>(null);
  const [connectionTest, setConnectionTest] =
    useState<ConnectionTestDialog | null>(null);
  const [baseUrlPreview, setBaseUrlPreview] = useState<string | null>(null);
  const selected =
    instances.find((instance) => instance.name === selectedName) || null;
  useEffect(() => {
    setRevealedSecret(null);
  }, [selectedName]);
  useEffect(() => {
    if (!revealedSecret) return;
    const timeout = window.setTimeout(() => setRevealedSecret(null), 30000);
    return () => window.clearTimeout(timeout);
  }, [revealedSecret]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  const submitInstance = (event: FormEvent) => {
    event.preventDefault();
    if (!instanceForm) return;
    const form = instanceForm;
    const common = {
      description: form.description,
      enabled: form.enabled,
      timeoutMs: Number(form.timeoutMs),
      technicalCompany: form.technicalCompany,
    };
    const authFields =
      form.authType === "OAUTH"
        ? {
            tenantId: form.tenantId,
            clientId: form.clientId,
            environment: form.environment,
            ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
          }
        : form.authType === "SSO"
          ? { baseUrl: form.baseUrl }
          : {
              baseUrl: form.baseUrl,
              username: form.username,
              ...(form.password ? { password: form.password } : {}),
            };
    const isEditing = Boolean(selected && selected.name === form.name);
    if (
      !isEditing &&
      ((form.authType === "OAUTH" && !form.clientSecret) ||
        ((form.authType === "BASIC" || form.authType === "NTLM") &&
          !form.password))
    ) {
      setError("A secret is required when creating this authentication type.");
      return;
    }
    void perform(async () => {
      if (isEditing)
        await request(`/instances/${encodeURIComponent(form.name)}`, {
          method: "PATCH",
          body: JSON.stringify({ ...common, ...authFields }),
        });
      else
        await request("/instances", {
          method: "POST",
          body: JSON.stringify({
            name: form.name,
            authType: form.authType,
            ...common,
            ...authFields,
          }),
        });
      await reload();
      setSelectedName(form.name);
      setInstanceForm(null);
      setRevealedSecret(null);
    });
  };
  const testTechnicalCompany = (instanceName: string) => {
    void perform(async () => {
      const target = `${instanceName} technical company`;
      try {
        const result = await request<ConnectionTestResponse>(
          `/instances/${encodeURIComponent(instanceName)}/test-technical-company`,
          { method: "POST" },
        );
        setConnectionTest({
          target,
          succeeded: true,
          durationMs: result.durationMs,
          requestId: result.requestId,
        });
      } catch (caught) {
        const error = caught instanceof ApiRequestError ? caught : undefined;
        setConnectionTest({
          target,
          succeeded: false,
          durationMs: error?.durationMs,
          error: error?.detail || (caught instanceof Error ? caught.message : "Technical company test failed."),
          errorType: error?.errorType,
          requestId: error?.requestId,
        });
      }
    });
  };
  const testInstanceConnection = (instanceName: string) => {
    void perform(async () => {
      try {
        const result = await request<ConnectionTestResponse>(
          `/instances/${encodeURIComponent(instanceName)}/test-connection`,
          { method: "POST" },
        );
        setConnectionTest({
          target: instanceName,
          succeeded: true,
          durationMs: result.durationMs,
          requestId: result.requestId,
        });
      } catch (caught) {
        const error = caught instanceof ApiRequestError ? caught : undefined;
        setConnectionTest({
          target: instanceName,
          succeeded: false,
          durationMs: error?.durationMs,
          error: error?.detail || (caught instanceof Error ? caught.message : "Connection test failed."),
          errorType: error?.errorType,
          requestId: error?.requestId,
        });
      }
    });
  };
  const revealSecret = (field: SecretField) => {
    if (!selected) return;
    void perform(async () => {
      const result = await request<{ value: string }>(
        `/instances/${encodeURIComponent(selected.name)}/secrets/${field}/reveal`,
        { method: "POST" },
      );
      setRevealedSecret({
        label: field === "password" ? "Password" : "Client secret",
        value: result.value,
      });
    });
  };
  const editSecret = (field: SecretField, value: string) => {
    if (!instanceForm) return;
    setRevealedSecret(null);
    setInstanceForm({ ...instanceForm, [field]: value });
  };
  return (
    <div className="view-layout instances-layout">
      <header className="view-header">
        <div>
          <p className="eyebrow">Configuration</p>
          <h1>Instances</h1>
        </div>
        <button
          className="primary-button"
          type="button"
          title="Create a new Business Central connection profile"
          onClick={() => {
            setSelectedName(null);
            setInstanceForm(emptyInstanceForm());
          }}
        >
          <Plus size={17} aria-hidden="true" />
          New instance
        </button>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="instances-grid">
        <section className="list-panel" aria-label="Instances">
          <div className="panel-heading">
            <h2>Configured instances</h2>
            <button
              className="icon-button"
              type="button"
              title="Refresh instances"
              aria-label="Refresh instances"
              onClick={() => void reload()}
            >
              <RefreshCw size={17} className={loading ? "spinning" : ""} />
            </button>
          </div>
          {instances.length === 0 && (
            <p className="empty-state">No instances configured.</p>
          )}
          {instances.map((instance) => (
            <button
              className={`instance-row ${selected?.name === instance.name ? "selected" : ""}`}
              type="button"
              key={instance.id}
              title={`Select ${instance.name}`}
              onClick={() => {
                setSelectedName(instance.name);
                setInstanceForm(null);
              }}
            >
              <span>
                <strong>{instance.name}</strong>
                <small>
                  {instance.authType} ·{" "}
                  {instance.description || "No description"}
                </small>
              </span>
              <StatusBadge enabled={instance.enabled} />
            </button>
          ))}
        </section>
        <section className="detail-panel">
          {instanceForm ? (
            <InstanceForm
              form={instanceForm}
              editing={Boolean(selected && selected.name === instanceForm.name)}
              hasPassword={selected?.hasPassword}
              hasClientSecret={selected?.hasClientSecret}
              busy={busy}
              request={request}
              onChange={setInstanceForm}
              onSecretChange={editSecret}
              onReveal={revealSecret}
              onCancel={() => setInstanceForm(null)}
              onSubmit={submitInstance}
            />
          ) : selected ? (
            <>
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{selected.authType}</p>
                  <h2>{selected.name}</h2>
                </div>
                <div className="button-row">
                  <button
                    className="icon-button"
                    type="button"
                    title="Edit instance"
                    aria-label="Edit instance"
                    onClick={() => setInstanceForm(instanceToForm(selected))}
                  >
                    <Pencil size={17} />
                  </button>
                  <button
                    className="icon-button danger"
                    type="button"
                    title="Delete instance"
                    aria-label="Delete instance"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete instance "${selected.name}"?`,
                        )
                      )
                        void perform(async () => {
                          await request(
                            `/instances/${encodeURIComponent(selected.name)}`,
                            { method: "DELETE" },
                          );
                          await reload();
                          setSelectedName(null);
                        });
                    }}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              <dl className="definition-grid">
                <dt>Status</dt>
                <dd>
                  <StatusBadge enabled={selected.enabled} />
                </dd>
                <dt>Timeout</dt>
                <dd>{selected.timeoutMs.toLocaleString()} ms</dd>
                <dt>Endpoint</dt>
                <dd>
                  {selected.baseUrl || selected.environment || "Not applicable"}
                </dd>
                <dt>Technical company</dt>
                <dd>{selected.technicalCompany}</dd>
              </dl>
              <button
                className="secondary-button"
                type="button"
                disabled={busy || !selected.enabled}
                title={selected.enabled
                  ? "Test the configured OData service root and authentication without requiring a Company"
                  : "Enable the instance before testing its connection"}
                onClick={() => testInstanceConnection(selected.name)}
              >
                <RefreshCw
                  size={16}
                  className={busy ? "spinning" : ""}
                  aria-hidden="true"
                />
                Test connection
              </button>
              <button
                className="secondary-button instance-toggle"
                type="button"
                title="Show the Business Central base URL used for requests"
                onClick={() =>
                  setBaseUrlPreview(
                    resolveEffectiveBaseUrl(instanceToForm(selected)),
                  )
                }
              >
                <Server size={16} aria-hidden="true" />
                Show base URL
              </button>
              <button
                className="secondary-button instance-toggle"
                type="button"
                disabled={busy || !selected.enabled}
                title="Verify that the technical company can load execution contexts"
                onClick={() => testTechnicalCompany(selected.name)}
              >
                <RefreshCw size={16} className={busy ? "spinning" : ""} aria-hidden="true" />
                Test technical company
              </button>
              <button
                className="secondary-button instance-toggle"
                type="button"
                disabled={busy}
                title={selected.enabled ? "Block new requests to this instance" : "Allow new requests to this instance"}
                aria-label={
                  selected.enabled ? "Disable instance" : "Enable instance"
                }
                onClick={() =>
                  void perform(async () => {
                    await request(
                      `/instances/${encodeURIComponent(selected.name)}/enabled`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: !selected.enabled }),
                      },
                    );
                    await reload();
                  })
                }
              >
                {selected.enabled ? "Disable instance" : "Enable instance"}
              </button>
            </>
          ) : (
            <div className="empty-detail">
              <Building2 size={34} aria-hidden="true" />
              <h2>Select an instance</h2>
              <p>Choose an instance to manage its connection and technical company.</p>
            </div>
          )}
        </section>
      </div>
      {revealedSecret && (
        <Modal
          title={revealedSecret.label}
          onClose={() => setRevealedSecret(null)}
        >
          <p>This value is visible for 30 seconds.</p>
          <input
            className="revealed-secret-value"
            value={revealedSecret.value}
            readOnly
            aria-label={revealedSecret.label}
          />
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              title="Close dialog"
              onClick={() => setRevealedSecret(null)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
      {connectionTest && (
        <Modal
          title={connectionTest.succeeded ? "Connection successful" : "Connection failed"}
          onClose={() => setConnectionTest(null)}
        >
          <p>
            {connectionTest.succeeded
              ? `Connection to ${connectionTest.target} succeeded.`
              : `Connection to ${connectionTest.target} could not be established.`}
          </p>
          <dl className="definition-grid">
            {connectionTest.durationMs !== undefined && (
              <>
                <dt>Duration</dt>
                <dd>{connectionTest.durationMs.toLocaleString()} ms</dd>
              </>
            )}
            {!connectionTest.succeeded && connectionTest.errorType && (
              <>
                <dt>Error type</dt>
                <dd>{connectionTest.errorType}</dd>
              </>
            )}
            {!connectionTest.succeeded && connectionTest.error && (
              <>
                <dt>Reason</dt>
                <dd>{connectionTest.error}</dd>
              </>
            )}
            {connectionTest.requestId && (
              <>
                <dt>Request ID</dt>
                <dd>{connectionTest.requestId}</dd>
              </>
            )}
          </dl>
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              title="Close connection test result"
              onClick={() => setConnectionTest(null)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
      {baseUrlPreview && (
        <BaseUrlDialog
          baseUrl={baseUrlPreview}
          onClose={() => setBaseUrlPreview(null)}
        />
      )}
    </div>
  );
}

function InstanceForm({
  form,
  editing,
  hasPassword,
  hasClientSecret,
  busy,
  request,
  onChange,
  onSecretChange,
  onReveal,
  onCancel,
  onSubmit,
}: {
  form: InstanceFormData;
  editing: boolean;
  hasPassword?: boolean;
  hasClientSecret?: boolean;
  busy: boolean;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  onChange: (value: InstanceFormData) => void;
  onSecretChange: (field: SecretField, value: string) => void;
  onReveal: (field: SecretField) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const [visibleSecret, setVisibleSecret] =
    useState<RevealedSecretDialog | null>(null);
  const [showBaseUrl, setShowBaseUrl] = useState(false);
  const [connectionState, setConnectionState] = useState<"idle" | "testing" | "verified" | "loadingCompanies">("idle");
  const [availableCompanies, setAvailableCompanies] = useState<AvailableCompany[]>([]);
  const [connectionError, setConnectionError] = useState("");
  const effectiveBaseUrl = resolveEffectiveBaseUrl(form);
  const connectionSignature = JSON.stringify({
    authType: form.authType,
    baseUrl: form.baseUrl,
    username: form.username,
    password: form.password,
    tenantId: form.tenantId,
    clientId: form.clientId,
    clientSecret: form.clientSecret,
    environment: form.environment,
    timeoutMs: form.timeoutMs,
  });
  useEffect(() => {
    if (!visibleSecret) return;
    const timeout = window.setTimeout(() => setVisibleSecret(null), 30000);
    return () => window.clearTimeout(timeout);
  }, [visibleSecret]);
  useEffect(() => {
    setConnectionState("idle");
    setAvailableCompanies([]);
    setConnectionError("");
  }, [connectionSignature]);
  const connectionInput = () => ({
    authType: form.authType,
    timeoutMs: Number(form.timeoutMs),
    ...(form.authType === "OAUTH"
      ? {
          tenantId: form.tenantId,
          clientId: form.clientId,
          clientSecret: form.clientSecret,
          environment: form.environment,
        }
      : form.authType === "SSO"
        ? { baseUrl: form.baseUrl }
        : {
            baseUrl: form.baseUrl,
            username: form.username,
            password: form.password,
          }),
  });
  const canTestConnection = Boolean(
    effectiveBaseUrl
    && (form.authType === "SSO"
      || (form.authType === "OAUTH"
        ? form.clientId && form.clientSecret && form.tenantId && form.environment
        : form.username && form.password)),
  );
  const testConnection = async () => {
    setConnectionState("testing");
    setConnectionError("");
    try {
      await request<ConnectionTestResponse>("/instance-connection/test", {
        method: "POST",
        body: JSON.stringify(connectionInput()),
      });
      setConnectionState("verified");
    } catch (caught) {
      const detail = caught instanceof ApiRequestError ? caught.detail : undefined;
      setConnectionError(detail || (caught instanceof Error ? caught.message : "Connection test failed."));
      setConnectionState("idle");
    }
  };
  const loadCompanies = async () => {
    setConnectionState("loadingCompanies");
    setConnectionError("");
    try {
      const response = await request<CompanyDiscoveryResponse>("/instance-connection/companies", {
        method: "POST",
        body: JSON.stringify(connectionInput()),
      });
      setAvailableCompanies(response.companies);
      setConnectionState("verified");
      if (!response.companies.some((company) => company.name === form.technicalCompany)) {
        onChange({ ...form, technicalCompany: "" });
      }
    } catch (caught) {
      const detail = caught instanceof ApiRequestError ? caught.detail : undefined;
      setConnectionError(detail || (caught instanceof Error ? caught.message : "Company discovery failed."));
      setConnectionState("idle");
    }
  };
  const secretInput = (
    field: SecretField,
    label: string,
    hasSecret: boolean | undefined,
  ) => {
    const isStoredSecret = editing && hasSecret && !form[field];
    return (
      <label>
        {label}
        <span className="secret-input">
          <input
            type="password"
            value={form[field]}
            title={`Enter the ${label.toLowerCase()} for this authentication method`}
            onChange={(event) => onSecretChange(field, event.target.value)}
            autoComplete="new-password"
            placeholder={editing && hasSecret ? "Stored value unchanged" : ""}
            required={!editing}
          />
          <button
            className="icon-button secret-eye"
            type="button"
            title={`Show ${label.toLowerCase()}`}
            aria-label={`Show ${label.toLowerCase()}`}
            onClick={() => {
              if (isStoredSecret) {
                onReveal(field);
                return;
              }
              setVisibleSecret({ label, value: form[field] });
            }}
          >
            <Eye size={16} />
          </button>
        </span>
      </label>
    );
  };
  return (
    <form className="edit-form" onSubmit={onSubmit}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            {editing ? "Edit configuration" : "New configuration"}
          </p>
          <h2>{editing ? form.name : "Create instance"}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Close form"
          aria-label="Close form"
          onClick={onCancel}
        >
          <X size={18} />
        </button>
      </div>
      <div className="form-grid">
        <label>
          Name
          <input
            value={form.name}
            title="Unique name used by administrators and MCP agents to select this instance"
            onChange={(event) =>
              onChange({ ...form, name: event.target.value })
            }
            disabled={editing}
            required
          />
        </label>
        <label>
          Authentication
          <select
            value={form.authType}
            title="Authentication method used for Business Central requests"
            disabled={editing}
            onChange={(event) =>
              onChange({ ...form, authType: event.target.value as AuthType })
            }
          >
            <option value="BASIC">BASIC</option>
            <option value="NTLM">NTLM</option>
            <option value="SSO">SSO</option>
            <option value="OAUTH">OAUTH</option>
          </select>
        </label>
        <label className="wide">
          Description
          <input
            value={form.description}
            title="Optional description for administrators"
            onChange={(event) =>
              onChange({ ...form, description: event.target.value })
            }
          />
        </label>
        <label>
          Timeout (ms)
          <input
            type="number"
            min="1"
            max="300000"
            value={form.timeoutMs}
            title="Maximum duration in milliseconds for a Business Central request"
            onChange={(event) =>
              onChange({ ...form, timeoutMs: event.target.value })
            }
            required
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.enabled}
            title="Allow new MCP requests to this instance"
            onChange={(event) =>
              onChange({ ...form, enabled: event.target.checked })
            }
          />
          Enabled
        </label>
        {form.authType === "OAUTH" ? (
          <>
            <label>
              Tenant ID
              <input
                value={form.tenantId}
                title="Microsoft Entra ID directory (tenant) ID used for Business Central Online"
                onChange={(event) =>
                  onChange({ ...form, tenantId: event.target.value })
                }
                required
              />
            </label>
            <label>
              Client ID
              <input
                value={form.clientId}
                title="Microsoft Entra application (client) ID"
                onChange={(event) =>
                  onChange({ ...form, clientId: event.target.value })
                }
                required
              />
            </label>
            <label>
              Environment
              <input
                value={form.environment}
                title="Technical Business Central Online environment name"
                placeholder="P4E_Sandbox"
                onChange={(event) =>
                  onChange({ ...form, environment: event.target.value })
                }
                required
              />
            </label>
            {secretInput("clientSecret", "Client secret", hasClientSecret)}
          </>
        ) : (
          <>
            <label
              className="wide"
              title="Select an MCP tool to execute, e.g. jmxq_searchTables to find a table."
            >
              <span className="field-label-with-action">
                <span>Base URL</span>
                <button
                  className="url-assist-button"
                  type="button"
                  title={`Insert an editable ${form.authType} OData V4 Base URL example`}
                  onClick={() =>
                    onChange({
                      ...form,
                      baseUrl: getBaseUrlExample(form.authType),
                    })
                  }
                >
                  <WandSparkles size={15} aria-hidden="true" />
                  Use example
                </button>
              </span>
              <input
                type="url"
                value={form.baseUrl}
                title={`Business Central OData V4 service root. Example: ${getBaseUrlExample(form.authType)}`}
                placeholder={getBaseUrlExample(form.authType)}
                onChange={(event) =>
                  onChange({ ...form, baseUrl: event.target.value })
                }
                required
              />
            </label>
            {form.authType !== "SSO" && (
              <>
                <label title="Select the configured Business Central instance, e.g. Sandbox.">
                  Username
                  <input
                    value={form.username}
                    title="Business Central username for this connection"
                    onChange={(event) =>
                      onChange({ ...form, username: event.target.value })
                    }
                    required
                  />
                </label>
                {secretInput("password", "Password", hasPassword)}
              </>
            )}
          </>
        )}
      </div>
      <section className="connection-setup" aria-label="Technical company setup">
        <div>
          <p className="eyebrow">Technical company</p>
          <h3>Verify connection and choose a company</h3>
        </div>
        <div className="connection-setup-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={!canTestConnection || connectionState === "testing" || connectionState === "loadingCompanies"}
            title="Test the entered Business Central connection without saving this Instance"
            onClick={() => void testConnection()}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {connectionState === "testing" ? "Testing connection" : "Test connection"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={connectionState !== "verified"}
            title="Load available Business Central companies after a successful connection test"
            onClick={() => void loadCompanies()}
          >
            <Building2 size={16} aria-hidden="true" />
            {connectionState === "loadingCompanies" ? "Loading companies" : "Load companies"}
          </button>
        </div>
        {connectionState === "verified" && !availableCompanies.length && !connectionError && (
          <p className="connection-status">Connection verified. Load companies to choose the technical company.</p>
        )}
        {connectionError && <p className="form-error" role="alert">{connectionError}</p>}
        <label>
          Technical company
          <select
            value={form.technicalCompany}
            title="Business Central company used internally for context, table, metadata, and information API calls"
            disabled={availableCompanies.length === 0}
            onChange={(event) => onChange({ ...form, technicalCompany: event.target.value })}
            required
          >
            <option value="">{availableCompanies.length ? "Select a company" : "Test and load companies first"}</option>
            {availableCompanies.map((company) => (
              <option key={company.name} value={company.name}>
                {company.displayName ? `${company.displayName} (${company.name})` : company.name}
              </option>
            ))}
          </select>
        </label>
      </section>
      <div className="form-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!effectiveBaseUrl}
          title="Show the Business Central base URL used for requests"
          onClick={() => setShowBaseUrl(true)}
        >
          <Server size={16} aria-hidden="true" />
          Show base URL
        </button>
        <button
          className="secondary-button"
          type="button"
          title="Discard unsaved instance changes"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || !form.technicalCompany || availableCompanies.length === 0}
          title={editing ? "Save instance changes" : "Create this instance"}
        >
          {editing ? "Save changes" : "Create instance"}
        </button>
      </div>
      {visibleSecret && (
        <Modal title={visibleSecret.label} onClose={() => setVisibleSecret(null)}>
          <p>This value is visible for 30 seconds.</p>
          <input
            className="revealed-secret-value"
            value={visibleSecret.value}
            readOnly
            aria-label={visibleSecret.label}
          />
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              title="Close dialog"
              onClick={() => setVisibleSecret(null)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
      {showBaseUrl && (
        <BaseUrlDialog
          baseUrl={effectiveBaseUrl}
          onClose={() => setShowBaseUrl(false)}
        />
      )}
    </form>
  );
}

function ToolsView({
  instances,
  request,
}: {
  instances: Instance[];
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [selectedToolName, setSelectedToolName] = useState("");
  const [selectedInstanceName, setSelectedInstanceName] = useState("");
  const [executionContextCode, setExecutionContextCode] = useState("");
  const [executionCompany, setExecutionCompany] = useState("");
  const [availableExecutionCompanies, setAvailableExecutionCompanies] = useState<string[]>([]);
  const [loadingExecutionCompanies, setLoadingExecutionCompanies] = useState(false);
  const [tableRef, setTableRef] = useState("");
  const [searchPattern, setSearchPattern] = useState("");
  const [script, setScript] = useState("");
  const [selectedScriptTemplate, setSelectedScriptTemplate] = useState("");
  const [executionContextPickerOpen, setExecutionContextPickerOpen] = useState(false);
  const [availableExecutionContexts, setAvailableExecutionContexts] = useState<ExecutionContextOption[]>([]);
  const [selectedAvailableExecutionContext, setSelectedAvailableExecutionContext] = useState("");
  const [loadingExecutionContexts, setLoadingExecutionContexts] = useState(false);
  const [executionContextPickerError, setExecutionContextPickerError] = useState("");
  const [result, setResult] = useState<ToolExecutionResult | null>(null);
  const [error, setError] = useState("");
  const [loadingTools, setLoadingTools] = useState(true);
  const [running, setRunning] = useState(false);
  const [confirmExecution, setConfirmExecution] = useState(false);
  const selectedTool = tools.find((tool) => tool.name === selectedToolName);
  const requiresInstance = (tool: ToolDefinition | undefined) => {
    const required = tool?.inputSchema.required;
    return Array.isArray(required) && required.includes("bcInstance");
  };
  const requiresExecutionCompany = (tool: ToolDefinition | undefined) => {
    const required = tool?.inputSchema.required;
    return Array.isArray(required) && required.includes("executionCompany");
  };
  const acceptsExecutionContext = (tool: ToolDefinition | undefined) => {
    const properties = tool?.inputSchema.properties;
    return typeof properties === "object" && properties !== null && "executionContextCode" in properties;
  };

  useEffect(() => {
    setLoadingTools(true);
    void request<ToolDefinition[]>("/tools")
      .then((loadedTools) => {
        setTools(loadedTools);
        setSelectedToolName((current) =>
          loadedTools.some((tool) => tool.name === current)
            ? current
            : (loadedTools[0]?.name || ""),
        );
      })
      .catch((caught) =>
        setError(
          caught instanceof Error ? caught.message : "Unable to load tools.",
        ),
      )
      .finally(() => setLoadingTools(false));
  }, [request]);

  useEffect(() => {
    if (instances.some((instance) => instance.name === selectedInstanceName)) {
      return;
    }
    setSelectedInstanceName(
      instances.find((instance) => instance.enabled)?.name || "",
    );
  }, [instances, selectedInstanceName]);

  const loadAvailableExecutionContexts = async () => {
    if (!selectedInstanceName) return;

    setLoadingExecutionContexts(true);
    setExecutionContextPickerError("");
    try {
      const toolResult = await request<ToolExecutionResult>("/tools/call", {
        method: "POST",
        body: JSON.stringify({
          name: "jmxq_listExecutionContexts",
          arguments: {
            bcInstance: selectedInstanceName,
          },
        }),
      });
      const contexts = getExecutionContextOptions(toolResult);
      setAvailableExecutionContexts(contexts);
      setSelectedAvailableExecutionContext((current) =>
        contexts.some((context) => context.code === current)
          ? current
          : (contexts.find((context) => context.code === executionContextCode)?.code || ""),
      );
    } catch (caught) {
      setAvailableExecutionContexts([]);
      setExecutionContextPickerError(
        caught instanceof Error
          ? caught.message
          : "Unable to load execution contexts.",
      );
    } finally {
      setLoadingExecutionContexts(false);
    }
  };

  const loadExecutionCompanies = async () => {
    if (!selectedInstanceName || !executionContextCode.trim()) return;
    setLoadingExecutionCompanies(true);
    try {
      const toolResult = await request<ToolExecutionResult>("/tools/call", {
        method: "POST",
        body: JSON.stringify({
          name: "jmxq_describeExecutionContext",
          arguments: { bcInstance: selectedInstanceName, executionContextCode: executionContextCode.trim() },
        }),
      });
      const companies = getExecutionCompanies(toolResult);
      setAvailableExecutionCompanies(companies);
      setExecutionCompany((current) => companies.includes(current) ? current : (companies[0] || ""));
    } catch (caught) {
      setAvailableExecutionCompanies([]);
      setError(caught instanceof Error ? caught.message : "Unable to load execution companies.");
    } finally {
      setLoadingExecutionCompanies(false);
    }
  };

  const openExecutionContextPicker = () => {
    setExecutionContextPickerOpen(true);
    setSelectedAvailableExecutionContext("");
    void loadAvailableExecutionContexts();
  };

  const selectInstance = (instanceName: string) => {
    setSelectedInstanceName(instanceName);
    setExecutionContextCode("");
    setExecutionCompany("");
    setAvailableExecutionCompanies([]);
    setAvailableExecutionContexts([]);
    setSelectedAvailableExecutionContext("");
    setExecutionContextPickerError("");
    setExecutionContextPickerOpen(false);
    setTableRef("");
    setSearchPattern("");
    setSelectedScriptTemplate("");
    setScript("");
    setResult(null);
    setError("");
    setConfirmExecution(false);
  };

  const runTool = async (toolName = selectedToolName) => {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) return;
    const instanceRequired = requiresInstance(tool);
    if (instanceRequired && !selectedInstanceName) {
      setError("Select an enabled Instance before running this tool.");
      return;
    }
    if (requiresExecutionCompany(tool) && !executionCompany) {
      setError("Select an execution company allowed by the selected execution context.");
      return;
    }

    const args: Record<string, string> = {};
    if (instanceRequired) {
      args.bcInstance = selectedInstanceName;
    }
    if (instanceRequired) {
      if (acceptsExecutionContext(tool) && executionContextCode.trim()) {
        args.executionContextCode = executionContextCode.trim();
      }
    }
    if (toolName === "jmxq_describeTableFields") args.tableRef = tableRef;
    if (toolName === "jmxq_searchTables") args.searchPattern = searchPattern;
    if (toolName === "jmxq_executeScript") args.script = script;
    if (toolName === "jmxq_executeScript") args.executionCompany = executionCompany;

    setRunning(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await request<ToolExecutionResult>("/tools/call", {
          method: "POST",
          body: JSON.stringify({ name: toolName, arguments: args }),
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Tool execution failed.",
      );
    } finally {
      setRunning(false);
      setConfirmExecution(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selectedToolName === "jmxq_executeScript") {
      setConfirmExecution(true);
      return;
    }
    void runTool();
  };
  const resultText = result?.content.map((item) => item.text).join("\n") || "";

  return (
    <div className="view-layout">
      <header className="view-header">
        <div>
          <p className="eyebrow">MCP simulation</p>
          <h1>Tools</h1>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={running || !selectedInstanceName}
          title="Load JMX-QUERY examples from the selected Business Central instance"
          onClick={() => {
            setSelectedToolName("jmxq_getExamples");
            void runTool("jmxq_getExamples");
          }}
        >
          <BookOpen size={17} aria-hidden="true" />
          Get examples
        </button>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="tools-grid">
        <form className="tool-request-panel" onSubmit={submit}>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Request</p>
              <h2>Run MCP tool</h2>
            </div>
            {loadingTools && <RefreshCw className="spinning" size={18} />}
          </div>
          <div className="form-grid">
            <label className="wide">
              Tool
              <select
                value={selectedToolName}
                title="Select an MCP tool to execute, e.g. jmxq_searchTables to find a table."
                onChange={(event) => setSelectedToolName(event.target.value)}
                disabled={loadingTools || running}
              >
                {tools.map((tool) => (
                  <option key={tool.name} value={tool.name}>
                    {tool.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedTool && (
              <p className="tool-description wide">{selectedTool.description}</p>
            )}
            {requiresInstance(selectedTool) && (
              <label title="Select the configured Business Central instance, e.g. Sandbox.">
                  Instance
                  <select
                    value={selectedInstanceName}
                    title="Select the configured Business Central instance, e.g. Sandbox."
                    onChange={(event) => selectInstance(event.target.value)}
                    disabled={running}
                    required
                  >
                    <option value="">Select Instance</option>
                    {instances.map((instance) => (
                      <option
                        key={instance.id}
                        value={instance.name}
                        disabled={!instance.enabled}
                      >
                        {instance.name}{instance.enabled ? "" : " (disabled)"}
                      </option>
                    ))}
                  </select>
              </label>
            )}
            {acceptsExecutionContext(selectedTool) && (
              <div className="wide execution-context-field">
                <div className="field-label-with-action">
                  <label htmlFor="execution-context" title="Execution context returned by Business Central.">
                    Execution context
                  </label>
                  <button
                    className="url-assist-button"
                    type="button"
                    disabled={running || !selectedInstanceName}
                    title="Select an execution context available through the technical company."
                    onClick={openExecutionContextPicker}
                  >
                    <ListFilter size={15} aria-hidden="true" />
                    Select available
                  </button>
                </div>
                <input
                  id="execution-context"
                  value={executionContextCode}
                  title="Execution context returned by Business Central."
                  onChange={(event) => {
                    setExecutionContextCode(event.target.value);
                    setExecutionCompany("");
                    setAvailableExecutionCompanies([]);
                  }}
                  disabled={running}
                  required
                />
              </div>
            )}
            {requiresExecutionCompany(selectedTool) && (
              <label className="wide">
                Execution company
                <span className="field-label-with-action">
                  <select
                    value={executionCompany}
                    title="Company allowed by the selected execution context for script execution."
                    onChange={(event) => setExecutionCompany(event.target.value)}
                    disabled={running || loadingExecutionCompanies || !executionContextCode.trim()}
                    required
                  >
                    <option value="">
                      {loadingExecutionCompanies ? "Loading execution companies..." : "Select execution company"}
                    </option>
                    {availableExecutionCompanies.map((company) => (
                      <option key={company} value={company}>{company}</option>
                    ))}
                  </select>
                  <button
                    className="url-assist-button"
                    type="button"
                    disabled={running || loadingExecutionCompanies || !selectedInstanceName || !executionContextCode.trim()}
                    title="Load the companies allowed by the selected execution context."
                    onClick={() => void loadExecutionCompanies()}
                  >
                    <RefreshCw size={15} aria-hidden="true" />
                    Load allowed
                  </button>
                </span>
              </label>
            )}
            {selectedToolName === "jmxq_describeTableFields" && (
              <label
                className="wide"
                title="Enter a table name or numeric reference, e.g. Customer or #18."
              >
                Table reference
                <input
                  value={tableRef}
                  title="Enter a table name or numeric reference, e.g. Customer or #18."
                  onChange={(event) => setTableRef(event.target.value)}
                  disabled={running}
                  required
                />
              </label>
            )}
            {selectedToolName === "jmxq_searchTables" && (
              <label
                className="wide"
                title="Enter a table search pattern with wildcards, e.g. *customer* or *ledger*."
              >
                Search pattern
                <input
                  value={searchPattern}
                  title="Enter a table search pattern with wildcards, e.g. *customer* or *ledger*."
                  onChange={(event) => setSearchPattern(event.target.value)}
                  disabled={running}
                  placeholder="*customer*"
                  required
                />
              </label>
            )}
            {selectedToolName === "jmxq_executeScript" && (
              <>
                <label
                  className="wide"
                  title="Select a read-only JMX-QUERY example, e.g. Article count."
                >
                  Test script
                  <select
                    value={selectedScriptTemplate}
                    title="Select a read-only JMX-QUERY example, e.g. Article count."
                    onChange={(event) => {
                      const template = event.target.value;
                      setSelectedScriptTemplate(template);
                      if (template === "article-count") {
                        setScript(articleCountScript);
                      }
                    }}
                    disabled={running}
                  >
                    <option value="">Custom script</option>
                    <option value="article-count">Article count (read-only)</option>
                  </select>
                </label>
                <label
                  className="wide"
                  title={"JMX-QUERY script sent to the selected Business Central Company. Example:\nFROM Item AS i\n| SELECT COUNT(*) AS ArticleCount"}
                >
                  JMX-QUERY script
                  <textarea
                    value={script}
                    title={"JMX-QUERY script sent to the selected Business Central Company. Example:\nFROM Item AS i\n| SELECT COUNT(*) AS ArticleCount"}
                    onChange={(event) => {
                      setScript(event.target.value);
                      setSelectedScriptTemplate("");
                    }}
                    disabled={running}
                    required
                  />
                </label>
              </>
            )}
          </div>
          <div className="form-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={!selectedTool || running}
              title="Run the selected MCP tool through the Admin API"
            >
              <Play size={17} aria-hidden="true" />
              {running ? "Running" : "Run tool"}
            </button>
          </div>
        </form>
        <section className="tool-result-panel" aria-live="polite">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Response</p>
              <h2>{result ? (result.isError ? "Tool error" : "Tool result") : "Awaiting request"}</h2>
            </div>
            {result && (
              <button
                className="icon-button"
                type="button"
                title="Copy response to clipboard"
                aria-label="Copy response to clipboard"
                onClick={() =>
                  void navigator.clipboard.writeText(resultText).catch(() =>
                    setError("Unable to copy the response to the clipboard."),
                  )
                }
              >
                <Copy size={17} />
              </button>
            )}
          </div>
          {result ? (
            <>
              <dl className="definition-grid tool-result-details">
                <dt>Status</dt>
                <dd>
                  <span className={`status-pill ${result.isError ? "error" : "success"}`}>
                    {result.isError ? "error" : "success"}
                  </span>
                </dd>
                <dt>Duration</dt>
                <dd>{result.durationMs.toLocaleString()} ms</dd>
                <dt>Request ID</dt>
                <dd>{result.requestId}</dd>
                {result.executionContextCode && (
                  <>
                    <dt>Execution context</dt>
                    <dd>{result.executionContextCode}</dd>
                  </>
                )}
              </dl>
              <pre className="tool-response"><code>{resultText}</code></pre>
            </>
          ) : (
            <p className="empty-state">Select a tool and run it to inspect its response.</p>
          )}
        </section>
      </div>
      {confirmExecution && (
        <Modal
          title="Run JMX-QUERY script"
          onClose={() => setConfirmExecution(false)}
        >
          <p>
            This script is sent to Business Central and can change data. Review
            the selected Instance, execution context, execution company, and script before continuing.
          </p>
          <pre><code>{script}</code></pre>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              title="Cancel script execution"
              onClick={() => setConfirmExecution(false)}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={running}
              title="Confirm and run the script against Business Central"
              onClick={() => void runTool()}
            >
              <Play size={17} aria-hidden="true" />
              Run script
            </button>
          </div>
        </Modal>
      )}
      {executionContextPickerOpen && (
        <Modal
          title="Select execution context"
          onClose={() => setExecutionContextPickerOpen(false)}
        >
          {executionContextPickerError && (
            <p className="form-error" role="alert">
              {executionContextPickerError}
            </p>
          )}
          <label title="Execution contexts listed by Business Central, e.g. DEFAULT or ALL.">
            Available execution contexts
            <select
              value={selectedAvailableExecutionContext}
              disabled={loadingExecutionContexts}
              title="Execution contexts listed by Business Central, e.g. DEFAULT or ALL."
              onChange={(event) =>
                setSelectedAvailableExecutionContext(event.target.value)
              }
            >
              <option value="">
                {loadingExecutionContexts
                  ? "Loading execution contexts..."
                  : availableExecutionContexts.length
                    ? "Select execution context"
                    : "No execution contexts available"}
              </option>
              {availableExecutionContexts.map((context) => (
                <option key={context.code} value={context.code}>
                  {context.description && context.description !== context.code
                    ? `${context.description} (${context.code})`
                    : context.code}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={loadingExecutionContexts}
              title="Reload execution contexts from Business Central"
              onClick={() => void loadAvailableExecutionContexts()}
            >
              <RefreshCw
                size={16}
                className={loadingExecutionContexts ? "spinning" : ""}
                aria-hidden="true"
              />
              Reload
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!selectedAvailableExecutionContext || loadingExecutionContexts}
              title="Use the selected execution context"
              onClick={() => {
                setExecutionContextCode(selectedAvailableExecutionContext);
                setExecutionContextPickerOpen(false);
              }}
            >
              Use execution context
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function LogsView({
  request,
}: {
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const [filters, setFilters] = useState({
    limit: "100",
    status: "",
    instanceName: "",
    companyName: "",
    tool: "",
    from: "",
    to: "",
  });
  const [timeRange, setTimeRange] = useState<LogTimeRange>("all");
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [filterOptions, setFilterOptions] = useState<LogFilterOptions>(
    emptyLogFilterOptions,
  );
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<LogRecord | null>(null);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearRetentionDays, setClearRetentionDays] = useState("30");
  const [clearError, setClearError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (
        (filters.from && !isInternationalDate(filters.from)) ||
        (filters.to && !isInternationalDate(filters.to))
      ) {
        throw new Error("Enter dates in yyyy/mm/dd format.");
      }
      const rangeMinutes = logTimeRangeMinutes[timeRange];
      const now = new Date();
      const queryValues = {
        ...filters,
        from: rangeMinutes
          ? new Date(now.getTime() - rangeMinutes * 60_000).toISOString()
          : filters.from
            ? toLogTimestamp(filters.from)
            : "",
        to: rangeMinutes
          ? now.toISOString()
          : filters.to
            ? toLogTimestamp(filters.to, true)
            : "",
      };
      const query = new URLSearchParams(
        Object.entries(queryValues).filter(([, value]) => value),
      );
      const suffix = query.toString() ? `?${query}` : "";
      const [records, summary] = await Promise.all([
        request<LogRecord[]>(`/logs${suffix}`),
        request<Metrics>(`/logs/metrics${suffix}`),
      ]);
      setLogs(records);
      setFilterOptions((previous) => ({
        instances: Array.from(
          new Set([
            ...previous.instances,
            ...records.flatMap((record) =>
              record.instanceName ? [record.instanceName] : [],
            ),
          ]),
        ).sort(),
        companies: Array.from(
          new Map(
            [
              ...previous.companies,
              ...records.flatMap((record) =>
                record.instanceName && record.companyName
                  ? [
                      {
                        instanceName: record.instanceName,
                        companyName: record.companyName,
                      },
                    ]
                  : [],
              ),
            ].map((company) => [
              `${company.instanceName}\u0000${company.companyName}`,
              company,
            ]),
          ).values(),
        ).sort((left, right) =>
          left.companyName.localeCompare(right.companyName),
        ),
        tools: Array.from(
          new Set([...previous.tools, ...records.map((record) => record.tool)]),
        ).sort(),
      }));
      setMetrics(summary);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load logs.",
      );
    } finally {
      setLoading(false);
    }
  }, [filters, request, timeRange]);
  useEffect(() => {
    if (
      (filters.from && !isInternationalDate(filters.from)) ||
      (filters.to && !isInternationalDate(filters.to))
    ) {
      return;
    }
    void load();
  }, [filters.from, filters.to, load, timeRange]);
  const companyOptions = filterOptions.companies.filter(
    (company) =>
      !filters.instanceName || company.instanceName === filters.instanceName,
  );
  const clearLogs = async () => {
    setClearing(true);
    setClearError("");
    try {
      const retentionQuery = clearRetentionDays
        ? `?retentionDays=${clearRetentionDays}`
        : "";
      const result = await request<{ deletedFiles: number }>(
        `/logs${retentionQuery}`,
        { method: "DELETE" },
      );
      setSelected(null);
      setShowClearDialog(false);
      setClearMessage(
        `${result.deletedFiles} log ${result.deletedFiles === 1 ? "file" : "files"} deleted.`,
      );
      await load();
    } catch (caught) {
      setClearError(
        caught instanceof Error ? caught.message : "Unable to clear logs.",
      );
    } finally {
      setClearing(false);
    }
  };
  return (
    <div className="view-layout">
      <header className="view-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Logs</h1>
        </div>
        <div className="button-row">
          <button
            className="secondary-button"
            type="button"
            title="Clear stored audit logs using a selected retention period"
            onClick={() => {
              setClearError("");
              setShowClearDialog(true);
            }}
            disabled={loading || clearing}
          >
            <Trash2 size={17} aria-hidden="true" />
            Clear logs
          </button>
          <button
            className="primary-button"
            type="button"
            title="Refresh log records and metrics using the selected filters"
            onClick={() => void load()}
            disabled={loading || clearing}
          >
            <RefreshCw
              size={17}
              className={loading ? "spinning" : ""}
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>
      </header>
      <p className="notice">
        Filters update the displayed records automatically. Use Refresh to retrieve
        new records from the server.
      </p>
      {clearMessage && <p className="notice" role="status">{clearMessage}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="filter-bar">
        <label>
          Status
          <select
            value={filters.status}
            title="Filter records by successful or failed status"
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value })
            }
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label>
          Instance
          <select
            value={filters.instanceName}
            title="Filter records by Instance name"
            onChange={(event) => {
              const instanceName = event.target.value;
              setFilters({ ...filters, instanceName, companyName: "" });
            }}
          >
            <option value="">All</option>
            {filterOptions.instances.map((instanceName) => (
              <option key={instanceName} value={instanceName}>
                {instanceName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Company
          <select
            value={filters.companyName}
            title="Filter records by Company name"
            onChange={(event) =>
              setFilters({ ...filters, companyName: event.target.value })
            }
          >
            <option value="">All</option>
            {companyOptions.map((company) => (
              <option
                key={`${company.instanceName}-${company.companyName}`}
                value={company.companyName}
              >
                {company.companyName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tool
          <select
            value={filters.tool}
            title="Filter records by MCP tool name"
            onChange={(event) =>
              setFilters({ ...filters, tool: event.target.value })
            }
          >
            <option value="">All</option>
            {filterOptions.tools.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </select>
        </label>
        <label>
          Zeitraum
          <select
            value={timeRange}
            title="Zeitraum für die angezeigten Protokolle auswählen"
            onChange={(event) => {
              const selectedRange = event.target.value as LogTimeRange;
              setTimeRange(selectedRange);
              if (selectedRange !== "custom") {
                setFilters({ ...filters, from: "", to: "" });
              }
            }}
          >
            <option value="all">Gesamter Zeitraum</option>
            <option value="5m">Letzte 5 Min.</option>
            <option value="10m">Letzte 10 Min.</option>
            <option value="1h">Letzte Stunde</option>
            <option value="6h">Letzte 6 Stunden</option>
            <option value="24h">Letzte 24 Stunden</option>
            <option value="3d">Letzte 3 Tage</option>
            <option value="custom">Benutzerdefiniert</option>
          </select>
        </label>
        <label>
          Von
          <input
            type="text"
            value={filters.from}
            disabled={timeRange !== "custom"}
            title="Protokolle ab diesem lokalen Datum anzeigen"
            placeholder="jjjj/mm/tt"
            inputMode="numeric"
            pattern="\d{4}/\d{2}/\d{2}"
            onChange={(event) => {
              setTimeRange("custom");
              setFilters({
                ...filters,
                from: event.target.value,
              });
            }}
          />
        </label>
        <label>
          Bis
          <input
            type="text"
            value={filters.to}
            disabled={timeRange !== "custom"}
            title="Protokolle bis zu diesem lokalen Datum anzeigen"
            placeholder="jjjj/mm/tt"
            inputMode="numeric"
            pattern="\d{4}/\d{2}/\d{2}"
            onChange={(event) => {
              setTimeRange("custom");
              setFilters({
                ...filters,
                to: event.target.value,
              });
            }}
          />
        </label>
        <label>
          Limit
          <input
            type="number"
            min="1"
            max="1000"
            value={filters.limit}
            title="Maximum number of records to return, from 1 to 1000"
            onChange={(event) =>
              setFilters({ ...filters, limit: event.target.value })
            }
          />
        </label>
      </div>
      {metrics && (
        <div className="metrics">
          <Metric label="Total" value={metrics.total} />
          <Metric label="Success" value={metrics.success} />
          <Metric label="Errors" value={metrics.error} />
          <Metric
            label="Average duration"
            value={`${metrics.averageDurationMs} ms`}
          />
        </div>
      )}
      <div className="log-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Local time</th>
              <th>Status</th>
              <th>Instance</th>
              <th>Company</th>
              <th>Tool</th>
              <th>Duration</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((record) => (
              <tr key={`${record.requestId}-${record.timestamp}`}>
                <td>{formatLogTimestamp(record.timestamp)}</td>
                <td>
                  <span className={`status-pill ${record.status}`}>
                    {record.status}
                  </span>
                </td>
                <td>{record.instanceName || "—"}</td>
                <td>{record.companyName || "—"}</td>
                <td>{record.tool}</td>
                <td>{record.durationMs} ms</td>
                <td>
                  <button
                    className="icon-button"
                    type="button"
                    title="View log details"
                    aria-label="View log details"
                    onClick={() => setSelected(record)}
                  >
                    <FileText size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && (
          <p className="empty-state">No matching log records.</p>
        )}
      </div>
      {selected && (
        <Modal title="Log details" onClose={() => setSelected(null)}>
          <dl className="definition-grid">
            <dt>Request ID</dt>
            <dd>{selected.requestId}</dd>
            <dt>Error type</dt>
            <dd>{selected.errorType || "—"}</dd>
            <dt>Error message</dt>
            <dd>{selected.errorMessage || "—"}</dd>
          </dl>
          {selected.script && (
            <>
              <h3>Script</h3>
              <pre>
                <code>{selected.script}</code>
              </pre>
            </>
          )}
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              title="Close the log details dialog"
              onClick={() => setSelected(null)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
      {showClearDialog && (
        <Modal
          title="Clear logs"
          onClose={() => !clearing && setShowClearDialog(false)}
        >
          <p>
            This permanently deletes stored audit log files outside the selected retention period.
          </p>
          <label>
            Retention
            <select
              value={clearRetentionDays}
              title="Choose how much audit log history to keep"
              onChange={(event) => setClearRetentionDays(event.target.value)}
              disabled={clearing}
            >
              <option value="">Delete all logs</option>
              <option value="1">Keep the last day</option>
              <option value="7">Keep the last 7 days</option>
              <option value="30">Keep the last 30 days</option>
              <option value="90">Keep the last 90 days</option>
            </select>
          </label>
          {clearError && <p className="form-error" role="alert">{clearError}</p>}
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              title="Cancel log cleanup"
              onClick={() => setShowClearDialog(false)}
              disabled={clearing}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              title="Permanently delete the selected audit logs"
              onClick={() => void clearLogs()}
              disabled={clearing}
            >
              <Trash2 size={17} aria-hidden="true" />
              {clearing ? "Clearing" : "Clear logs"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ConnectionGuideView({
  session,
  request,
}: {
  session: Session;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const [connectionInfo, setConnectionInfo] = useState<McpConnectionInfo | null>(null);
  const [location, setLocation] = useState<ConnectionLocation>("local");
  const [harness, setHarness] = useState<Harness>("vscode");
  const [lanHostname, setLanHostname] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [mcpApiKey, setMcpApiKey] = useState<string | null>(null);
  const [revealingApiKey, setRevealingApiKey] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [apiKeyError, setApiKeyError] = useState("");
  const loadConnectionInfo = useEffectEvent(() => {
    void request<McpConnectionInfo>("/mcp-connection")
      .then((info) => {
        setConnectionInfo(info);
        try {
          if (isLoopbackHostname(new URL(session.serverUrl).hostname)) {
            setLanHostname((current) => current || info.lanAddresses?.[0] || info.hostname);
          }
        } catch {
          // Session URLs are validated at sign-in.
        }
      })
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "Unable to load MCP connection information.",
        ),
      );
  });
  useEffect(() => {
    loadConnectionInfo();
  }, []);
  useEffect(() => {
    if (!mcpApiKey) return;
    const timeout = window.setTimeout(() => setMcpApiKey(null), 30000);
    return () => window.clearTimeout(timeout);
  }, [mcpApiKey]);

  let sessionAddress: URL | null = null;
  try {
    sessionAddress = new URL(session.serverUrl);
  } catch { /* Session URLs are validated at sign-in. */ }
  const streamablePort = connectionInfo?.streamablePort
    ?? (sessionAddress?.port
      ? Number(sessionAddress.port)
      : sessionAddress?.protocol === "https:" ? 443 : 80);
  const suggestedLanHostname = sessionAddress && !isLoopbackHostname(sessionAddress.hostname)
    ? sessionAddress.hostname
    : connectionInfo?.lanAddresses?.[0] || connectionInfo?.hostname || "";
  const selectedLanHostname = lanHostname.trim() || suggestedLanHostname;
  const lanHostnameIsValid = (() => {
    if (!selectedLanHostname || isLoopbackHostname(selectedLanHostname.toLowerCase())) return false;
    try {
      const candidate = new URL(`http://${selectedLanHostname}`);
      return candidate.hostname === selectedLanHostname.toLowerCase() && !candidate.port;
    } catch {
      return false;
    }
  })();
  const endpoint = !sessionAddress || !streamablePort
    ? null
    : location === "local"
      ? toConnectionEndpoint("127.0.0.1", sessionAddress.protocol, streamablePort)
      : lanHostnameIsValid
        ? toConnectionEndpoint(selectedLanHostname, sessionAddress.protocol, streamablePort)
        : null;
  const isClaudeDesktop = harnessMeta[harness].stdio === true;
  const apiKeyRequired = connectionInfo?.apiKeyRequired === true;
  const bearerPlaceholder = "Bearer <JMXQ_MCPAPI_KEY>";
  const buildStdioConfiguration = () => {
    if (!connectionInfo?.workingDirectory || !connectionInfo.nodePath) return "";
    const root = connectionInfo.workingDirectory.replace(/[\\/]+$/, "");
    const separator = root.includes("\\") ? "\\" : "/";
    return JSON.stringify({
      mcpServers: {
        "jmxq-mcp-server": {
          command: connectionInfo.nodePath,
          args: [`${root}${separator}build${separator}index.js`],
          cwd: root,
          env: { JMXQ_STDIO_ONLY: "true" },
        },
      },
    }, null, 2);
  };
  const buildHttpConfiguration = (url: string) => {
    switch (harness) {
      case "vscode":
        return JSON.stringify({
          ...(apiKeyRequired
            ? {
              inputs: [{
                id: "jmxq-mcp-server-api-key",
                type: "promptString",
                description: "JMX-QUERY MCP API key",
                password: true,
              }],
            }
            : {}),
          servers: {
            "jmxq-mcp-server": {
              type: "http",
              url,
              ...(apiKeyRequired
                ? { headers: { Authorization: "Bearer ${input:jmxq-mcp-server-api-key}" } }
                : {}),
            },
          },
        }, null, 2);
      case "cursor":
        return JSON.stringify({
          mcpServers: {
            "jmxq-mcp-server": {
              url,
              ...(apiKeyRequired ? { headers: { Authorization: bearerPlaceholder } } : {}),
            },
          },
        }, null, 2);
      case "gemini":
        return JSON.stringify({
          mcpServers: {
            "jmxq-mcp-server": {
              httpUrl: url,
              ...(apiKeyRequired ? { headers: { Authorization: bearerPlaceholder } } : {}),
            },
          },
        }, null, 2);
      case "claudeCode":
        return [
          "claude mcp add --transport http jmxq-mcp-server",
          JSON.stringify(url),
          ...(apiKeyRequired ? [`--header ${JSON.stringify(`Authorization: ${bearerPlaceholder}`)}`] : []),
        ].join(" ");
      case "hermes":
        return [
          "mcp_servers:",
          "  jmxq-mcp-server:",
          `    url: ${JSON.stringify(url)}`,
          ...(apiKeyRequired
            ? ["    headers:", '      Authorization: "Bearer ${JMXQ_MCPAPI_KEY}"']
            : []),
        ].join("\n");
      case "codex":
        return [
          "[mcp_servers.jmxq-mcp-server]",
          `url = ${JSON.stringify(url)}`,
          ...(apiKeyRequired ? ['bearer_token_env_var = "JMXQ_MCPAPI_KEY"'] : []),
        ].join("\n");
      default:
        return "";
    }
  };
  const configuration = isClaudeDesktop
    ? buildStdioConfiguration()
    : endpoint
      ? buildHttpConfiguration(endpoint)
      : "";
  const copyConfiguration = () => {
    if (!configuration) return;
    void navigator.clipboard.writeText(configuration)
      .then(() => setCopied(true))
      .catch(() => setError("Unable to copy the configuration to the clipboard."));
  };
  const revealApiKey = () => {
    setRevealingApiKey(true);
    setApiKeyError("");
    setApiKeyCopied(false);
    void request<McpApiKeyResponse>("/mcp-connection/api-key/reveal", { method: "POST" })
      .then((response) => setMcpApiKey(response.value))
      .catch((caught) => setError(
        caught instanceof Error ? caught.message : "Unable to reveal the MCP API key.",
      ))
      .finally(() => setRevealingApiKey(false));
  };
  const copyApiKey = () => {
    if (!mcpApiKey) return;
    void navigator.clipboard.writeText(mcpApiKey)
      .then(() => setApiKeyCopied(true))
      .catch(() => setApiKeyError("Unable to copy the MCP API key to the clipboard."));
  };

  return (
    <div className="view-layout connection-layout">
      <header className="view-header">
        <div>
          <p className="eyebrow">MCP setup</p>
          <h1>Connect</h1>
        </div>
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!sessionAddress && (
        <p className="form-error" role="alert">The current Admin server URL is invalid.</p>
      )}
      <section className="connection-panel" aria-label="MCP connection guide">
        <div className="connection-controls">
          <label>
            Harness
            <select value={harness} onChange={(event) => setHarness(event.target.value as Harness)}>
              {(Object.keys(harnessMeta) as Harness[]).map((key) => (
                <option key={key} value={key}>{harnessMeta[key].label}</option>
              ))}
            </select>
          </label>
          {!isClaudeDesktop && (
            <fieldset className="location-control">
              <legend>Connect from</legend>
              <div className="segmented-control">
                <button
                  type="button"
                  className={location === "local" ? "selected" : ""}
                  aria-pressed={location === "local"}
                  onClick={() => setLocation("local")}
                >
                  This MCP server
                </button>
                <button
                  type="button"
                  className={location === "lan" ? "selected" : ""}
                  aria-pressed={location === "lan"}
                  onClick={() => setLocation("lan")}
                >
                  Local network
                </button>
              </div>
            </fieldset>
          )}
        </div>

        {!isClaudeDesktop && location === "lan" && (
          <div className="lan-setup">
            <label>
              MCP server LAN hostname or IP address
              <input
                value={lanHostname}
                list="lan-host-options"
                placeholder={suggestedLanHostname || "e.g. bc-mcp-server or 192.168.1.20"}
                onChange={(event) => setLanHostname(event.target.value)}
              />
              <datalist id="lan-host-options">
                {connectionInfo?.lanAddresses?.map((address) => (
                  <option key={address} value={address} />
                ))}
                {connectionInfo?.hostname && (
                  <option value={connectionInfo.hostname} />
                )}
              </datalist>
            </label>
            {!lanHostnameIsValid && (
              <p className="notice" role="status">
                Enter a non-loopback LAN hostname or IP address to create a configuration for another computer.
              </p>
            )}
            <p className="connection-note">
              The MCP service must listen on its LAN interface or `0.0.0.0`, and Windows Firewall must allow the MCP port only from trusted local-network clients.
            </p>
          </div>
        )}

        {!isClaudeDesktop && location === "local" && (
          <p className="connection-note">
            This configuration works only on the computer running the MCP service. It uses the loopback address and needs no LAN firewall rule.
          </p>
        )}

        {isClaudeDesktop && (
          <div className="claude-setup">
            <p className="connection-note">
              Claude Desktop starts a local Stdio-only server process on this computer. It does not use an HTTP endpoint or the MCP API key.
            </p>
            <ol>
              <li>Open <code>%APPDATA%\Claude\claude_desktop_config.json</code>.</li>
              <li>Add the generated server entry to <code>mcpServers</code>.</li>
              <li>Save the file and restart Claude Desktop.</li>
            </ol>
            {!configuration && (
              <p className="notice" role="status">
                Restart this MCP server to generate the local Node.js and project paths for Claude Desktop.
              </p>
            )}
          </div>
        )}

        <div className="connection-summary">
          <span>{isClaudeDesktop ? "Transport" : "Streamable HTTP endpoint"}</span>
          <code>{isClaudeDesktop ? "Local Stdio process (no HTTP port)" : endpoint || "Enter a LAN hostname or IP address."}</code>
        </div>
        <div className="connection-instructions">
          <div>
            <h2>{harnessMeta[harness].label}</h2>
            <p>{harnessMeta[harness].hint}</p>
          </div>
          <div className="connection-actions">
            {connectionInfo?.apiKeyRequired && !isClaudeDesktop && (
              <button
                className="secondary-button"
                type="button"
                disabled={revealingApiKey}
                onClick={revealApiKey}
              >
                <KeyRound size={17} aria-hidden="true" />
                {revealingApiKey ? "Loading key" : "Show API key"}
              </button>
            )}
            <button
              className="secondary-button"
              type="button"
              disabled={!configuration}
              onClick={copyConfiguration}
            >
              <Copy size={17} aria-hidden="true" />
              {copied ? "Copied" : "Copy configuration"}
            </button>
          </div>
        </div>
        <pre className="connection-code"><code>{configuration || ""}</code></pre>
      </section>
      {mcpApiKey && (
        <Modal title="MCP API key" onClose={() => setMcpApiKey(null)}>
          <p>This value is visible for 30 seconds.</p>
          <input
            className="revealed-secret-value"
            value={mcpApiKey}
            readOnly
            aria-label="MCP API key"
          />
          {apiKeyError && <p className="form-error" role="alert">{apiKeyError}</p>}
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={copyApiKey}
            >
              <Copy size={17} aria-hidden="true" />
              {apiKeyCopied ? "Copied" : "Copy API key"}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => setMcpApiKey(null)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DocumentationView({
  session,
  request,
}: {
  session: Session;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const loadDocumentation = useEffectEvent(() => {
    void request<string>("/documentation")
      .then(setMarkdown)
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "Unable to load documentation.",
        ),
      );
  });
  useEffect(() => {
    loadDocumentation();
  }, []);
  const headings = Array.from(markdown.matchAll(/^##?\s+(.+)$/gm))
    .map((match) => match[1].replace(/[`*]/g, ""))
    .slice(0, 12);
  const slug = (value: string) =>
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-");
  return (
    <div className="view-layout documentation-layout">
      <header className="view-header">
        <div>
          <p className="eyebrow">Reference</p>
          <h1>Documentation</h1>
        </div>
        <div className="button-row">
          <a
            className="secondary-button"
            href={`${session.serverUrl}/admin/api/documentation/overview`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the illustrated architecture, setup and workflow overview in a new tab"
          >
            <ExternalLink size={17} aria-hidden="true" />
            Visual overview
          </a>
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="docs-grid">
        {headings.length > 0 && (
          <aside className="toc">
            <strong>On this page</strong>
            {headings.map((heading) => (
              <a key={heading} href={`#${slug(heading)}`}>
                {heading}
              </a>
            ))}
          </aside>
        )}
        <article className="markdown-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSlug]}
            components={{
              a: ({ href, children, ...props }) =>
                /^https?:\/\//i.test(href || "") ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    {...props}
                  >
                    {children}
                  </a>
                ) : (
                  <a href={href} {...props}>
                    {children}
                  </a>
                ),
              code: ({ children, ...props }) => (
                <code {...props}>{children}</code>
              ),
            }}
          >
            {markdown}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`status-icon ${enabled ? "success" : "disabled"}`}
      role="img"
      aria-label={enabled ? "Enabled" : "Disabled"}
      title={enabled ? "Enabled" : "Disabled"}
    >
      {enabled ? (
        <ShieldCheck size={16} aria-hidden="true" />
      ) : (
        <X size={16} aria-hidden="true" />
      )}
    </span>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="panel-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            type="button"
            title="Close dialog"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export default App;
