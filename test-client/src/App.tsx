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
  Eye,
  FileText,
  KeyRound,
  LogOut,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sun,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import "./App.css";

type View = "instances" | "logs" | "documentation";
type Theme = "light" | "dark";
type AuthType = "BASIC" | "NTLM" | "SSO" | "OAUTH";
type SecretField = "password" | "clientSecret";
interface Company {
  id: string;
  name: string;
  company: string;
  executionContextCode: string;
  enabled: boolean;
}
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
  companies: Company[];
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
interface Session {
  serverUrl: string;
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
}
interface CompanyFormData {
  name: string;
  company: string;
  executionContextCode: string;
  enabled: boolean;
}
interface AvailableCompany {
  name: string;
  displayName?: string;
}
interface ConnectionTestResponse {
  status: "ok";
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
});
const emptyCompanyForm = (): CompanyFormData => ({
  name: "",
  company: "",
  executionContextCode: "DEFAULT",
  enabled: true,
});
const defaultServerUrl = import.meta.env.DEV
  ? "http://127.0.0.1:5000"
  : window.location.origin;
const normalizeServerUrl = (value: string) => value.trim().replace(/\/+$/, "");
const themeStorageKey = "jmx-query-admin-theme";
const adminServerUrlStorageKey = "jmx-query-admin-server-url";
const initialServerUrl = () => {
  try {
    return window.localStorage.getItem(adminServerUrlStorageKey) || defaultServerUrl;
  } catch {
    return defaultServerUrl;
  }
};
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
});

