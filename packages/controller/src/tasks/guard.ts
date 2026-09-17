import path from 'node:path';
import type { RequirementContract } from '../../../protocol/src/types.ts';

export class ScopeGuard {
  private contract: RequirementContract;

  constructor(contract: RequirementContract) {
    this.contract = contract;
  }

  public updateContract(contract: RequirementContract): void {
    this.contract = contract;
  }

  public getContract(): RequirementContract {
    return this.contract;
  }

  public verifyPathAccess(filePath: string): void {
    if (!this.contract.scopePaths || this.contract.scopePaths.length === 0) {
      return; // If open scope, allow
    }

    const normalized = filePath.replace(/\\/g, '/');
    const cleanPath = path.posix.normalize(normalized).replace(/^\.\//, '');

    const isAllowed = this.contract.scopePaths.some((p) => {
      const normP = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
      if (normP === '.' || normP === '') {
        return !cleanPath.startsWith('../');
      }
      if (cleanPath === normP) {
        return true;
      }
      const prefix = normP.endsWith('/') ? normP : normP + '/';
      return cleanPath.startsWith(prefix);
    });

    if (!isAllowed) {
      throw new Error(`ScopeGuard: Scope violation. Path "${filePath}" not permitted in requirement ${this.contract.requirementId}`);
    }
  }

  public verifyProposedAction(actionDescription: string): void {
    if (!this.contract.forbiddenItems || this.contract.forbiddenItems.length === 0) {
      return;
    }

    const lowerAction = actionDescription.toLowerCase();
    for (const forbidden of this.contract.forbiddenItems) {
      const trimmed = forbidden.trim().toLowerCase();
      if (!trimmed) {
        continue;
      }

      // Check full string and stripped keyword variant (e.g. "禁止修改" -> "修改")
      const stripped = trimmed.replace(/^(?:do not|don't|不要|禁止)\s*/i, '').trim();

      if (lowerAction.includes(trimmed) || (stripped.length > 0 && lowerAction.includes(stripped))) {
        throw new Error(`ScopeGuard: Forbidden item detected. Action "${actionDescription}" violates "${forbidden}"`);
      }
    }
  }

  public verifyActionInScope(filePath: string): void {
    this.verifyPathAccess(filePath);
  }

  public detectUnapprovedScopeExpansion(filePath: string): boolean {
    try {
      this.verifyPathAccess(filePath);
      return false;
    } catch {
      return true;
    }
  }
}
