// Stands in for src/cli/index.js in test/console.test.js: reports what it was given
// (argv, stdin, whether the passphrase variable reached its environment).

import { createHash } from 'node:crypto'

const chunks = []
for await (const c of process.stdin) chunks.push(c)
const argv = process.argv.slice(2)
process.stdout.write(JSON.stringify({
  command: argv[0],
  ok: true,
  exit_code: 0,
  // stdin as a hash: the Console scrubs the passphrase from anything a child prints.
  result: { argv, stdin_sha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), stdin_bytes: Buffer.concat(chunks).length, env_has_passphrase: 'JUSTRUNME_APPROVER_PASSPHRASE' in process.env, env_has_home: 'JUSTRUNME_HOME' in process.env },
}) + '\n')
