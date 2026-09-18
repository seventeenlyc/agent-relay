// packages/protocol/src/coordinator.ts
import type { HandoffPackManifest, HandoffAckPacket } from './types.ts';

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

/**
 * 两阶段只读握手的跨适配器契约。
 *
 * 约定：
 *  - buildPreparationPrompt 返回必须以只读方式启动新会话的提示词，并携带 handoffId 等核对字段。
 *  - parseAckFromOutput 从会话输出中提取 HandoffAckPacket；无法解析时返回 null（不得抛错）。
 *  - verifyAckAndAuthorize 校验 3D 哈希与有效模型，并在状态机处于 PREPARING 时执行 CAS 租约转移；
 *    失败必须返回 { success: false }，且不得留下已转移的租约。
 *  - startNewSession 把状态机从 CHECKPOINTED/STARTING 推进到 PREPARING 并记录新 owner。
 *
 * 提示词方言按适配器不同（Codex/Claude 用 manifest JSON，DSH 用 KEY: value 标记行）；
 * 契约只要求两者都声明只读模式并携带 handoffId，具体方言由共享 skill 覆盖。
 */
export interface HandshakeCoordinator {
  startNewSession(newSessionId: string): void;
  buildPreparationPrompt(manifest: HandoffPackManifest): string;
  parseAckFromOutput(text: string): HandoffAckPacket | null;
  verifyAckAndAuthorize(manifest: HandoffPackManifest, ack: HandoffAckPacket): HandshakeResult;
}
