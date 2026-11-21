import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { delimiter, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import { YouDubInnoUpdater } from './inno-updater'

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloaded' | 'error'
  version?: string
  error?: string
}

const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'waiting'])
const MAX_BACKEND_RESTARTS = 3
const WIN_TITLEBAR_HEIGHT = 40

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

const repoRoot = resolve(__dirname, '../..')
const backendRoot = app.isPackaged ? process.resourcesPath : repoRoot
const authToken =
  process.env.YOUDUB_DISABLE_AUTH === '1'
    ? ''
    : (process.env.YOUDUB_AUTH_TOKEN?.trim() || randomBytes(32).toString('hex'))
const secretsToken = randomBytes(32).toString('hex')

let mainWindow: BrowserWindow | null = null
let secretsServer: Server | null = null
let secretsBridgeUrl = ''
let backendProc: ChildProcess | null = null
let backendPort = 0
let backendUrl = ''
let backendOrigin = ''
let windowUrl = ''
let windowOrigin = ''
let backendRestarts = 0
let backendStarted = false
let restartTimer: NodeJS.Timeout | null = null
let stabilityTimer: NodeJS.Timeout | null = null
let isQuitting = false
let quitConfirmed = false
let quitInFlight = false
let updater: AppUpdater | null = null
const recentBackendLogs: string[] = []

function appendLog(chunk: Buffer): void {
  const text = chunk.toString('utf8')
  process.stderr.write(text)
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    recentBackendLogs.push(line)
    if (recentBackendLogs.length > 30) recentBackendLogs.shift()
  }
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.toLowerCase().startsWith('bearer ')) return false
  const actual = Buffer.from(header.slice(7).trim(), 'utf8')
  const target = Buffer.from(expected, 'utf8')
  return actual.length === target.length && timingSafeEqual(actual, target)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        rejectBody(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          rejectBody(new Error('Expected JSON object'))
          return
        }
        resolveBody(parsed as Record<string, unknown>)
      } catch (err) {
        rejectBody(err)
      }
    })
    req.on('error', rejectBody)
  })
}

async function startSecretsBridge(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (!bearerMatches(req.headers.authorization, secretsToken)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    if (req.method !== 'POST' || (req.url !== '/encrypt' && req.url !== '/decrypt')) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON payload' })
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      sendJson(res, 503, { error: 'safeStorage encryption is unavailable' })
      return
    }
    if (req.url === '/encrypt') {
      if (typeof body.plaintext !== 'string') {
        sendJson(res, 400, { error: 'plaintext must be a string' })
        return
      }
      sendJson(res, 200, { ciphertext: safeStorage.encryptString(body.plaintext).toString('base64') })
      return
    }
    if (typeof body.ciphertext !== 'string') {
      sendJson(res, 400, { error: 'ciphertext must be a string' })
      return
    }
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(body.ciphertext, 'base64'))
      sendJson(res, 200, { plaintext })
    } catch {
      sendJson(res, 400, { error: 'Failed to decrypt payload' })
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Secrets bridge failed to bind')
  return { server, url: `http://127.0.0.1:${addr.port}` }
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer()
    srv.once('error', rejectPort)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr !== 'string' ? addr.port : 0
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)))
    })
  })
}

function resolvePythonBin(): string {
  const override = process.env.YOUDUB_PYTHON_BIN?.trim()
  if (override) return override
  const win = process.platform === 'win32'
  const venvRel = win ? 'Scripts/python.exe' : 'bin/python'
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'python', win ? 'python.exe' : 'bin/python3'),
        join(process.resourcesPath, 'python', win ? 'python.exe' : 'bin/python'),
        join(process.resourcesPath, 'venv', venvRel),
        join(app.getPath('userData'), 'runtime', 'venv', venvRel),
      ]
    : [
        join(repoRoot, '.venv', venvRel),
        join(repoRoot, '.venv', win ? 'Scripts/python.exe' : 'bin/python3'),
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return win ? 'python' : 'python3'
}

async function waitForHealth(url: string, child: ChildProcess | null, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Backend exited before becoming healthy (code=${child.exitCode ?? child.signalCode}).`)
    }
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return
    } catch {
      // keep polling until deadline
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for backend health check at ${url}/api/health`)
}

