export const NEEDS_INFO_MARKER = '<!-- youdub-triage:needs-info -->'

const METADATA_LINE_RE = /^(?:YouDub|系统|架构|页面|语言|主题|客户端|阶段)\s*:/i

const PLACEHOLDER_LINES = [
  /^请描述遇到的问题[。.]?$/,
  /^请描述环境配置过程中遇到的问题及出错前的操作[。.]?$/,
  /^请补充相关日志或截图，并移除\s*API\s*Key、Token、密码等敏感信息[。.]?$/,
  /^请粘贴环境配置页「复制日志」得到的完整诊断日志，并补充相关截图（如有）[。.]?$/,
  /^请移除\s*API\s*Key、Token、密码等敏感信息[。.]?$/,
  /^请描述你在什么场景下需要这个功能，目前遇到了什么不便[。.]?$/,
  /^请描述你希望\s*YouDub\s*Desktop\s*如何工作[。.]?$/,
  /^如有参考实现、截图或替代方案，欢迎补充[。.]?$/,
]

const NON_BUG_LABELS = new Set(['enhancement', 'documentation', 'question'])
const TYPE_LABELS = new Set(['bug', 'enhancement', 'question', 'documentation'])

const AREA_RULES = [
  {
    label: 'area: setup',
    pattern: /\[环境配置\]|环境配置|环境准备|模型准备|模型下载|依赖安装|虚拟环境|\bvenv\b|pytorch|\btorch\b|\bcuda\b|\brocm\b|\bffmpeg\b|modelscope|pypi|镜像/i,
  },
  {
    label: 'area: asr',
    pattern: /whisper|语音识别|\basr\b|转写|transcrib|时间戳|timestamp/i,
  },
  {
    label: 'area: translation',
    pattern: /翻译|字幕翻译|\bllm\b|\bopenai\b|deepseek|anthropic|gemini|openrouter|segment_id|\bprompt\b|api\s*key/i,
  },
  {
    label: 'area: tts',
    pattern: /配音|合成|voxcpm|\btts\b|克隆|音色|人声分离|demucs|强制对齐|aligner|qwen3/i,
  },
  {
    label: 'area: download',
    pattern: /yt-dlp|youtube|bilibili|b站|视频下载|音频下载|只下载|\bcookies?\b/i,
  },
]

const MACOS_RE = /\b(macos|mac\s*os|darwin|apple\s*silicon|mac)\b/i
const WINDOWS_RE = /\b(windows|win32|win64|\.exe)\b/i

function isMetadataCodeBlock(blockContent) {
  const lines = blockContent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.every((line) => METADATA_LINE_RE.test(line))
}

export function stripTemplateBoilerplate(body = '') {
  const normalized = String(body ?? '').replace(/\r\n?/g, '\n')
  const withoutMetadataBlocks = normalized.replace(/```(?:text)?[ \t]*\n([\s\S]*?)```/gi, (match, inner) => (
    isMetadataCodeBlock(inner) ? '' : match
  ))

  const keptLines = []
  for (const rawLine of withoutMetadataBlocks.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    if (/^#{1,6}\s+/.test(trimmed)) continue
    if (/^\d+\.\s*$/.test(trimmed)) continue
    if (PLACEHOLDER_LINES.some((re) => re.test(trimmed))) continue
    keptLines.push(trimmed)
  }
  return keptLines.join('\n')
}

function extractSystemLine(body = '') {
  const normalized = String(body ?? '').replace(/\r\n?/g, '\n')
  for (const match of normalized.matchAll(/^系统\s*:\s*(.+)$/gm)) {
    const value = match[1].trim()
    if (value) return value
  }
  return ''
}

export function classifyIssue({ title = '', body = '', existingLabels = [] } = {}) {
  const safeTitle = String(title ?? '')
  const safeBody = String(body ?? '')
  const existing = new Set(
    (Array.isArray(existingLabels) ? existingLabels : [])
      .map((label) => (typeof label === 'string' ? label : label?.name))
      .filter(Boolean),
  )

  const cleanedBody = stripTemplateBoilerplate(safeBody)
  const addSet = new Set()
  const removeSet = new Set()

  const hasTypeLabel = [...TYPE_LABELS].some((label) => existing.has(label))
  if (!hasTypeLabel) {
    if (/^\[功能建议\]|^\[feature/i.test(safeTitle)) {
      addSet.add('enhancement')
    } else if (/^\[环境配置\]/.test(safeTitle)) {
      addSet.add('bug')
      addSet.add('area: setup')
    } else if (/^\[问题反馈\]/.test(safeTitle)) {
      addSet.add('bug')
    }
  }

  const systemLine = extractSystemLine(safeBody)
  const platformText = systemLine ? `${safeTitle}\n${systemLine}` : `${safeTitle}\n${cleanedBody}`
  if (MACOS_RE.test(platformText)) {
    addSet.add('platform: macos')
  }
  if (WINDOWS_RE.test(platformText)) {
    addSet.add('platform: windows')
  }

  const areaText = `${safeTitle}\n${cleanedBody}`
  for (const rule of AREA_RULES) {
    if (rule.pattern.test(areaText)) {
      addSet.add(rule.label)
    }
  }

  const effectiveLabels = new Set([...existing, ...addSet])
  const isNonBug = [...NON_BUG_LABELS].some((label) => effectiveLabels.has(label))
  const userText = cleanedBody.replace(/\s+/g, '')
  const needsInfo = !isNonBug && userText.length < 5

  if (needsInfo) {
    if (!existing.has('needs-info')) {
      addSet.add('needs-info')
    }
  } else {
    if (existing.has('needs-info')) {
      removeSet.add('needs-info')
    }
    if (existing.has('stale')) {
      removeSet.add('stale')
    }
  }

  const labelsToAdd = [...addSet].filter((label) => !existing.has(label))
  const labelsToRemove = [...removeSet]
  const isSetupIssue = /^\[环境配置\]/.test(safeTitle) || effectiveLabels.has('area: setup')

  return {
    labelsToAdd,
    labelsToRemove,
    needsInfo,
    isSetupIssue,
  }
}

export function buildNeedsInfoComment({ isSetupIssue = false } = {}) {
  const detailsHint = isSetupIssue
    ? '- 请补充出错前的操作步骤，并在环境配置页点击**「复制日志」**贴出完整诊断日志（注意脱敏 API Key / Token 等信息）。'
    : '- 请补充具体的问题现象、复现步骤、使用的模型/版本，以及相关报错日志或截图（注意移除 API Key 等敏感信息）。'

  return [
    NEEDS_INFO_MARKER,
    '感谢反馈！目前这条 Issue 还缺少足够的问题描述或日志信息，暂时无法定位具体原因：',
    '',
    detailsHint,
    '- 反馈前建议先确认已更新至 [Releases 最新版本](https://github.com/liuzhao1225/YouDub-Desktop/releases/latest)。',
    '',
    '你可以直接编辑主楼或在本条下回复补充信息；回复后会自动移除 `needs-info` 标签。',
  ].join('\n')
}
