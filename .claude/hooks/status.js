// SessionStart hook: print where the work stands, read live from git and GitHub.
// Open work lives only on GitHub (open PRs, open issues), never in a local file, so
// this cannot go stale the way HANDOFF.md did. Any command may fail (no gh, no
// network): print what works, and say so for what does not.
const { execSync } = require('node:child_process');
const sh = (cmd) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString().trim(); } catch { return null; } };
const json = (cmd) => { try { return JSON.parse(sh(cmd)); } catch { return null; } };

const ci = (r = []) =>
  r.some(c => /FAILURE|ERROR|CANCELLED|TIMED_OUT/.test(c.conclusion || c.state)) ? 'red'
  : r.some(c => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING') ? 'running'
  : r.length ? 'green' : 'no checks';

const out = ['=== Where the work stands (live from git + GitHub) ==='];
const branch = sh('git rev-parse --abbrev-ref HEAD');
const dirty = sh('git status --short');
if (branch) out.push(`Branch: ${branch}${dirty ? `, ${dirty.split('\n').length} uncommitted file(s)` : ', clean'}`);

const prs = json('gh pr list --json number,title,isDraft,headRefName,statusCheckRollup');
const issues = json('gh issue list --json number,title,labels');
if (!prs || !issues) out.push('GitHub: unavailable. Run `gh pr list` and `gh issue list` by hand.');
if (prs) {
  out.push(prs.length ? 'Open PRs (the body says how to resume):' : 'Open PRs: none');
  for (const p of prs) out.push(`  #${p.number} ${p.isDraft ? '[draft] ' : ''}${p.title} (${p.headRefName}, CI ${ci(p.statusCheckRollup)})`);
}
if (issues) {
  out.push(issues.length ? 'Open issues ([owner] = steps only the owner can do):' : 'Open issues: none');
  for (const i of issues) out.push(`  #${i.number} ${i.labels.map(l => `[${l.name}] `).join('')}${i.title}`);
}
process.stdout.write(out.join('\n') + '\n');
