import React, { useState, useEffect, useRef } from 'react';
import './ChatClient.css';

interface Message {
    id: string;
    text: string;
    sender: 'user' | 'bot';
    timestamp: number;
    isHtml?: boolean;
}

interface ChatClientProps {
    targetUrlProp?: string;
    sessionIdProp?: string;
}

export default function ChatClient({ targetUrlProp, sessionIdProp }: ChatClientProps) {
    const [messages, setMessages] = useState<Message[]>(() => {
        const saved = localStorage.getItem('chat_history');
        return saved ? JSON.parse(saved) : [];
    });
    const [inputText, setInputText] = useState('');
    const [targetUrl, setTargetUrl] = useState(() => targetUrlProp || localStorage.getItem('chat_target_url') || '');
    const [sessionId, setSessionId] = useState(() => sessionIdProp || localStorage.getItem('chat_session_id') || '');
    const [lastSentMessage, setLastSentMessage] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const historyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        localStorage.setItem('chat_history', JSON.stringify(messages));
        if (historyRef.current) {
            historyRef.current.scrollTop = historyRef.current.scrollHeight;
        }
    }, [messages]);

    useEffect(() => {
        if (targetUrlProp !== undefined) {
            setTargetUrl(targetUrlProp);
        }
    }, [targetUrlProp]);

    useEffect(() => {
        localStorage.setItem('chat_target_url', targetUrl);
    }, [targetUrl]);

    useEffect(() => {
        if (sessionIdProp !== undefined) {
            setSessionId(sessionIdProp);
        }
    }, [sessionIdProp]);

    useEffect(() => {
        localStorage.setItem('chat_session_id', sessionId);
    }, [sessionId]);

    const sendMessage = async (textOverride?: string) => {
        const textToSend = textOverride || inputText;
        if (!textToSend.trim() || !targetUrl) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            text: textToSend,
            sender: 'user',
            timestamp: Date.now(),
        };

        if (!textOverride) {
            setMessages(prev => [...prev, userMessage]);
            setInputText('');
        }
        setLastSentMessage(textToSend);
        setIsLoading(true);

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'text/plain',
            };
            if (sessionId) {
                headers['X-Session-ID'] = sessionId;
            }

            const response = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: userMessage.text,
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const contentType = response.headers.get('content-type');
            const resultText = await response.text();

            let displayText = resultText;
            let identifiedAsHtml = contentType?.includes('text/html') || resultText.trim().startsWith('<');

            // Robust JSON parsing: if it's a JSON object, try to find the content
            try {
                if (resultText.trim().startsWith('{')) {
                    const json = JSON.parse(resultText);
                    // Check common n8n/webhook response fields
                    const extracted = json.output || json.text || json.message || (typeof json === 'string' ? json : null);
                    if (extracted) {
                        displayText = extracted;
                        identifiedAsHtml = identifiedAsHtml || displayText.trim().startsWith('<');
                    }
                }
            } catch (e) {
                // Not valid JSON, stick with raw text
            }

            const botMessage: Message = {
                id: (Date.now() + 1).toString(),
                text: displayText,
                sender: 'bot',
                timestamp: Date.now(),
                isHtml: identifiedAsHtml,
            };

            setMessages(prev => [...prev, botMessage]);
        } catch (error: any) {
            const errorMessage: Message = {
                id: (Date.now() + 1).toString(),
                text: `Error: ${error.message}`,
                sender: 'bot',
                timestamp: Date.now(),
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };


    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const clearHistory = () => {
        if (window.confirm('Are you sure you want to clear the chat history?')) {
            setMessages([]);
        }
    };

    return (
        <div className="chat-container app-card glass">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2>Chat Client</h2>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'var(--error)' }} onClick={clearHistory}>
                        Clear
                    </button>
                </div>
            </div>


            <div className="chat-history" ref={historyRef}>
                {messages.length === 0 && (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', margin: 'auto' }}>
                        No messages yet. Start a conversation!
                    </div>
                )}
                {messages.map((msg) => (
                    <div key={msg.id} className={`chat-message ${msg.sender} ${msg.text.startsWith('Error:') ? 'error' : ''}`}>
                        {msg.isHtml ? (
                            <div className="html-content" dangerouslySetInnerHTML={{ __html: msg.text }} />
                        ) : (
                            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
                        )}
                        {msg.text.startsWith('Error:') && lastSentMessage && (
                            <button
                                className="btn retry-btn"
                                onClick={() => sendMessage(lastSentMessage)}
                                disabled={isLoading}
                            >
                                Retry
                            </button>
                        )}
                        <div style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '0.25rem', textAlign: msg.sender === 'user' ? 'right' : 'left' }}>
                            {new Date(msg.timestamp).toLocaleTimeString()}
                        </div>
                    </div>
                ))}
                {isLoading && (
                    <div className="chat-message bot" style={{ opacity: 0.7 }}>
                        Typing...
                    </div>
                )}
            </div>

            <div className="chat-input-area">
                <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={handleKeyPress}
                    placeholder="Type your message..."
                    disabled={isLoading}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <button
                        className="btn"
                        onClick={() => sendMessage()}
                        disabled={isLoading || !inputText.trim() || !targetUrl}
                        style={{ height: lastSentMessage ? '30px' : '44px', padding: '0 0.75rem' }}
                    >
                        Send
                    </button>
                    {lastSentMessage && (
                        <button
                            className="btn"
                            onClick={() => sendMessage(lastSentMessage)}
                            disabled={isLoading || !targetUrl}
                            style={{ height: '24px', fontSize: '0.65rem', background: 'var(--border)', padding: '0 0.5rem' }}
                            title={`Retry: ${lastSentMessage.substring(0, 30)}...`}
                        >
                            Retry
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
