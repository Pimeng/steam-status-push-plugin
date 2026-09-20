# Steam Status Push Plugin

适用于 Yunzai 系机器人的 Steam 状态推送插件。支持绑定 Steam 账号、轮询在线与游戏状态、向多个群聊推送状态变化，以及生成 1920×1080 状态卡片和帮助图片。

## 功能

- 绑定 Steam 好友代码、SteamID64、Steam 个人资料链接、好友邀请链接、交易链接或自定义 ID。
- 推送上线、离线、忙碌、离开等个人状态变化。
- 推送开始游戏、结束游戏和切换游戏，并显示本次游玩时长。
- 一个账号可配置多个推送群聊。
- 支持“@某人 在干嘛”查询正在进行的游戏。
- 自适应轮询：根据启用人数调整请求间隔。
- 两套内置图片预置：
  - `white`：白底立绘，使用 `https://t.alcy.cc/bd`。
  - `blur`：竖版插画与宽羽化模糊过渡，使用 `https://t.alcy.cc/moemp`。
- 背景、头像和游戏封面带缓存及并发请求合并。

## 安装

在 Yunzai 根目录执行：

```bash
git clone https://github.com/Pimeng/steam-status-push-plugin.git plugins/steam-status-push-plugin
```

重启机器人后插件会自动创建 `config/config.yaml`。

本插件依赖宿主 Yunzai 已提供的 `yaml`、Puppeteer、Art Template 等运行环境，不需要在插件目录单独安装依赖。

## 配置

首次启动后编辑：

```text
plugins/steam-status-push-plugin/config/config.yaml
```

至少需要配置 Steam Web API Key：

```yaml
apiKey: "你的 Steam Web API Key"
```

也可以保持 `apiKey` 为空，并设置环境变量 `STEAM_API_KEY`。

Steam Web API Key 申请地址：<https://steamcommunity.com/dev/apikey>

### 图片预置

模糊羽化模板：

```yaml
render:
  preset: blur
```

白底模板：

```yaml
render:
  preset: white
```

`background` 和 `backgroundMode` 留空时跟随预置。需要自定义时可覆盖：

```yaml
render:
  preset: blur
  background: "https://example.com/background.webp"
  backgroundMode: auto
  backgroundBlur: 8
  backgroundCache: 60
```

完整配置和注释参见 [`config/default.yaml`](config/default.yaml)。

### 配置热重载

插件会监听 `config/config.yaml`（以及 `config/default.yaml`）的变化，保存后自动应用新配置，无需重启机器人：

- API Key、代理地址与超时：立即生效，并按需重新校验。
- 轮询开关、自适应策略与固定 cron：立即重排轮询调度。
- 推送开关与渲染配置：后续推送立即使用新值，背景缓存会同步刷新。

也可以发送 `#steam 重载配置` 手动触发（仅主人）。

> `config/config.yaml` 已被 `.gitignore` 排除。请勿提交 Steam API Key、代理认证或机器人运行数据。

## 指令

| 指令 | 说明 |
| --- | --- |
| `#steam 绑定 <标识>` | 绑定 Steam 账号（好友代码 / SteamID64 / 邀请链接 / 主页链接 / 交易链接 / 自定义 ID） |
| `#steam 绑定状态 / 绑定 状态` | 查看绑定信息和实时状态 |
| `#steam 解绑` | 解除绑定 |
| `#steam 开启推送` | 仅在当前群开启推送（只能在群聊使用） |
| `#steam 关闭推送` | 仅关闭当前群的推送（只能在群聊使用） |
| `#steam 禁用所有推送` | 移除并关闭全部群聊推送 |
| `#steam add [群号]` | 添加推送群，省略群号时使用当前群 |
| `#steam del <群号>` | 删除推送群 |
| `#steam enablestatus / enable status` | 私聊查看完整推送群列表 |
| `@某人 在干嘛` | 对方正在游戏时发送状态卡片 |
| `#steam test [game/status]` | 管理员生成测试图片 |
| `#steam help` | 查看帮助 |
| `#steam 重载配置` | 立即热重载 `config.yaml`（仅主人） |
| `#steam 更新` | 拉取插件更新（仅主人） |
| `#steam 强制更新` | 放弃已跟踪文件的本地修改并强制更新（仅主人） |
| `#steam 更新日志 / 更新 日志` | 查看最近提交记录 |

更新成功后会沿用 Yunzai 内置更新器的行为，提示并重启机器人以应用新代码。`config/config.yaml` 属于忽略文件，不会被正常更新或强制更新覆盖。

## 数据与安全

- 用户绑定与状态数据保存在宿主项目的 `data/steam-status-push-plugin/`，不会写入插件仓库。
- `config/config.yaml` 仅用于本地运行，并被 Git 忽略。
- 使用自定义 Steam API 代理时，API Key 会被发送至该地址；请只使用可信服务。
- 发布或反馈问题前，请检查日志和截图中是否包含 SteamID、群号或认证信息。

## 兼容性

- 采用 Yunzai 插件目录结构，当前在 Elia-Yunzai 环境中开发和验证。
- 需要可用的 Chromium/Puppeteer 渲染环境。
- 推荐 Node.js 18 或更高版本，以使用内置 `fetch`。

## 许可证

本项目使用 [GNU General Public License v3.0](LICENSE) 开源，与当前宿主 Yunzai 项目的许可证保持一致。
