export type DesktopLocaleId = 'zh' | 'en' | 'ja'

export interface DesktopMessages {
  checkUpdatesMenu: string
  settingsMenu: string
  viewMenu: string

  updateTitle: string
  updateReadyMessage: string
  updateReadyDetail: string
  updateRestartButton: string
  updateLaterButton: string
  updateCurrentMessage: string
  updateCurrentDetail: string
  updateDownloadingMessage: string
  updateDownloadingDetail: string
  updateFailedMessage: string
  updateUnavailableDevMessage: string
  updatePortableMessage: string
  updatePortableDetail: string
  updateUnsupportedPlatformMessage: string
  updateUnsupportedPlatformDetail: string
  updateOpenDownloadsButton: string
  updateCloseButton: string
  exitApplicationButton: string

  quitActiveTasksMessage: string
  quitActiveTasksDetail: string
  quitButton: string
  cancelButton: string
}

const MESSAGES: Record<DesktopLocaleId, DesktopMessages> = {
  zh: {
    checkUpdatesMenu: '检查更新…',
    settingsMenu: '设置…',
    viewMenu: '视图',

    updateTitle: '软件更新',
    updateReadyMessage: 'YouDub v{version} 已准备就绪',
    updateReadyDetail: '新版本已完成下载与校验。重启应用即可完成安装。',
    updateRestartButton: '重启并更新',
    updateLaterButton: '稍后更新',
    updateCurrentMessage: '当前已是最新版本',
    updateCurrentDetail: '当前安装版本为 YouDub v{version}。',
    updateDownloadingMessage: '正在后台下载 YouDub v{version}',
    updateDownloadingDetail: '下载进度：{percent}%，完成后将提示您重启安装。',
    updateFailedMessage: '检查或安装更新失败',
    updateUnavailableDevMessage: '仅已打包安装的桌面应用支持自动检查更新。',
    updatePortableMessage: '当前版本为 Windows 便携版，不支持应用内自动更新',
    updatePortableDetail: '请前往 GitHub Releases 下载并运行安装版（Setup）或手动覆盖新版。',
    updateUnsupportedPlatformMessage: '当前系统架构暂不支持应用内自动更新',
    updateUnsupportedPlatformDetail: '请前往 GitHub Releases 下载对应平台的安装包。',
    updateOpenDownloadsButton: '打开下载页',
    updateCloseButton: '关闭',
    exitApplicationButton: '退出应用',

    quitActiveTasksMessage: '仍有任务正在运行或排队中',
    quitActiveTasksDetail: '现在退出 YouDub 将中断正在进行的任务。',
    quitButton: '仍然退出',
    cancelButton: '取消',
  },
  en: {
    checkUpdatesMenu: 'Check for Updates…',
    settingsMenu: 'Settings…',
    viewMenu: 'View',

    updateTitle: 'Software Update',
    updateReadyMessage: 'YouDub v{version} is ready to install',
    updateReadyDetail: 'The update has been downloaded and verified. Restart YouDub to apply it.',
    updateRestartButton: 'Restart to Update',
    updateLaterButton: 'Later',
    updateCurrentMessage: 'You are up to date',
    updateCurrentDetail: 'YouDub v{version} is currently the newest version available.',
    updateDownloadingMessage: 'Downloading YouDub v{version} in background',
    updateDownloadingDetail: 'Progress: {percent}%. You will be prompted when it is ready to install.',
    updateFailedMessage: 'Software update failed',
    updateUnavailableDevMessage: 'Automatic updates are only available in packaged builds of YouDub.',
    updatePortableMessage: 'Portable Windows builds do not support automatic in-app updates',
    updatePortableDetail: 'Open GitHub Releases to download the Windows Setup installer or update manually.',
    updateUnsupportedPlatformMessage: 'Automatic updates are not supported on this platform architecture',
    updateUnsupportedPlatformDetail: 'Open GitHub Releases to download the latest build for your system.',
    updateOpenDownloadsButton: 'Open Downloads',
    updateCloseButton: 'Close',
    exitApplicationButton: 'Quit YouDub',

    quitActiveTasksMessage: 'Tasks are still running or queued',
    quitActiveTasksDetail: 'Quitting YouDub now will interrupt active tasks.',
    quitButton: 'Quit',
    cancelButton: 'Cancel',
  },
  ja: {
    checkUpdatesMenu: 'アップデートを確認…',
    settingsMenu: '設定…',
    viewMenu: '表示',

    updateTitle: 'ソフトウェアアップデート',
    updateReadyMessage: 'YouDub v{version} のインストール準備が整いました',
    updateReadyDetail: '新しいバージョンのダウンロードと検証が完了しました。再起動して適用してください。',
    updateRestartButton: '再起動して更新',
    updateLaterButton: '後で',
    updateCurrentMessage: '最新バージョンです',
    updateCurrentDetail: '現在インストールされているのは YouDub v{version} です。',
    updateDownloadingMessage: 'YouDub v{version} をバックグラウンドでダウンロード中',
    updateDownloadingDetail: '進行状況: {percent}%。完了後に再起動の確認が表示されます。',
    updateFailedMessage: 'アップデートの確認またはインストールに失敗しました',
    updateUnavailableDevMessage: '自動アップデートはパッケージ版 YouDub でのみ利用できます。',
    updatePortableMessage: 'Windows ポータブル版はアプリ内自動更新に対応していません',
    updatePortableDetail: 'GitHub Releases からセットアップ版をダウンロードするか手動で更新してください。',
    updateUnsupportedPlatformMessage: 'このシステムアーキテクチャでは自動更新を利用できません',
    updateUnsupportedPlatformDetail: 'GitHub Releases からお使いの環境向けの最新ビルドをダウンロードしてください。',
    updateOpenDownloadsButton: 'ダウンロードページを開く',
    updateCloseButton: '閉じる',
    exitApplicationButton: 'YouDub を終了',

    quitActiveTasksMessage: '実行中または待機中のタスクがあります',
    quitActiveTasksDetail: '今すぐ YouDub を終了すると、進行中のタスクが中断されます。',
    quitButton: '終了',
    cancelButton: 'キャンセル',
  },
}

function normalizeLocale(value: string | null | undefined): DesktopLocaleId | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('ja')) return 'ja'
  if (normalized.startsWith('en')) return 'en'
  return null
}

export function resolveDesktopLocale(
  preferred?: string | null,
  systemLocale?: string,
): { id: DesktopLocaleId; messages: DesktopMessages } {
  const id = normalizeLocale(preferred) ?? normalizeLocale(systemLocale) ?? 'en'
  return { id, messages: MESSAGES[id] }
}

export function formatDesktopMessage(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  )
}
