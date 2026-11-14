import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { toolsClientScript } from '../server/automation/tools-client.js';

const execFileAsync = promisify(execFile);

function runTools(scriptPath: string, args: string[], env: Record<string, string>, stdinText?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [scriptPath, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    if (stdinText !== undefined) {
      child.stdin?.end(stdinText);
    } else {
      child.stdin?.end();
    }
  });
}

test('toolsClientScript supports inline JSON, @file (with BOM), --file, stdin, and transport error reporting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-client-test-'));
  const scriptPath = join(dir, 'tools.mjs');
  const received: unknown[] = [];

  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    const env = {
      TOOLS_URL: `http://127.0.0.1:${addr.port}/tools`,
      TOOLS_TOKEN: 'test-token',
    };

    writeFileSync(scriptPath, toolsClientScript('TOOLS_URL', 'TOOLS_TOKEN', 'followup_tool_transport_error'));

    const inlineRes = await runTools(scriptPath, ['{"tool":"get_task"}'], env);
    assert.equal(inlineRes.code, 0);

    const bomPayload = join(dir, 'payload.json');
    writeFileSync(bomPayload, '\uFEFF{"tool":"get_site"}');
    const atFileRes = await runTools(scriptPath, [`@${bomPayload}`], env);
    assert.equal(atFileRes.code, 0);

    const flagFileRes = await runTools(scriptPath, ['--file', bomPayload], env);
    assert.equal(flagFileRes.code, 0);

    const stdinRes = await runTools(scriptPath, [], env, '{"tool":"act","decision":{"action":"retry"}}');
    assert.equal(stdinRes.code, 0);

    assert.deepEqual(received, [
      { tool: 'get_task' },
      { tool: 'get_site' },
      { tool: 'get_site' },
      { tool: 'act', decision: { action: 'retry' } },
    ]);

    await new Promise<void>((r) => server.close(() => r()));
    const errRes = await runTools(scriptPath, ['{"tool":"get_task"}'], env);
    assert.notEqual(errRes.code, 0);
    const parsedErr = JSON.parse(errRes.stdout.trim());
    assert.equal(parsedErr.kind, 'followup_tool_transport_error');
    assert.equal(parsedErr.hostname, '127.0.0.1');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execFileAsync sanity', () => {
  assert.equal(typeof execFileAsync, 'function');
});
