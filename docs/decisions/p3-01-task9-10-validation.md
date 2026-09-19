# P3-01 任务 9、10 验收记录

日期：2026-09-19。实施分支：`feature/p3-01-crash-recovery`。

## 覆盖范围

- Task 9：`tests/recovery/crash-recovery.test.ts`，7 项测试。覆盖旧 worker 无法静止时保留租约、停止意图消费前后重启、无法确认停止时保留意图、暂停后重启、CAS 后取消令牌失效、CAS 边界崩溃与取消组合下重复重启不重新授权。
- Task 10：`tests/recovery/partial-tasks.test.ts`，3 项测试。覆盖失败任务保持 `in_progress`、失败诊断与证据进入交接材料及后继执行提示、外部结果未知与长作业静止超时不自动重放。
- 公共测试夹具关闭并重新打开实际 SQLite 文件，以存活的 ScriptedAdapter 会话模拟控制器崩溃后的 worker。统一检查最多一个活跃写入者、已发布快照的完整性与哈希、原始输入及用户文件保留、完成事件不重复、取消/暂停/恢复状态保持；各场景另行断言提交次数和授权记录。

## 验收发现及修复

首轮新增 8 项测试中 4 项失败，暴露三类问题：

1. 对账消费停止意图前没有停止存活 worker。现在先核对当前会话、会话链及待交接会话的静止状态；无法确认时保留停止意图与租约。终态对账直接返回，防止残留 AUTHORIZED 记录重新授权。
2. 失败诊断仅留在事件中。现在保留失败证据哈希，将未完成任务最近一次失败诊断写入 manifest，并在后继单元提示中提供诊断上下文。
3. 长作业静止超时进入普通 BLOCKED。现在进入 RECOVERY_REQUIRED，保留任务现场并阻止自动重放。

修复后首批 8 项通过，补充停止无法确认与暂停重启两项边界测试。

## 验证结果

`npm test` 已接入 `tests/recovery/*.test.ts`，另提供 `npm run test:recovery`。

最终全量结果：310 tests，310 pass，0 fail，0 cancelled，0 skipped，0 todo。`git diff --check` 通过。

本记录验证控制器、持久化、恢复流程及模拟客户端契约；不代表真实 Codex、Claude、DSH 模型链路或真实进程被强杀后的端到端发布验收。没有修改客户端配置，也没有合并到 main。
