export type VideoSource = {
  platform: 'YouTube' | 'Bilibili'
  url: string
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])
const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'])
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,32}$/
const BILIBILI_VIDEO_RE = /^\/video\/((?:BV[A-Za-z0-9]+|av\d+))(?:\/.*)?$/i

function extractCandidateUrl(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    const match = raw.match(/https?:\/\/[^\s"'<>]+/i)
    if (match) {
      const cleaned = match[0].replace(/[\]）】。，,;'"!]+$/, '')
      try {
        return new URL(cleaned)
      } catch { /* fall through */ }
    }
    throw new Error('请输入有效的 http/https 视频链接')
  }
}

/** Validate and normalize YouTube and Bilibili single-video URLs (also extracts links from share text). */
export function videoSource(raw: string): VideoSource {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('请输入 YouTube 或 Bilibili 视频链接')
  const parsed = extractCandidateUrl(trimmed)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
    throw new Error('仅支持标准的 YouTube 或 Bilibili 网页链接')
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')

  if (YOUTUBE_HOSTS.has(host)) {
    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
      if (!YOUTUBE_ID_RE.test(id)) throw new Error('无效的 YouTube 短链接')
      return { platform: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` }
    }
    if (parsed.pathname.startsWith('/playlist')) {
      throw new Error('不支持播放列表链接，请粘贴单个视频链接')
    }
    if (parsed.pathname.startsWith('/shorts/')) {
      const id = parsed.pathname.slice('/shorts/'.length).split('/')[0] ?? ''
      if (!YOUTUBE_ID_RE.test(id)) throw new Error('无效的 YouTube Shorts 链接')
      return { platform: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` }
    }
    if (parsed.pathname === '/watch') {
      const id = parsed.searchParams.get('v') ?? ''
      if (!YOUTUBE_ID_RE.test(id)) throw new Error('无效的 YouTube 视频链接')
      return { platform: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` }
    }
    throw new Error('不支持该 YouTube 链接格式')
  }

  if (BILIBILI_HOSTS.has(host)) {
    if (host === 'b23.tv') {
      const code = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
      if (!code) throw new Error('无效的 b23.tv 短链接')
      return { platform: 'Bilibili', url: `https://b23.tv/${code}` }
    }
    const videoMatch = parsed.pathname.match(BILIBILI_VIDEO_RE)
    if (!videoMatch) {
      throw new Error('请输入有效的 Bilibili /video/BV... 视频链接')
    }
    const p = parsed.searchParams.get('p')
    const url = `https://www.bilibili.com/video/${videoMatch[1]}/${p && /^\d+$/.test(p) ? `?p=${p}` : ''}`
    return { platform: 'Bilibili', url }
  }

  throw new Error('仅支持 YouTube 和 Bilibili 视频链接')
}
