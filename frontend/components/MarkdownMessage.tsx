"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import type { GenerationMetrics, SourceReference } from "@/lib/types";

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setCopyError(true);
      window.setTimeout(() => setCopyError(false), 2400);
    }
  }

  return (
    <div className="code-frame">
      <div className="code-toolbar">
        <span>{language || "code"}</span>
        <button type="button" className="copy-button" onClick={copyCode} aria-label="Copy code">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copyError ? "Clipboard unavailable" : copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code className={language ? `language-${language}` : undefined}>{code}</code></pre>
    </div>
  );
}

const markdownComponents: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (child && typeof child === "object" && "props" in child) {
      const codeElement = child as React.ReactElement<{
        className?: string;
        children?: React.ReactNode;
      }>;
      const language = codeElement.props.className?.match(/language-([\w-]+)/)?.[1] || "";
      const code = typeof codeElement.props.children === "string"
        ? codeElement.props.children.replace(/\n$/, "")
        : String(codeElement.props.children ?? "");
      return <CodeBlock language={language} code={code} />;
    }
    return <pre>{children}</pre>;
  },
  a({ href, children }) {
    const safeHref = href && /^https?:\/\//i.test(href) ? href : undefined;
    return safeHref
      ? <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>;
  },
};

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function MessageSources({ sources }: { sources?: SourceReference[] }) {
  const safeSources = (sources || []).filter((source) => {
    if (source.kind !== "web") return true;
    try {
      return new URL(source.url || "").protocol === "https:";
    } catch {
      return false;
    }
  });
  if (!safeSources.length) return null;

  return (
    <details className="sources">
      <summary>Sources <span>{safeSources.length}</span></summary>
      <ul>
        {safeSources.map((source, index) => source.kind === "web" ? (
          <li key={`${source.url}-${index}`}>
            <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a>
            {source.date && <small>{source.date}</small>}
          </li>
        ) : (
          <li key={`${source.documentId}-${source.chunkIndex}-${index}`}>
            <span className="source-document">{source.fileName || "Private document"}</span>
            {typeof source.chunkIndex === "number" && <small>Passage {source.chunkIndex}</small>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function MessageMetrics({ metrics }: { metrics?: GenerationMetrics }) {
  if (!metrics) return null;
  const details = [
    metrics.model,
    metrics.firstTokenMs === null ? null : `first token ${metrics.firstTokenMs} ms`,
    `${metrics.totalMs} ms total`,
    typeof metrics.inputTokens === "number" ? `${metrics.inputTokens} input tokens` : null,
    typeof metrics.outputTokens === "number" ? `${metrics.outputTokens} output tokens` : null,
  ].filter(Boolean);
  return (
    <>
      <div className="message-metrics" aria-label="Generation metrics">Local · {details.join(" · ")}</div>
      {metrics.finishReason === "length" && (
        <div className="message-warning" role="status">
          The model reached its output limit; this response may be incomplete. Increase Maximum output tokens in Settings and retry.
        </div>
      )}
    </>
  );
}
