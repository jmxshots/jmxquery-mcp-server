import { Copy, X } from "lucide-react";
import { useState } from "react";

export function BaseUrlDialog({
  baseUrl,
  onClose,
}: {
  baseUrl: string;
  onClose: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");

  const copyBaseUrl = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopyStatus("Copied to clipboard.");
    } catch {
      setCopyStatus("Unable to copy the base URL.");
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Effective base URL"
      >
        <div className="panel-heading">
          <h2>Effective base URL</h2>
          <button
            className="icon-button"
            type="button"
            title="Close dialog"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p>Business Central requests for this instance use this base URL.</p>
        <pre>{baseUrl}</pre>
        {copyStatus && <p role="status">{copyStatus}</p>}
        <div className="modal-actions">
          <button
            className="secondary-button"
            type="button"
            title="Copy base URL to clipboard"
            onClick={() => void copyBaseUrl()}
          >
            <Copy size={16} aria-hidden="true" />
            Copy to clipboard
          </button>
          <button
            className="primary-button"
            type="button"
            title="Close base URL dialog"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </section>
    </div>
  );
}