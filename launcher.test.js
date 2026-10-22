
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const start = readFileSync(new URL('./Start Galleypost.command', import.meta.url), 'utf8');
const stop = readFileSync(new URL('./Stop Galleypost.command', import.meta.url), 'utf8');
function fixture(t, scripts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'social-engine-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const [name, body] of Object.entries({ curl: 'exit 1', lsof: 'exit 1', open: 'echo browser-opened', ...scripts })) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const isolate = source => source.replace('export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"', `export PATH="${bin}:/usr/bin:/bin"`);
  writeFileSync(join(dir, 'Start.command'), isolate(start));
  writeFileSync(join(dir, 'Stop.command'), isolate(stop));
  for (const file of ['server.js', 'index.html', 'package-lock.json']) writeFileSync(join(dir, file), 'fixture');
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  return { dir, run: (file = 'Start.command', input = '') => spawnSync('/bin/bash', [join(dir, file)], { env, input, encoding: 'utf8', timeout: 5000 }) };
}
const validNode = 'case "$*" in *process.versions*) exit 0 ;; *) exit 1 ;; esac';

test('launcher explains missing Node and removes its startup lock', t => {
  const f = fixture(t); const r = f.run();
  assert.equal(r.status, 1); assert.match(r.stderr, /Node.js is missing/);
  assert.doesNotMatch(r.stderr, /OPENAI_API_KEY=/);
  assert.equal(existsSync(join(f.dir, ".demo-launch.lock")), false);
});
test('launcher explains unsupported Node', t => {
  const f = fixture(t, { node: 'exit 1' });
  assert.match(f.run().stderr, /22.13 or newer/);
});
test('first dependency install requires consent and cancellation leaves no server', t => {
  const f = fixture(t, { node: validNode, npm: 'echo should-not-install' });
  const r = f.run('Start.command', 'n\n');
  assert.equal(r.status, 1); assert.match(r.stdout, /Install them now/);
  assert.match(r.stderr, /Installation cancelled/); assert.doesNotMatch(r.stdout, /should-not-install/);
});
test('dependency download failure has a useful explanation', t => {
  const f = fixture(t, { node: validNode, npm: 'echo installing-fixture; exit 1' });
  const r = f.run('Start.command', 'y\n');
  assert.match(r.stdout, /Installing dependencies/); assert.match(r.stderr, /Check your internet connection/);
});
test('already-running Galleypost server is reopened without starting another process', t => {
  const f = fixture(t, { curl: 'echo \'{"app":"social-engine"}\'', node: 'echo must-not-start; exit 1' });
  const r = f.run(); assert.equal(r.status, 0);
  assert.match(r.stdout, /already running/); assert.match(r.stdout, /browser-opened/);
  assert.doesNotMatch(r.stdout, /must-not-start/);
});
test('occupied port is reported without stopping another application', t => {
  const f = fixture(t, { lsof: 'echo 12345' });
  assert.match(f.run().stderr, /No process was stopped/);
});
test('stop never signals a process when saved identity is invalid or absent', t => {
  const f = fixture(t);
  assert.equal(f.run('Stop.command').status, 0);
  writeFileSync(join(f.dir, '.demo-server.pid'), 'not-a-pid');
  const r = f.run('Stop.command'); assert.equal(r.status, 1); assert.match(r.stdout, /No process was stopped/);
});


test('a stale launch lock is recovered safely', t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, '.demo-launch.lock'));
  writeFileSync(join(f.dir, '.demo-launch.lock/pid'), '2147480000');
  const r = f.run();
  assert.match(r.stderr, /Node.js is missing/);
  assert.equal(existsSync(join(f.dir, '.demo-launch.lock')), false);
});