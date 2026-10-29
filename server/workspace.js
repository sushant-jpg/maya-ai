import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_ENTRIES = 10_000;
const MAX_SEARCH_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 100;
const MAX_CHECK_OUTPUT = 1024 * 1024;
const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const BLOCKED_DIRECTORY_NAMES = new Set([
  '.aws', '.azure', '.cache', '.config', '.git', '.gnupg', '.kube', '.next',
  '.nuxt', '.ssh', '.turbo', '.venv', '.vscode', 'coverage', 'node_modules',
  'secrets', 'venv',
]);
const BLOCKED_FILE_NAMES = new Set([
  '.npmrc', '.pypirc', 'authorized_keys', 'credentials', 'credentials.json',
  'id_dsa', 'id_ed25519', 'id_rsa', 'id_ecdsa',
]);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.html', '.java', '.js', '.jsx',
  '.json', '.md', '.mjs', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svg',
  '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml',
]);
const CHECK_SCRIPTS = new Set(['test', 'lint', 'typecheck', 'build']);

function redactCheckOutput(value) {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b((?:API|ACCESS|AUTH|CLIENT|CLOUD|PRIVATE|SECRET|PASSWORD|TOKEN)[A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
}

export class WorkspaceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}

export function createWorkspaceService({ rootPath = '', spawnProcess = spawn } = {}) {
  const configuredRoot = rootPath ? path.resolve(rootPath) : null;
  const proposals = new Map();
  let activeCheck = false;

  async function getRoot() {
    if (!configuredRoot) throw new WorkspaceError('Workspace access is not configured on the Maya server.', 503);
    let root;
    try {
      root = await fs.realpath(configuredRoot);
    } catch {
      throw new WorkspaceError('The configured workspace folder is unavailable.', 503);
    }
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) throw new WorkspaceError('The configured workspace path is not a folder.', 503);
    return root;
  }

  function normalizeRelativePath(value = '.') {
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) {
      throw new WorkspaceError('A valid workspace-relative path is required.');
    }
    if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) {
      throw new WorkspaceError('Workspace paths must be relative.');
    }
    const segments = value.replace(/\\/g, '/').split('/');
    if (segments.some((segment) => segment === '..')) {
      throw new WorkspaceError('Parent-directory traversal is not allowed.');
    }
    if (segments.some((segment) => segment.includes(':') || /[<>\"|?*]/.test(segment) || (segment !== '.' && /[. ]$/.test(segment))
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) {
      throw new WorkspaceError('Workspace paths contain unsupported file-system names.');
    }
    const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new WorkspaceError('Parent-directory traversal is not allowed.');
    }
    return normalized === '.' ? '' : normalized;
  }

  function isSensitivePath(relativePath) {
    const segments = relativePath.split(/[\\/]/).filter(Boolean);
    if (segments.some((segment) => BLOCKED_DIRECTORY_NAMES.has(segment.toLowerCase()))) return true;
    return segments.some((segment) => {
      const lower = segment.toLowerCase();
      return BLOCKED_FILE_NAMES.has(lower)
        || /^\.env(?:\.|$)/i.test(segment)
        || /\.(?:pem|key|p12|pfx|secret|secrets|tfstate|tfvars)$/i.test(segment)
        || /^(?:secrets?|credentials?|service[-_]?account)(?:\.|$)/i.test(segment);
    });
  }

  async function resolvePath(value, { allowMissingFinal = false } = {}) {
    const root = await getRoot();
    const relativePath = normalizeRelativePath(value);
    if (!relativePath) return { root, relativePath, absolutePath: root };
    if (isSensitivePath(relativePath)) throw new WorkspaceError('This path is protected and cannot be accessed.');
    const absolutePath = path.resolve(root, relativePath);
    const relativeFromRoot = path.relative(root, absolutePath);
    if (relativeFromRoot === '..' || relativeFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFromRoot)) {
      throw new WorkspaceError('Workspace paths must stay inside the configured folder.');
    }

    const segments = relativePath.split(/[\\/]/).filter(Boolean);
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new WorkspaceError('Symbolic links are not accessible through workspace tools.');
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        if (error.code !== 'ENOENT' || !allowMissingFinal || index !== segments.length - 1) {
          if (error.code === 'ENOENT') throw new WorkspaceError('The requested workspace path does not exist.', 404);
          throw error;
        }
      }
    }
    return { root, relativePath, absolutePath };
  }

  async function readTextFile(absolutePath) {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new WorkspaceError('Only regular files can be read.');
    if (stat.size > MAX_FILE_BYTES) throw new WorkspaceError('Files larger than 512 KB cannot be opened.');
    const content = await fs.readFile(absolutePath);
    if (content.includes(0)) throw new WorkspaceError('Binary files cannot be opened as text.');
    if (content.length > MAX_FILE_BYTES) throw new WorkspaceError('Files larger than 512 KB cannot be opened.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new WorkspaceError('The selected file is not valid UTF-8 text.');
    }
  }

  async function listFiles(relativePath = '.') {
    const { absolutePath, relativePath: normalized } = await resolvePath(relativePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) throw new WorkspaceError('The selected workspace path is not a folder.');
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const visible = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childPath = normalized ? `${normalized}/${entry.name}` : entry.name;
      if (isSensitivePath(childPath)) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const childStat = await fs.stat(path.join(absolutePath, entry.name));
      visible.push({
        name: entry.name,
        path: childPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isFile() ? childStat.size : undefined,
      });
    }
    visible.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
    if (visible.length > MAX_LIST_ENTRIES) {
      throw new WorkspaceError(`This folder has more than ${MAX_LIST_ENTRIES} entries. Open a subfolder instead.`, 413);
    }
    return { path: normalized, entries: visible };
  }

  async function readFile(relativePath) {
    const { absolutePath, relativePath: normalized } = await resolvePath(relativePath);
    return { path: normalized, content: await readTextFile(absolutePath) };
  }

  async function searchCode(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) {
      throw new WorkspaceError('Search text must be between 1 and 200 characters.');
    }
    const root = await getRoot();
    const matches = [];
    let filesVisited = 0;
    let entriesVisited = 0;
    let bytesRead = 0;
    const stack = [{ absolutePath: root, relativePath: '' }];
    while (stack.length && filesVisited < MAX_SEARCH_FILES && entriesVisited < MAX_SEARCH_ENTRIES && bytesRead < MAX_SEARCH_BYTES && matches.length < MAX_SEARCH_MATCHES) {
      const current = stack.pop();
      const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
      entriesVisited += entries.length;
      for (const entry of entries) {
        if (entriesVisited > MAX_SEARCH_ENTRIES) break;
        const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
        if (isSensitivePath(relativePath) || entry.isSymbolicLink()) continue;
        const absolutePath = path.join(current.absolutePath, entry.name);
        if (entry.isDirectory()) {
          if (current.relativePath.split('/').filter(Boolean).length < 11) stack.push({ absolutePath, relativePath });
          continue;
        }
        if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const stat = await fs.stat(absolutePath);
        if (stat.size > 256 * 1024) continue;
        filesVisited += 1;
        bytesRead += stat.size;
        const text = await fs.readFile(absolutePath, 'utf8');
        const lines = text.split(/\r?\n/);
        for (let line = 0; line < lines.length; line += 1) {
          if (lines[line].toLowerCase().includes(query.trim().toLowerCase())) {
            matches.push({ path: relativePath, line: line + 1, text: lines[line].slice(0, 500) });
            if (matches.length >= MAX_SEARCH_MATCHES) break;
          }
        }
        if (filesVisited >= MAX_SEARCH_FILES || entriesVisited >= MAX_SEARCH_ENTRIES || bytesRead >= MAX_SEARCH_BYTES || matches.length >= MAX_SEARCH_MATCHES) break;
      }
    }
    return {
      matches,
      truncated: filesVisited >= MAX_SEARCH_FILES || entriesVisited >= MAX_SEARCH_ENTRIES || bytesRead >= MAX_SEARCH_BYTES || matches.length >= MAX_SEARCH_MATCHES,
    };
  }

  async function getInfo() {
    if (!configuredRoot) return { enabled: false };
    const root = await getRoot();
    return {
      enabled: true,
      name: path.basename(root),
      id: createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16),
    };
  }

  async function createProposal(relativePath, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new WorkspaceError('Proposed file content must be 512 KB or smaller.');
    }
    for (const [id, proposal] of proposals) {
      if (proposal.expiresAt < Date.now()) proposals.delete(id);
    }
    if (proposals.size >= 200) throw new WorkspaceError('Too many file proposals are awaiting review. Wait for older proposals to expire.', 429);
    const resolved = await resolvePath(relativePath, { allowMissingFinal: true });
    let before = null;
    try {
      before = await readTextFile(resolved.absolutePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const id = randomUUID();
    const fingerprint = before === null ? null : createHash('sha256').update(before).digest('hex');
    const expiresAt = Date.now() + PROPOSAL_TTL_MS;
    proposals.set(id, { relativePath: resolved.relativePath, content, before, fingerprint, expiresAt });
    return { id, path: resolved.relativePath, before, after: content, expiresAt };
  }

  async function applyProposal(id) {
    const proposal = proposals.get(id);
    if (!proposal || proposal.expiresAt < Date.now()) {
      proposals.delete(id);
      throw new WorkspaceError('This file proposal is missing or expired. Create a new proposal.', 404);
    }
    const resolved = await resolvePath(proposal.relativePath, { allowMissingFinal: true });
    let current = null;
    try {
      current = await readTextFile(resolved.absolutePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== proposal.before) throw new WorkspaceError('The file changed after this proposal was created. Review a new proposal before applying it.', 409);

    const tempPath = path.join(path.dirname(resolved.absolutePath), `.maya-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempPath, proposal.content, { encoding: 'utf8', flag: 'wx' });
      if (proposal.fingerprint === null) {
        await fs.link(tempPath, resolved.absolutePath);
        await fs.unlink(tempPath);
      } else {
        const latest = await readTextFile(resolved.absolutePath);
        if (createHash('sha256').update(latest).digest('hex') !== proposal.fingerprint) {
          throw new WorkspaceError('The file changed after this proposal was created. Review a new proposal before applying it.', 409);
        }
        await fs.rename(tempPath, resolved.absolutePath);
      }
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      if (error instanceof WorkspaceError) throw error;
      if (error.code === 'EEXIST') throw new WorkspaceError('A file was created at this path after the proposal. Review a new proposal.', 409);
      if (error.code === 'ENOENT') throw new WorkspaceError('The destination folder no longer exists.', 404);
      throw error;
    }
    proposals.delete(id);
    return { applied: true, path: proposal.relativePath };
  }

  async function runCheck(check, approved) {
    if (!CHECK_SCRIPTS.has(check)) throw new WorkspaceError('Only test, lint, typecheck, and build checks are allowed.');
    if (approved !== true) throw new WorkspaceError('Explicit approval is required before running a project check.', 403);
    if (activeCheck) throw new WorkspaceError('Another approved workspace check is already running.', 409);
    const root = await getRoot();
    let packageJson;
    try {
      packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    } catch {
      throw new WorkspaceError('A valid package.json is required to run approved npm checks.', 400);
    }
    if (!packageJson.scripts || typeof packageJson.scripts[check] !== 'string') {
      throw new WorkspaceError(`The workspace does not define an npm ${check} script.`, 400);
    }
    activeCheck = true;
    try {
      return await new Promise((resolve, reject) => {
        let output = '';
        let timedOut = false;
        let capped = false;
        const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
        const args = process.platform === 'win32'
          ? ['/d', '/s', '/c', `npm.cmd run ${check}`]
          : ['run', check];
        const allowedEnvironment = new Set([
          'APPDATA', 'CI', 'COMSPEC', 'FORCE_COLOR', 'HOME', 'LOCALAPPDATA',
          'NODE_ENV', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP',
          'USERPROFILE', 'WINDIR',
        ]);
        const env = Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => allowedEnvironment.has(key.toUpperCase())));
        let child;
        try {
          child = spawnProcess(command, args, {
            cwd: root,
            shell: false,
            windowsHide: true,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          reject(new WorkspaceError(`Could not start the approved ${check} check. Verify that Node.js and npm are available.`, 503));
          return;
        }
        const append = (chunk) => {
          if (capped) return;
          const text = chunk.toString('utf8');
          output += text.slice(0, MAX_CHECK_OUTPUT - output.length);
          if (output.length >= MAX_CHECK_OUTPUT) {
            capped = true;
            child.kill();
          }
        };
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, CHECK_TIMEOUT_MS);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(new WorkspaceError(`Could not start the approved ${check} check: ${error.message}`, 503));
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolve({
            check,
            command: `npm run ${check}`,
            exitCode: code,
            signal,
            timedOut,
            output: redactCheckOutput(output),
            outputTruncated: capped,
          });
        });
      });
    } finally {
      activeCheck = false;
    }
  }

  return {
    configured: Boolean(configuredRoot),
    getInfo,
    listFiles,
    readFile,
    searchCode,
    createProposal,
    applyProposal,
    runCheck,
  };
}
