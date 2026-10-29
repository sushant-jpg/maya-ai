"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, FileCode2, Folder, FolderOpen, Play, Search, X } from "lucide-react";
import hljs from "highlight.js/lib/common";
import {
  approveWorkspaceProposal,
  createWorkspaceProposal,
  fetchWorkspaceFile,
  fetchWorkspaceFiles,
  fetchWorkspaceInfo,
  runWorkspaceCheck,
  searchWorkspace,
} from "@/lib/api";
import type {
  WorkspaceCheckResult,
  WorkspaceEntry,
  WorkspaceInfo,
  WorkspaceProposal,
  WorkspaceSearchMatch,
} from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  projectNotes: string;
  onProjectNotesChange: (value: string) => void;
};

function parentPath(value: string) {
  const segments = value.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function highlighted(content: string) {
  return hljs.highlightAuto(content).value;
}

export function WorkspaceDialog({ open, onClose, projectNotes, onProjectNotesChange }: Props) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceSearchMatch[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [proposal, setProposal] = useState<WorkspaceProposal | null>(null);
  const [checkResult, setCheckResult] = useState<WorkspaceCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewing, setPreviewing] = useState(false);

  const segments = useMemo(() => currentPath.split("/").filter(Boolean), [currentPath]);
  const hasUnappliedChanges = content !== originalContent || proposal !== null;
  const requestClose = useCallback(() => {
    if (hasUnappliedChanges && !window.confirm("Discard your unapproved workspace changes and close this panel?")) return;
    onClose();
  }, [hasUnappliedChanges, onClose]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    fetchWorkspaceInfo().then(async (info) => {
      if (!active) return;
      setWorkspace(info);
      if (info.enabled) {
        const listing = await fetchWorkspaceFiles(".");
        if (!active) return;
        setEntries(listing.entries);
        setCurrentPath("");
      }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Unable to open the configured workspace.");
    }).finally(() => {
      if (active) setLoadingWorkspace(false);
    });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, requestClose]);

  if (!open) return null;

  async function loadFolder(path: string) {
    if (hasUnappliedChanges && !window.confirm("Discard your unapproved file changes before changing folders?")) return;
    setBusy(true);
    setError("");
    try {
      const listing = await fetchWorkspaceFiles(path || ".");
      setCurrentPath(listing.path);
      setEntries(listing.entries);
      setFilePath("");
      setContent("");
      setOriginalContent("");
      setProposal(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to list this workspace folder.");
    } finally {
      setBusy(false);
    }
  }

  async function openFile(path: string) {
    if (hasUnappliedChanges && !window.confirm("Discard your unapproved file changes before opening another file?")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const file = await fetchWorkspaceFile(path);
      setFilePath(file.path);
      setContent(file.content);
      setOriginalContent(file.content);
      setProposal(null);
      setPreviewing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to open this workspace file.");
    } finally {
      setBusy(false);
    }
  }

  async function searchFiles(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!searchText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await searchWorkspace(searchText.trim());
      setSearchResults(result.matches);
      setSearchTruncated(result.truncated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Workspace search failed.");
    } finally {
      setBusy(false);
    }
  }

  function startNewFile() {
    if (hasUnappliedChanges && !window.confirm("Discard your unapproved changes and start a new file?")) return;
    setFilePath(currentPath ? `${currentPath}/` : "");
    setContent("");
    setOriginalContent("");
    setProposal(null);
    setPreviewing(false);
    setNotice("");
  }

  async function reviewChanges() {
    if (!filePath.trim()) {
      setError("Enter a workspace-relative file path before reviewing changes.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setProposal(await createWorkspaceProposal(filePath.trim(), content));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare a file change.");
    } finally {
      setBusy(false);
    }
  }

  async function applyChanges() {
    if (!proposal || !window.confirm(`Apply the reviewed changes to "${proposal.path}"?`)) return;
    setBusy(true);
    setError("");
    try {
      await approveWorkspaceProposal(proposal.id);
      setFilePath(proposal.path);
      setContent(proposal.after);
      setOriginalContent(proposal.after);
      setProposal(null);
      setNotice(`Changes applied to ${proposal.path}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to apply this file proposal.");
      setBusy(false);
      return;
    }
    try {
      const listing = await fetchWorkspaceFiles(currentPath || ".");
      setEntries(listing.entries);
    } catch (cause) {
      setError(cause instanceof Error ? `Changes were applied, but the file list could not be refreshed: ${cause.message}` : "Changes were applied, but the file list could not be refreshed.");
    } finally {
      setBusy(false);
    }
  }

  async function runCheck(check: "test" | "lint" | "typecheck" | "build") {
    if (!window.confirm(`Run the workspace's own "npm run ${check}" script? Project scripts can change files or use the network. Continue only if you trust this workspace.`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setCheckResult(await runWorkspaceCheck(check));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to run the ${check} check.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-title">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">LOCAL DEVELOPMENT TOOLS</p>
            <h2 id="workspace-title">Workspace <span>{workspace?.enabled ? workspace.name : "not configured"}</span></h2>
          </div>
          <button type="button" className="icon-button" onClick={requestClose} aria-label="Close workspace"><X size={18} /></button>
        </header>

        {loadingWorkspace ? (
          <div className="workspace-empty" role="status">Loading workspace configuration…</div>
        ) : !workspace?.enabled ? (
          <div className="workspace-empty">
            <FolderOpen size={24} />
            <strong>{error ? "Workspace could not be opened" : "Workspace tools are disabled"}</strong>
            {error && <p role="alert">{error}</p>}
            <p>Set <code>MAYA_WORKSPACE_ROOT</code> to an explicit local folder, then restart Maya. The server will not expose its folder path to the browser.</p>
          </div>
        ) : (
          <>
            <div className="workspace-toolbar">
              <button type="button" className="secondary-button" onClick={() => startNewFile()} disabled={busy}>New file</button>
              <form className="workspace-search" onSubmit={(event) => void searchFiles(event)}>
                <Search size={15} aria-hidden="true" />
                <input value={searchText} onChange={(event) => setSearchText(event.target.value)} aria-label="Search workspace code" placeholder="Search code" maxLength={200} />
                <button type="submit" disabled={busy || !searchText.trim()}>Search</button>
              </form>
            </div>

            <div className="workspace-body">
              <nav className="workspace-files" aria-label="Workspace files">
                <div className="workspace-breadcrumb">
                  <button type="button" onClick={() => void loadFolder("")}>Workspace</button>
                  {segments.map((segment, index) => {
                    const path = segments.slice(0, index + 1).join("/");
                    return <span key={path}><ChevronRight size={13} /><button type="button" onClick={() => void loadFolder(path)}>{segment}</button></span>;
                  })}
                </div>
                <div className="workspace-entry-list">
                  {currentPath && <button type="button" className="workspace-entry" onClick={() => void loadFolder(parentPath(currentPath))}><Folder size={15} /> <span>..</span></button>}
                  {entries.map((entry) => (
                    <button
                      type="button"
                      className={`workspace-entry ${entry.path === filePath ? "is-selected" : ""}`}
                      key={entry.path}
                      onClick={() => entry.type === "directory" ? void loadFolder(entry.path) : void openFile(entry.path)}
                    >
                      {entry.type === "directory" ? <Folder size={15} /> : <FileCode2 size={15} />}
                      <span>{entry.name}</span>
                      {entry.type === "file" && <small>{entry.size ? `${Math.ceil(entry.size / 1024)} KB` : ""}</small>}
                    </button>
                  ))}
                  {!entries.length && <p className="muted small">This folder is empty.</p>}
                </div>
                {searchResults.length > 0 && (
                  <div className="workspace-search-results">
                    <strong>Search results{searchTruncated ? " (limited)" : ""}</strong>
                    {searchResults.map((match, index) => (
                      <button type="button" key={`${match.path}-${match.line}-${index}`} onClick={() => void openFile(match.path)}>
                        <span>{match.path}:{match.line}</span><small>{match.text}</small>
                      </button>
                    ))}
                  </div>
                )}
              </nav>

              <div className="workspace-editor">
                <div className="workspace-editor-heading">
                  <input aria-label="Workspace-relative file path" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="Choose a file or enter a relative path" />
                  <div>
                    <button type="button" className="secondary-button" onClick={() => setPreviewing((value) => !value)} disabled={!filePath}>{previewing ? "Edit" : "Preview"}</button>
                    <button type="button" className="primary-button" onClick={() => void reviewChanges()} disabled={busy || !filePath}>Review changes</button>
                  </div>
                </div>
                {previewing ? (
                  <pre className="workspace-code-preview"><code dangerouslySetInnerHTML={{ __html: highlighted(content) }} /></pre>
                ) : (
                  <textarea className="workspace-code-editor" value={content} onChange={(event) => setContent(event.target.value)} aria-label="Workspace file content" spellCheck={false} disabled={busy} />
                )}
                {proposal && (
                  <section className="workspace-diff" aria-label="Proposed file changes">
                    <header><strong>Review before applying: {proposal.path}</strong><button type="button" className="secondary-button" onClick={() => setProposal(null)}>Discard</button></header>
                    <div className="workspace-diff-columns">
                      <div><small>Before</small><pre>{proposal.before ?? "(new file)"}</pre></div>
                      <div><small>After</small><pre>{proposal.after}</pre></div>
                    </div>
                    <button type="button" className="primary-button" onClick={() => void applyChanges()} disabled={busy}><Check size={14} /> Approve and apply</button>
                  </section>
                )}
                {error && <p className="workspace-message workspace-error" role="alert">{error}</p>}
                {notice && <p className="workspace-message" role="status">{notice}</p>}
              </div>
            </div>

            <footer className="workspace-checks">
              <div>
                <strong>Run approved checks</strong>
                <p>Each check runs only after confirmation, but project npm scripts are trusted code.</p>
              </div>
              <div className="workspace-check-buttons">
                {(["test", "lint", "typecheck", "build"] as const).map((check) => (
                  <button type="button" className="secondary-button" key={check} disabled={busy} onClick={() => void runCheck(check)}>
                    <Play size={12} /> {check}
                  </button>
                ))}
              </div>
            </footer>
            <label className="workspace-notes">
              <span><strong>Project notes</strong><small>Saved in this browser for this workspace and included as chat context.</small></span>
              <textarea value={projectNotes} onChange={(event) => onProjectNotesChange(event.target.value)} maxLength={4000} placeholder="Project conventions, architecture, key files, or tasks in progress…" />
            </label>
            {checkResult && (
              <section className={`workspace-check-result ${checkResult.exitCode === 0 && !checkResult.timedOut ? "is-success" : "is-failure"}`} aria-label="Workspace check output">
                <div><strong>{checkResult.command}</strong><span>{checkResult.timedOut ? "Timed out" : `Exit code ${checkResult.exitCode ?? "unknown"}`}</span></div>
                <pre>{checkResult.output || "(no output)"}{checkResult.outputTruncated ? "\n[Output truncated at 1 MB]" : ""}</pre>
              </section>
            )}
            {busy && <div className="workspace-busy" role="status">Working…</div>}
          </>
        )}
      </section>
    </div>
  );
}
