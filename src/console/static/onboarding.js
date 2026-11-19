// Setup (onboarding), Built with Kiro and the architecture strip. Every command shown here is
// one this repository documents or runs in its own scripts; every file named exists in it.
// Nothing on these screens changes a file, a key or Kiro's configuration: commands are copied
// by the user and run in their own terminal. Written fresh for this repository.

import { badge, h, icon, stateBox } from './ui.js'

// GitHub links are shown because the repository was confirmed public (GitHub API visibility
// "public", 2026-11-19). Set to null to hide every GitHub link and keep the paths only.
export const PUBLIC_REPO = 'https://github.com/justrunme/justrunme-zero'

function copyButton(value, label = 'Copy') {
  const b = h('button', { type: 'button', class: 'copy-btn', 'aria-label': `${label}: ${value.split('\n')[0]}` }, icon('copy'), ` ${label}`)
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value)
      b.replaceChildren(icon('check'), ' Copied')
    } catch {
      b.replaceChildren(icon('cross'), ' Select the text instead')
    }
  })
  return b
}

/** A command or file body with a Copy button; shown as text, never parsed as HTML. */
function codeBlock(text, { title = null } = {}) {
  return h('div', { class: 'cmd' },
    h('div', { class: 'cmd-bar' }, h('span', { class: 'muted mono', text: title ?? 'shell' }), h('span', { class: 'spacer' }), copyButton(text)),
    h('pre', { class: 'mono' }, h('code', { text })))
}

function pathRow(p, kind = 'tree') {
  return h('span', { class: 'path-row' }, h('code', { class: 'mono', text: p }), copyButton(p, 'Copy path'),
    PUBLIC_REPO ? h('a', { class: 'home-link', href: `${PUBLIC_REPO}/${kind}/main/${p.replace(/\/$/, '')}`, target: '_blank', rel: 'noreferrer noopener', text: 'View on GitHub →' }) : null)
}

// ---- Built with Kiro --------------------------------------------------------------------------

export const KIRO_PARTS = [
  { title: 'Kiro Specs', path: '.kiro/specs/justrunme-zero/', kind: 'tree', text: 'Requirements, design and the task list the Kiro sessions worked from (requirements.md, design.md, tasks.md).' },
  { title: 'PreToolUse Hook', path: '.kiro/hooks/pretooluse.json', kind: 'blob', text: 'Kiro runs `node src/hook/pretooluse.js` before every tool call. With JUSTRUNME_GATE=on it allows or blocks the call against the mission contract and a signed authorization; exit 2 blocks.' },
  { title: 'MCP Integration', path: 'src/mcp/', kind: 'tree', text: 'The tools the Kiro agent calls: rehearse, get_impact_report, compare, request_approval, run_mission, get_receipt, undo_mission, verify_recovery, replay_mission. No tool can approve.' },
  { title: 'Development Evidence', path: 'docs/KIRO_LOG.md', kind: 'blob', text: 'The log of the Kiro sessions that wrote this repository, including the live Kiro CLI runs and what they showed.' },
]

export function builtWithKiro() {
  return h('section', { class: 'home-section kiro' },
    h('div', { class: 'row' }, h('h2', { text: 'Built with Kiro' }), h('span', { class: 'spacer' })),
    h('p', { class: 'kiro-lead', text: 'Built with Kiro. Verified by JustRunMe.' }),
    h('div', { class: 'kcards' }, KIRO_PARTS.map((k) => h('article', { class: 'kcard' }, h('h3', { text: k.title }), h('p', { class: 'muted', text: k.text }), pathRow(k.path, k.kind)))),
    h('div', { class: 'note' },
      h('strong', { text: 'Live and recorded, kept apart. ' }),
      'Live Kiro runs: one recorded operator run with Kiro CLI 3.4.0 and JUSTRUNME_GATE=on (docs/agent-runs/2026-11-18-run1.md) and the T25 experiment runs (docs/agent-runs/). The plans of the recorded demo mission were replayed from T25 v3 run T3 through the MCP tools by a script; no live agent wrote them during the recording.'))
}

// ---- Architecture -----------------------------------------------------------------------------

