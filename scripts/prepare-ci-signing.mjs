import { mkdir, writeFile, link } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const allowedRepos = new Set(['liuzhao1225/YouDub-Desktop', 'liuzhao1225/YouDub-webui'])
if (process.env.GITHUB_ACTIONS !== 'true' || !allowedRepos.has(process.env.GITHUB_REPOSITORY || '') || process.env.GITHUB_REF_TYPE !== 'tag') {
  throw new Error('CI signing material is restricted to this repository tag workflow.')
}
const directory = resolve(process.env.YOUDUB_APPLE_CREDENTIALS_DIR || '')
if (directory !== join(process.env.RUNNER_TEMP, 'apple-signing')) throw new Error('Signing material must use the runner temporary directory.')
process.umask(0o077)
await mkdir(directory, { recursive: false, mode: 0o700 })
const required = name => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing signing secret: ${name}`)
  return value
}
for (const [name, file] of [['APPLE_CERTIFICATE_BASE64', 'certificate.p12'], ['APPLE_API_KEY_BASE64', 'AuthKey.p8']]) {
  await writeFile(join(directory, file), Buffer.from(required(name), 'base64'), { mode: 0o600 })
}
const values = {
  BUILD_CERTIFICATE_FILE: 'certificate.p12', APP_STORE_CONNECT_API_KEY_FILE: 'AuthKey.p8',
  ...Object.fromEntries(['P12_PASSWORD', 'CODESIGN_IDENTITY', 'APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID'].map(name => [name, required(name)])),
}
await writeFile(join(directory, '.env'), Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
await link(join(directory, '.env'), join(directory, 'env.txt'))
console.log('Temporary signing material prepared.')
