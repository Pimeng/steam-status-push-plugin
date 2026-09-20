import { update as YunzaiUpdate } from "../../other/update.js"

const PLUGIN_NAME = "steam-status-push-plugin"

/**
 * 复用 Yunzai 内置更新器：统一处理拉取、冲突提示、更新日志与重启。
 * 插件自己的 config/config.yaml 已被 Git 忽略，正常更新不会覆盖本地凭据。
 */
export class SteamStatusUpdate extends plugin {
  constructor() {
    super({
      name: "Steam状态推送更新",
      dsc: "更新 Steam 状态推送插件",
      event: "message",
      priority: 1000,
      rule: [
        {
          reg: /^#?steam\s*(?:插件\s*)?(?:更新日志|update\s*log)$/i,
          fnc: "updateLog",
        },
        {
          reg: /^#?steam\s*(?:插件\s*)?(?:强制\s*)?(?:更新|update)$/i,
          fnc: "update",
        },
      ],
    })
  }

  async update(e = this.e) {
    if (!e.isMaster) {
      await e.reply("暂无权限，只有主人才能更新 Steam 状态推送插件")
      return true
    }

    // 通用更新器通过消息内容判断是否为强制更新，并从后缀解析插件目录名。
    const force = /强制/i.test(String(e.msg || ""))
    e.msg = `#${force ? "强制" : ""}更新${PLUGIN_NAME}`

    const updater = new YunzaiUpdate()
    updater.e = e
    return updater.update()
  }

  async updateLog(e = this.e) {
    const updater = new YunzaiUpdate()
    updater.e = e

    if (!updater.getPlugin(PLUGIN_NAME)) {
      await e.reply("未检测到插件 Git 仓库，无法读取更新日志")
      return true
    }

    const log = await updater.getLog(PLUGIN_NAME)
    await e.reply(log || "暂无更新日志")
    return true
  }
}