/** Six stages; `example` is a route of the recorded run (opened with the recorded source). */
export const STAGES = [
  { id: 'agent', label: 'Agent', what: 'A Kiro agent proposes a change as a SQL migration file inside the mission contract\'s allowed paths.', checks: 'The PreToolUse hook (gate on) allows or blocks each tool call against the contract; it does not rehearse anything.', artifact: 'A signed hook_decision receipt for every allowed or blocked call while a valid contract exists.', example: ['missions/mission-t25v2-a/proposed', 'The first plan of the recorded mission'] },
  { id: 'rehearse', label: 'Rehearse', what: 'The agent calls the MCP tool rehearse. JustRunMe runs the plan on a disposable copy of the database on an internal Docker network.', checks: 'That every network of the copy is internal before real data is loaded; the plan runs only there.', artifact: 'A signed rehearsal report and a rehearsal receipt; the SQL is archived by content hash.', example: ['missions/mission-t25v2-a/rehearsed', 'The rehearsal that lost one order'] },
  { id: 'measure', label: 'Measure', what: 'Row counts of the protected tables, the schema and the database logic (triggers, functions, rules) are compared before and after.', checks: 'Protected rows lost, tables or columns removed, logic removed, changed or switched off.', artifact: 'The verdict in the report: SAFE, DATA LOSS, LOGIC BYPASS, LOGIC CHANGE or FAILED, with the evidence (for example which trigger fired).', example: ['impact', 'DATA LOSS against SAFE, side by side'] },
  { id: 'approve', label: 'Approve', what: 'For a SAFE plan the agent asks with request_approval. A person reads the exact SQL and the measured impact and approves with the approver key.', checks: 'The request is pending and unexpired, the report is SAFE and signed, the files are unchanged since the request.', artifact: 'A single-use authorization signed by the approver key, bound to the plan, the files and the source fingerprint.', example: ['approvals', 'The approved request of the recorded mission'] },
  { id: 'execute', label: 'Execute', what: 'The agent calls run_mission. The real run starts only with a valid authorization for exactly this plan.', checks: 'The source fingerprint (git, row counts, schema, logic, image digests) still equals the rehearsed one; state is captured for undo first.', artifact: 'A run_result receipt with the measured outcome, and the capture id for undo.', example: ['missions/mission-t25v2-a/executed', 'The run of the approved plan'] },
  { id: 'verify', label: 'Verify', what: 'The real result is compared with the rehearsal; justrunme verify re-checks every signature, the order of the receipts and the plan history.', checks: 'Schema hash, row counts and checksums against the rehearsal; every receipt signature and hash link.', artifact: 'A verifiable receipt chain; after an undo, a verification receipt (it compares supported database grants and ownership for captures that recorded them).', example: ['missions/mission-t25v2-a/verified', 'The run whose result equals the rehearsal'] },
]

export function architecture(ui, open) {
  const detail = h('div', { class: 'arch-detail', 'aria-live': 'polite' })
  const buttons = []
  const show = (st) => {
    ui.archStage = st.id
    for (const [id, b] of buttons) b.setAttribute('aria-pressed', id === st.id ? 'true' : 'false')
    const link = open ? h('a', { class: 'home-link', href: `#/${st.example[0]}`, text: `${st.example[1]} →` }) : h('span', { class: 'muted', text: 'needs the verified recorded run' })
    if (open) link.addEventListener('click', (e) => {
      e.preventDefault?.()
      open(st.example[0])
    })
    detail.replaceChildren(
      h('div', { class: 'arch-grid' },
        h('div', {}, h('div', { class: 'k', text: 'What happens' }), h('p', { text: st.what })),
        h('div', {}, h('div', { class: 'k', text: 'What is checked' }), h('p', { text: st.checks })),
        h('div', {}, h('div', { class: 'k', text: 'Evidence produced' }), h('p', { text: st.artifact }))),
      h('div', { class: 'row' }, h('span', { class: 'muted', text: 'A genuine example in the recorded run:' }), link))
  }
  const strip = h('ol', { class: 'arch-strip' })
  STAGES.forEach((st, i) => {
    const b = h('button', { type: 'button', class: 'arch-step', 'aria-pressed': 'false' }, h('span', { class: 'arch-n', text: String(i + 1) }), h('span', { text: st.label }))
    b.addEventListener('click', () => show(st))
    buttons.push([st.id, b])
    strip.append(h('li', {}, b))
  })
  const box = h('section', { class: 'home-section arch' },
    h('div', { class: 'row' }, h('h2', { text: 'How JustRunMe works' }), h('span', { class: 'spacer' })),
    strip,
    h('p', { class: 'muted arch-hook' }, icon('shield'), ' The PreToolUse hook sits under every stage: it allows or blocks each Kiro tool call against the contract and a signed authorization. It does not rehearse a call by itself; rehearsal happens when the agent calls rehearse.'),
    detail)
  show(STAGES.find((s) => s.id === ui.archStage) ?? STAGES[0])
  return box
}

// ---- Setup -------------------------------------------------------------------------------------

const HOOK_JSON = `{
  "version": "v1",
  "hooks": [
    {
      "name": "JustRunMe gate",
      "trigger": "PreToolUse",
      "description": "Default-deny gate. Inactive unless JUSTRUNME_GATE=on. Exit 2 blocks the tool call.",
      "action": {
        "type": "command",
        "command": "node src/hook/pretooluse.js",
        "timeout": 20
      }
    }
  ]
}`

