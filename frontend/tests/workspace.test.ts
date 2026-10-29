import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveWorkspaceProposal,
  createWorkspaceProposal,
  fetchWorkspaceFiles,
  fetchWorkspaceInfo,
  runWorkspaceCheck,
} from "../lib/api";

test("workspace API encodes relative paths and validates workspace status", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/workspace")) {
      return Response.json({ workspace: { enabled: true, name: "maya", id: "123" } });
    }
    return Response.json({ path: "src/test folder", entries: [] });
  };
  try {
    assert.deepEqual(await fetchWorkspaceInfo(), { enabled: true, name: "maya", id: "123" });
    assert.deepEqual(await fetchWorkspaceFiles("src/test folder"), { path: "src/test folder", entries: [] });
    assert.match(requests[1].url, /path=src%2Ftest\+folder/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("workspace proposals and checks send explicit approval with fixed operations", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/workspace/proposals")) {
      return Response.json({ proposal: { id: "proposal-id", path: "src/new.ts", before: null, after: "export {};", expiresAt: Date.now() + 1000 } });
    }
    if (url.includes("/apply")) return Response.json({ applied: true, path: "src/new.ts" });
    return Response.json({ check: "test", command: "npm run test", exitCode: 0, signal: null, timedOut: false, output: "passed", outputTruncated: false });
  };
  try {
    const proposal = await createWorkspaceProposal("src/new.ts", "export {};");
    assert.equal(proposal.path, "src/new.ts");
    await approveWorkspaceProposal(proposal.id);
    await runWorkspaceCheck("test");
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { approved: true });
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { check: "test", approved: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
