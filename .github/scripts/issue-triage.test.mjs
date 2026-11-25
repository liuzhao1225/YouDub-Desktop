import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildNeedsInfoComment, classifyIssue, NEEDS_INFO_MARKER, stripTemplateBoilerplate } from './issue-triage.mjs'

describe('issue-triage', () => {
  it('classifies issue #158 (empty body + Apple Silicon + Whisper title) as macos, asr, bug, and needs-info', () => {
    const result = classifyIssue({
      title: '[问题反馈] Mac [Apple silicon] 语音识别步骤 Whisper returned an empty or invalid speech segment.',
      body: '',
      existingLabels: [],
    })

    assert.equal(result.needsInfo, true)
    assert.deepEqual(new Set(result.labelsToAdd), new Set(['bug', 'platform: macos', 'area: asr', 'needs-info']))
    assert.deepEqual(result.labelsToRemove, [])
  })

  it('classifies issue #195 (blank setup template on win32) as bug, setup, windows, and needs-info without false translation tag', () => {
    const body = [
      '### 问题描述',
      '',
      '请描述环境配置过程中遇到的问题及出错前的操作。',
      '',
      '### 环境信息',
      '',
      '```text',
      'YouDub: 0.0.12',
      '系统: win32 x64 / 10.0.26200',
      '阶段: 模型准备',
      '```',
      '',
      '### 诊断日志',
      '',
      '请粘贴环境配置页「复制日志」得到的完整诊断日志，并补充相关截图（如有）。',
      '',
      '请移除 API Key、Token、密码等敏感信息。',
    ].join('\n')

    const result = classifyIssue({
      title: '[环境配置] 环境准备',
      body,
      existingLabels: [],
    })

    assert.equal(stripTemplateBoilerplate(body), '')
    assert.equal(result.needsInfo, true)
    assert.equal(result.isSetupIssue, true)
    assert.deepEqual(new Set(result.labelsToAdd), new Set(['bug', 'area: setup', 'platform: windows', 'needs-info']))
    assert.ok(!result.labelsToAdd.includes('area: translation'))
  })

  it('classifies issue #196 (Windows DeepSeek segment_id bug) without needs-info', () => {
    const result = classifyIssue({
      title: '翻译批次要求 100% 保留 segment_id，模型合并相邻碎片即整任务失败，且无法单批重试',
      body: 'YouDub Desktop 0.0.12（Windows x64），翻译服务 deepseek，进行到第 10 批失败。',
      existingLabels: [],
    })

    assert.equal(result.needsInfo, false)
    assert.deepEqual(new Set(result.labelsToAdd), new Set(['area: translation', 'platform: windows']))
  })

  it('classifies issue #200 (macOS download + translation enhancement) without needs-info or bug', () => {
    const body = [
      '### 问题描述',
      '',
      '是否可以只下载音频进行翻译，节省下载流量。然后替换到原youtube链接进行在线播放',
      '',
      '### 复现步骤',
      '',
      '1. 无',
      '2. ',
      '',
      '### 基础信息',
      '',
      '```text',
      'YouDub: 0.0.13',
      '系统: macOS / 25.4.0',
      '架构: arm64',
      '```',
      '',
      '### 日志或截图（可选）',
      '',
      '请补充相关日志或截图，并移除 API Key、Token、密码等敏感信息。',
    ].join('\n')

    const result = classifyIssue({
      title: '[问题反馈]是否可以只下载音频进行翻译，节省下载流量',
      body,
      existingLabels: ['enhancement'],
    })

    assert.equal(result.needsInfo, false)
    assert.deepEqual(new Set(result.labelsToAdd), new Set(['platform: macos', 'area: download', 'area: translation']))
  })

  it('does not falsely trigger area: translation from bug-report footer API Key mention', () => {
    const body = [
      '### 问题描述',
      '',
      '点击配音生成时 VoxCPM 模型加载报错退出。',
      '',
      '### 基础信息',
      '',
      '```text',
      'YouDub: 0.1.3',
      '系统: macOS / 25.4.0',
      '```',
      '',
      '### 日志或截图（可选）',
      '',
      '请补充相关日志或截图，并移除 API Key、Token、密码等敏感信息。',
    ].join('\n')

    const result = classifyIssue({
      title: '[问题反馈] 配音失败',
      body,
      existingLabels: ['bug'],
    })

    assert.equal(result.needsInfo, false)
    assert.deepEqual(new Set(result.labelsToAdd), new Set(['platform: macos', 'area: tts']))
    assert.ok(!result.labelsToAdd.includes('area: translation'))
  })

  it('prefers explicit 系统 metadata line over OS names mentioned in user prose', () => {
    const body = [
      '### 问题描述',
      '',
      '在 macOS 上运行时 Whisper 报错，之前我在 Windows 电脑上是正常的。',
      '',
      '### 基础信息',
      '',
      '```text',
      'YouDub: 0.1.3',
      '系统: macOS / 25.4.0',
      '```',
    ].join('\n')

    const result = classifyIssue({
      title: '[问题反馈] 语音识别报错',
      body,
      existingLabels: ['bug'],
    })

    assert.deepEqual(new Set(result.labelsToAdd), new Set(['platform: macos', 'area: asr']))
    assert.ok(!result.labelsToAdd.includes('platform: windows'))
  })

  it('does not add needs-info or bug to feature requests even with short body', () => {
    const result = classifyIssue({
      title: '[功能建议] ',
      body: '### 使用场景\n\n请描述你在什么场景下需要这个功能，目前遇到了什么不便。\n',
      existingLabels: [],
    })

    assert.equal(result.needsInfo, false)
    assert.deepEqual(result.labelsToAdd, ['enhancement'])
  })

  it('removes needs-info and stale when an edited issue includes real details', () => {
    const result = classifyIssue({
      title: '[环境配置] 环境准备',
      body: '### 问题描述\n\n下载 PyTorch wheel 时一直超时，已附上复制日志。\n',
      existingLabels: ['bug', 'area: setup', 'needs-info', 'stale'],
    })

    assert.equal(result.needsInfo, false)
    assert.deepEqual(result.labelsToRemove, ['needs-info', 'stale'])
  })

  it('builds a needs-info reminder comment with marker and setup log instructions', () => {
    const setupComment = buildNeedsInfoComment({ isSetupIssue: true })
    assert.ok(setupComment.startsWith(NEEDS_INFO_MARKER))
    assert.ok(setupComment.includes('复制日志'))

    const generalComment = buildNeedsInfoComment({ isSetupIssue: false })
    assert.ok(generalComment.startsWith(NEEDS_INFO_MARKER))
    assert.ok(generalComment.includes('复现步骤'))
  })
})
