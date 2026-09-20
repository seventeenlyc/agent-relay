import fs from 'node:fs';
import path from 'node:path';

function getTimestampString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export class ConfigMerger {
  public backupFile(targetPath: string): string | null {
    if (!fs.existsSync(targetPath)) return null;
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath);
    const base = path.basename(targetPath, ext);
    const backupPath = path.join(dir, `${base}${ext}.bak.${getTimestampString()}`);
    fs.copyFileSync(targetPath, backupPath);
    return backupPath;
  }

  public mergeJsonFile<T = any>(
    targetPath: string,
    updater: (existing: any) => any
  ): { backupPath: string | null; updated: T } {
    let existing: any = {};
    let backupPath: string | null = null;

    if (fs.existsSync(targetPath)) {
      backupPath = this.backupFile(targetPath);
      try {
        const raw = fs.readFileSync(targetPath, 'utf8');
        existing = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        existing = {};
      }
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    const updated = updater(existing);
    const jsonStr = JSON.stringify(updated, null, 2);
    const tmpPath = `${targetPath}.tmp`;
    fs.writeFileSync(tmpPath, jsonStr, 'utf8');
    fs.renameSync(tmpPath, targetPath);

    return { backupPath, updated };
  }

  public mergeMarkdownBlock(
    targetPath: string,
    blockContent: string,
    blockTag = 'AGENT_RELAY'
  ): { backupPath: string | null } {
    const startTag = `<!-- ${blockTag}_START -->`;
    const endTag = `<!-- ${blockTag}_END -->`;
    const wrappedBlock = `\n${startTag}\n${blockContent}\n${endTag}\n`;

    let backupPath: string | null = null;
    let original = '';

    if (fs.existsSync(targetPath)) {
      backupPath = this.backupFile(targetPath);
      original = fs.readFileSync(targetPath, 'utf8');
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    const regex = new RegExp(`${startTag}[\\s\\S]*?${endTag}`, 'm');
    let finalContent = '';
    if (regex.test(original)) {
      finalContent = original.replace(regex, `${startTag}\n${blockContent}\n${endTag}`);
    } else {
      finalContent = original ? `${original.trimEnd()}\n${wrappedBlock}` : wrappedBlock.trimStart();
    }

    const tmpPath = `${targetPath}.tmp`;
    fs.writeFileSync(tmpPath, finalContent, 'utf8');
    fs.renameSync(tmpPath, targetPath);

    return { backupPath };
  }

  public removeJsonManagedEntries(
    targetPath: string,
    predicate: (item: any) => boolean
  ): boolean {
    if (!fs.existsSync(targetPath)) return false;
    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const json = JSON.parse(raw);
      let changed = false;

      if (Array.isArray(json.hooks)) {
        const origLen = json.hooks.length;
        json.hooks = json.hooks.filter((h: any) => !predicate(h));
        if (json.hooks.length !== origLen) changed = true;
      }

      if (changed) {
        this.backupFile(targetPath);
        const tmpPath = `${targetPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(json, null, 2), 'utf8');
        fs.renameSync(tmpPath, targetPath);
      }
      return changed;
    } catch {
      return false;
    }
  }

  public removeMarkdownBlock(targetPath: string, blockTag = 'AGENT_RELAY'): boolean {
    if (!fs.existsSync(targetPath)) return false;
    const startTag = `<!-- ${blockTag}_START -->`;
    const endTag = `<!-- ${blockTag}_END -->`;
    const regex = new RegExp(`\\n?${startTag}[\\s\\S]*?${endTag}\\n?`, 'm');

    const original = fs.readFileSync(targetPath, 'utf8');
    if (regex.test(original)) {
      this.backupFile(targetPath);
      const replaced = original.replace(regex, '\n').trim() + '\n';
      const tmpPath = `${targetPath}.tmp`;
      fs.writeFileSync(tmpPath, replaced, 'utf8');
      fs.renameSync(tmpPath, targetPath);
      return true;
    }
    return false;
  }
}
