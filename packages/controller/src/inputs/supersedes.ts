import type { InputLedger } from './ledger.ts';
import type { RequirementContract } from '../../../protocol/src/types.ts';

export function deriveContractFromLedger(ledger: InputLedger): RequirementContract {
  const humanInputs = ledger.getHumanInputs();
  const goals: string[] = [];
  const forbiddenItems: string[] = [];
  const sourceInputIds: string[] = [];
  let version = 1;

  for (const record of humanInputs) {
    sourceInputIds.push(record.inputId);
    const text = record.rawContent;

    // Detect explicit forbidden items (e.g. "do not ...", "不要 ...", "禁止 ...")
    const forbiddenMatch = text.match(/(?:do not|don't|不要|禁止)\s+([^,，.。\n]+)/i);
    if (forbiddenMatch && forbiddenMatch[1]) {
      const item = forbiddenMatch[1].trim();
      if (!forbiddenItems.includes(item)) {
        forbiddenItems.push(item);
      }
    } else {
      goals.push(text);
    }

    if (record.supersedesId) {
      version++;
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
