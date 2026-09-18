import { computeSha256, serializeCanonicalJson, validateTaskItem } from '../../../protocol/src/index.ts';
import type { TaskItem, TaskStatus } from '../../../protocol/src/types.ts';

export class TaskGraph {
  private tasks: Map<string, TaskItem> = new Map();

  public addTask(params: {
    taskId: string;
    requirementId: string;
    title: string;
    description?: string;
    dependencies?: string[];
    allowedPaths?: string[];
    expectedArtifacts?: string[];
  }): TaskItem {
    if (this.tasks.has(params.taskId)) {
      throw new Error(`TaskGraph: Task ${params.taskId} already exists`);
    }

    const deps = params.dependencies || [];
    if (deps.includes(params.taskId)) {
      throw new Error(`TaskGraph: Task ${params.taskId} cannot depend on itself`);
    }

    // Check for circular dependency with existing tasks
    for (const dep of deps) {
      if (this.wouldCreateCycle(dep, params.taskId)) {
        throw new Error(`TaskGraph: Adding task ${params.taskId} creates a circular dependency with ${dep}`);
      }
    }

    const task: TaskItem = {
      taskId: params.taskId,
      requirementId: params.requirementId,
      title: params.title,
      description: params.description || '',
      dependencies: deps,
      status: 'pending',
      allowedPaths: params.allowedPaths || [],
      expectedArtifacts: params.expectedArtifacts || []
    };

    validateTaskItem(task);
    this.tasks.set(params.taskId, task);
    return task;
  }

  /**
   * 从持久化快照逐字重建任务图（重启恢复用）。
   * 保留 status / testEvidenceHash / completedAt，因此 computeSnapshotHash() 可稳定复现。
   * 校验：依赖必须存在、不得自引用、不得成环、completed 必须携带证据。
   * 任何一条不合法即整体拒绝，不留下半还原状态。
   */
  public restoreFrom(items: TaskItem[]): void {
    if (items.length === 0) {
      return;
    }

    const staged: TaskItem[] = [];
    const stagedById = new Map<string, TaskItem>();
    for (const item of items) {
      const existing = this.tasks.get(item.taskId) ?? stagedById.get(item.taskId);
      if (existing) {
        continue; // 幂等：已存在的任务不重复还原
      }
      const copy: TaskItem = {
        taskId: item.taskId,
        requirementId: item.requirementId,
        title: item.title,
        description: item.description,
        dependencies: [...item.dependencies],
        status: item.status,
        allowedPaths: [...item.allowedPaths],
        expectedArtifacts: [...item.expectedArtifacts],
        testEvidenceHash: item.testEvidenceHash,
        completedAt: item.completedAt
      };
      validateTaskItem(copy);
      if (copy.dependencies.includes(copy.taskId)) {
        throw new Error(`TaskGraph: Task ${copy.taskId} cannot depend on itself`);
      }
      if (copy.status === 'completed' && !copy.testEvidenceHash) {
        throw new Error(`TaskGraph: Task ${copy.taskId} completed status requires testEvidenceHash`);
      }
      staged.push(copy);
      stagedById.set(copy.taskId, copy);
    }

    for (const task of staged) {
      for (const dep of task.dependencies) {
        if (!this.tasks.has(dep) && !stagedById.has(dep)) {
          throw new Error(`TaskGraph: Task ${task.taskId} has unknown dependency ${dep}`);
        }
        if (this.wouldCreateCycle(dep, task.taskId)) {
          throw new Error(`TaskGraph: Restoring task ${task.taskId} creates a circular dependency with ${dep}`);
        }
      }
    }

    for (const task of staged) {
      this.tasks.set(task.taskId, task);
    }
  }

  private wouldCreateCycle(startId: string, targetId: string): boolean {
    const visited = new Set<string>();
    const queue = [startId];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr === targetId) {
        return true;
      }
      if (visited.has(curr)) {
        continue;
      }
      visited.add(curr);

      const t = this.tasks.get(curr);
      if (t && t.dependencies) {
        for (const next of t.dependencies) {
          if (!visited.has(next)) {
            queue.push(next);
          }
        }
      }
    }

    return false;
  }

  public getTask(taskId: string): TaskItem | undefined {
    const task = this.tasks.get(taskId);
    return task
      ? {
          ...task,
          dependencies: [...task.dependencies],
          allowedPaths: [...task.allowedPaths],
          expectedArtifacts: [...task.expectedArtifacts]
        }
      : undefined;
  }

  public updateTaskStatus(taskId: string, status: TaskStatus): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`TaskGraph: Task ${taskId} not found`);
    }
    if (status === 'completed' && !task.testEvidenceHash) {
      throw new Error(`TaskGraph: Task ${taskId} completed status requires testEvidenceHash`);
    }
    task.status = status;
    if (status === 'completed' && !task.completedAt) {
      task.completedAt = Date.now();
    }
  }

  public completeTaskWithEvidence(taskId: string, evidenceHash: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`TaskGraph: Task ${taskId} not found`);
    }
    if (!evidenceHash || evidenceHash.trim() === '') {
      throw new Error('TaskGraph: evidenceHash is required to complete task');
    }
    task.testEvidenceHash = evidenceHash;
    task.status = 'completed';
    task.completedAt = Date.now();
  }

  public getNextActionableTask(): TaskItem | undefined {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        const depsSatisfied = task.dependencies.every((depId) => {
          const dep = this.tasks.get(depId);
          return dep !== undefined && dep.status === 'completed';
        });
        if (depsSatisfied) {
          return task;
        }
      }
    }
    return undefined;
  }

  public isAllCompleted(): boolean {
    if (this.tasks.size === 0) {
      return false;
    }
    return Array.from(this.tasks.values()).every((t) => t.status === 'completed' || t.status === 'cancelled');
  }

  public computeSnapshotHash(): string {
    const sortedTasks = [...this.getAllTasks()].sort((a, b) => a.taskId.localeCompare(b.taskId));
    return computeSha256(serializeCanonicalJson(sortedTasks));
  }

  public getAllTasks(): TaskItem[] {
    return Array.from(this.tasks.values()).map((t) => ({
      ...t,
      dependencies: [...t.dependencies],
      allowedPaths: [...t.allowedPaths],
      expectedArtifacts: [...t.expectedArtifacts]
    }));
  }

  public getPendingTasks(): TaskItem[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === 'pending')
      .map((t) => ({
        ...t,
        dependencies: [...t.dependencies],
        allowedPaths: [...t.allowedPaths],
        expectedArtifacts: [...t.expectedArtifacts]
      }));
  }
}
