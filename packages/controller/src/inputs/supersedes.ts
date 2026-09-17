import type { InputLedger } from './ledger.ts';
import type { RequirementContract } from '../../../protocol/src/types.ts';

export function deriveContractFromLedger(ledger: InputLedger): RequirementContract {
  const humanInputs = ledger.getHumanInputs();
  const goals: string[] = [];
  const forbiddenItems: string[] = [];
  const sourceInputIds: string[] = [];
  let version = 1;

  const supersededIds = new Set<string>();
  for (const record of humanInputs) {
    if (record.supersedesId) {
      supersededIds.add(record.supersedesId);
      version++;
    }
  }

  for (const record of humanInputs) {
    sourceInputIds.push(record.inputId);
    if (supersededIds.has(record.inputId)) {
      continue;
    }
    const text = record.rawContent;

    // Detect explicit forbidden items (e.g. "do not ...", "不要 ...", "禁止 ...")
    // Support zero-whitespace after Chinese keywords as well as English
    const forbiddenMatches = [...text.matchAll(/(?:(?:do not|don't)\s+|(?:不要|禁止)\s*)([^,，.。\n]+)/gi)];
    if (forbiddenMatches.length > 0) {
      for (const m of forbiddenMatches) {
        if (m[1]) {
          const item = m[1].trim();
          if (!forbiddenItems.includes(item)) {
            forbiddenItems.push(item);
          }
        }
      }
    }

    // Also extract goals: clauses that do not contain forbidden keywords
    const clauses = text.split(/[.。\n]+/).map((s) => s.trim()).filter(Boolean);
    let addedGoal = false;
    for (const clause of clauses) {
      if (!/(?:do not|don't|不要|禁止)/i.test(clause)) {
        goals.push(clause);
        addedGoal = true;
      }
    }
    if (!addedGoal && forbiddenMatches.length === 0) {
      goals.push(text.trim());
    }
  }

  return {
    requirementId: 'req-root',
    version,
    goals,
    scopePaths: [],
    forbiddenItems,
    acceptanceCriteria: ['All tests green', 'No forbidden items violated'],
    sourceInputIds,
    status: 'active'
  };
}