function spawnBackend(): ChildProcess {
  const pythonBin = resolvePythonBin()
  const devUrl = process.env.YOUDUB_DEV_URL?.trim()
  const webDist = app.isPackaged
    ? join(process.resourcesPath, 'web-dist')
    : (devUrl ? '' : (process.env.YOUDUB_WEB_DIST?.trim() || join(repoRoot, 'apps/web/dist')))

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: [backendRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    YOUDUB_AUTH_TOKEN: authToken,
    YOUDUB_SECRETS_BRIDGE_URL: secretsBridgeUrl,
    YOUDUB_SECRETS_TOKEN: secretsToken,
  }
  if (app.isPackaged) {
    env.YOUDUB_PACKAGED = '1'
    env.YOUDUB_MANAGED_RUNTIME = '1'
    if (!env.YOUDUB_UV_BIN) {
      const bundledUv = join(process.resourcesPath, 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv')
      if (existsSync(bundledUv)) env.YOUDUB_UV_BIN = bundledUv
    }
  }
  if (webDist) env.YOUDUB_WEB_DIST = webDist

  const proc = spawn(pythonBin, ['-m', 'backend.app.server', '--host', '127.0.0.1', '--port', String(backendPort)], {
    cwd: backendRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout?.on('data', appendLog)
  proc.stderr?.on('data', appendLog)
  proc.on('exit', (code, signal) => {
    if (stabilityTimer) {
      clearTimeout(stabilityTimer)
      stabilityTimer = null
    }
    if (backendProc === proc) backendProc = null
    if (isQuitting || !backendStarted) return
    if (backendRestarts < MAX_BACKEND_RESTARTS) {
      backendRestarts += 1
      console.error(`Backend exited (${code ?? signal}); restarting (${backendRestarts}/${MAX_BACKEND_RESTARTS})...`)
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (isQuitting) return
        const nextProc = spawnBackend()
        backendProc = nextProc
        void waitForHealth(backendUrl, nextProc).catch((err) => {
          console.error('Backend restart failed:', err)
        })
      }, 500)
      return
    }
    const detail = recentBackendLogs.slice(-10).join('\n') || `Exit status: ${code ?? signal}`
    dialog.showErrorBox('YouDub Backend Error', `The YouDub backend process stopped unexpectedly.\n\n${detail}`)
    quitConfirmed = true
    isQuitting = true
    app.quit()
  })

  stabilityTimer = setTimeout(() => {
    backendRestarts = 0
  }, 60_000)
  stabilityTimer.unref()
  return proc
}

async function stopBackend(): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (stabilityTimer) {
    clearTimeout(stabilityTimer)
    stabilityTimer = null
  }
  const proc = backendProc
  backendProc = null
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return

  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore if already exited
      }
      resolveExit()
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolveExit()
    }
  })
}

async function shutdownServices(): Promise<void> {
  await stopBackend()
  if (secretsServer) {
    const srv = secretsServer
    secretsServer = null
    await new Promise<void>((resolveClose) => srv.close(() => resolveClose()))
  }
}

function titleBarOverlayOptions(): Electron.TitleBarOverlayOptions {
  return {
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#f8fafc' : '#0f172a',
    height: WIN_TITLEBAR_HEIGHT,
  }
}

function isAllowedNavigation(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return parsed.origin === windowOrigin || parsed.origin === backendOrigin
  } catch {
    return false
  }
}

function openExternalIfHttp(rawUrl: string): void {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      void shell.openExternal(rawUrl)
    }
  } catch {
    // ignore malformed URL
  }
}

function emitUpdateState(state: UpdateState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('youdub:update-state', state)
  }
}

function setupUpdater(): void {
  const instance: AppUpdater = process.platform === 'win32' ? new YouDubInnoUpdater() : autoUpdater
  instance.autoDownload = true
  instance.autoInstallOnAppQuit = false
  instance.on('checking-for-update', () => emitUpdateState({ status: 'checking' }))
  instance.on('update-available', (info) => emitUpdateState({ status: 'available', version: info.version }))
  instance.on('update-not-available', (info) => emitUpdateState({ status: 'not-available', version: info.version }))
  instance.on('update-downloaded', (info) => emitUpdateState({ status: 'downloaded', version: info.version }))
  instance.on('error', (error) => emitUpdateState({ status: 'error', error: error.message }))
  updater = instance
}

