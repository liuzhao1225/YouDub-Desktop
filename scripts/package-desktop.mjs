/** Package the YouDub Electron desktop application using electron-builder. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { appVersion } from './release-version.mjs'
import { desktopUpdateConfig, writeUpdateFeed } from './desktop-update-feed.mjs'

const root = resolve(import.meta.dirname, '..')
const desktopDir = join(root, 'apps/desktop')
const output = join(root, 'dist')
const cacheDir = join(root, '.cache/package')

const desktopPkg = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8'))
if (desktopPkg.version !== appVersion) {
  throw new Error(`apps/desktop/package.json version (${desktopPkg.version}) differs from root version (${appVersion})`)
}

const desktopRequire = createRequire(join(desktopDir, 'package.json'))
const { build, Platform, Arch } = desktopRequire('electron-builder')

async function generateWindowsIco() {
  const sharp = createRequire(join(root, 'apps/web/package.json'))('sharp')
  const sizes = [16, 32, 48, 64, 128, 256]
  const images = await Promise.all(
    sizes.map((size) => sharp(join(desktopDir, 'icon.svg')).resize(size, size).png().toBuffer()),
  )
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  for (const [index, png] of images.entries()) {
    const at = 6 + index * 16
    const size = sizes[index]
    header[at] = header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  }
  const winCache = join(root, '.cache/windows')
  await mkdir(winCache, { recursive: true })
  const icoPath = join(winCache, 'YouDub.ico')
  await writeFile(icoPath, Buffer.concat([header, ...images]))
  return icoPath
}

async function downloadVerified(urls, dest, expectedSha256) {
  let lastErr
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (expectedSha256) {
        const digest = createHash('sha256').update(buf).digest('hex')
        if (digest !== expectedSha256) {
          throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${digest}`)
        }
      }
      await writeFile(dest, buf)
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('Download failed')
}

function findFileRecursive(dir, targetName) {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const hit = findFileRecursive(full, targetName)
      if (hit) return hit
    } else if (entry.isFile() && entry.name === targetName) {
      return full
    }
  }
  return null
}

function extractTarGz(archivePath, destDir) {
  const tarBin =
    process.platform === 'win32' &&
    existsSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'))
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  execFileSync(
    tarBin,
    [
      '-xzf',
      relative(cacheDir, archivePath).replace(/\\/g, '/'),
      '--strip-components=1',
      '-C',
      relative(cacheDir, destDir).replace(/\\/g, '/'),
    ],
    { cwd: cacheDir, stdio: 'inherit' },
  )
}

async function prepareBundledRuntime() {
  const manifest = JSON.parse(await readFile(join(root, 'backend/app/manifests/setup-runtime.json'), 'utf8'))
  const platformKey =
    process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
      : process.platform === 'win32'
        ? 'win32-x64'
        : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const win = process.platform === 'win32'
  const uvExe = win ? 'uv.exe' : 'uv'
  const stagedUvDir = join(cacheDir, 'uv-runtime')
  const stagedUvBin = join(stagedUvDir, uvExe)
  const appSupportDir = win
    ? join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'YouDub')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support/YouDub')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'youdub')

  await mkdir(stagedUvDir, { recursive: true })
  if (!existsSync(stagedUvBin)) {
    const localUv =
      (process.env.YOUDUB_UV_BIN && existsSync(process.env.YOUDUB_UV_BIN) ? process.env.YOUDUB_UV_BIN : null) ||
      findFileRecursive(join(appSupportDir, 'runtime/uv'), uvExe)
    if (localUv) {
      await copyFile(localUv, stagedUvBin)
    } else {
      const pathUv = spawnSync(win ? 'where' : 'which', ['uv'], { encoding: 'utf8' })
      const resolvedPathUv = pathUv.status === 0 ? pathUv.stdout.trim().split(/\r?\n/)[0] : ''
      if (resolvedPathUv && existsSync(resolvedPathUv)) {
        await copyFile(resolvedPathUv, stagedUvBin)
      } else {
        const uvVer = manifest.uv?.version || '0.13.0'
        const targetMap = {
          'darwin-arm64': 'aarch64-apple-darwin',
          'darwin-x64': 'x86_64-apple-darwin',
          'win32-x64': 'x86_64-pc-windows-msvc',
          'linux-arm64': 'aarch64-unknown-linux-gnu',
          'linux-x64': 'x86_64-unknown-linux-gnu',
        }
        const triple = targetMap[platformKey]
        const ext = win ? 'zip' : 'tar.gz'
        const archive = join(cacheDir, `uv-${triple}.${ext}`)
        await downloadVerified(
          [`https://github.com/astral-sh/uv/releases/download/${uvVer}/uv-${triple}.${ext}`],
          archive,
        )
        if (win) {
          execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${stagedUvDir}' -Force`], { stdio: 'inherit' })
          const extracted = findFileRecursive(stagedUvDir, uvExe)
          if (extracted && extracted !== stagedUvBin) await copyFile(extracted, stagedUvBin)
        } else {
          extractTarGz(archive, stagedUvDir)
        }
      }
    }
    if (!win) await chmod(stagedUvBin, 0o755)
  }

  const stagedPythonDir = join(cacheDir, 'python-runtime')
  const stagedPythonBin = join(stagedPythonDir, win ? 'python.exe' : 'bin/python3')
  const hasWorkingPython = () => {
    if (!existsSync(stagedPythonBin)) return false
    const check = spawnSync(stagedPythonBin, ['-c', 'import fastapi, uvicorn, httpx, pydantic, multipart, sentencex, PIL'], {
      stdio: 'ignore',
    })
    return check.status === 0
  }

  if (!hasWorkingPython()) {
    rmSync(stagedPythonDir, { recursive: true, force: true })
    await mkdir(stagedPythonDir, { recursive: true })
    const localPyRoot = join(appSupportDir, 'runtime/python')
    let copiedLocal = false
    if (existsSync(localPyRoot)) {
      for (const entry of readdirSync(localPyRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('cpython-')) {
          const candidateDir = join(localPyRoot, entry.name)
          const candidateBin = join(candidateDir, win ? 'python.exe' : 'bin/python3')
          if (existsSync(join(candidateDir, 'BUILD')) && existsSync(candidateBin)) {
            if (win) {
              cpSync(candidateDir, stagedPythonDir, { recursive: true, dereference: true })
            } else {
              execFileSync('cp', ['-a', `${candidateDir}/.`, stagedPythonDir], { stdio: 'inherit' })
            }
            copiedLocal = true
            break
          }
        }
      }
    }
    if (!copiedLocal) {
      const pySpec = manifest.python?.[platformKey]
      if (!pySpec) throw new Error(`No standalone Python manifest entry for ${platformKey}`)
      const archive = join(cacheDir, pySpec.path)
      await downloadVerified([pySpec.url, ...(pySpec.mirrors || [])], archive, pySpec.sha256)
      extractTarGz(archive, stagedPythonDir)
    }
    if (!win) execFileSync('chmod', ['-R', 'u+rwX,go+rX', stagedPythonDir], { stdio: 'inherit' })

    const reqBase = join(root, 'backend/requirements/base.txt')
    const pipArgs = ['pip', 'install', '--python', stagedPythonBin, '--system', '--break-system-packages', '-r', reqBase]
    let installed = spawnSync(stagedUvBin, pipArgs, { cwd: root, stdio: 'inherit' })
    if (installed.status !== 0) {
      installed = spawnSync(
        stagedUvBin,
        [...pipArgs, '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
        { cwd: root, stdio: 'inherit' },
      )
    }
    if (installed.status !== 0) throw new Error('Failed to install base Python dependencies into bundled runtime')
    execFileSync(stagedPythonBin, ['-c', 'import fastapi, uvicorn, httpx, pydantic, multipart, sentencex, PIL'], {
      stdio: 'inherit',
    })
  }

  return { stagedPythonDir, stagedUvDir }
}

if (process.argv.includes('--installers-only')) {
  if (process.platform !== 'win32') {
    throw new Error('macOS distribution uses the signed and notarized release step.')
  }
  const builderConfig = JSON.parse(await readFile(join(cacheDir, 'builder.json'), 'utf8'))
  await build({
    projectDir: desktopDir,
    prepackaged: join(output, 'win-unpacked'),
    targets: Platform.WINDOWS.createTarget(['zip'], Arch.x64),
    config: builderConfig,
  })
  await generateWindowsIco()
  const compiler =
    process.env.YOUDUB_ISCC ||
    join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Inno Setup 6/ISCC.exe')
  await access(compiler)
  execFileSync(
    compiler,
    [`/DAppVersion=${appVersion}`, `/DRepoRoot=${root}`, join(desktopDir, 'windows/installer.iss')],
    { stdio: 'inherit' },
  )
  await writeUpdateFeed(output, appVersion, 'win32')
} else {
  if (!process.argv.includes('--skip-build')) {
    const win = process.platform === 'win32'
    const npmCmd = win ? 'npm.cmd' : 'npm'
    for (const args of [
      ['--prefix', 'apps/web', 'run', 'build'],
      ['--prefix', 'apps/desktop', 'run', 'build'],
    ]) {
      const res = spawnSync(npmCmd, args, { cwd: root, stdio: 'inherit', shell: win })
      if (res.status !== 0) process.exit(res.status ?? 1)
    }
  }

  for (const required of [
    join(root, 'apps/web/dist/index.html'),
    join(desktopDir, 'dist/main.js'),
    join(desktopDir, 'dist/preload.cjs'),
  ]) {
    if (!existsSync(required)) {
      throw new Error(`Required build output missing: ${required}`)
    }
  }

  await mkdir(cacheDir, { recursive: true })
  const { stagedPythonDir, stagedUvDir } = await prepareBundledRuntime()
  const sharp = createRequire(join(root, 'apps/web/package.json'))('sharp')
  const iconPng = join(cacheDir, 'youdub-icon.png')
  await sharp(join(desktopDir, 'icon.svg')).resize(1024, 1024).png().toFile(iconPng)
  const winIcon = process.platform === 'win32' ? await generateWindowsIco() : iconPng

  const baseCommit =
    process.env.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const buildMetaPath = join(cacheDir, 'build.json')
  await writeFile(buildMetaPath, JSON.stringify({ version: appVersion, baseCommit }, null, 2) + '\n')

  const updateConfigPath = join(cacheDir, 'app-update.yml')
  await writeFile(updateConfigPath, JSON.stringify(desktopUpdateConfig, null, 2) + '\n')

  const extraResources = [
    {
      from: join(root, 'backend'),
      to: 'backend',
      filter: ['**/*', '!**/__pycache__/**', '!**/.pytest_cache/**', '!tests/**'],
    },
    { from: join(root, 'apps/web/dist'), to: 'web-dist' },
    {
      from: stagedPythonDir,
      to: 'python',
      filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'],
    },
    { from: stagedUvDir, to: 'uv' },
    { from: buildMetaPath, to: 'build.json' },
    { from: updateConfigPath, to: 'app-update.yml' },
  ]
  if (existsSync(join(root, 'submodule'))) {
    extraResources.push({
      from: join(root, 'submodule'),
      to: 'submodule',
      filter: ['**/*', '!**/.git/**', '!**/__pycache__/**'],
    })
  }
  for (const [srcName, destName] of [
    ['pyproject.toml', 'pyproject.toml'],
    ['requirements.txt', 'requirements.txt'],
    ['LICENSE', 'LICENSE-YouDub.txt'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ]) {
    const srcPath = join(root, srcName)
    if (existsSync(srcPath)) extraResources.push({ from: srcPath, to: destName })
  }

  const targetPlatform =
    process.platform === 'darwin'
      ? Platform.MAC
      : process.platform === 'win32'
        ? Platform.WINDOWS
        : Platform.LINUX
  const targetArch =
    process.platform === 'win32'
      ? Arch.x64
      : process.arch === 'arm64'
        ? Arch.arm64
        : Arch.x64

  const config = {
    appId: 'com.youdub.desktop',
    productName: 'YouDub',
    directories: { app: desktopDir, output },
    electronVersion: desktopRequire('electron/package.json').version,
    asar: false,
    npmRebuild: false,
    electronLanguages: ['en', 'en-US', 'zh-CN', 'ja'],
    files: ['package.json', 'dist/**/*', '!**/*.map'],
    extraResources,
    mac: {
      category: 'public.app-category.video',
      minimumSystemVersion: '14.0',
      identity: '-',
      icon: iconPng,
      artifactName: 'YouDub-${version}-macOS-${arch}.${ext}',
    },
    win: {
      icon: winIcon,
      artifactName: 'YouDub-${version}-windows-${arch}.${ext}',
    },
    publish: null,
  }

  await writeFile(join(cacheDir, 'builder.json'), JSON.stringify(config, null, 2) + '\n')
  await build({
    projectDir: desktopDir,
    targets: targetPlatform.createTarget(['dir'], targetArch),
    config,
  })
}
