// packages/controller/src/workspace/key.ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把物理工作区路径规范化为跨 run、跨客户端一致的 workspace_key（V34）。
 *
 * 规则：
 *  1. 解析为绝对路径
 *  2. 用 realpathSync.native 解析符号链接与 Windows junction：解析对象是**最长已存在祖先**，
 *     尚未创建的尾段按原顺序接回，因此「目录尚不存在」与「目录已存在」得到同一个 key
 *  3. Windows 上折叠大小写（该平台文件系统大小写不敏感）
 *
 * 独立 worktree 的 realpath 各不相同，因此不会被误判为同一工作区。
 */
export function normalizeWorkspaceKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);

  let current = resolved;
  const tail: string[] = [];
  let real: string | undefined;

  // 从叶子向上找最长的已存在祖先：只有它需要 realpath 解析（符号链接/junction），
  // 未创建的尾段原样保留。否则「链接前缀 + 尚不存在的叶子」会与真实目录解析出两个 key，
  // 同一物理目录就可能出现两个 owner
  for (;;) {
    try {
      real = fs.realpathSync.native(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // 整条路径都不存在（例如未挂载的盘符）：退回绝对路径，保持确定性与不抛错
        real = undefined;
        break;
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }

  const normalized =
    real === undefined ? path.normalize(resolved) : path.normalize(path.join(real, ...tail));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
