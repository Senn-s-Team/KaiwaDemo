# KaiwaDemo 设计规范

> 设计方向：Calm Conversational Studio
> 适用范围：首页、活动会话、会后复盘、历史与本机录音相关界面
> 文档性质：实现前的视觉与布局规范，不改变产品行为契约
>
> [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

## 1. Visual Theme and Atmosphere

KaiwaDemo 是一间安静的语言练习工作室，不是彩色学习玩具，也不是音频工程控制台。视觉应降低即时评判压力，让用户始终知道三件事：现在轮到谁、系统正在做什么、下一步可以做什么。

设计气质：安静、清晰、可信、轻量、音频优先。

设计拨盘：

- `DESIGN_VARIANCE`: 4，使用结构差异，不使用装饰性混乱。
- `MOTION_INTENSITY`: 3，动效只表达状态、反馈和层级变化。
- `VISUAL_DENSITY`: 4，保留短会话所需信息，避免把每一块内容都做成卡片。
- 主题：浅色优先，暖灰纸面配深墨文字和单一青绿色强调。
- CSS 策略：继续使用现有的原生 CSS，集中维护 `src/index.css` 与 `src/App.css` 的 token；不引入 Tailwind、CSS Modules 或新的 CSS-in-JS 方案。

必须保留的产品语义：固定五轮半双工会话、听力 L0-L4、表达 L1-L4、确认稿、语音到文字降级、可恢复错误、会后真实证据、一个关键回合重做、本机录音默认关闭。

禁止把视觉改版误写成行为改版。产品行为以 `docs/product-contract.md` 为准。

## 2. Color Palette and Roles

颜色按语义使用。页面最多一个主强调色，录音和错误颜色只承担状态语义，不用于装饰。

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#F5F6F2` | 全局纸面背景，替代现有亮薄荷绿画布 |
| `--surface` | `#FFFFFF` | 顶栏、输入区、主要浮层表面 |
| `--surface-soft` | `#EEF2EF` | 次级区域、非激活列表行、浅层分组 |
| `--surface-pressed` | `#E6ECE8` | 按压、选中和轻微交互反馈 |
| `--ink` | `#203039` | 主要文字、主图标、关键状态 |
| `--muted` | `#667477` | 辅助文字、时间、次级说明 |
| `--subtle` | `#8B9898` | 非关键元信息，不能用于正文或按钮文字 |
| `--accent` | `#287B78` | 唯一主强调色，主 CTA、当前级别、链接和选中状态 |
| `--accent-soft` | `#DCEDEA` | 青绿色浅底，音频消息、选中行和轻提示 |
| `--divider` | `#D8E1DE` | 分隔线和非装饰性边界 |
| `--recording` | `#C96E68` | 正在录音、停止录音、录音失败相关状态 |
| `--on-recording` | `#FFF8F5` | 录音色背景上的文字和图标 |
| `--success` | `#4F8066` | 可恢复成功、已确认、完成状态 |
| `--error` | `#B95752` | 错误状态和阻断性提示 |
| `--error-soft` | `#F8ECEA` | 错误与阻断提示的浅底；其上正文使用 `--ink` |
| `--warning-soft` | `#F8ECEA` | 需要留意但非阻断的提示浅底，例如静音提醒 |
| `--focus` | `#287B78` | 键盘焦点环，需与相邻背景保持清晰对比 |

颜色规则：

- 不使用紫蓝渐变、霓虹光晕或彩色背景轮换。
- 不再把 mint、apricot、butter、sky 同时作为并列 UI 色块。
- `--recording` 只表示录音状态，不表示错误或危险。
- 错误提示优先使用文字和操作路径，不能只依靠颜色。
- 文字颜色不能直接使用浅灰放在彩色背景上，必须使用对应背景的高对比深色。
- 任何新的状态颜色必须先映射到现有语义 token，不得添加临时色值。

## 3. Typography Rules

继续使用项目现有的跨平台 CJK 字体栈，避免为了装饰引入不稳定的外部字体：

```css
-apple-system,
BlinkMacSystemFont,
"SF Pro Text",
"Hiragino Sans",
"Yu Gothic UI",
"PingFang SC",
"Noto Sans CJK JP",
sans-serif
```

字体角色：

| Role | Size | Weight | Line height | Use |
|---|---:|---:|---:|---|
| `display` | `clamp(28px, 7vw, 40px)` | 650 | 1.18 | 首页主标题、完成页主结论 |
| `section` | `22px` | 650 | 1.3 | 页面区块标题 |
| `message` | `16px` | 450 | 1.75 | 日语消息、确认稿、中文解释 |
| `body` | `15px` | 450 | 1.7 | 常规说明和表单辅助文字 |
| `label` | `13px` | 600 | 1.45 | 状态、轮数、目标、控件标签 |
| `meta` | `12px` | 500 | 1.5 | 时间、来源、非关键元数据 |
| `counter` | `13px` | 650 | 1.2 | 五轮计数、录音时长、动态数字 |

排版规则：

- 中文和日文正文行高保持 `1.7` 至 `1.8`，不能套用紧凑拉丁文行高。
- 日语正文使用 `lang="ja"`，中文辅助使用 `lang="zh"`，混合文本按实际语言标记。
- 动态计数和录音时间使用 `font-variant-numeric: tabular-nums`。
- 标题使用 `text-wrap: balance`，正文使用 `text-wrap: pretty`。
- 不对 CJK 文本使用负字距。
- 主标题最多两到三行，按钮文案在 360px 宽度下不能产生难以理解的截断。
- 动作型文案优先，例如“查看关键信息”“确认这段转写”“重做这一回合”，不使用内部编号作为唯一文案。

## 4. Component Styling

### 4.1 Shape and radius

统一使用轻量结构化圆角，不再使用 Soft NeoBrutalism 的贴纸式大圆角和偏移阴影：

```css
--radius-control: 10px;
--radius-surface: 14px;
--radius-sheet: 18px;
--radius-pill: 999px;
```

规则：

- 普通按钮和输入控件使用 `--radius-control`。
- 主要聚合表面使用 `--radius-surface`。
- Bottom Sheet 使用 `--radius-sheet`，只在顶部保留圆角。
- 状态标签和轮数标签可以使用 `--radius-pill`，但不把所有控件都做成 pill。
- 不使用 `border-radius` 临时值；新增值必须先归入这套 scale。

### 4.2 Buttons

主按钮：

- 背景 `--accent`，文字 `--surface`。
- 高度 44px，录音主按钮最小高度 48px。
- 水平 padding 16px 至 20px。
- 使用轻微背景变化和 `transform: scale(0.98)` press feedback。
- 不使用 2px 深色边框，不使用 `3px` 或 `4px` 偏移阴影。

次按钮：

- 背景透明或 `--surface-soft`。
- 文字 `--ink` 或 `--accent`。
- 使用细分隔线或背景层级表达边界，不使用粗框。

状态：

- default：稳定背景和清晰文字。
- hover：仅在 `@media (hover: hover)` 中改变背景或文字色。
- active：100ms 至 160ms 内完成轻微 press scale。
- disabled：降低对比度和 opacity，但仍保留可读标签。
- loading：保留原操作语义，明确显示“正在准备”“正在整理”等状态。
- focus-visible：至少 3px 的 `--focus` outline，不能移除焦点反馈。

### 4.3 Inputs and textareas

- 输入区是首页的第一视觉锚点，不放入多层嵌套卡片。
- textarea 默认最小高度 112px，移动端允许自然增高，但不能因为辅助文案无限撑高首屏。
- 输入区与 STT 控件在 480px 以下改为纵向排列。
- placeholder 使用 `--muted`，不可使用 `--subtle` 承担完整提示。
- 聚焦时只改变边界和背景层级，不出现跳动或布局重排。
- 错误必须紧贴输入区出现，说明问题和下一步操作。

### 4.4 Conversation messages

- 会话消息使用开放式消息流，气泡只用于区分发话者，不承担装饰作用。
- AI 消息使用 `--accent-soft` 或 `--surface`，用户消息使用 `--surface` 与轻分隔线区分。
- 不使用粗边框和偏移阴影。
- 录音 bubble 高度自然增长，不能固定高度截断日语转写。
- 当前转写、录音时长、确认动作优先显示；实时辅助建议默认可折叠。
- 只有已确认文本才进入正式消息推进，视觉上不得把 interim transcript 伪装成确认稿。

### 4.5 Bottom Sheet

结构固定为三层：

```text
Sheet
├── Header / drag handle
├── Content：唯一可滚动区域
└── Footer：固定操作区 + bottom safe area
```

规则：

- 使用动态 viewport，高度基于 `dvh`，不以固定 `vh` 作为移动端上限。
- `overscroll-behavior: contain`，避免拖动 sheet 时带动 body。
- header 和 footer 不随 content 滚动。
- footer 必须包含 `env(safe-area-inset-bottom)`。
- textarea 聚焦时，确认按钮必须保持在 visual viewport 内。
- 360px 下 textarea 需要可收缩或受最大高度约束。
- 关闭按钮触控区域至少 44px，即使视觉图标更小。

### 4.6 Focus and accessibility

- icon-only button 必须有 `aria-label`。
- 所有操作使用原生 `<button>`，导航使用 `<a>`。
- 键盘焦点必须可见。
- 错误、录音状态、转写进度使用现有 `role="status"`、`role="alert"` 或 `aria-live` 语义，不以颜色代替文字。
- 保留 skip link、safe-area 和 `prefers-reduced-motion`。

## 5. Layout Principles

### 5.1 Global spacing

使用 4px 基础间距和固定响应式梯度：

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
```

不要针对单个间隙不断增加新的数值。页面感觉过松或过紧时，优先调整整组 spacing ladder。

### 5.2 Home

首页信息顺序：

```text
场景输入
↓
中文 STT
↓
必要澄清
↓
场景准备信息
↓
开始练习
↓
最近练习
↓
示例场景
```

规则：

- 输入和“准备练习”是主要任务，历史和示例不与其争夺首屏权重。
- 中文 STT 只填入可编辑输入框，不自动提交或开始会话。
- 角色、关系和唯一目标在准备信息中纵向排列，360px 下不做并列操作。
- 上次建议默认收起，只有用户主动查看时展开。
- 首页主 CTA 不 fixed，避免遮挡输入和键盘。

### 5.3 ActiveSession

会话页固定采用三段式：

```text
固定顶栏：角色 / 轮次 / 当前状态 / 目标入口
独立滚动消息区：相手消息 / 用户转写 / 听力支架
固定底部 dock：录音或文字输入 / 确认 / 辅助入口
```

规则：

- `.im-message-viewport` 是唯一消息滚动容器。
- `.im-bottom-dock` 不滚动，内容变高时消息区缩小。
- 顶栏在 390px 以下只显示角色、轮次、状态和一个目标入口。
- “提前复盘”和上次建议移入次级菜单，不与轮次和状态并列竞争。
- L0-L4 和表达帮助逐级展开，不一次显示全部内容。
- 主操作始终位于底部拇指可达区域。
- 录音中当前转写必须可见，辅助建议可以收起。

### 5.4 SessionComplete

完成页顺序：

```text
完成状态
↓
本次最重要的收获
↓
一个真实证据
↓
重做这一回合
↓
详细证据，可展开
↓
重练 / 新场景
```

规则：

- 首屏不展示完整反馈长文。
- 详细证据、听力发现和表达建议默认收起。
- 每个关键证据旁边保留对应重做入口。
- 重练和新场景不 fixed，放在自然文档流末尾。
- 四维反馈是事实列表，不做四张相同视觉卡片。

### 5.5 Surface hierarchy

从低到高使用背景层级，而不是装饰性边框：

1. `canvas`：`--canvas`
2. `soft`：`--surface-soft`
3. `surface`：`--surface`
4. `sheet`：`--surface` 加轻柔、带背景色倾向的阴影

只在确实需要表达分隔、表格关系、输入边界或焦点时使用 border。禁止所有组件统一套边框。

## 6. Depth and Elevation

抛弃现有的：

- `--shadow-standard: 3px 3px 0 ...`
- `--shadow-primary: 4px 4px 0 ...`
- 2px 深色卡片边框
- 按钮通过位移制造贴纸感

采用以下深度规则：

```css
--shadow-sheet: 0 -8px 32px rgba(32, 48, 57, 0.10);
--shadow-floating: 0 4px 16px rgba(32, 48, 57, 0.08);
--shadow-focus: 0 0 0 3px rgba(40, 123, 120, 0.22);
```

- 普通消息和列表不使用阴影。
- 只有 sheet、需要脱离内容流的浮层、明确的主要 surface 可以使用阴影。
- 阴影始终偏柔和，不能看起来像贴纸或硬切块。
- 视觉层级优先使用空间、背景色阶和排版重量。

## 7. Motion

动效只服务于状态反馈、层级进入和操作确认：

| Interaction | Motion | Duration |
|---|---|---:|
| 按钮按压 | `transform: scale(0.98)` | 100-160ms |
| Sheet 出现 | `opacity + translateY(12px)` | 220-320ms |
| Sheet 关闭 | `opacity + translateY(-8px)` | 150-220ms |
| 转写出现 | opacity，必要时轻微 translateY | 180-260ms |
| 录音状态 | 低幅度波形或状态变化 | 仅录音期间 |
| 完成反馈 | 分段进入，不做弹跳 | 220-360ms |

规则：

- 只动画 `transform`、`opacity` 和必要的 `filter`。
- 禁止 `transition: all`。
- 禁止持续装饰性 pulse、bounce 和无限循环闪烁。
- `prefers-reduced-motion: reduce` 下移除进入位移、波形动画和非必要 pulse，仅保留即时状态变化。
- 高频操作不使用长动画；录音、切换文字和确认稿必须立即反馈。
- hover 仅在支持 hover 的设备上启用，触控设备不能依赖 hover。

## 8. Responsive Behavior

移动端是主约束，断点按行为变化定义：

### 8.1 Base: 320px 至 359px

- 页面横向 padding 12px 至 16px。
- 所有主要操作纵向排列。
- 主按钮独占一行。
- 顶栏只保留角色、轮次、状态和目标入口。
- 关闭、返回、切换控件触控区域至少 44px。
- 录音转写和 sheet content 允许自然滚动，不能固定高度截断。

### 8.2 Compact: 360px 至 389px

- 首页输入、STT、准备卡均单列。
- ActiveSession 顶栏合并次级 action。
- dock 主操作占剩余宽度，文字切换保持 44px。
- 辅助建议默认折叠。
- SessionComplete 首屏仅展示收获、证据和重做。

### 8.3 Standard mobile: 390px 至 519px

- 可以显示简短目标摘要。
- 可以恢复部分按钮文字，但不能让 action 区压缩轮次和状态。
- STT 控件仍可纵向排列。
- bottom sheet 使用动态 viewport，并保留 header/footer 固定结构。

### 8.4 Tablet and desktop: 520px 以上

- 内容区可扩大，但不恢复粗边框、偏移阴影和多色卡片。
- ActiveSession 消息区最大宽度约 860px。
- 首页和完成页可以使用双栏辅助布局，但核心操作仍按阅读顺序排列。
- 桌面端不能新增移动端没有的行为，只能提供更多空间。

### 8.5 Device constraints

- 根容器使用 `min-height: 100dvh`，不使用 `100vh` 作为移动端主要高度依据。
- 页面和会话容器使用现有 `env(safe-area-inset-*)` 策略。
- Bottom Sheet 和键盘输入必须以 visual viewport 可见性为验收目标。
- 需要检查 360px、375px、390px 和 1280px。

## 9. Do and Don't

### Do

- 用空间和排版表达层级。
- 让用户先看到当前状态，再看到辅助信息。
- 让语音操作始终位于拇指可达区域。
- 让消息流、sheet content 和页面正文各自承担明确滚动职责。
- 让完成页先给一个可执行收获，再展开证据。
- 使用单一青绿色强调产品的稳定性和连续性。
- 用真实的动作型文案解释 L1-L4，而不是只展示内部编号。

### Don't

- 不恢复 Soft NeoBrutalism 的粗边框、偏移阴影和贴纸式按钮。
- 不用紫蓝渐变、玻璃卡片或持续发光制造“AI 感”。
- 不把所有内容包装成相同卡片。
- 不在 360px 上保留桌面端所有顶栏操作。
- 不让 body、消息区、dock、sheet content 同时滚动。
- 不让未经确认的转写看起来像正式回答。
- 不用颜色单独表达录音、错误或成功。
- 不为了视觉丰富度改变固定五轮、逐级支架或会后证据的产品行为。

## 10. Agent Prompt Guide

以下 prompt 可以直接用于后续实现任务。实现代理必须先读取本文件，并保持现有 React + 原生 CSS 方案。

### Token quick reference

```text
canvas: #F5F6F2
surface: #FFFFFF
surface-soft: #EEF2EF
surface-pressed: #E6ECE8
ink: #203039
muted: #667477
accent: #287B78
accent-soft: #DCEDEA
divider: #D8E1DE
recording: #C96E68
success: #4F8066
error: #B95752
error-soft: #F8ECEA
warning-soft: #F8ECEA
control-radius: 10px
surface-radius: 14px
sheet-radius: 18px
primary-touch-target: 48px
minimum-touch-target: 44px
```

### Prompt 1: ActiveSession mobile shell

> 重排 `ActiveSession` 的移动端布局，保持现有会话状态和 controller 边界不变。使用 `#F5F6F2` canvas、`#FFFFFF` surface、`#203039` ink、`#287B78` accent，普通控件圆角 `10px`，surface 圆角 `14px`。保留固定顶栏、独立滚动消息区和固定底部 dock，禁止 body 参与会话滚动。390px 以下顶栏只显示角色、轮次、状态和一个目标入口，将提前复盘移入次级菜单。主录音按钮高度至少 `48px`，其他触控目标至少 `44px`。不要使用粗边框、偏移阴影或多色卡片。

### Prompt 2: Bottom Sheet keyboard-safe layout

> 优化会话 bottom sheet 的移动端结构。Sheet 使用 `18px` 顶部圆角、动态 `dvh` 高度和 `rgba(32,48,57,0.10)` 柔和阴影。Header 和 footer 固定，只有 content 滚动；footer 加 `env(safe-area-inset-bottom)`，textarea 聚焦时确认按钮必须保持在 visual viewport 内。360px 宽度下 textarea 可收缩，不能撑满 sheet。保留现有 aria、错误恢复和确认稿行为，不新增业务状态。

### Prompt 3: Home mobile preparation flow

> 重排首页为移动端单列流程：场景输入、中文 STT、必要澄清、准备信息、开始练习、最近练习、示例场景。使用 `#F5F6F2` canvas 和 `#FFFFFF` 输入 surface，主 CTA 使用 `#287B78`，按钮高度至少 `44px`。中文 STT 在 480px 以下纵向排列，但不得自动提交或开始会话。角色、关系、唯一目标纵向排列，上次建议默认收起。历史和示例不使用相同的彩色卡片矩阵。

### Prompt 4: SessionComplete evidence hierarchy

> 重排完成页的移动端信息层级。首屏只显示完成状态、本次最重要的收获、一个真实证据和“重做这一回合”。详细证据、听力发现和表达建议默认放进可展开区域。四维反馈使用纵向证据列表，不使用四张相同卡片。重练和新场景放在自然文档流末尾，不 fixed。不得生成总分或改变产品契约中的证据不足、未观察和重做语义。

## 11. Implementation boundaries

本规范允许后续修改：

- `src/index.css` 的全局 token、字体、焦点和基础响应式规则。
- `src/App.css` 的颜色、圆角、边框、阴影、布局和动效实现。
- `src/components/Home.tsx`、`ActiveSession.tsx`、`SessionComplete.tsx` 的结构性布局调整。
- 与视觉状态直接相关的 aria、折叠和移动端可见性标记。

本规范禁止后续视觉任务擅自修改：

- `docs/product-contract.md` 定义的五轮、支架、确认稿、恢复、录音和隐私行为。
- Worker、shared schema、token 边界、遥测边界和媒体生命周期。
- 页面路由、主产品流程和现有任务恢复语义。
- 为了视觉效果新增依赖、全局状态或第二套 CSS 方案。

## 12. Verification checklist

后续实现完成后，必须在真实浏览器界面检查：

- 360px、375px、390px、1280px 四个宽度。
- Home 输入、中文 STT、准备卡、历史和示例的首屏顺序。
- ActiveSession 顶栏、消息滚动、录音转写、文字输入和底部 dock。
- Bottom Sheet 在 textarea 聚焦、键盘出现、safe-area 和长内容下的 footer 可见性。
- SessionComplete 首屏收获、证据、重做和详细复盘折叠。
- 录音、转写、错误、确认稿和完成状态的可见反馈。
- `prefers-reduced-motion` 下没有必要的位移、波形和 pulse。
- 键盘焦点、ARIA 状态、触控目标和颜色对比度。
- 未改变固定五轮、逐级支架、确认稿和会后真实证据的产品行为。
