"use client";

import { ArrowUp, Paperclip, Search, Square } from "lucide-react";
import { useEffect, useRef } from "react";

type Props = {
  value: string;
  isGenerating: boolean;
  webSearch: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onToggleWebSearch: () => void;
  onUpload: (files: FileList | null) => void;
};

export function Composer({ value, isGenerating, webSearch, onChange, onSend, onStop, onToggleWebSearch, onUpload }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [value]);

  return (
    <div className="composer-wrap">
      <div className="composer">
        <label className="composer-attach icon-button" title="Add a private document">
          <Paperclip size={18} />
          <input type="file" accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf" onChange={(event) => {
            onUpload(event.currentTarget.files);
            event.currentTarget.value = "";
          }} />
        </label>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!isGenerating) onSend();
            }
          }}
          placeholder="Message Maya…"
          rows={1}
          aria-label="Message Maya"
          disabled={isGenerating}
        />
        {isGenerating ? (
          <button type="button" className="send-button stop-button" onClick={onStop} aria-label="Stop generating" title="Stop generating">
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button type="button" className="send-button" onClick={onSend} disabled={!value.trim()} aria-label="Send message" title="Send message">
            <ArrowUp size={19} />
          </button>
        )}
        <div className="composer-options">
          <button
            type="button"
            className={`option-chip ${webSearch ? "option-active" : ""}`}
            onClick={onToggleWebSearch}
            aria-pressed={webSearch}
            title="When enabled, your query is sent to the configured external search provider."
          >
            <Search size={14} /> Web search {webSearch && <span className="option-dot" />}
          </button>
          <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
        </div>
      </div>
      <p className="disclaimer">Maya can make mistakes. Verify important information.</p>
    </div>
  );
}
