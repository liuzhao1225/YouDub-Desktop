# YouDub Web 前端

基于 **Vite 8 + React 19 + TypeScript + Tailwind CSS v4 + `@xyflow/react`** 的单页应用（SPA），保留全部视觉设计规范、亮暗主题同步与工作流交互体验。

- `src/components/shell/`：应用框架、可折叠侧边栏与桌面原生标题栏适配。
- `src/components/settings/`：通用设置（语言、主题、数据目录、网络代理）与多协议 LLM 供应商配置（OpenAI / Anthropic / Gemini、模型发现、连通性测试）。
- `src/components/ui/primitives/` & `src/styles/`：独立持有的基础组件、设计 Tokens 与动态 Logo / 动效样式。
- `src/plugin/builtin/`：工作台、任务库、节点工作流画布与字幕/配音校对界面。
- `src/lib/` & `src/runtime/`：`/api/*` 请求封装、`EventSource`（`/api/events` SSE）实时订阅、工作流资源检查与本地表单草稿。
- `src/locales/`：中文（`zh`）、英文（`en`）、日文（`ja`）文案。

在仓库根目录或本目录执行：

```bash
npm --prefix apps/web run dev
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web test
npm --prefix apps/web run build
```
