import { randomUUID } from 'node:crypto';
import type { HandoffAckPacket } from '../../../protocol/src/types.ts';

export type HandoffState =
  | 'RUNNING'
  | 'DRAINING'
  | 'CHECKPOINTED'
  | 'STARTING'
  | 'PREPARING'
  | 'READY'
  | 'PAUSED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export class HandoffStateMachine {
  public readonly runId: string;
  private state: HandoffState;
  private currentOwner: string;
  private epoch: number;
  private pendingAck?: HandoffAckPacket;

  constructor(
    runId: string,
    initialOwner: string,
    initialEpoch = 1
  ) {
    this.runId = runId;
    this.currentOwner = initialOwner;
    this.epoch = initialEpoch;
    this.state = 'RUNNING';
  }

  public getState(): HandoffState {
    return this.state;
  }

  public getCurrentOwner(): string {
    return this.currentOwner;
  }

  public getEpoch(): number {
    return this.epoch;
  }

  public getPendingAck(): HandoffAckPacket | undefined {
    return this.pendingAck ? { ...this.pendingAck } : undefined;
  }

  public requestHandoff(_reason: string): void {
    if (this.state !== 'RUNNING') {
      throw new Error(`Cannot request handoff in state ${this.state}`);
    }
    this.state = 'DRAINING';
  }

  public checkpointCompleted(_checkpointHash?: string): void {
    if (this.state !== 'DRAINING') {
      throw new Error(`Cannot complete checkpoint in state ${this.state}`);
    }
    this.state = 'CHECKPOINTED';
  }

  public startNewSession(newSessionId: string): void {
    if (this.state !== 'CHECKPOINTED') {
      throw new Error(`Cannot start new session in state ${this.state}`);
    }
    this.state = 'PREPARING';
    this.currentOwner = newSessionId;
  }

  public receiveAck(ack: HandoffAckPacket): void {
    if (this.state !== 'PREPARING') {
      throw new Error(`Cannot receive ACK in state ${this.state}`);
    }
    if (ack.runId && ack.runId !== this.runId) {
      throw new Error(`Run ID mismatch: expected ${this.runId}, got ${ack.runId}`);
    }
    this.pendingAck = ack;
    this.state = 'READY';
  }

  public issueExecutionToken(): { token: string; epoch: number } {
    if (this.state !== 'READY') {
      throw new Error(`Cannot issue execution token in state ${this.state}`);
    }
    this.epoch++;
    this.state = 'RUNNING';
    return {
      token: `EXEC_TOKEN_${randomUUID()}`,
      epoch: this.epoch
    };
  }

  public pause(): void {
    this.state = 'PAUSED';
  }

  public cancel(): void {
    this.state = 'CANCELLED';
  }
}
