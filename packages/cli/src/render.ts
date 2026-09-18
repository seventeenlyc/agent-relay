// packages/cli/src/render.ts
import type { SessionChainLink } from '../../controller/src/run/store.ts';

const COLUMNS: Array<{ header: string; width: number }> = [
  { header: '#', width: 3 },
  { header: '旧会话', width: 22 },
  { header: '新会话', width: 22 },
  { header: '模型', width: 34 },
  { header: 'epoch', width: 5 },
  { header: '原因', width: 18 }
];

function cell(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function renderChain(links: SessionChainLink[]): string {
  if (links.length === 0) {
    return '（无会话链记录）\n';
  }

  const header = COLUMNS.map((c) => cell(c.header, c.width)).join(' ');
  const divider = COLUMNS.map((c) => '-'.repeat(c.width)).join(' ');
  const rows = links.map((link) =>
    [
      cell(String(link.sequence), COLUMNS[0].width),
      cell(link.prevSessionId ?? '(新 run)', COLUMNS[1].width),
      cell(link.nextSessionId, COLUMNS[2].width),
      cell(`${link.provider}/${link.model}${link.effort ? ` (${link.effort})` : ''}`, COLUMNS[3].width),
      cell(String(link.epoch), COLUMNS[4].width),
      cell(link.reason, COLUMNS[5].width)
    ].join(' ')
  );

  return [header, divider, ...rows].join('\n') + '\n';
}
