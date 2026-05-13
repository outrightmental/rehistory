#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ONE_GB = 1024 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

function usage() {
  return `
rehistory OWNER/REPO [options]

Rewrite the default branch so every reachable commit keeps the same tree,
parents, author, committer, and timestamps, but gets a Claude-generated message.

Options:
  -y, --yes                 Actually force-push the rewritten default branch.
      --dry-run             Generate rewritten history locally, but do not push.
      --no-push             Same as --dry-run after local rewrite.
      --branch <name>       Rewrite this branch instead of the repo default.
      --model <name>        Pass --model to claude, e.g. sonnet or opus.
      --keep-temp           Do not delete the temp clone after success.
      --skip-github-notes   Do not try to pull associated PR/comment context.
      --help                Show this help.

Examples:
  rehistory outrightmental/starbuster --dry-run --keep-temp
  rehistory outrightmental/starbuster --yes
`;
}

function parseArgs(argv) {
  const opts = {
    yes: false,
    push: true,
    dryRun: false,
    branch: null,
    model: null,
    keepTemp: false,
    includeGithubNotes: true,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (a === '--yes' || a === '-y') {
      opts.yes = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
      opts.push = false;
    } else if (a === '--no-push') {
      opts.push = false;
    } else if (a === '--branch') {
      opts.branch = requireValue(argv, ++i, '--branch');
    } else if (a === '--model') {
      opts.model = requireValue(argv, ++i, '--model');
    } else if (a === '--keep-temp') {
      opts.keepTemp = true;
    } else if (a === '--skip-github-notes') {
      opts.includeGithubNotes = false;
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}\n${usage()}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1 || !positional[0].includes('/')) {
    throw new Error(`Expected exactly one OWNER/REPO argument.\n${usage()}`);
  }

  if (opts.push && !opts.yes) {
    throw new Error(
      `Refusing to force-push without --yes. Run a dry run first, then rerun with --yes.\n${usage()}`,
    );
  }

  return { repo: positional[0], opts };
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return argv[index];
}

