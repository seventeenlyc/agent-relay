# Agent Relay Protocol Worker Skill

This skill governs the handoff protocol for agent workers under Agent Relay supervision.

## Rules of Engagement

1. **Read-Only Inspection on Entry**:
   When entering a new session, you are strictly in READ-ONLY mode.
   Do not modify, write, or touch any project files.

2. **Verify Checkpoint & Manifest**:
   - Verify the immutable user inputs: check that original user prompt hashes match.
   - Verify active tasks in the authoritative task graph.
   - Inspect workspace status without modifying files.

3. **Submit ACK Frame**:
   Emit your structured ACK response:
   ```json
   {
     "type": "handoff:ack",
     "sessionId": "<your-session-id>",
     "verifiedInputHeadHash": "<hash>",
     "status": "READY_FOR_EXECUTION"
   }
   ```

4. **Wait for Execution Token**:
   Wait until the supervisor issues your `EXECUTION_TOKEN` before performing any write or command actions.

---

## Architectural Protocol & State Machine

```
RUNNING -> DRAINING -> CHECKPOINTED -> PREPARING -> READY -> RUNNING (next epoch)
```

- **WorkspaceLease (CAS)**: Guaranteed single writer per `workspaceKey` via atomic epoch comparison.
- **Outbox Queue**: Durable queue for delivery of handoff notifications and checkpoints.
- **Authoritative Task Graph**: Enforces test evidence requirements and prevents scope creep.
- **Immutable Input Ledger**: Preserves historical human prompts and explicit revisions via `supersedes`.
