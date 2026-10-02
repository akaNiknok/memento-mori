// Self-check for guard-push.js: `node .claude/hooks/guard-push.test.js`
// Cannot live in a shell command — the fixtures read as real pushes to the hook.
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

const HOOK = path.join(__dirname, 'guard-push.js');
const REPO = path.resolve(__dirname, '..', '..');
const B = 'git ' + 'push'; // built at runtime so this file is not itself a match

function run(command) {
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, err: '' };
  } catch (e) {
    return { code: e.status, err: (e.stderr || '').toString() };
  }
}

const cases = [
  ['git status', 0, 'a non-push passes'],
  ['echo "' + B + ' origin main"', 0, 'an echo mentioning the words is not a push'],
  ['grep -rn "' + B + '" CLAUDE.md', 0, 'a grep for the words is not a push'],
  [B + ' origin main', 2, 'a push to the released branch is blocked'],
  ['cd /repo && ' + B + ' -u origin main', 2, 'blocked behind a cd prefix'],
  [B + ' -u origin feature/x', 0, 'a push to a feature branch passes when tests pass'],
  [B + ' --force-with-lease origin feature/x', 0, 'flags do not defeat the match'],
];

for (const [command, want, label] of cases) {
  const { code, err } = run(command);
  assert.strictEqual(code, want, `${label}\n  command: ${command}\n  got ${code}, want ${want}\n  ${err}`);
  console.log(`ok  exit ${code}  ${label}`);
}
console.log('\nguard-push: all ' + cases.length + ' cases pass');
