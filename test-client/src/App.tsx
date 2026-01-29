import { useState, useEffect, useCallback, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

const MCP_SERVER_URL = 'http://127.0.0.1:4000';

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
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [argumentsJson, setArgumentsJson] = useState('{}');
  const [executionContextCode, setExecutionContextCode] = useState(() => localStorage.getItem('jmxq_ctx') || '');
  const [output, setOutput] = useState('');
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'raw' | 'value'>('value');
  const [endpointUrl, setEndpointUrl] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Persist context
  useEffect(() => {
    localStorage.setItem('jmxq_ctx', executionContextCode);
  }, [executionContextCode]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [output]);

  const getMessageUrl = useCallback(() => {
    if (endpointUrl) return `${MCP_SERVER_URL}${endpointUrl}`;
    return `${MCP_SERVER_URL}/mcp/messages`;
  }, [endpointUrl]);

  const addLog = (msg: string) => {
    setOutput((prev) => prev + (prev ? '\n' : '') + msg);
  };

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('connecting');
    setEndpointUrl(null);
    setTools([]);
    const es = new EventSource(`${MCP_SERVER_URL}/mcp/sse`);

    es.onopen = () => {
      setStatus('connected');
      addLog('[System] SSE Connected.');
    };

    es.onerror = (err) => {
      console.error('SSE Error:', err);
      setStatus('disconnected');
      addLog('[Error] SSE Connection lost or failed.');
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
  }, []);

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

  const initialize = async () => {
    addLog('[System] Sending Initialization request...');
    try {
      const resp = await fetch(getMessageUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
          <h1>JMX-QUERY Admin</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div className={`status-badge ${status}`}>
              {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Offline'}
            </div>
            <button className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={connect}>Connect</button>
          </div>
        </header>

        <div className="card glass">
          <label>Active Execution Context</label>
          <input
            type="text"
            value={executionContextCode}
            onChange={(e) => setExecutionContextCode(e.target.value)}
            placeholder="e.g. DEFAULT"
            style={{ padding: '0.5rem', fontSize: '0.875rem' }}
          />
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
      </div>

      <div className="main-content">
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

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* System Logs */}
            <div className="output-area" ref={logRef} style={{ flex: 'none', maxHeight: '120px', fontSize: '0.75rem', opacity: 0.8 }}>
              {output}
            </div>

            {/* Content Section */}
            <div style={{ flex: 1, minHeight: 0 }}>
              {activeTab === 'raw' && lastResult && (
                <SyntaxHighlighter
                  language="json"
                  style={atomDark}
                  customStyle={{ margin: 0, borderRadius: '8px', fontSize: '0.875rem', backgroundColor: '#111827', minHeight: '100%' }}
                >
                  {lastResult}
                </SyntaxHighlighter>
              )}

              {activeTab === 'value' && extractedText && (
                <SyntaxHighlighter
                  language="text"
                  style={atomDark}
                  customStyle={{ margin: 0, borderRadius: '8px', fontSize: '0.875rem', backgroundColor: '#111827', minHeight: '100%' }}
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
      </div>
    </div>
  );
}
