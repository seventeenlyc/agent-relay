import { randomUUID } from 'node:crypto';

export interface OutboxMessage {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  createdAt: number;
}

export class OutboxQueue {
  private messages: Map<string, OutboxMessage> = new Map();

  public enqueue(topic: string, payload: Record<string, unknown>): OutboxMessage {
    const msg: OutboxMessage = {
      id: randomUUID(),
      topic,
      payload: { ...payload },
      status: 'pending',
      createdAt: Date.now()
    };
    this.messages.set(msg.id, msg);
    return { ...msg, payload: { ...msg.payload } };
  }

  public markDelivered(id: string): void {
    const msg = this.messages.get(id);
    if (msg) {
      msg.status = 'delivered';
    }
  }

  public getPending(): OutboxMessage[] {
    return Array.from(this.messages.values())
      .filter((m) => m.status === 'pending')
      .map((m) => ({ ...m, payload: { ...m.payload } }));
  }
}
