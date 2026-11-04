# Chrome Web Store Listing

## 名称

对话导出助手

## 简短说明

将豆包、DeepSeek 的当前对话一键导出为 Markdown 或 JSON 文件。

## 详细说明

对话导出助手可以把豆包、DeepSeek 网页版里的当前对话导出为本地文件，便于备份、整理、归档或后续分析。

主要功能：

- 支持豆包（doubao.com）和 DeepSeek（chat.deepseek.com）的对话详情页
- 导出为 Markdown，直接阅读或放进笔记软件
- 导出为 JSON，保留角色、消息 ID 和原始消息数据，便于二次处理
- 在对话详情页右上角显示一键导出按钮，也可以从工具栏弹窗导出
- DeepSeek 对话保留深度思考内容；重新生成过的会话只导出当前看到的分支
- 豆包对话支持接口分页，能导出很长的历史
- 可手动启用页面滚动兜底导出
- 导出过程中可随时停止

隐私与数据处理：

- 插件只在用户点击导出时读取对话内容
- 插件不读取、不保存账号密码、cookie 或登录 token
- 插件不会把对话内容上传到开发者服务器或任何第三方
- 导出的文件保存在用户本地下载目录
- 接口请求只发送到当前页面所属的网站（doubao.com 或 chat.deepseek.com），使用浏览器当前的登录状态

适用场景：

- 备份自己的 AI 对话
- 将对话整理为 Markdown 文档
- 将对话保存为 JSON 用于个人数据处理
- 导出长对话并保留结构化数据

本扩展不是豆包、字节跳动或 DeepSeek 的官方产品，也未与它们建立官方合作、授权或背书关系。

## 类别建议

Productivity

## 语言

中文（简体）

## 图片素材

| 用途 | 文件 | 尺寸 |
| --- | --- | --- |
| 商店图标 | `icons/icon128.png` | 128x128 |
| 截图 1：弹窗导出 | `store-assets/screenshot-1-1280x800.png` | 1280x800 |
| 截图 2：Markdown 结果 | `store-assets/screenshot-2-1280x800.png` | 1280x800 |
| 截图 3：DeepSeek + JSON 结果 | `store-assets/screenshot-3-1280x800.png` | 1280x800 |
| 截图 4：支持的网站与隐私 | `store-assets/screenshot-4-1280x800.png` | 1280x800 |
| 小宣传图 | `store-assets/small-promo-tile-440x280.png` | 440x280 |
| 大宣传图（可选） | `store-assets/marquee-promo-tile-1400x560.png` | 1400x560 |

设计稿在 `store-assets/design/`，改完运行 `zsh store-assets/design/render.sh` 重新生成。

## 权限说明

activeTab：
仅在用户点击扩展并发起导出时，临时访问当前活动的对话页面，用于读取当前对话内容。

scripting：
仅在用户从弹窗发起导出时，向当前活动页面注入导出脚本。

站点访问 `https://*.doubao.com/chat/*`：
用于在豆包聊天详情页显示“导出当前会话内容”的悬浮按钮。按钮只在 `/chat/数字ID` 和 `/chat/bot/chat/数字ID` 两类路径出现，用户点击按钮后才会读取当前会话并生成本地文件。

站点访问 `https://chat.deepseek.com/*`：
用于在 DeepSeek 会话详情页（`/a/chat/s/会话ID`）显示悬浮导出按钮，并在页面里记录页面自身请求所用的请求头，以便用户点击导出时以当前登录状态读取该会话的历史消息。用户点击按钮后才会读取会话内容。

## 单一用途说明

本扩展的唯一用途是帮助用户将当前 AI 对话（豆包、DeepSeek）导出为本地 Markdown 或 JSON 文件。

## 审核测试说明

豆包：

1. 安装扩展。
2. 打开 `https://www.doubao.com/` 并登录。
3. 进入任意豆包对话页。
4. 点击页面右上角的“导出当前会话内容”按钮，或点击扩展图标打开弹窗。
5. 点击“导出 Markdown”或“导出 JSON”。默认只使用接口，不滚动页面。
6. 浏览器会下载对应格式的本地文件。

DeepSeek：

1. 打开 `https://chat.deepseek.com/` 并登录。
2. 进入任意会话（地址形如 `https://chat.deepseek.com/a/chat/s/会话ID`）。
3. 点击页面右上角蓝色的“导出当前会话内容”按钮，或点击扩展图标打开弹窗导出。
4. 浏览器会下载对应格式的本地文件。

如果测试账号无法访问接口，请在弹窗中选择“只用滚动”模式，测试当前页面已加载内容的导出。
