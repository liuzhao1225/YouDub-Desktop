/** Launch local YouDub development stack (FastAPI + Vite + Electron, or --web-only). */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { delimiter, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const webOnly = process.argv.includes('--web-only')
const win = process.platform === 'win32'

function resolvePythonBin() {
  const override = process.env.YOUDUB_PYTHON_BIN?.trim()
  if (override) return override
  const venvBin = join(root, '.venv', win ? 'Scripts/python.exe' : 'bin/python')
  if (existsSync(venvBin)) return venvBin
  return win ? 'python' : 'python3'
}

function isPortAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createNetServer()
    server.once('error', () => resolveAvailable(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveAvailable(true))
    })
  })
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr !== 'string' ? addr.port : 0
      server.close((err) => (err ? rejectPort(err) : resolvePort(port)))
    })
  })
}

async function waitForHttp(url, name, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${name} exited before responding (${child.exitCode ?? child.signalCode})`)
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for ${name} at ${url}`)
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
}

const pythonBin = resolvePythonBin()
const configuredPort = Number(process.env.YOUDUB_PORT || 0)
const backendPort = configuredPort > 0
  ? configuredPort
  : ((await isPortAvailable(8765)) ? 8765 : await getFreePort())
const backendUrl = `http://127.0.0.1:${backendPort}`
const viteUrl = 'http://127.0.0.1:5173'

if (!webOnly) {
  const npmCmd = win ? 'npm.cmd' : 'npm'
  const build = spawnSync(npmCmd, ['--prefix', 'apps/desktop', 'run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: win,
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const children = []
let shuttingDown = false
const waitForChildExit = (child) =>
  new Promise((resolveWait) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolveWait()
      return
    }
    child.once('exit', () => resolveWait())
  })

const shutdown = (code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) killChild(child)
  const timeout = setTimeout(() => {
    for (const child of children) {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }
    process.exit(code)
  }, 5000)
  timeout.unref()
  void Promise.all(children.map(waitForChildExit)).then(() => {
    clearTimeout(timeout)
    process.exit(code)
  })
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

const viteBin = join(root, 'apps/web/node_modules/vite/bin/vite.js')
const viteChild = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5173'], {
  cwd: join(root, 'apps/web'),
  env: { ...process.env, YOUDUB_BACKEND_URL: backendUrl },
  stdio: 'inherit',
})
children.push(viteChild)

let backendChild = null
if (webOnly) {
  const backendEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    YOUDUB_NODE_PATH: process.env.YOUDUB_NODE_PATH || process.execPath,
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  }
  backendChild = spawn(
    pythonBin,
    ['-m', 'backend.app.server', '--host', '127.0.0.1', '--port', String(backendPort)],
    { cwd: root, env: backendEnv, stdio: 'inherit', windowsHide: true },
  )
  children.push(backendChild)
}

try {
  await Promise.all([
    waitForHttp(viteUrl, 'Vite dev server', viteChild),
    backendChild ? waitForHttp(`${backendUrl}/api/health`, 'FastAPI backend', backendChild) : Promise.resolve(),
  ])
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  shutdown(1)
}

if (webOnly) {
  console.log(`YouDub dev servers ready:\n  Web:     ${viteUrl}\n  Backend: ${backendUrl}`)
  const onExit = (name) => (code) => {
    if (!shuttingDown) {
      console.error(`${name} exited (${code ?? 0})`)
      shutdown(code ?? 1)
    }
  }
  viteChild.once('exit', onExit('Vite dev server'))
  backendChild.once('exit', onExit('FastAPI backend'))
} else {
  const electronCli = join(root, 'apps/desktop/node_modules/electron/cli.js')
  const electronChild = spawn(process.execPath, [electronCli, join(root, 'apps/desktop')], {
    cwd: root,
    env: {
      ...process.env,
      YOUDUB_DEV_URL: viteUrl,
      YOUDUB_PORT: String(backendPort),
      YOUDUB_PYTHON_BIN: pythonBin,
    },
    stdio: 'inherit',
  })
  children.push(electronChild)

  viteChild.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`Vite dev server exited unexpectedly (${code ?? 0})`)
      shutdown(code ?? 1)
    }
  })
  electronChild.once('exit', (code) => shutdown(code ?? 0))
}