function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>("instances");
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
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
    const candidateServerUrl = normalizeServerUrl(initialServerUrl());
    const restoreSession = async () => {
      try {
        const response = await fetch(`${candidateServerUrl}/admin/api/session`, {
          credentials: "include",
        });
        if (response.ok) {
          setServerUrl(candidateServerUrl);
          setSession({ serverUrl: candidateServerUrl });
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
    const candidate = {
      serverUrl: normalizeServerUrl(serverUrl),
      adminKey: adminKey.trim(),
    };
    if (!candidate.serverUrl || !candidate.adminKey) {
      setLoginError("Enter both the server URL and Admin API key.");
      return;
    }
    setLoginError("");
    try {
      const response = await fetch(
        `${candidate.serverUrl}/admin/api/session`,
        {
          method: "POST",
          credentials: "include",
          headers: { Authorization: `Bearer ${candidate.adminKey}` },
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "The Admin API key was rejected."
            : `Server returned HTTP ${response.status}.`,
        );
      try {
        window.localStorage.setItem(
          adminServerUrlStorageKey,
          candidate.serverUrl,
        );
      } catch {
        // Session restoration is optional when browser storage is unavailable.
      }
      setAdminKey("");
      setSession({ serverUrl: candidate.serverUrl });
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
        serverUrl={serverUrl}
        adminKey={adminKey}
        error={loginError}
        onServerUrl={setServerUrl}
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
        <nav>
          <NavigationButton
            active={view === "instances"}
            icon={<Building2 size={18} />}
            label="Instances"
            onClick={() => setView("instances")}
          />
          <NavigationButton
            active={view === "logs"}
            icon={<FileText size={18} />}
            label="Logs"
            onClick={() => setView("logs")}
          />
          <NavigationButton
            active={view === "documentation"}
            icon={<BookOpen size={18} />}
            label="Documentation"
            onClick={() => setView("documentation")}
          />
        </nav>
        <div className="sidebar-theme-control">
          <ThemeToggle
            theme={theme}
            onToggle={() => setTheme(theme === "light" ? "dark" : "light")}
          />
        </div>
        <div className="sidebar-footer">
          <span className="server-name" title={session.serverUrl}>
            {session.serverUrl}
          </span>
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
        {view === "logs" && <LogsView request={request} />}
        {view === "documentation" && <DocumentationView request={request} />}
      </section>
    </main>
  );
}

function LoginScreen({
  serverUrl,
  adminKey,
  error,
  onServerUrl,
  onAdminKey,
  onSubmit,
  theme,
  onThemeChange,
}: {
  serverUrl: string;
  adminKey: string;
  error: string;
  onServerUrl: (value: string) => void;
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
          Server URL
          <input
            type="url"
            value={serverUrl}
            title="URL of the JMX-QUERY MCP Server Admin API"
            onChange={(event) => onServerUrl(event.target.value)}
            placeholder="http://127.0.0.1:5000"
            autoComplete="url"
            required
          />
        </label>
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
  const [companyForm, setCompanyForm] = useState<CompanyFormData | null>(null);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [availableCompanies, setAvailableCompanies] = useState<AvailableCompany[]>([]);
  const [loadingAvailableCompanies, setLoadingAvailableCompanies] = useState(false);
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false);
  const [availableCompanySelection, setAvailableCompanySelection] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<
    Partial<Record<SecretField, string>>
  >({});
  const [revealPrompt, setRevealPrompt] = useState<SecretField | null>(null);
  const [confirmKey, setConfirmKey] = useState("");
  const [connectionTest, setConnectionTest] =
    useState<ConnectionTestDialog | null>(null);
  const selected =
    instances.find((instance) => instance.name === selectedName) || null;
  useEffect(() => {
    setRevealed({});
    setRevealPrompt(null);
    setConfirmKey("");
  }, [selectedName]);
  useEffect(() => {
    if (!Object.keys(revealed).length) return;
    const timeout = window.setTimeout(() => setRevealed({}), 30000);
    return () => window.clearTimeout(timeout);
  }, [revealed]);
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
      setRevealed({});
    });
  };
  const submitCompany = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !companyForm) return;
    const form = companyForm;
    const payload = editingCompany
      ? {
          company: form.company,
          executionContextCode: form.executionContextCode,
          enabled: form.enabled,
        }
      : form;
    void perform(async () => {
      const endpoint = editingCompany
        ? `/instances/${encodeURIComponent(selected.name)}/companies/${encodeURIComponent(editingCompany.name)}`
        : `/instances/${encodeURIComponent(selected.name)}/companies`;
      await request(endpoint, {
        method: editingCompany ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      await reload();
      setCompanyForm(null);
      setEditingCompany(null);
    });
  };
  const testConnection = (instanceName: string, companyName: string) => {
    void perform(async () => {
      const target = `${instanceName} / ${companyName}`;
      try {
        const result = await request<ConnectionTestResponse>(
          `/instances/${encodeURIComponent(instanceName)}/companies/${encodeURIComponent(companyName)}/test-connection`,
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
          error: error?.detail || (caught instanceof Error ? caught.message : "Connection test failed."),
          errorType: error?.errorType,
          requestId: error?.requestId,
        });
      }
    });
  };
  const loadAvailableCompanies = () => {
    if (!selected) return;
    setLoadingAvailableCompanies(true);
    setError("");
    void request<AvailableCompany[]>(
      `/instances/${encodeURIComponent(selected.name)}/available-companies`,
    )
      .then((companies) => {
        setAvailableCompanies(companies);
      })
      .catch((caught) => {
        setError(
          caught instanceof Error ? caught.message : "Unable to load companies.",
        );
      })
      .finally(() => setLoadingAvailableCompanies(false));
  };
  const openCompanyPicker = () => {
    setCompanyPickerOpen(true);
    setAvailableCompanySelection("");
    setAvailableCompanies([]);
    loadAvailableCompanies();
  };
  const useSelectedAvailableCompany = () => {
    const company = availableCompanies.find(
      (candidate) => candidate.name === availableCompanySelection,
    );
    if (!company) return;
    setCompanyForm({
      ...emptyCompanyForm(),
      name: company.displayName || company.name,
      company: company.name,
    });
    setEditingCompany(null);
    setCompanyPickerOpen(false);
    setAvailableCompanySelection("");
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
  const revealSecret = () => {
    if (!selected || !revealPrompt) return;
    const field = revealPrompt;
    void perform(async () => {
      const result = await request<{ value: string }>(
        `/instances/${encodeURIComponent(selected.name)}/secrets/${field}/reveal`,
        {
          method: "POST",
          body: JSON.stringify({ confirmAdminKey: confirmKey }),
        },
      );
      setRevealed((current) => ({ ...current, [field]: result.value }));
      setRevealPrompt(null);
      setConfirmKey("");
    });
  };
  const editSecret = (field: SecretField, value: string) => {
    if (!instanceForm) return;
    setRevealed((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
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
            setCompanyForm(null);
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
                setCompanyForm(null);
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
              revealed={revealed}
              busy={busy}
              onChange={setInstanceForm}
              onSecretChange={editSecret}
              onReveal={setRevealPrompt}
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
                          `Delete instance "${selected.name}" and all its companies?`,
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
                disabled={busy}
                title={
                  selected.enabled
                    ? "Block new requests to this instance and all of its companies"
                    : "Allow new requests to this instance and its enabled companies"
                }
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
              <div className="subsection-heading">
                <div>
                  <h3>Companies</h3>
                  <p>Execution contexts available to this instance.</p>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || !selected.enabled}
                  title={selected.enabled
                    ? "Load the available companies from the configured OData service"
                    : "Enable the instance before loading companies"}
                  onClick={() => {
                    openCompanyPicker();
                  }}
                >
                  <Plus size={16} aria-hidden="true" />
                  Add company
                </button>
              </div>
              {companyForm ? (
                <CompanyForm
                  form={companyForm}
                  editing={Boolean(editingCompany)}
                  busy={busy}
                  onChange={setCompanyForm}
                  onCancel={() => {
                    setCompanyForm(null);
                    setEditingCompany(null);
                  }}
                  onSubmit={submitCompany}
                />
              ) : (
                <div className="company-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Technical company</th>
                        <th>Context</th>
                        <th>Status</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.companies.map((company) => (
                        <tr key={company.id}>
                          <td>{company.name}</td>
                          <td>{company.company}</td>
                          <td>{company.executionContextCode}</td>
                          <td>
                            <StatusBadge enabled={company.enabled} />
                          </td>
                          <td>
                            <div className="table-actions">
                              <button
                                className="icon-button"
                                type="button"
                                title={`Test connection to ${company.name}`}
                                aria-label={`Test connection to ${company.name}`}
                                disabled={busy}
                                onClick={() =>
                                  testConnection(selected.name, company.name)
                                }
                              >
                                <RefreshCw
                                  size={16}
                                  className={busy ? "spinning" : ""}
                                />
                              </button>
                              <button
                                className="icon-button"
                                type="button"
                                title={`Edit ${company.name}`}
                                aria-label={`Edit ${company.name}`}
                                onClick={() => {
                                  setCompanyForm({
                                    name: company.name,
                                    company: company.company,
                                    executionContextCode:
                                      company.executionContextCode,
                                    enabled: company.enabled,
                                  });
                                  setEditingCompany(company);
                                }}
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                className="icon-button"
                                type="button"
                                title={
                                  company.enabled
                                    ? `Disable ${company.name}`
                                    : `Enable ${company.name}`
                                }
                                aria-label={
                                  company.enabled
                                    ? `Disable ${company.name}`
                                    : `Enable ${company.name}`
                                }
                                onClick={() =>
                                  void perform(async () => {
                                    await request(
                                      `/instances/${encodeURIComponent(selected.name)}/companies/${encodeURIComponent(company.name)}/enabled`,
                                      {
                                        method: "PATCH",
                                        body: JSON.stringify({
                                          enabled: !company.enabled,
                                        }),
                                      },
                                    );
                                    await reload();
                                  })
                                }
                              >
                                {company.enabled ? (
                                  <X size={16} />
                                ) : (
                                  <ShieldCheck size={16} />
                                )}
                              </button>
                              <button
                                className="icon-button danger"
                                type="button"
                                title={`Delete ${company.name}`}
                                aria-label={`Delete ${company.name}`}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Delete company "${company.name}"?`,
                                    )
                                  )
                                    void perform(async () => {
                                      await request(
                                        `/instances/${encodeURIComponent(selected.name)}/companies/${encodeURIComponent(company.name)}`,
                                        { method: "DELETE" },
                                      );
                                      await reload();
                                    });
                                }}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selected.companies.length === 0 && (
                    <p className="empty-state">
                      No companies configured for this instance.
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="empty-detail">
              <Building2 size={34} aria-hidden="true" />
              <h2>Select an instance</h2>
              <p>Choose an instance to manage its settings and companies.</p>
            </div>
          )}
        </section>
      </div>
      {companyPickerOpen && selected && (
        <Modal
          title="Select Business Central company"
          onClose={() => {
            setCompanyPickerOpen(false);
            setAvailableCompanySelection("");
          }}
        >
          <label>
            Business Central company
            <select
              value={availableCompanySelection}
              disabled={loadingAvailableCompanies}
              title="Companies available from the configured OData service"
              onChange={(event) =>
                setAvailableCompanySelection(event.target.value)
              }
            >
              <option value="">
                {loadingAvailableCompanies
                  ? "Loading companies..."
                  : availableCompanies.length
                    ? "Select a company"
                    : "No companies available"}
              </option>
              {availableCompanies.map((company) => (
                <option key={company.name} value={company.name}>
                  {company.displayName && company.displayName !== company.name
                    ? `${company.displayName} (${company.name})`
                    : company.name}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={loadingAvailableCompanies}
              title="Reload companies from Business Central"
              onClick={loadAvailableCompanies}
            >
              <RefreshCw
                size={16}
                className={loadingAvailableCompanies ? "spinning" : ""}
                aria-hidden="true"
              />
              Reload
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!availableCompanySelection || loadingAvailableCompanies}
              title="Use the selected company"
              onClick={useSelectedAvailableCompany}
            >
              Use company
            </button>
          </div>
        </Modal>
      )}
      {revealPrompt && (
        <Modal
          title={`Reveal ${revealPrompt === "password" ? "password" : "client secret"}`}
          onClose={() => {
            setRevealPrompt(null);
            setConfirmKey("");
          }}
        >
          <p>
            Confirm the Admin API key before showing this value. The value is
            cleared after 30 seconds and when you switch instances.
          </p>
          <label>
            Admin API key
            <input
              type="password"
              value={confirmKey}
              title="Re-enter the Admin API key to reveal this stored secret"
              onChange={(event) => setConfirmKey(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              title="Close this dialog without revealing the stored secret"
              onClick={() => {
                setRevealPrompt(null);
                setConfirmKey("");
              }}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy || !confirmKey}
              title="Reveal this stored secret for 30 seconds"
              onClick={revealSecret}
            >
              <Eye size={16} aria-hidden="true" />
              Reveal
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
    </div>
  );
}

function InstanceForm({
  form,
  editing,
  hasPassword,
  hasClientSecret,
  revealed,
  busy,
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
  revealed: Partial<Record<SecretField, string>>;
  busy: boolean;
  onChange: (value: InstanceFormData) => void;
  onSecretChange: (field: SecretField, value: string) => void;
  onReveal: (field: SecretField) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const secretInput = (
    field: SecretField,
    label: string,
    hasSecret: boolean | undefined,
  ) => (
    <label>
      {label}
      <span className="secret-input">
        <input
          type={revealed[field] ? "text" : "password"}
          value={revealed[field] || form[field]}
          title={`Enter the ${label.toLowerCase()} for this authentication method`}
          onChange={(event) => onSecretChange(field, event.target.value)}
          autoComplete="new-password"
          placeholder={editing && hasSecret ? "Stored value unchanged" : ""}
          required={!editing}
        />
        {editing && hasSecret && (
          <button
            className="icon-button secret-eye"
            type="button"
            title={`Reveal ${label.toLowerCase()}`}
            aria-label={`Reveal ${label.toLowerCase()}`}
            onClick={() => onReveal(field)}
          >
            <Eye size={16} />
          </button>
        )}
      </span>
    </label>
  );
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
                title="Business Central Online environment name, for example Production or Sandbox"
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
            <label className="wide">
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
                <label>
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
      <div className="form-actions">
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
          disabled={busy}
          title={editing ? "Save instance changes" : "Create this instance"}
        >
          {editing ? "Save changes" : "Create instance"}
        </button>
      </div>
    </form>
  );
}

function CompanyForm({
  form,
  editing,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: CompanyFormData;
  editing: boolean;
  busy: boolean;
  onChange: (value: CompanyFormData) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="company-form" onSubmit={onSubmit}>
      <div className="form-grid">
        <label>
          Name
          <input
            value={form.name}
            disabled={editing}
            title="Unique alias that MCP agents use as bcCompany"
            onChange={(event) =>
              onChange({ ...form, name: event.target.value })
            }
            required
          />
        </label>
        <label>
          Technical company
          <input
            value={form.company}
            title="Exact Business Central Company value sent in the OData company parameter"
            onChange={(event) =>
              onChange({ ...form, company: event.target.value })
            }
            required
          />
        </label>
        <label>
          Default execution context
          <input
            value={form.executionContextCode}
            title="Execution context used when an MCP tool does not provide one"
            onChange={(event) =>
              onChange({ ...form, executionContextCode: event.target.value })
            }
            required
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.enabled}
            title="Allow new MCP requests to this Company"
            onChange={(event) =>
              onChange({ ...form, enabled: event.target.checked })
            }
          />
          Enabled
        </label>
      </div>
      <div className="form-actions">
        <button
          className="secondary-button"
          type="button"
          title="Discard unsaved Company changes"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={busy}
          title={editing ? "Save Company changes" : "Create this Company"}
        >
          {editing ? "Save company" : "Create company"}
        </button>
      </div>
    </form>
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
    requestId: "",
    from: "",
    to: "",
  });
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<LogRecord | null>(null);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams(
        Object.entries(filters).filter(([, value]) => value),
      );
      const suffix = query.toString() ? `?${query}` : "";
      const [records, summary] = await Promise.all([
        request<LogRecord[]>(`/logs${suffix}`),
        request<Metrics>(`/logs/metrics${suffix}`),
      ]);
      setLogs(records);
      setMetrics(summary);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load logs.",
      );
    } finally {
      setLoading(false);
    }
  };
  const loadInitialLogs = useEffectEvent(() => {
    void load();
  });
  useEffect(() => {
    loadInitialLogs();
  }, []);
  return (
    <div className="view-layout">
      <header className="view-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Logs</h1>
        </div>
        <button
          className="primary-button"
          type="button"
          title="Refresh log records and metrics using the selected filters"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            size={17}
            className={loading ? "spinning" : ""}
            aria-hidden="true"
          />
          Refresh
        </button>
      </header>
      <p className="notice">
        Live updates are not enabled because browser EventSource cannot send the
        Admin API bearer header. Use Refresh to retrieve current records.
      </p>
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
          <input
            value={filters.instanceName}
            title="Filter records by Instance name"
            onChange={(event) =>
              setFilters({ ...filters, instanceName: event.target.value })
            }
          />
        </label>
        <label>
          Company
          <input
            value={filters.companyName}
            title="Filter records by Company name"
            onChange={(event) =>
              setFilters({ ...filters, companyName: event.target.value })
            }
          />
        </label>
        <label>
          Tool
          <input
            value={filters.tool}
            title="Filter records by MCP tool name"
            onChange={(event) =>
              setFilters({ ...filters, tool: event.target.value })
            }
          />
        </label>
        <label>
          Request ID
          <input
            value={filters.requestId}
            title="Filter records by the server request ID"
            onChange={(event) =>
              setFilters({ ...filters, requestId: event.target.value })
            }
          />
        </label>
        <label>
          From
          <input
            type="datetime-local"
            value={filters.from}
            title="Show records created on or after this local date and time"
            onChange={(event) =>
              setFilters({
                ...filters,
                from: event.target.value
                  ? new Date(event.target.value).toISOString()
                  : "",
              })
            }
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={filters.to}
            title="Show records created on or before this local date and time"
            onChange={(event) =>
              setFilters({
                ...filters,
                to: event.target.value
                  ? new Date(event.target.value).toISOString()
                  : "",
              })
            }
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
              <th>Time</th>
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
                <td>{new Date(record.timestamp).toLocaleString()}</td>
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

function DocumentationView({
  request,
}: {
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
