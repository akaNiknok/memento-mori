// release.js — `npm run release -- patch|minor` on a feature branch. It does NOT release.
//
// GitHub Flow: a merge into main is the only path to live, and the Release workflow
// (.github/workflows/release.yml) deploys a merge whose version is not yet tagged. This
// script bumps the version, tests, pushes the branch and opens its PR into main.
// Merging that PR is what ships. No credential is needed, so it works the same in a
// cloud session as on the owner's machine.
//
// Without an argument it skips the bump, for a branch that is already bumped (a re-run).
// A change that must not deploy (docs, Apps Script, tests) needs no bump and no script:
// open its PR with `gh pr create`. CI refuses a PR that touches worker/ without a bump.
const { execSync } = require('child_process');
const out = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const run = (cmd, opts) => execSync(cmd, { stdio: 'inherit', ...opts });
const fail = (msg) => { console.error(msg); process.exit(1); };
const pkgVersion = () => JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version;

const bump = process.argv[2];
if (bump && !['patch', 'minor', 'major'].includes(bump)) fail(`usage: npm run release -- patch|minor (got ${bump})`);

const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch === 'main' || branch === 'HEAD') fail(`run this on a feature branch, not ${branch}`);
if (out('git status --porcelain')) fail('working tree not clean');

run('git fetch origin main --tags --quiet');
const live = JSON.parse(out('git show origin/main:package.json')).version;

if (bump) {
  if (pkgVersion() !== live) fail(`already bumped to ${pkgVersion()} (main is ${live}) — run without an argument`);
  // The `version` lifecycle script (stamp-version.js) writes index.html and stages it.
  run(`npm version ${bump} --no-git-tag-version`);
  run(`git commit -am "Bump version to ${pkgVersion()}"`);
} else if (pkgVersion() === live) {
  fail(`version is still ${live}, the same as main — npm run release -- patch|minor`);
}

const tag = 'v' + pkgVersion();
if (out(`git tag -l ${tag}`)) fail(`${tag} is already tagged — main moved past it; bump again`);

// test.js fails when index.html's brand-ver span disagrees with package.json. Catch
// that here rather than in CI.
run('npm test');
run(`git push -u origin ${branch}`);

const existing = out(`gh pr list --base main --head ${branch} --state open --json number -q ".[0].number"`);
if (existing) {
  console.log(`PR #${existing} is already open for this branch.`);
} else {
  const subjects = out(`git log --no-merges --reverse --invert-grep --grep="^Bump version" --format=%s origin/main..HEAD`).split('\n').filter(Boolean);
  run(`gh pr create --base main --head ${branch} --title "${(subjects[0] || branch).replace(/"/g, "'")} (${tag})" --body-file -`, {
    input: `Releases \`${tag}\` on merge.\n\n## What's Changed\n${subjects.map(s => '* ' + s).join('\n')}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}
console.log(`\n${tag} is ready. Merge the PR to release; the workflow does the rest.`);
