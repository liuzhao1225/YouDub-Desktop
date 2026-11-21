import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const python = process.env.YOUDUB_TEST_PYTHON || resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
if (!env.FFMPEG_PATH) {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true })
  if (probe.status !== 0 && process.platform === 'darwin') {
    const dir = join(homedir(), 'Library', 'Application Support', 'YouDub', 'runtime', 'ffmpeg')
    if (existsSync(join(dir, 'ffmpeg')) && existsSync(join(dir, 'ffprobe'))) {
      env.FFMPEG_PATH = join(dir, 'ffmpeg')
      env.FFPROBE_PATH = join(dir, 'ffprobe')
      env.PATH = `${dir}${delimiter}${env.PATH ?? ''}`
    }
  }
}
const result = spawnSync(python, ['-m', 'pytest', 'backend/tests', ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true, env,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
