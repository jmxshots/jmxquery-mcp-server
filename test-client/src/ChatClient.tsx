import React, { useState, useEffect, useRef } from 'react';
import './ChatClient.css';

interface Message {
    id: string;
    text: string;
    sender: 'user' | 'bot';
    timestamp: number;
    isHtml?: boolean;
}

export default function ChatClient() {
    const [messages, setMessages] = useState<Message[]>(() => {
        const saved = localStorage.getItem('chat_history');
        return saved ? JSON.parse(saved) : [];
    });
    const [inputText, setInputText] = useState('');
    const [targetUrl, setTargetUrl] = useState(() => localStorage.getItem('chat_target_url') || '');
    const [showConfig, setShowConfig] = useState(!localStorage.getItem('chat_target_url'));
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
        localStorage.setItem('chat_target_url', targetUrl);
    }, [targetUrl]);

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
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                },
                body: userMessage.text,
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const contentType = response.headers.get('content-type');
            const resultText = await response.text();

            const botMessage: Message = {
                id: (Date.now() + 1).toString(),
                text: resultText,
                sender: 'bot',
                timestamp: Date.now(),
                isHtml: contentType?.includes('text/html') || resultText.trim().startsWith('<'),
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
        <div className="chat-container card glass">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2>Chat Client</h2>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'var(--border)' }} onClick={() => setShowConfig(!showConfig)}>
                        {showConfig ? 'Hide Config' : 'Configure'}
                    </button>
                    <button className="btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'var(--error)' }} onClick={clearHistory}>
                        Clear
                    </button>
                </div>
            </div>

            {showConfig && (
                <div className="card" style={{ background: 'rgba(0,0,0,0.2)', padding: '1rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div>
                            <label>Target URL (Webhook)</label>
                            <input
                                type="text"
                                value={targetUrl}
                                onChange={(e) => setTargetUrl(e.target.value)}
                                placeholder="https://n8n.example.com/webhook/..."
                            />
                        </div>
                    </div>
                </div>
            )}

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
