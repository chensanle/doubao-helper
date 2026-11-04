# 对话导出助手

一个用于导出豆包、DeepSeek 当前对话的 Chrome 扩展。默认导出为 Markdown，适合备份、整理、归档长对话；也支持导出 JSON，便于后续做结构化处理。

扩展只在你点击导出时运行，不会保存账号密码、不会内置 cookie，也不会把对话内容上传到开发者服务器。

当前版本 `0.4.0`。已上架 Chrome 应用商店，搜索“对话导出助手”即可安装，也可以按下面的方式从源码或压缩包加载。

## 安装

需要 Chrome 88 及以上（扩展使用 Manifest V3），Edge 等 Chromium 内核浏览器同样可用。

### 从源码加载

1. 克隆仓库：`git clone https://github.com/chensanle/doubao-helper.git`（也可以直接下载源码 ZIP）。
2. 打开 Chrome 的 `chrome://extensions/`。
3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本仓库目录。

### 从压缩包加载

1. 在 [Releases](https://github.com/chensanle/doubao-helper/releases) 下载最新安装包（当前为 `doubao-export-extension-0.4.0.zip`）。
2. 解压到本地文件夹。
3. 打开 Chrome 的 `chrome://extensions/`。
4. 打开“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择解压后的文件夹。

## 使用

1. 在 Chrome 里打开豆包对话页，例如 `https://www.doubao.com/chat/bot/chat/1234567890123456789`。
2. 如果当前页面是 `/chat/数字ID` 或 `/chat/bot/chat/数字ID` 这两类聊天详情页，页面右上角会出现红色的“导出当前会话内容 v0.4.0”按钮；按钮可以拖动，位置会被记住。
3. 点击按钮即可按默认设置导出 Markdown。
4. 等待浏览器下载 `.md` 文件。
5. 从弹窗发起的导出，可以在导出过程中点击“停止”中断；直接点悬浮按钮发起的导出不支持中断。

也可以点击浏览器工具栏里的“对话导出助手”图标，打开弹窗后手动选择导出方式。

DeepSeek 的用法见下面的 [DeepSeek](#deepseek) 一节。

一般情况下不需要改设置。默认会通过豆包页面同源接口分页读取历史消息，不会滚动页面。只有用户在弹窗里手动开启“允许滚动兜底”或选择“只用滚动”时，插件才会滚动页面。

## 导出格式

### Markdown

默认推荐。适合直接阅读、整理到笔记软件、提交到文档或做长期归档。

### JSON

弹窗里和 Markdown 并列，主要给需要二次处理的人使用。JSON 会保留接口返回的 `raw` 原始消息，方便进一步处理图片、搜索卡片、引用、工具调用等复杂内容。

## 高级设置

弹窗里的高级设置默认折叠，普通用户可以忽略。

- 导出方式：默认“只用接口”。
- 接口页数：接口分页最多拉取多少页，默认 `1000`。
- 每页条数：每次接口请求拉取多少条原始消息，默认 `20`。
- 起始 Anchor：默认自动。普通 `/chat/数字ID` 会使用 `9007199254740991 + direction=1`，`/chat/bot/chat/数字ID` 会使用 `0 + direction=3`。
- 向上加载次数：滚动兜底时，最多尝试向上触发多少次历史消息加载。
- 向下收集屏数：滚动兜底时，从顶部往下最多扫描多少屏。

接口模式默认最多拉取 `1000 * 20 = 20000` 条原始消息。插件会按当前 URL 类型自动选择首次分页参数，再按返回消息里的 `index_in_conv` 作为下一页锚点，用 `direction=1` 往更早的历史消息翻页。

默认不会自动切换到滚动模式，避免接口数据和滚动数据混在一起造成顺序或重复错乱。

## DeepSeek

支持 `https://chat.deepseek.com/a/chat/s/会话ID`（以及不带 `/a` 的 `/chat/s/会话ID`）这类会话详情页。导出的 Markdown / JSON 结构和豆包一致：

- JSON 的 `source` 为 `deepseek`，每条消息有 `index`、`role`、`text`、`messageId`、`raw`；有深度思考内容时多一个 `thinking` 字段。
- Markdown 标题为 `# DeepSeek 对话导出`，助手消息标题为 `### DeepSeek`；思考过程以引用块放在回答前面。
- 文件名为 `deepseek-chat-会话ID-时间.md/json`。

代码在 `deepseek-content.js` 和 `deepseek-page-hook.js`，和豆包的 `content.js` / `page-hook.js` 完全独立，不影响豆包导出。

### 导出流程

1. **接口（默认）**：`deepseek-page-hook.js` 注入到页面里，hook `fetch` / `XHR`，记下页面自己调 `/api/v0/...` 时带的请求头（`authorization`、`x-app-version`、`x-client-*`），并缓存页面请求过的 `/api/v0/chat/history_messages` 返回。导出时由页面脚本用同样的请求头重新请求 `GET /api/v0/chat/history_messages?chat_session_id=会话ID`；如果还没观察到请求头（例如插件是在页面打开之后才注入的），就读页面 `localStorage.userToken` 拼 `Bearer` 头。请求失败时用缓存的页面返回兜底。
2. **当前分支**：DeepSeek 的消息是树状的（重新生成、编辑提问会产生分支）。插件沿 `chat_session.current_message_id` 顺着 `parent_id` 往上，只导出当前看到的那条分支；拿不到这个字段时按 `message_id` 排序导出全部消息，`meta.branchMode` 会标明用的是哪种。
3. **DOM / 滚动兜底**：悬浮按钮用“接口优先”，接口失败时直接读当前页面 DOM（不滚动）；弹窗里选“只用滚动”或开启“允许滚动兜底”时才会滚动页面。DOM 识别只依赖 `.ds-markdown`（回答正文）、`.ds-think-content`（思考过程）、`.ds-message` 这几个看起来不是混淆名的 class，其它都是按结构推断。

弹窗里的“接口页数 / 每页条数 / 起始 Anchor”只对豆包生效。

### 接口格式里不确定的地方

下面这些是按 DeepSeek 网页版目前的返回结构写的，接口一变就可能需要调整 `deepseek-content.js`：

- 历史接口路径 `/api/v0/chat/history_messages`、参数 `chat_session_id`，返回体 `{ code: 0, data: { biz_code: 0, biz_data: { chat_session, chat_messages } } }`。
- 是否需要分页：目前假设一次返回整个会话。如果超长会话导出的条数明显偏少，说明接口有分页参数，需要补。
- 消息正文的两种格式都做了兼容：旧格式 `role`（`USER` / `ASSISTANT`）+ `content` + `thinking_content`；新格式 `fragments: [{ type: "REQUEST" | "RESPONSE" | "THINK" | "SEARCH", content }]`。`SEARCH` 等其它类型的 fragment 不进 `text`，只保留在 `raw`。
- 附件只取 `files[].file_name` 追加成“附件：xxx”一行。
- 鉴权：假设请求头里的 `authorization: Bearer <token>` 就够了，token 来自页面请求或 `localStorage.userToken`（`{ value: "..." }`）。
- DOM 兜底的选择器（`.ds-markdown` 等）也是按目前的页面结构推断的。

### 在真实页面上测试

1. 打开 `chrome://extensions/`，开启“开发者模式”，点“加载已解压的扩展程序”选这个目录（如果商店版也装着，先停用商店版，避免两个悬浮按钮）。改了代码后点扩展卡片上的刷新按钮，再**刷新 DeepSeek 页面**。
2. 打开一个有几轮对话的会话，例如 `https://chat.deepseek.com/a/chat/s/xxxx`，右上角应出现蓝色的“导出当前会话内容 v0.4.0”按钮（可拖动）。
3. 点按钮导出 Markdown，对照页面检查：轮数是否完整、顺序是否正确、用户 / DeepSeek 角色是否对、思考过程是否在。
4. 打开工具栏弹窗，分别导出 JSON，看 `meta`：
   - `sourceMode` 应为 `api`；如果是 `visible`，说明接口失败、走了 DOM 兜底，`meta.apiError` 里有原因。
   - `requestSource`：`observed-headers`（用页面请求头）、`stored-token`（用 localStorage token）或 `observed-response`（用缓存的页面返回）。
   - `rawCount` 和导出条数对比；`branchMode` 应为 `current-branch`。
5. 再试几种情况：用过“重新生成”的会话（应只导出当前分支）、带深度思考的会话、带附件的会话、很长的会话（看是否需要分页）、在弹窗里选“只用滚动”导出一次（对比 DOM 识别结果）。
6. 如果接口失败，打开 DevTools → Network，筛选 `history_messages`，把请求 URL、请求头名字（不要贴 token 值）和返回 JSON 的结构发给开发者，用来修正解析。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `manifest.json` | 扩展清单，声明两个站点的内容脚本和权限 |
| `content.js` / `page-hook.js` | 豆包导出：悬浮按钮、接口分页、滚动兜底 |
| `deepseek-content.js` / `deepseek-page-hook.js` | DeepSeek 导出，和豆包完全独立 |
| `popup.html` / `popup.js` / `popup.css` | 工具栏弹窗和高级设置 |
| `icons/` | 扩展图标 |
| `store-assets/` | 商店素材、上架说明和隐私政策 |

安装包不放在仓库里，见 [Releases](https://github.com/chensanle/doubao-helper/releases)。

## 隐私说明

- 扩展只在用户主动点击导出时运行。
- 扩展只会在豆包、DeepSeek 的对话详情页显示悬浮导出按钮，但只有点击按钮后才会读取对话内容。
- 扩展不会读取或保存账号密码。
- 扩展不会内置、保存或展示 cookie 明文。
- 扩展不会把对话内容上传到开发者服务器。
- 接口请求只发送到当前豆包页面所属的 `doubao.com`，并使用浏览器当前登录态。
- DeepSeek 的接口请求只发送到 `chat.deepseek.com`，由页面脚本带上页面自己的登录 token 发起；token 只在页面里使用，不会传给扩展的其它部分，也不会保存。
- 导出的 Markdown 或 JSON 文件保存在用户本地下载目录。

## 目前边界

- 只能导出当前账号可见、当前页面能加载出来的内容。
- 接口分页依赖豆包当前 `/im/chain/single` 返回结构，主要使用 `has_more`、`index_in_conv` 和 `content_block`；如果接口变化，可以切到“只用滚动”。
- 豆包前端 class 名可能会变化；插件里用了多层兜底，但页面大改版后可能需要调整 `content.js`。

## 免责声明

本扩展不是豆包、字节跳动或 DeepSeek 官方产品，也未与它们建立官方合作、授权或背书关系。请只导出你自己有权访问和保存的内容。
