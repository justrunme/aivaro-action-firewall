# Chaos Twin — recorded recovery evidence (20 November 2026)

This is a **recorded**, single-mission run, not a live execution or a reproduction script. The `mission-chaos-live` receipt timestamp is `2026-11-20T15:31:41.872Z`. The original run's exact repository commit was **not recorded**, so do not attribute these results to a particular SHA.

## Files

- `chaos.json` — CLI result: injected database-container **SIGKILL after step 2**, undo **RECOVERED**, verdict **RECOVERY PROVEN**, 21 recovery checks with **0 failures**, and `cleanup.clean=true` (0 leftover containers, networks and volumes).
- `verify.json` — original CLI `verify` result: **one** signed receipt, `ok=true`, no chain or policy findings. This is an archived result, not a verification of the copied files.
- `receipts.jsonl` — the original, unmodified, canonical, Ed25519-signed recovery-rehearsal receipt. One receipt only; this is not a full production mission history.
- `keys.json` — original CLI `keys init` response with **public** key hex only; no private key.
- `operator.pub` — original **public** Ed25519 verification key (PEM).
- `head-anchor.json` — original **signed** head anchor, preserved verbatim (its original on-disk filename encoded the original workspace path hash). No private key is included.

## Verify the published copy (Node.js 24+, repository root)

This **one shell command** checks the copied canonical receipt, Ed25519 signature, genesis link, public key, and separately signed head anchor using JustRunMe's existing `canonicalJson`, `genesisHash`, `receiptHash`, `publicKeyHex` and `verifyValue` helpers. It needs **no private key**, Docker, or original machine paths:

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs'
import { createPublicKey } from 'node:crypto'
import { canonicalJson } from './src/util/canonical.js'
import { genesisHash, receiptHash } from './src/receipts/chain.js'
import { publicKeyHex, verifyValue } from './src/receipts/keys.js'
const dir = 'docs/evidence/chaos-live-2026-11-20/'
const pub = createPublicKey(readFileSync(dir + 'operator.pub'))
const raw = readFileSync(dir + 'receipts.jsonl', 'utf8')
const lines = raw.trimEnd().split('\n')
const receipts = lines.map(JSON.parse)
const head = JSON.parse(readFileSync(dir + 'head-anchor.json', 'utf8'))
const fail = (reason) => { throw Error('INVALID: ' + reason) }
let prev = genesisHash('mission-chaos-live')
for (let i = 0; i < receipts.length; i++) {
  const r = receipts[i]
  const { signature, ...body } = r
  if (lines[i] !== canonicalJson(r)) fail('noncanonical receipt')
  if (r.version !== 1 || r.seq !== i || r.mission_id !== 'mission-chaos-live') fail('receipt metadata')
  if (r.prev_hash !== prev || r.operator_pubkey !== publicKeyHex(pub)) fail('broken link/key')
  if (!verifyValue(pub, body, signature)) fail('receipt signature')
  prev = receiptHash(r)
}
const { signature, ...anchorBody } = head
if (!verifyValue(pub, anchorBody, signature)) fail('anchor signature')
if (head.mission_id !== 'mission-chaos-live' || head.seq !== receipts.length - 1 || head.hash !== prev) fail('anchored head')
console.log(`PASS: ${receipts.length} receipt(s), signatures, genesis link and signed head anchor`)
JS
```

The original full CLI check also succeeded, with its original workspace and operator-key directory still on the Mac:

```sh
JUSTRUNME_HOME=/tmp/jrm-chaos-live-keys-Se2x9g node src/cli/index.js verify --repo /tmp/jrm-chaos-live-ws-DbqFmI --mission mission-chaos-live
```

Original result: `ok=true`, `receipts=1`, empty `chain_findings` and `policy_findings`, exit **0**. **That command is historical and Mac-specific; do not expect those `/tmp` paths to exist on another machine.** Running `verify` directly against a newly copied receipt alone returned exit **3**, `NO_OPERATOR_KEY`: the full CLI expects the operator key home and a head anchor indexed by the original workspace's path. The portable verification above checks the original signed anchor and public key **without changing either**, but is not the full CLI policy/history check.

## Limits

The steps executed with the operator OS user's rights: **Chaos Twin is not a sandbox for untrusted shell**. The twin tested the database, not external effects; the health check was **not configured**. The 21 checks cover only the captured resources and recorded checks. A valid signature proves consistency with the included public key, **not independent identity attestation**, nor that the underlying database actions occurred. The public repo does not include the original private key, original workspace, database image, or Docker execution environment. The copied evidence is intended for inspection, not to rerun a production workflow.