const CONTRACT_YAML = `id: my-first-mission
objective: Apply one migration to the demo database
allowed_paths: [demo/migrations/]
protected_tables: [orders, patches]
time_limit_seconds: 300
irreversible_actions: []
plan:
  - { id: migrate, tool: sql_migration, args: [demo/migrations/003.sql], reversibility: true }
resources: { databases: [pumpkin_patch], config_files: [], compose_services: [db] }`

const TARGET_JSON = `{ "project": "jrm-demo", "compose_file": "demo/docker-compose.yml", "db_service": "db", "db_user": "demo_user", "db_name": "pumpkin_patch" }`

const BLOCK_TEST = `echo '{"hook_event_name":"PreToolUse","cwd":".","tool_name":"execute_bash","tool_input":{"command":"rm -rf demo"}}' \\
  | JUSTRUNME_GATE=on node src/hook/pretooluse.js; echo "exit $?"`

const STEPS = [
  {
    id: 'install', title: 'Get JustRunMe', body: 'Node.js 24 or newer. There is no packaged install yet: the hook runs `node src/hook/pretooluse.js` relative to the workspace, so Kiro opens a workspace that contains this repository.',
    code: [['git clone https://github.com/justrunme/justrunme-zero\ncd justrunme-zero\nnpm install', 'shell']],
    status: (s) => (s ? [s.node.ok ? 'ok' : 'bad', `Node ${s.node.version} runs this Console`] : null),
  },
  {
    id: 'hook', title: 'Kiro PreToolUse hook', body: 'The repository ships the hook file. Kiro reads hooks from .kiro/hooks/ of the workspace. Installed is not the same as on: the hook does nothing until the gate is enabled (step 4).',
    code: [[HOOK_JSON, '.kiro/hooks/pretooluse.json']],
    status: (s) => (s ? [s.hook.installed ? 'ok' : 'warn', s.hook.installed ? `Hook installed: ${s.hook.files.map((f) => f.file).join(', ')}` : s.hook.script ? 'No PreToolUse hook file runs src/hook/pretooluse.js' : 'src/hook/pretooluse.js is not in this workspace'] : null),
  },
  {
    id: 'keys', title: 'Operator and approver keys', body: 'Once. Keys live in JUSTRUNME_HOME (default ~/.justrunme). The operator key signs receipts; the approver key is sealed with a passphrase and signs authorizations only. Do not export JUSTRUNME_APPROVER_PASSPHRASE in the shell Kiro starts from.',
    code: [['node src/cli/index.js keys init\nnode src/cli/index.js approver init', 'shell']],
    status: (s) => (s ? [s.keys.operator && s.keys.approver ? 'ok' : 'warn', `operator public key ${s.keys.operator ? 'found' : 'missing'} · approver public key ${s.keys.approver ? 'found' : 'missing'} (in the key directory of this Console${s.keys.home_from_env ? ', from JUSTRUNME_HOME' : ''})`] : null),
  },
  {
    id: 'gate', title: 'Enable the gate for a new Kiro session', body: 'The gate is on only when the exact value JUSTRUNME_GATE=on is in the environment Kiro starts with. An agent cannot change it for the hook; an operator who forgets it gets no protection. The Console cannot see the environment of a Kiro session, so it never shows this step as done.',
    code: [['JUSTRUNME_GATE=on kiro-cli chat', 'shell']],
    status: (s) => (s ? ['mute', 'Unknown from the Console: the gate lives in the Kiro session\'s environment'] : null),
  },
  {
    id: 'contract', title: 'Mission contract', body: 'justrunme.mission.yaml says what the mission may touch; justrunme.target.json names the Compose project of the database. Both sit in the workspace root; the hook protects them. Unknown keys are rejected.',
    code: [[CONTRACT_YAML, 'justrunme.mission.yaml'], [TARGET_JSON, 'justrunme.target.json'], ['node src/cli/index.js status', 'shell']],
    status: (s) => (s ? [s.contract.valid && s.target ? 'ok' : s.contract.present ? 'bad' : 'warn', s.contract.valid ? `Contract valid: mission ${s.contract.mission_id}${s.target ? '' : ' · justrunme.target.json missing'}` : s.contract.present ? `Contract invalid: ${s.contract.errors.join('; ')}` : 'No justrunme.mission.yaml in this workspace'] : null),
  },
  {
    id: 'check', title: 'Check that the hook really blocks', body: 'From the workspace root, with an operator key installed. Expect exit 2 and a JSON line with "justrunme":"deny". With a valid contract the denial is also a signed hook_decision receipt. This line is taken from test/hook.test.js.',
    code: [[BLOCK_TEST, 'shell']],
    status: (s) => (s ? s.evidence.checked
      ? [s.evidence.chain_ok && s.evidence.hook_decisions > 0 ? 'info' : 'mute', s.evidence.chain_ok ? `${s.evidence.hook_decisions} signed hook decision${s.evidence.hook_decisions === 1 ? '' : 's'} in the chain of ${s.contract.mission_id}` : `The chain of ${s.contract.mission_id} does not verify: ${s.evidence.problem}`]
      : ['mute', 'Needs a valid contract and an operator key first'] : null),
  },
  {
    id: 'start', title: 'Start a protected Kiro workflow', body: 'The operator agent in .kiro/agents/justrunme-operator.json declares the JustRunMe MCP server and has no shell tool. Give it the database change you want: it rehearses, revises after a denial and asks for approval. You approve in the Approval Center or with `justrunme approve`. The recorded runs used this command with --trust-all-tools.',
    code: [['JUSTRUNME_GATE=on kiro-cli chat --v3 --agent justrunme-operator --trust-workspace --require-mcp-startup', 'shell'], ['node src/cli/index.js console', 'shell']],
    status: (s) => (s ? [s.operator_agent ? 'ok' : 'warn', s.operator_agent ? 'Operator agent found in this workspace' : '.kiro/agents/justrunme-operator.json is not in this workspace'] : null),
  },
]

