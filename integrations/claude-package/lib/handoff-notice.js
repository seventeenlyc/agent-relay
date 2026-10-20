export function formatHandoffRedirectionNotice({ sessionId, title, reason, reasonDetails }) {
  return [
    'Agent Relay：独立任务交接',
    `原因：${reasonDetails || reason}`,
    `任务：${title}`,
    `目标会话：${sessionId}`,
    '已请求启动独立 Claude 会话。',
    `查看：claude --resume ${sessionId}`
  ].join('\n');
}
