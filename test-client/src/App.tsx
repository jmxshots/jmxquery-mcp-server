import { useState, useEffect, useCallback, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ChatClient from './ChatClient';

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export default function App() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [mcpServerUrl, setMcpServerUrl] = useState(() => localStorage.getItem('mcp_server_url') || 'http://127.0.0.1:4000');
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [argumentsJson, setArgumentsJson] = useState('{}');
  const [executionContextCode, setExecutionContextCode] = useState(() => localStorage.getItem('jmxq_ctx') || '');
  const [scriptContent, setScriptContent] = useState(() => localStorage.getItem('jmxq_script') || '');
  const [output, setOutput] = useState('');
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'raw' | 'value'>('value');
  const [endpointUrl, setEndpointUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [activeView, setActiveView] = useState<'admin' | 'chat'>(() => (localStorage.getItem('active_view') as any) || 'admin');
  const [chatTargetUrl, setChatTargetUrl] = useState(() => localStorage.getItem('chat_target_url') || '');
  const eventSourceRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('active_view', activeView);
  }, [activeView]);

  useEffect(() => {
    localStorage.setItem('chat_target_url', chatTargetUrl);
  }, [chatTargetUrl]);

  // Persist context, script, and URL
  useEffect(() => {
    localStorage.setItem('jmxq_ctx', executionContextCode);
  }, [executionContextCode]);

  useEffect(() => {
    localStorage.setItem('jmxq_script', scriptContent);
  }, [scriptContent]);

  useEffect(() => {
    localStorage.setItem('mcp_server_url', mcpServerUrl);
  }, [mcpServerUrl]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [output]);

  const getMessageUrl = useCallback(() => {
    if (endpointUrl) return `${mcpServerUrl}${endpointUrl}`;
    return `${mcpServerUrl}/mcp/messages`;
  }, [endpointUrl, mcpServerUrl]);

  const addLog = (msg: string) => {
    setOutput((prev) => prev + (prev ? '\n' : '') + msg);
  };

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStatus('disconnected');
    setEndpointUrl(null);
    setTools([]);
    addLog('[System] SSE Disconnected by user.');
  }, []);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('connecting');
    setEndpointUrl(null);
    setTools([]);

    const url = new URL(`${mcpServerUrl}/mcp/sse`);
    if (apiKey) url.searchParams.set('apiKey', apiKey.trim());

    const es = new EventSource(url.toString());

    es.onopen = () => {
      setStatus('connected');
      addLog('[System] SSE Connected.');
    };

    es.onerror = (err) => {
      console.error('SSE Error:', err);
      setStatus('disconnected');
      addLog('[Error] SSE Connection lost or failed. Check API Key if required.');
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.result && data.id === 'list-tools-req') {
          setTools(data.result.tools || []);
        } else if (data.result && data.id?.toString().startsWith('call-')) {
          const rawText = JSON.stringify(data.result, null, 2);
          setLastResult(rawText);

          // Try to extract text tag from content array
          const contentText = data.result.content?.[0]?.text;
          setExtractedText(contentText || null);
          setActiveTab(contentText ? 'value' : 'raw');

          addLog('✅ [TOOL RESULT] received.');
        } else if (data.error) {
          addLog('\n❌ [TOOL ERROR]:\n' + JSON.stringify(data.error, null, 2));
          setLastResult(JSON.stringify(data.error, null, 2));
          setExtractedText(null);
          setActiveTab('raw');
        } else {
          addLog(`[SSE Message]: ${event.data.substring(0, 100)}...`);
        }
      } catch (e) {
        addLog(`[SSE Message]: ${event.data.substring(0, 100)}...`);
      }
    };

    es.addEventListener('endpoint', (event: any) => {
      const url = event.data;
      setEndpointUrl(url);
      addLog(`[System] Server ready at ${url}`);
    });

    eventSourceRef.current = es;
  }, [apiKey]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  // Auto-initialize when we have both connection and endpoint URL
  useEffect(() => {
    if (status === 'connected' && endpointUrl) {
      initialize();
    }
  }, [status, endpointUrl]);

  const getHeaders = () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }
    return headers;
  };

  const initialize = async () => {
    addLog('[System] Sending Initialization request...');
    try {
      const resp = await fetch(getMessageUrl(), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'init-req',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'JMXQ-GUI', version: '1.0.0' },
            capabilities: {}
          }
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }

      addLog('[System] Initialization request sent successfully.');

      await fetch(getMessageUrl(), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {}
        }),
      });

      await listTools();
    } catch (err: any) {
      addLog('[Init Error] Fetch failed: ' + err.message);
    }
  };

  const listTools = async () => {
    addLog('[System] Requesting tool list...');
    try {
      const resp = await fetch(getMessageUrl(), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'list-tools-req',
          method: 'tools/list',
          params: {}
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }
    } catch (err: any) {
      addLog('[Fetch Error] Tool list failed: ' + err.message);
    }
  };

  const callTool = async () => {
    if (!selectedTool) return;
    setOutput('[System] Calling tool ' + selectedTool.name + '...');
    setLastResult(null);
    setExtractedText(null);
    try {
      const args = JSON.parse(argumentsJson);
      const resp = await fetch(getMessageUrl(), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `call-${Date.now()}`,
          method: 'tools/call',
          params: {
            name: selectedTool.name,
            arguments: args
          }
        }),
      });

      addLog(`[System] POST ${selectedTool.name} returned status ${resp.status}`);
    } catch (err: any) {
      addLog('[Tool Call Error]: ' + err.message);
    }
  };

  const copyToClipboard = () => {
    const textToCopy = activeTab === 'raw' ? lastResult : extractedText;
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      addLog('[System] Content copied to clipboard!');
    }
  };

  return (
    <div className="container">
      <div className="sidebar">
        <header>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h1 style={{ marginBottom: 0 }}>JMX-QUERY</h1>
            <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
              <div className={`tab ${activeView === 'admin' ? 'active' : ''}`} onClick={() => setActiveView('admin')}>MCP-Client</div>
              <div className={`tab ${activeView === 'chat' ? 'active' : ''}`} onClick={() => setActiveView('chat')}>Chat</div>
            </div>
          </div>
        </header>

        {activeView === 'admin' ? (
          <>
            <div className="card glass">
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                <div className={`status-badge ${status}`}>
                  {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Offline'}
                </div>
                {status === 'connected' ? (
                  <button className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'var(--error)' }} onClick={disconnect}>Disconnect</button>
                ) : (
                  <button className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={connect} disabled={status === 'connecting'}>Connect</button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div>
                  <label>MCP Server URL</label>
                  <input
                    type="text"
                    value={mcpServerUrl}
                    onChange={(e) => setMcpServerUrl(e.target.value)}
                    placeholder="http://127.0.0.1:4000"
                  />
                </div>
                <div>
                  <label>Service URL</label>
                  <input
                    type="text"
                    value={endpointUrl || ''}
                    onChange={(e) => setEndpointUrl(e.target.value)}
                    placeholder="e.g. http://localhost:7048/BC/ODataV4/..."
                  />
                </div>
                <div>
                  <label>API Key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter API Key if required"
                  />
                </div>
                <div>
                  <label>Active Execution Context</label>
                  <input
                    type="text"
                    value={executionContextCode}
                    onChange={(e) => setExecutionContextCode(e.target.value)}
                    placeholder="e.g. DEFAULT"
                  />
                </div>
                <div>
                  <label>Active JMXQuery Script</label>
                  <textarea
                    rows={4}
                    value={scriptContent}
                    onChange={(e) => setScriptContent(e.target.value)}
                    placeholder="Enter script here..."
                    style={{ height: '100px', resize: 'vertical' }}
                  />
                </div>
              </div>
            </div>

            <div className="card glass" style={{ flex: 1, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h3>Tools</h3>
                <button className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={listTools}>Refresh</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {tools.map((t) => (
                  <div
                    key={t.name}
                    className={`tool-item ${selectedTool?.name === t.name ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedTool(t);
                      const props = t.inputSchema.properties || {};
                      const initialArgs = Object.keys(props).reduce((acc, k) => {
                        let val = "";
                        if (k === 'executionContextCode' && executionContextCode) {
                          val = executionContextCode;
                        } else if (k === 'script' && scriptContent && t.name === 'jmxq_executeScript') {
                          val = scriptContent;
                        }
                        return { ...acc, [k]: val };
                      }, {});
                      setArgumentsJson(JSON.stringify(initialArgs, null, 2));
                    }}
                  >
                    <strong>{t.name}</strong>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="card glass">
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                Use the Chat Client to interact with Business Central data using natural language via your n8n workflows.
              </p>
            </div>
            <div className="card glass">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div>
                  <label>n8n Webhook URL</label>
                  <input
                    type="text"
                    value={chatTargetUrl}
                    onChange={(e) => setChatTargetUrl(e.target.value)}
                    placeholder="https://n8n.example.com/webhook/..."
                    style={{ fontSize: '0.85rem' }}
                  />
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                    This URL is used to send messages to your n8n workflow.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="main-content">
        {activeView === 'admin' ? (
          <>
            <div className="card" style={{ flex: 'none' }}>
              <h2>Tool: {selectedTool?.name || 'Please select a tool'}</h2>
              <textarea
                rows={8}
                value={argumentsJson}
                onChange={(e) => setArgumentsJson(e.target.value)}
                placeholder='{"arg": "val"}'
              />
              <button className="btn" onClick={callTool} disabled={!selectedTool}>
                Execute Tool Call
              </button>
            </div>

            <div className="card" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="tabs" style={{ marginBottom: 0 }}>
                  <div className={`tab ${activeTab === 'raw' ? 'active' : ''}`} onClick={() => setActiveTab('raw')}>RAW Result</div>
                  <div className={`tab ${activeTab === 'value' ? 'active' : ''}`} onClick={() => setActiveTab('value')}>VALUE Result</div>
                </div>
                {(lastResult || extractedText) && (
                  <button className="btn" style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }} onClick={copyToClipboard}>
                    Copy {activeTab.toUpperCase()}
                  </button>
                )}
              </div>

              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* System Logs */}
                <div className="output-area" ref={logRef} style={{ flex: 'none', maxHeight: '120px', fontSize: '0.75rem', opacity: 0.8 }}>
                  {output}
                </div>

                {/* Content Section */}
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  {activeTab === 'raw' && lastResult && (
                    <SyntaxHighlighter
                      language="json"
                      style={atomDark}
                      customStyle={{ margin: 0, borderRadius: '8px', fontSize: '0.875rem', backgroundColor: '#111827', flex: 1, overflow: 'auto' }}
                    >
                      {lastResult}
                    </SyntaxHighlighter>
                  )}

                  {activeTab === 'value' && extractedText && (
                    <SyntaxHighlighter
                      language="text"
                      style={atomDark}
                      customStyle={{ margin: 0, borderRadius: '8px', fontSize: '0.875rem', backgroundColor: '#111827', flex: 1, overflow: 'auto' }}
                    >
                      {extractedText}
                    </SyntaxHighlighter>
                  )}

                  {activeTab === 'value' && !extractedText && (
                    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      No single value result available. Check the RAW tab.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <ChatClient targetUrlProp={chatTargetUrl} />
        )}
      </div>
    </div>
  );
}
