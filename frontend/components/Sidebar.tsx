"use client";

import {
  FileText,
  MessageSquare,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Conversation, DocumentItem, MayaState } from "@/lib/types";

type Props = {
  state: MayaState;
  conversations: Conversation[];
  activeId: string | null;
  search: string;
  isOpen: boolean;
  documents: DocumentItem[];
  documentsBusy: boolean;
  documentsError: string;
  collapsed: boolean;
  onSearch: (value: string) => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onRename: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  onSettings: () => void;
  onTheme: () => void;
  onClose: () => void;
  onToggleCollapse: () => void;
  onUpload: (files: FileList | null) => void;
  onRefreshDocuments: () => void;
  onDeleteDocument: (document: DocumentItem) => void;
};

export function Sidebar({
  state,
  conversations,
  activeId,
  search,
  isOpen,
  documents,
  documentsBusy,
  documentsError,
  collapsed,
  onSearch,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
  onSettings,
  onTheme,
  onClose,
  onToggleCollapse,
  onUpload,
  onRefreshDocuments,
  onDeleteDocument,
}: Props) {
  return (
    <>
      <button
        className={`sidebar-backdrop ${isOpen ? "is-visible" : ""}`}
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        tabIndex={isOpen ? 0 : -1}
      />
      <aside className={`sidebar ${isOpen ? "sidebar-open" : ""} ${collapsed ? "is-collapsed" : ""}`} aria-label="Conversation sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">✦</span>
            <span><strong>Maya</strong><small>Local AI workspace</small></span>
          </div>
          <button type="button" className="icon-button mobile-close" onClick={onClose} aria-label="Close sidebar"><X size={18} /></button>
          <button type="button" className="icon-button desktop-close" onClick={onToggleCollapse} aria-label="Collapse sidebar"><PanelLeftClose size={18} /></button>
        </div>

        <button type="button" className="new-chat-button" onClick={onNewChat}>
          <Plus size={17} /> New chat <span className="shortcut">⌘ K</span>
        </button>

        <label className="history-search">
          <Search size={16} aria-hidden="true" />
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
        </label>

        <section className="sidebar-section history-section" aria-labelledby="history-heading">
          <div className="section-heading"><span id="history-heading">Your chats</span><span className="section-count">{conversations.length}</span></div>
          <div className="conversation-list">
            {conversations.length === 0 ? (
              <p className="muted small empty-history">{search ? "No matching conversations." : "Your conversations will appear here."}</p>
            ) : conversations.map((conversation) => (
              <div className={`conversation-row ${conversation.id === activeId ? "is-active" : ""}`} key={conversation.id}>
                <button
                  type="button"
                  className="conversation-select"
                  onClick={() => onSelect(conversation.id)}
                  aria-current={conversation.id === activeId ? "page" : undefined}
                >
                  <MessageSquare size={15} aria-hidden="true" />
                  <span>{conversation.title || "Untitled chat"}</span>
                </button>
                <div className="conversation-menu">
                  <button type="button" className="icon-button mini" aria-label={`Actions for ${conversation.title}`} title="Conversation actions">
                    <MoreHorizontal size={17} />
                  </button>
                  <div className="conversation-menu-items">
                    <button type="button" onClick={() => onRename(conversation)}>Rename</button>
                    <button type="button" className="danger-text" onClick={() => onDelete(conversation)}>Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="sidebar-section documents-section" aria-labelledby="documents-heading">
          <div className="section-heading">
            <span id="documents-heading">Private documents</span>
            <div className="section-actions">
              <button type="button" className="icon-button mini" onClick={onRefreshDocuments} disabled={documentsBusy} aria-label="Refresh documents" title="Refresh">
                <span className={documentsBusy ? "spin" : ""}>↻</span>
              </button>
              <label className="icon-button mini upload-label" aria-label="Upload a private document" title="Upload TXT, Markdown, or PDF">
                <Upload size={15} />
                <input type="file" accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf" onChange={(event) => {
                  onUpload(event.currentTarget.files);
                  event.currentTarget.value = "";
                }} />
              </label>
            </div>
          </div>
          <p className={`muted small privacy-note ${documentsError ? "storage-error" : ""}`} role={documentsError ? "alert" : "status"} aria-live="polite">
            {documentsBusy
              ? "Checking local document storage…"
              : documentsError || "ChromaDB ready. Documents are indexed locally for answers with sources."}
          </p>
          <div className="document-list">
            {documents.map((document) => (
              <div className="document-row" key={document.id}>
                <FileText size={15} aria-hidden="true" />
                <span title={document.fileName}>{document.fileName}</span>
                <button type="button" className="icon-button mini" onClick={() => onDeleteDocument(document)} aria-label={`Delete ${document.fileName}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {!documents.length && <p className="muted small">{documentsBusy ? "Loading documents…" : "No documents added."}</p>}
          </div>
        </section>

        <footer className="sidebar-footer">
          <div className="local-badge"><span /> Local-first assistant</div>
          <div className="footer-actions">
            <button type="button" className="footer-button" onClick={onSettings}><Settings2 size={17} /> Settings</button>
            <button type="button" className="icon-button" onClick={onTheme} aria-label={`Switch to ${state.theme === "dark" ? "light" : "dark"} theme`}>
              {state.theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </footer>
      </aside>
    </>
  );
}