const STATE_TEXT = {
  hook_installed: { yes: ['Installed', 'ok'], no: ['Not installed', 'warn'] },
  gate_enabled: { unknown: ['Not visible from the Console', 'mute'] },
  mission_protected: { seen: ['Hook decisions seen', 'info'], not_verified: ['Not verified', 'mute'] },
}

function threeStates(s) {
  const tile = (name, key, why) => {
    const [label, tone] = s ? STATE_TEXT[key][s.states[key]] : ['Not inspected', 'mute']
    return h('div', { class: `st3 ${tone}` }, h('div', { class: 'st3-name', text: name }), badge(label, tone), h('p', { class: 'muted', text: why }))
  }
  const ne = () => h('div', { class: 'st3-ne', 'aria-hidden': 'true', text: '≠' })
  return h('div', { class: 'st3-row', role: 'group', 'aria-label': 'Three different states' },
    tile('Hook installed', 'hook_installed', 'A hook file runs the JustRunMe gate before each tool call.'), ne(),
    tile('Gate enabled', 'gate_enabled', 'JUSTRUNME_GATE=on is set for the Kiro session. Only that session\'s environment knows.'), ne(),
    tile('Mission protected', 'mission_protected', s?.evidence?.hook_decisions > 0 && s.evidence.chain_ok
      ? `The chain of ${s.contract.mission_id} verifies and holds ${s.evidence.hook_decisions} signed hook decisions. That shows the gate was on when they were written, not that it is on now.`
      : 'Shown only from a verified chain with signed hook decisions. Never shown as PROTECTED.'))
}

export function setupScreen(ctx) {
  const S = ctx.setup
  const inspect = S?.mode === 'live' && S.status?.ok
  const status = inspect ? S.status : null
  const intro = h('div', { class: 'setup-head' },
    h('div', { class: 'eyebrow', text: 'GET STARTED WITH KIRO' }),
    h('h1', { text: 'Put JustRunMe in front of your Kiro agent' }),
    h('p', { class: 'hero-p', text: 'Seven steps. You copy each command and run it in your own terminal; this page changes nothing on your machine.' }))
  const scope = !S || S.loading
    ? h('div', { class: 'note' }, h('span', { class: 'muted working', text: 'Reading this Console\'s workspace' }))
    : S.mode === 'live'
    ? (S.status?.ok
      ? h('div', { class: 'note' }, h('strong', { text: 'Read-only checks of this Console\'s workspace. ' }), 'They read files and the receipt chain; they cannot see your Kiro session.')
      : stateBox('error', 'The setup checks could not be read', S.error ?? 'unknown error'))
    : h('div', { class: 'note' }, h('strong', { text: 'Informational. ' }), 'This Console has no workspace of its own (it shows the recorded run), so it does not inspect or control your Kiro installation.')
  const steps = h('ol', { class: 'setup-steps' }, STEPS.map((st, i) => {
    const s = st.status(status)
    return h('li', { class: 'setup-step' },
      h('div', { class: 'ss-n', text: String(i + 1) }),
      h('div', { class: 'ss-body' },
        h('div', { class: 'row' }, h('h3', { text: st.title }), h('span', { class: 'spacer' }), s ? badge(s[1], s[0], s[0] === 'ok' ? 'check' : s[0] === 'bad' ? 'cross' : s[0] === 'warn' ? 'alert' : 'dash') : null),
        h('p', { class: 'muted', text: st.body }),
        st.code.map(([code, title]) => codeBlock(code, { title }))))
  }))
  return h('div', { class: 'setup reveal' }, intro, threeStates(status), scope, steps)
}
