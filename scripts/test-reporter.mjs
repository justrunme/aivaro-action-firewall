// A node:test reporter that counts results and prints one JSON line at the end.
// Used by scripts/test-report.mjs; it writes nothing else. Suites are not counted:
// the number is the number of tests, the same one the default reporter prints.
//
// Written fresh for this repository.

export default async function* reporter(source) {
  let passed = 0
  let failed = 0
  let skipped = 0
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    if (event.data.details?.type === 'suite') continue
    if (event.type === 'test:fail') failed += 1
    else if (event.data.skip !== undefined && event.data.skip !== false) skipped += 1
    else if (event.data.todo !== undefined && event.data.todo !== false) skipped += 1
    else passed += 1
  }
  yield JSON.stringify({ passed, failed, skipped, total: passed + failed + skipped }) + '\n'
}
