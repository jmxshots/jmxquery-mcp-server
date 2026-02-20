import { useEffect, useRef, useState, useId } from 'react';

interface HtmlBoxProps {
    html: string;
    className?: string;
}

export default function HtmlBox({ html, className }: HtmlBoxProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(80);
    const frameId = useId();

    // Listen for postMessage from the iframe to get its content height
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.data?.type === 'htmlbox-resize' && event.data?.id === frameId) {
                const newHeight = event.data.height;
                if (newHeight > 0) {
                    setHeight(newHeight);
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [frameId]);

    const styles = `
        :root {
            --text: #e8e8e8;
            --bg: #1a1a1a;
            --primary: #61dafb;
            --border: #444444;
        }
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            background: transparent !important;
            color: var(--text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 14px;
            line-height: 1.5;
            overflow: hidden;
        }
        * { box-sizing: border-box; }
        
        /* Dark Theme Overrides */
        h1, h2, h3, h4, h5, h6 { color: #ffffff; margin-top: 1rem; margin-bottom: 0.5rem; }
        p { margin-bottom: 0.75rem; color: #e8e8e8; }
        span, div { color: #e8e8e8; }
        em, i { color: #c0c0c0; font-style: italic; }
        strong, b { color: #ffffff; }

        table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.875rem; background-color: #2c2c2c; }
        th { background-color: #3d3d3d; color: #ffffff; border: 1px solid #555555; padding: 0.75rem 0.5rem; font-weight: 500; text-align: left; }
        td { border: 1px solid #555555; padding: 0.5rem; color: #f0f0f0; }
        tr:nth-child(even) { background-color: #252525; }

        pre { background: #1a1a1a; color: #f5f5f5; padding: 1rem; border-radius: 4px; font-family: 'Roboto Mono', 'Fira Code', monospace; font-size: 13px; margin: 1rem 0; border: 1px solid #444444; overflow-x: auto; white-space: pre-wrap; }
        code { background: #2a2a2a; color: #61dafb; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.9em; border: 1px solid #3a3a3a; }
        a { color: #61dafb; text-decoration: none; font-weight: 500; }
        a:hover { text-decoration: underline; color: #80e7ff; }

        img { max-width: 100%; height: auto; }

        /* Aggressive overrides for injected inline styles */
        *[style*="background-color: white"], *[style*="background-color: #fff"],
        *[style*="background-color:#fff"], *[style*="background-color: #ffffff"],
        *[style*="background-color:#ffffff"], *[style*="background:white"],
        *[style*="background: white"], *[style*="background: #fff"],
        *[style*="background:#fff"], *[style*="background: #ffffff"],
        *[style*="background:#ffffff"],
        *[style*="background-color: rgb(255, 255, 255)"] {
            background-color: var(--bg) !important;
            background: var(--bg) !important;
        }
        *[style*="color: black"], *[style*="color: #000"],
        *[style*="color:#000"], *[style*="color: #000000"],
        *[style*="color:#000000"], *[style*="color:black"],
        *[style*="color: rgb(0, 0, 0)"] {
            color: var(--text) !important;
        }

        /* Catch-all for any styled element */
        div[style], section[style], article[style], pre[style] {
            background-color: var(--bg) !important;
        }
    `;

    // The iframe script sends its height to the parent via postMessage
    const resizeScript = `
        <script>
            const FRAME_ID = '${frameId}';
            function reportHeight() {
                const h = Math.max(
                    document.body.scrollHeight,
                    document.body.offsetHeight,
                    document.documentElement.scrollHeight,
                    document.documentElement.offsetHeight
                );
                parent.postMessage({ type: 'htmlbox-resize', id: FRAME_ID, height: h }, '*');
            }
            // Report immediately and then observe for changes
            reportHeight();
            window.addEventListener('load', () => {
                reportHeight();
                // Observe body size changes (images loading, dynamic content, etc.)
                const ro = new ResizeObserver(() => reportHeight());
                ro.observe(document.body);
                // Also observe all images
                document.querySelectorAll('img').forEach(img => {
                    img.addEventListener('load', reportHeight);
                });
            });
            // Safety: report again after a short delay
            setTimeout(reportHeight, 200);
            setTimeout(reportHeight, 1000);
        </script>
    `;

    const fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>${styles}</style></head>
<body>${html}${resizeScript}</body>
</html>`;

    return (
        <iframe
            ref={iframeRef}
            srcDoc={fullHtml}
            className={className}
            title="Result Content"
            sandbox="allow-scripts"
            style={{
                width: '100%',
                height: `${height}px`,
                border: 'none',
                overflow: 'hidden',
                backgroundColor: 'transparent',
                display: 'block',
            }}
        />
    );
}
