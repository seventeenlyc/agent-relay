import type { TaskItem } from './types.ts';

export function validateTaskItem(task: Partial<TaskItem>): asserts task is TaskItem {
  if (!task.taskId || typeof task.taskId !== 'string') {
    throw new Error('validateTaskItem: taskId is required');
  }
  if (!task.requirementId || typeof task.requirementId !== 'string') {
    throw new Error('validateTaskItem: requirementId is required');
  }
  if (!task.title || typeof task.title !== 'string') {
    throw new Error('validateTaskItem: title is required');
  }
  if (!task.status || !['pending', 'in_progress', 'verifying', 'completed', 'cancelled', 'blocked'].includes(task.status)) {
    throw new Error('validateTaskItem: invalid status');
  }
  if (task.status === 'completed' && !task.testEvidenceHash) {
    throw new Error('validateTaskItem: completed status requires testEvidenceHash');
  }
}
