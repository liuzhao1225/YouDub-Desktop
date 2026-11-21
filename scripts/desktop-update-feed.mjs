/** Electron-updater metadata for the exact immutable artifacts published in one GitHub Release. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_URL = 'https://github.com/liuzhao1225/YouDub-Desktop'
export const desktopUpdateURL = `${REPO_URL}/releases/latest/download/`
export const desktopUpdateConfig = { provider: 'generic', url: desktopUpdateURL, updaterCacheDirName: 'youdub-updater' }
const platforms = { darwin: ['macOS-arm64.zip', 'latest-mac.yml'], win32: ['windows-x64-Setup.exe', 'latest.yml'] }

export async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

function resolveFeedTarget(directory, version, platform) {
  const [suffix, channel] = platforms[platform]
  const file = `YouDub-${version}-${suffix}`
  return {
    channel,
    artifact: join(directory, file),
    feedPath: join(directory, channel),
    url: `${REPO_URL}/releases/download/v${version}/${file}`,
  }
}

export async function writeUpdateFeed(directory, version, platform) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !platforms[platform]) throw new Error('Invalid desktop update version or platform')
  const { artifact, feedPath, url } = resolveFeedTarget(directory, version, platform)
  const sha512 = await hashFile(artifact, 'sha512', 'base64')
  const size = (await stat(artifact)).size
  // JSON is a YAML subset; no serializer-dependent escaping of release asset URLs.
  const metadata = { version, files: [{ url, sha512, size }], path: url, sha512 }
  await writeFile(feedPath, JSON.stringify(metadata, null, 2) + '\n')
  for (const path of [artifact, feedPath]) await writeFile(path + '.sha256', `${await hashFile(path, 'sha256', 'hex')}  ${basename(path)}\n`)
  await verifyUpdateFeed(directory, version, platform, { sha512, size })
}

export async function verifyUpdateFeed(directory, version, platform, expected) {
  const { channel, artifact, feedPath, url } = resolveFeedTarget(directory, version, platform)
  const metadata = JSON.parse(await readFile(feedPath, 'utf8'))
  const sha512 = expected?.sha512 ?? await hashFile(artifact, 'sha512', 'base64')
  const size = expected?.size ?? (await stat(artifact)).size
  if (metadata.version !== version || metadata.files?.length !== 1 || metadata.files[0].url !== url
    || metadata.path !== url || metadata.sha512 !== sha512 || metadata.files[0].sha512 !== sha512
    || metadata.files[0].size !== size) throw new Error(`Invalid ${channel}: artifact/version/hash mismatch`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, directory, version, platform] = process.argv.slice(2)
  if (!['write', 'verify'].includes(operation)) throw new Error('Usage: desktop-update-feed.mjs write|verify <directory> <version> darwin|win32')
  await (operation === 'write' ? writeUpdateFeed : verifyUpdateFeed)(directory, version, platform)
}
