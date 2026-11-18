// Tests for the docker helper scripts (secret init + coturn flag builder).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ezspeak-docker-'));

function initSecrets(dir, env = {}) {
  return execFileSync('sh', [path.join(ROOT, 'docker/init-secrets.sh')], {
    env: { PATH: process.env.PATH, SECRETS_DIR: dir, ...env }, encoding: 'utf8',
  });
}

// Runs coturn.sh with a fake `turnserver` that prints its arguments.
function coturnArgs(env = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'turn_secret'), 'S3CRET');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'turnserver'), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'detect-external-ip'), '#!/bin/sh\necho 203.0.113.50\n', { mode: 0o755 });
  const r = spawnSync('sh', [path.join(ROOT, 'docker/coturn.sh')], {
    env: { PATH: `${bin}:${process.env.PATH}`, SECRETS_DIR: dir, ...env }, encoding: 'utf8',
  });
  return { status: r.status, args: r.stdout.trim().split('\n'), stderr: r.stderr };
}

test('init-secrets: generates once, keeps it, explicit TURN_SECRET overrides', () => {
  const dir = tmp();
  assert.match(initSecrets(dir), /generated/);
  const first = fs.readFileSync(path.join(dir, 'turn_secret'), 'utf8');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(initSecrets(dir), /keeping/);
  assert.equal(fs.readFileSync(path.join(dir, 'turn_secret'), 'utf8'), first);
  assert.match(initSecrets(dir, { TURN_SECRET: 'mine' }), /from environment/);
  assert.equal(fs.readFileSync(path.join(dir, 'turn_secret'), 'utf8'), 'mine');
  assert.equal(fs.statSync(path.join(dir, 'turn_secret')).mode & 0o777, 0o444, 'readable by coturn (nobody) and node');
});

test('coturn.sh: secure defaults', () => {
  const { status, args } = coturnArgs();
  assert.equal(status, 0);
  for (const a of ['--use-auth-secret', '--static-auth-secret=S3CRET', '--listening-port=3478',
                   '--min-port=49160', '--max-port=49200', '--no-cli', '--no-tls', '--fingerprint',
                   '--no-tcp-relay', '--user-quota=30', '--max-bps=500000', '--no-software-attribute']) {
    assert.ok(args.includes(a), `missing ${a}`);
  }
  assert.ok(args.includes('--denied-peer-ip=192.168.0.0-192.168.255.255'));
  assert.ok(args.includes('--denied-peer-ip=127.0.0.0-127.255.255.255'));
  assert.ok(args.includes('--denied-peer-ip=169.254.0.0-169.254.255.255'), 'cloud metadata blocked');
  assert.ok(!args.includes('--allow-loopback-peers'));
  assert.ok(!args.some(a => a.startsWith('--external-ip')));
});

test('coturn.sh: ports, LAN mode, external IP', () => {
  let { args } = coturnArgs({ TURN_PORT: '3479', TURN_MIN_PORT: '50000', TURN_MAX_PORT: '50100', TURN_ALLOW_LAN: 'true' });
  assert.ok(args.includes('--listening-port=3479'));
  assert.ok(args.includes('--min-port=50000') && args.includes('--max-port=50100'));
  assert.ok(args.includes('--allow-loopback-peers'));
  assert.ok(!args.some(a => a.startsWith('--denied-peer-ip')));
  ({ args } = coturnArgs({ TURN_EXTERNAL_IP: '198.51.100.7' }));
  assert.ok(args.includes('--external-ip=198.51.100.7'));
  ({ args } = coturnArgs({ TURN_USER_QUOTA: '5', TURN_MAX_BPS: '100000', TURN_TOTAL_QUOTA: '50' }));
  assert.ok(args.includes('--user-quota=5') && args.includes('--max-bps=100000') && args.includes('--total-quota=50'));
  ({ args } = coturnArgs({ TURN_EXTERNAL_IP: 'auto' }));
  assert.ok(args.includes('--external-ip=203.0.113.50'));
});

test('coturn.sh: refuses to start without a secret', () => {
  const r = spawnSync('sh', [path.join(ROOT, 'docker/coturn.sh')], { env: { PATH: process.env.PATH, SECRETS_DIR: tmp() }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing/);
});