async function hasActiveTasks(): Promise<boolean> {
  if (!backendUrl) return false
  try {
    const res = await fetch(`${backendUrl}/api/tasks?limit=20&offset=0`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { items?: Array<{ status?: string }> }
    return (data.items ?? []).some((task) => ACTIVE_TASK_STATUSES.has(String(task.status ?? '')))
  } catch {
    return false
  }
}

async function confirmQuitIfActiveTasks(): Promise<boolean> {
  if (!(await hasActiveTasks())) return true
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'YouDub',
    message: 'Tasks are still running or queued.',
    detail: 'Quitting YouDub now will interrupt active tasks.',
  }
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

function createWindow(loadUrl: string): BrowserWindow {
  const iconCandidates = [
    join(process.resourcesPath, 'youdub-icon.png'),
    join(repoRoot, '.cache/package/youdub-icon.png'),
  ]
  const icon = iconCandidates.find((p) => existsSync(p))
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'YouDub',
    show: false,
    ...(icon && process.platform !== 'darwin' ? { icon } : {}),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 18 },
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
        }
      : {}),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: titleBarOverlayOptions(),
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.on('enter-full-screen', () => win.webContents.send('youdub:fullscreen', true))
  win.on('leave-full-screen', () => win.webContents.send('youdub:fullscreen', false))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url)) openExternalIfHttp(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
      openExternalIfHttp(url)
    }
  })

  void win.loadURL(loadUrl)
  return win
}

function registerIpcHandlers(): void {
  ipcMain.on('youdub:bootstrap', (event) => {
    event.returnValue = {
      platform: process.platform,
      version: app.getVersion(),
      backendUrl,
      authToken,
      isFullScreen: mainWindow?.isFullScreen() ?? false,
    }
  })

  ipcMain.handle('youdub:pick-directory', async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('youdub:open-path', async (_event, targetPath: string) => {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      throw new Error('Target path must be a non-empty string')
    }
    const err = await shell.openPath(targetPath)
    if (err) throw new Error(err)
  })

  ipcMain.handle('youdub:check-updates', async () => {
    if (!app.isPackaged || !updater) {
      emitUpdateState({ status: 'not-available', version: app.getVersion() })
      return
    }
    await updater.checkForUpdates()
  })

  ipcMain.handle('youdub:quit-and-install', async () => {
    if (!app.isPackaged || !updater) return
    if (!(await confirmQuitIfActiveTasks())) return
    quitConfirmed = true
    isQuitting = true
    await shutdownServices()
    updater.quitAndInstall()
  })
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  nativeTheme.on('updated', () => {
    if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitleBarOverlay(titleBarOverlayOptions())
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && windowUrl && !isQuitting) {
      mainWindow = createWindow(windowUrl)
    }
  })

  process.on('exit', () => {
    if (backendProc && backendProc.exitCode === null && backendProc.signalCode === null) {
      try {
        backendProc.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  })

  app.on('before-quit', (event) => {
    if (quitConfirmed) return
    event.preventDefault()
    if (quitInFlight) return
    quitInFlight = true
    void (async () => {
      const proceed = await confirmQuitIfActiveTasks()
      if (!proceed) {
        quitInFlight = false
        return
      }
      quitConfirmed = true
      isQuitting = true
      await shutdownServices()
      app.quit()
    })()
  })

  void app.whenReady().then(async () => {
    registerIpcHandlers()
    if (app.isPackaged) setupUpdater()

    const bridge = await startSecretsBridge()
    secretsServer = bridge.server
    secretsBridgeUrl = bridge.url

    const externalUrl = process.env.YOUDUB_EXTERNAL_BACKEND_URL?.trim()
    if (externalUrl) {
      backendUrl = externalUrl.replace(/\/+$/, '')
      await waitForHealth(backendUrl, null)
    } else {
      const configuredPort = Number(process.env.YOUDUB_PORT || 0)
      backendPort = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : await getFreePort()
      backendUrl = `http://127.0.0.1:${backendPort}`
      backendProc = spawnBackend()
      await waitForHealth(backendUrl, backendProc)
      backendStarted = true
    }

    const loadUrl = process.env.YOUDUB_DEV_URL?.trim() || backendUrl
    backendOrigin = new URL(backendUrl).origin
    windowUrl = loadUrl
    windowOrigin = new URL(loadUrl).origin
    mainWindow = createWindow(loadUrl)
    console.log(`YouDub Desktop ready: ${backendUrl}`)

    if (app.isPackaged && updater) {
      setTimeout(() => {
        void updater?.checkForUpdates().catch(() => {})
      }, 5000).unref()
    }
  }).catch((error) => {
    const detail = recentBackendLogs.slice(-10).join('\n')
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('YouDub Startup Error', detail ? `${message}\n\n${detail}` : message)
    quitConfirmed = true
    isQuitting = true
    void shutdownServices().finally(() => app.quit())
  })
}
