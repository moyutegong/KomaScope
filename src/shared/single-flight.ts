/**
 * 单飞(重入)保护:同一时刻只允许一次在途调用,重复调用立即返回 null。
 *
 * 用途:目录选择对话框等"不能并发触发"的交互 —— 重复触发(双击、事件重复绑定、
 * 菜单与按钮混用)时不应弹出第二个对话框。纯逻辑、无依赖,可单测。
 */
export function createSingleFlight<T>(): (task: () => Promise<T>) => Promise<T | null> {
  let inFlight = false
  return async (task: () => Promise<T>): Promise<T | null> => {
    if (inFlight) return null
    inFlight = true
    try {
      return await task()
    } finally {
      // 任务成功或抛错都释放锁,避免一次失败让后续调用永久失效
      inFlight = false
    }
  }
}
