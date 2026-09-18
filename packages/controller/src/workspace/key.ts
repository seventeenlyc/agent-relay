// packages/controller/src/workspace/key.ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把物理工作区路径规范化为跨 run、跨客户端一致的 workspace_key（V34）。
 *
 * 规则：
 *  1. 解析为绝对路径
 *  2. 用 realpathSync.native 解析符号链接与 Windows junction
 *  3. Windows 上折叠大小写（该平台文件系统大小写不敏感）
 *
 * 独立 worktree 的 realpath 各不相同，因此不会被误判为同一工作区。
 */
export function normalizeWorkspaceKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);

  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    // 路径不存在（尚未创建的工作区）时退回绝对路径，保持确定性
    real = resolved;
  }

  const normalized = path.normalize(real);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