function shellish(cmd, args) {
  return [cmd, ...args].map((s) => {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(String(s))) return String(s);
    return `'${String(s).replaceAll("'", `'\\''`)}'`;
  }).join(' ');
}

function run(cmd, args, options = {}) {
  const {
    cwd,
    input,
    env = {},
    trim = true,
    allowFailure = false,
    encoding = 'utf8',
    maxBuffer = ONE_GB,
  } = options;

  const result = spawnSync(cmd, args, {
    cwd,
    input,
    env: { ...process.env, ...env },
    encoding,
    maxBuffer,
  });

  if (result.error) throw result.error;

  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      [
        `Command failed (${result.status}): ${shellish(cmd, args)}`,
        cwd ? `cwd: ${cwd}` : null,
        result.stdout ? `\nSTDOUT:\n${result.stdout}` : null,
        result.stderr ? `\nSTDERR:\n${result.stderr}` : null,
      ].filter(Boolean).join('\n'),
    );
  }

  if (encoding === 'buffer' || encoding === null) return result.stdout;
  return trim ? result.stdout.trim() : result.stdout;
}

function existsCommand(name) {
  const result = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function makeGit(workDir) {
  return function git(args, options = {}) {
    return run('git', ['-C', workDir, ...args], options);
  };
}

function makeGitBuffer(workDir) {
  return function gitBuffer(args, options = {}) {
    return run('git', ['-C', workDir, ...args], {
      ...options,
      encoding: 'buffer',
      trim: false,
    });
  };
}

function getDefaultBranch(repo) {
  return run('gh', [
    'repo',
    'view',
    repo,
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ]);
}

function getCommitMeta(git, sha) {
  const raw = git([
    'show',
    '-s',
    '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI',
    sha,
  ], { trim: false });

  const fields = raw.replace(/\n$/, '').split('\0');
  if (fields.length < 9) throw new Error(`Could not parse commit metadata for ${sha}`);

  const [
    hash,
    tree,
    parentsRaw,
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
  ] = fields;

  return {
    hash,
    tree,
    parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
    originalMessage: git(['log', '-1', '--format=%B', sha], {
      trim: false,
    }).replace(/\s+$/, ''),
  };
}

function listChangedPaths(gitBuffer, sha) {
  const buf = gitBuffer([
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-m',
    '-z',
    sha,
  ]);

  const decoded = TEXT_DECODER.decode(buf);
  return [...new Set(decoded.split('\0').filter(Boolean))].sort();
}

function blobExists(workDir, sha, filePath) {
  const result = spawnSync('git', ['-C', workDir, 'cat-file', '-e', `${sha}:${filePath}`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function readBlobText(workDir, sha, filePath) {
  const result = spawnSync('git', ['-C', workDir, 'cat-file', '-p', `${sha}:${filePath}`], {
    encoding: 'buffer',
    maxBuffer: ONE_GB,
  });

  if (result.error || result.status !== 0) {
    return `[could not read ${filePath} from ${sha}]`;
  }

  const buf = result.stdout;
  if (looksBinary(buf)) {
    return `[binary file omitted: ${filePath}, ${buf.length} bytes]`;
  }
  return TEXT_DECODER.decode(buf);
}

function looksBinary(buf) {
  const length = Math.min(buf.length, 8000);
  for (let i = 0; i < length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function getGithubNotes(repo, sha) {
  const notes = [];

  const pulls = run('gh', [
    'api',
    '-H',
    'Accept: application/vnd.github+json',
    `repos/${repo}/commits/${sha}/pulls`,
    '--jq',
    '.[] | "PR #" + (.number|tostring) + " " + .title + "\n" + ((.body // "")|tostring)',
  ], { allowFailure: true, trim: false });

  if (pulls && pulls.trim()) {
    notes.push(`Associated pull request text:\n${pulls.trim()}`);
  }

  const comments = run('gh', [
    'api',
    '-H',
    'Accept: application/vnd.github+json',
    `repos/${repo}/commits/${sha}/comments`,
    '--jq',
    '.[] | "Comment by " + .user.login + ":\n" + .body',
  ], { allowFailure: true, trim: false });

  if (comments && comments.trim()) {
    notes.push(`Commit comments:\n${comments.trim()}`);
  }

  return notes.join('\n\n');
}

function buildCommitContext(workDir, repo, branch, sha, index, total, includeGithubNotes) {
  const git = makeGit(workDir);
  const gitBuffer = makeGitBuffer(workDir);
  const meta = getCommitMeta(git, sha);

  const parentMessages = meta.parents.map((p, i) => {
    const msg = git(['log', '-1', '--format=%s%n%n%b', p], { trim: false }).trim();
    return `Parent ${i + 1}: ${p}\n${msg || '[no message]'}`;
  }).join('\n\n');

  const show = git([
    'show',
    '--root',
    '--find-renames',
    '--find-copies',
    '--stat',
    '--summary',
    '--patch',
    '--binary',
    '--format=fuller',
    sha,
  ], { trim: false });

  const changedPaths = listChangedPaths(gitBuffer, sha);
  const fileSnapshots = [];

  for (const filePath of changedPaths) {
    if (!blobExists(workDir, sha, filePath)) {
      fileSnapshots.push(`--- ${filePath}\n[deleted in this commit]`);
      continue;
    }

    const content = readBlobText(workDir, sha, filePath);
    fileSnapshots.push(`--- ${filePath}\n${content}`);
  }

  const githubNotes = includeGithubNotes ? getGithubNotes(repo, sha) : '';

  return {
    meta,
    context: [
      `Repository: ${repo}`,
      `Branch being rewritten: ${branch}`,
      `Commit ${index + 1} of ${total}: ${sha}`,
      `Parents: ${meta.parents.length ? meta.parents.join(' ') : '[root commit]'}`,
      '',
      'ORIGINAL COMMIT MESSAGE',
      '=======================',
      meta.originalMessage || '[empty message]',
      '',
      'PARENT COMMIT MESSAGES',
      '======================',
      parentMessages || '[root commit has no parents]',
      '',
      'GITHUB PR / COMMENT CONTEXT',
      '===========================',
      githubNotes || '[none found or not requested]',
      '',
      'FULL GIT SHOW WITH PATCH',
      '========================',
      show,
      '',
      'FULL CONTENT OF CHANGED FILES AFTER THIS COMMIT',
      '===============================================',
      fileSnapshots.join('\n\n') || '[no changed paths found]',
      '',
    ].join('\n'),
  };
}

function claudeCommitMessage(context, model) {
  const instruction = `You are rewriting one Git commit message.

Return ONLY the final commit message. Do not wrap it in Markdown. Do not add commentary.

Commit message rules:
- First line: concise title, imperative mood, 72 characters or less when possible.
- Then a blank line, then a body only if useful.
- Body should summarize the concrete code changes and their purpose.
- Base the message only on the evidence in the supplied commit context.
- Do not mention hashes, Claude, temporary folders, history rewriting, or this prompt.
- Do not invent issue numbers, PR numbers, motivations, or behavior not supported by the context.
- For merge commits, write a clean integration message that reflects what the merge brings in.
- If the original message is already strong, preserve it with light cleanup.
`;

  const args = [
    '--bare',
    '-p',
    '--no-session-persistence',
    '--max-turns',
    '1',
    '--tools',
    '',
    '--output-format',
    'text',
  ];

  if (model) args.push('--model', model);
  args.push(instruction);

  let output = run('claude', args, { input: context, trim: false });
  output = normalizeClaudeCommitMessage(output);

  if (!output) throw new Error('Claude returned an empty commit message.');
  return output;
}

function normalizeClaudeCommitMessage(s) {
  let out = String(s ?? '').replace(/\r\n/g, '\n').trim();
  const fence = out.match(/^```(?:text|gitcommit|markdown)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) out = fence[1].trim();
  return out.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function rewriteHistory(workDir, commits, messages) {
  const git = makeGit(workDir);
  const oldToNew = new Map();

  for (let i = 0; i < commits.length; i++) {
    const sha = commits[i];
    const meta = getCommitMeta(git, sha);
    const msg = messages[sha];

    if (!msg) throw new Error(`Missing generated message for ${sha}`);

    const msgFile = path.join(workDir, `.rehistory-message-${sha}.txt`);
    fs.writeFileSync(msgFile, msg, 'utf8');

    const newParentArgs = [];
    for (const parent of meta.parents) {
      newParentArgs.push('-p', oldToNew.get(parent) ?? parent);
    }

    const newSha = git(['commit-tree', meta.tree, ...newParentArgs, '-F', msgFile], {
      env: {
        GIT_AUTHOR_NAME: meta.authorName,
        GIT_AUTHOR_EMAIL: meta.authorEmail,
        GIT_AUTHOR_DATE: meta.authorDate,
        GIT_COMMITTER_NAME: meta.committerName,
        GIT_COMMITTER_EMAIL: meta.committerEmail,
        GIT_COMMITTER_DATE: meta.committerDate,
      },
    });

    oldToNew.set(sha, newSha);
    fs.rmSync(msgFile, { force: true });

    console.error(`[${i + 1}/${commits.length}] ${sha.slice(0, 12)} -> ${newSha.slice(0, 12)}`);
  }

  return oldToNew;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function main() {
  const { repo, opts } = parseArgs(process.argv.slice(2));

  for (const cmd of ['gh', 'git', 'claude']) {
    if (!existsCommand(cmd)) {
      throw new Error(`Required command not found or not executable: ${cmd}`);
    }
  }

  const branch = opts.branch ?? getDefaultBranch(repo);
  if (!branch) throw new Error(`Could not determine default branch for ${repo}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rehistory-'));
  const workDir = path.join(tempRoot, 'repo');
  let success = false;

  console.error(`Repository: ${repo}`);
  console.error(`Branch: ${branch}`);
  console.error(`Temp clone: ${workDir}`);
  console.error(opts.push ? 'Mode: rewrite and force-push' : 'Mode: dry run / no push');

  try {
    run('gh', ['repo', 'clone', repo, workDir, '--', '--branch', branch, '--no-single-branch'], {
      trim: false,
    });

    const git = makeGit(workDir);

    git(['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    git(['checkout', '-B', branch, `refs/remotes/origin/${branch}`]);

    const remoteRef = `refs/remotes/origin/${branch}`;
    const originalTip = git(['rev-parse', remoteRef]);
    const originalTree = git(['rev-parse', `${originalTip}^{tree}`]);

    const commits = git(['rev-list', '--reverse', '--topo-order', originalTip])
      .split('\n')
      .filter(Boolean);

    if (commits.length === 0) {
      throw new Error('Branch has no commits. Nothing to rewrite.');
    }

    console.error(`Original tip: ${originalTip}`);
    console.error(`Commits to rewrite: ${commits.length}`);

    const statePath = path.join(tempRoot, 'generated-messages.json');
    const messages = {};

    for (let i = 0; i < commits.length; i++) {
      const sha = commits[i];

      console.error(`\nGenerating message [${i + 1}/${commits.length}] ${sha}`);

      const { context } = buildCommitContext(
        workDir,
        repo,
        branch,
        sha,
        i,
        commits.length,
        opts.includeGithubNotes,
      );

      const contextPath = path.join(
        tempRoot,
        `context-${String(i + 1).padStart(5, '0')}-${sha}.txt`,
      );

      fs.writeFileSync(contextPath, context, 'utf8');

      const message = claudeCommitMessage(context, opts.model);
      messages[sha] = message;

      fs.writeFileSync(statePath, JSON.stringify(messages, null, 2), 'utf8');
      console.error(message.split('\n')[0]);
    }

    console.error('\nRebuilding commit graph...');

    const oldToNew = rewriteHistory(workDir, commits, messages);
    const newTip = oldToNew.get(originalTip);

    if (!newTip) throw new Error('Internal error: no rewritten tip found.');

    const rewriteBranch = `rehistory-${timestamp()}`;

    git(['update-ref', `refs/heads/${rewriteBranch}`, newTip]);
    git(['checkout', rewriteBranch]);

    const newTree = git(['rev-parse', `${newTip}^{tree}`]);

    if (newTree !== originalTree) {
      throw new Error(`Tree mismatch: original ${originalTree}, rewritten ${newTree}`);
    }

    git(['diff', '--quiet', originalTip, newTip]);

    console.error(`\nVerified: final tree is identical to original tip.`);
    console.error(`Rewritten tip: ${newTip}`);
    console.error(`Local rewritten branch: ${rewriteBranch}`);
    console.error(`Original tip kept in temp clone as SHA: ${originalTip}`);

    if (opts.push) {
      console.error('\nForce-pushing with lease...');

      git([
        'push',
        'origin',
        `${rewriteBranch}:refs/heads/${branch}`,
        `--force-with-lease=refs/heads/${branch}:${originalTip}`,
      ], { trim: false });

      console.error('\nDone. Default branch history was rewritten and pushed.');
    } else {
      console.error('\nDry run complete. No push was performed.');
      console.error(`Inspect locally:\n  cd ${workDir}\n  git log --oneline --decorate ${rewriteBranch}`);
      console.error(
        `Push manually:\n  git push origin ${rewriteBranch}:refs/heads/${branch} --force-with-lease=refs/heads/${branch}:${originalTip}`,
      );
    }

    success = true;
  } finally {
    if (success && !opts.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } else {
      console.error(`\nTemp data retained at: ${tempRoot}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`\nrehistory failed: ${err.message}`);
  process.exit(1);
}
