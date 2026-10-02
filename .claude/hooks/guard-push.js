// PreToolUse(Bash) gate for pushes.
// Silent (exit 0) unless the push targets the released branch or the tests fail.
// ponytail: one script, not three hooks. stdin carries the hook payload.
// Only a segment that STARTS a push counts, so an echo or grep that merely
// mentions the words is not a push. Segments split the way the permission
// system splits them: && || ; | & and newlines.
const { execSync } = require('node:child_process');
const RELEASED = 'main';

let raw = '';
process.stdin.on('data', d => (raw += d)).on('end', () => {
  let cmd = '';
  try { cmd = JSON.parse(raw).tool_input?.command || ''; } catch {}

  const pushes = cmd
    .split(/&&|\|\||;|\||&|\n/)
    .map(s => s.trim())
    .filter(s => /^git\s+(-\S+\s+|--\S+(=\S+)?\s+)*push\b/.test(s));
  if (!pushes.length) process.exit(0);

  if (pushes.some(s => new RegExp(`\\b${RELEASED}\\b`).test(s))) {
    console.error(
      `Blocked: never push directly to ${RELEASED}. Push a branch and open a PR into ${RELEASED} (\`npm run release -- patch|minor\` does both).`
    );
    process.exit(2);
  }

  try {
    execSync('npm test', { cwd: process.env.CLAUDE_PROJECT_DIR || '.', stdio: 'pipe' });
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    console.error('Blocked: `npm test` fails, so this push would ship a broken tree.\n' + out.slice(-1500));
    process.exit(2);
  }
  process.exit(0);
});
