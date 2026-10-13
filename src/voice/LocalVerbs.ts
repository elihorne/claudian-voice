import type { App } from 'obsidian';

/** A spoken instruction handled inside Obsidian, without the agent. */
export type LocalVerb =
  | { kind: 'capture'; text: string }
  | { kind: 'read-note' }
  | { kind: 'stop-reading' }
  | { kind: 'skip' };

const CAPTURE_PREFIXES = ['note to self', 'capture', 'remember', 'jot down', 'add to my notes'];

/** Recognises local verbs at the start of an utterance. Returns null when the agent should get it. */
export function parseLocalVerb(utterance: string): LocalVerb | null {
  const text = utterance.trim();
  const lower = text.toLowerCase().replace(/[.!?]+$/, '');
  for (const prefix of CAPTURE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const rest = text.slice(prefix.length).replace(/^[\s,:;-]+/, '').trim();
      return rest ? { kind: 'capture', text: rest } : null;
    }
  }
  if (/^(read (this|the) (note|page)( to me| aloud)?|read it to me|read from here)$/.test(lower)) return { kind: 'read-note' };
  if (/^(stop reading|stop)$/.test(lower)) return { kind: 'stop-reading' };
  if (/^(skip|next section|skip (this|that) section)$/.test(lower)) return { kind: 'skip' };
  return null;
}

/** Appends a timestamped line to today's daily note, creating the note if it does not exist. */
export async function appendToDailyNote(app: App, text: string): Promise<string> {
  const { folder, format } = dailyNoteSettings(app);
  const moment = (window as unknown as { moment: (d?: Date) => { format(f: string): string } }).moment;
  const stamp = moment();
  const name = stamp.format(format || 'YYYY-MM-DD');
  const path = `${folder ? `${folder.replace(/\/$/, '')}/` : ''}${name}.md`;
  const adapter = app.vault.adapter;
  if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
  const line = `- ${stamp.format('HH:mm')} ${text}`;
  if (await adapter.exists(path)) {
    const existing = await adapter.read(path);
    const body = existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
    await adapter.write(path, `${body}${line}\n`);
  } else {
    await adapter.write(path, `# ${name}\n\n${line}\n`);
  }
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
