import path from 'node:path';

export function quoteForWindows(arg: string): string {
  if (!arg) return '""';
  // 如果已经两端带双引号则直接返回
  if (arg.startsWith('"') && arg.endsWith('"')) {
    return arg;
  }
  // 包含空格、制表符、中文或特殊字符时，包裹双引号
  if (/[\s一-龥&|<>^%!]/.test(arg)) {
    return `"${arg}"`;
  }
  return arg;
}

export function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

export function buildNodeCommand(
  scriptPath: string,
  args: string[],
  options?: { nodeExec?: string }
): string {
  const nodeExec = options?.nodeExec ?? process.execPath;
  const quotedNode = quoteForWindows(normalizePath(nodeExec));
  const quotedScript = quoteForWindows(normalizePath(scriptPath));
  const quotedArgs = args.map((a) => quoteForWindows(a)).join(' ');
  return `${quotedNode} ${quotedScript} ${quotedArgs}`.trim();
}
