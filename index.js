import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "../../lib/plugins/plugin.js"

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "apps")
const files = fs.readdirSync(appDir).filter(file => file.endsWith(".js"))

const loaded = await Promise.allSettled(files.map(file => import(`./apps/${file}`)))

/**
 * 从 app 模块里挑出插件类
 *
 * 不能用 Object.keys(mod)[0]：ESM 的导出名是按字母序排的，
 * 模块里给单测用的工具函数（buildChangeInfo / needsCard）会排到插件类前面，
 * 于是云崽会拿工具函数当类去 new，报出莫名其妙的 TypeError。
 * 这里改成「按继承关系认类」，导出顺序怎么变都不受影响。
 */
export function pickPlugin(mod) {
  const fns = Object.values(mod).filter(v => typeof v === "function")
  return (
    // 首选继承自云崽 plugin 基类的那个
    fns.find(v => v.prototype instanceof plugin) ??
    // 退路：原型上有 init 的（云崽插件类的特征）
    fns.find(v => v.prototype && typeof v.prototype.init === "function") ??
    fns[0]
  )
}

const apps = {}
for (let i = 0; i < files.length; i++) {
  const name = files[i].replace(/\.js$/, "")
  if (loaded[i].status !== "fulfilled") {
    logger.error(`[Steam状态推送] 载入模块错误：${logger.red(name)}`)
    logger.error(loaded[i].reason)
    continue
  }
  apps[name] = pickPlugin(loaded[i].value)
}

logger.info("[Steam状态推送] 插件载入完毕")

export { apps }
