import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', line => {
  if (process.argv[2] === 'exit') process.exit(1)
  if (process.argv[2] === 'malformed') process.stdout.write('not-json\n')
  if (process.argv[2] === 'pid') process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, result: { pid: process.pid } }) + '\n')
  if (process.argv[2] === 'framing') {
    // A blank line, then a CR whose LF arrives in a later write, before the real response.
    process.stdout.write('\n\r')
    setTimeout(() => process.stdout.write('\n' + JSON.stringify({ id: JSON.parse(line).id, result: { protocolVersion: 1 } }) + '\r\n'), 150)
  }
})
