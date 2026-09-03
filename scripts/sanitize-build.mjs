import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url))
const workerDevVars = join(distRoot, 'kaiwa_demo', '.dev.vars')
await rm(workerDevVars, { force: true })

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? collectFiles(path) : [path]
    }),
  )
  return nested.flat()
}

const outputFiles = await collectFiles(distRoot)
const leakedDevVars = outputFiles.filter((path) => path.split('/').at(-1)?.startsWith('.dev.vars'))
if (leakedDevVars.length > 0) {
  throw new Error(`Development variables remained in build output: ${leakedDevVars.join(', ')}`)
}

const clientDirectory = join(distRoot, 'client')
const clientFiles = await collectFiles(clientDirectory)
const forbiddenClientPatterns = [
  /OPENAI_API_KEY/,
  /ELEVENLABS_API_KEY/,
  /sk-[A-Za-z0-9_-]{12,}/,
  /sutkn_[A-Za-z0-9_-]{12,}/,
]

for (const path of clientFiles) {
  const contents = await readFile(path)
  const text = contents.toString('utf8')
  const matched = forbiddenClientPatterns.find((pattern) => pattern.test(text))
  if (matched) throw new Error(`Forbidden secret material matched ${matched} in client artifact ${path}`)
}
