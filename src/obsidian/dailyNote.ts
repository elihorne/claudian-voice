import { type App, normalizePath, TFile } from 'obsidian';

/** Appends a timestamped line to today's daily note, creating the note if it does not exist. */
export async function appendToDailyNote(app: App, text: string): Promise<string> {
  const { folder, format } = dailyNoteSettings(app);
  const moment = (window as unknown as { moment: (d?: Date) => { format(f: string): string } }).moment;
  const stamp = moment();
  const name = stamp.format(format || 'YYYY-MM-DD');
  const path = normalizePath(`${folder ? `${folder.replace(/\/$/, '')}/` : ''}${name}.md`);
  const line = `- ${stamp.format('HH:mm')} ${text}`;
  // Go through the vault API (not the raw adapter) so open editors and metadata refresh.
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    const current = await app.vault.read(existing);
    const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await app.vault.append(existing, `${separator}${line}\n`);
    return path;
  }
  if (folder) {
    const normalizedFolder = normalizePath(folder);
    if (!app.vault.getAbstractFileByPath(normalizedFolder)) await app.vault.createFolder(normalizedFolder);
  }
  await app.vault.create(path, `# ${name}\n\n${line}\n`);
  return path;
}

function dailyNoteSettings(app: App): { folder: string; format: string } {
  const internal = (app as unknown as {
    internalPlugins?: { plugins?: Record<string, { enabled?: boolean; instance?: { options?: { folder?: string; format?: string } } }> };
    plugins?: { plugins?: Record<string, { settings?: { daily?: { folder?: string; format?: string }; dailyNotes?: { folder?: string; format?: string } } }> };
  });
  // Periodic Notes plugin takes precedence when installed, then the core Daily notes plugin.
  const periodic = internal.plugins?.plugins?.['periodic-notes']?.settings;
  const periodicDaily = periodic?.daily ?? periodic?.dailyNotes;
  if (periodicDaily?.format || periodicDaily?.folder) return { folder: periodicDaily.folder ?? '', format: periodicDaily.format ?? 'YYYY-MM-DD' };
  const core = internal.internalPlugins?.plugins?.['daily-notes']?.instance?.options;
  return { folder: core?.folder ?? '', format: core?.format ?? 'YYYY-MM-DD' };
}
