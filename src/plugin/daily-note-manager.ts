import { App, TFile, Notice } from "obsidian";
import type { Reminders, Reminder } from "../model/reminder";
import type { Settings } from "../plugin/settings";
import { DateTime } from "../model/time";
import { Todo } from "../model/format/markdown";
import moment from "moment";

export class DailyNoteManager {
  private isUpdating = false;

  constructor(
    private app: App,
    private reminders: Reminders,
    private settings: Settings,
    private updateReminder: (reminder: Reminder, checked: boolean) => Promise<void>
  ) {}

  public async updateDailyNote(quiet: boolean = true, specificDate?: DateTime) {
    if (!this.settings.autoEmbedTodosInDailyNote.value || this.isUpdating) {
      return;
    }

    const targetDate = specificDate || DateTime.now();
    const dailyNote = this.findDailyNote(targetDate);
    if (!dailyNote) {
      if (!quiet) {
        new Notice(`未找到日记本 (${targetDate.toYYYYMMDD()})`);
      }
      return;
    }

    this.isUpdating = true;
    try {
      console.info(`[DailyNoteManager] Total reminders in system: ${this.reminders.reminders.length}`);
      const todosOfDate = this.reminders.byDate(targetDate);
      console.info(`[DailyNoteManager] Filtered reminders for ${targetDate.toYYYYMMDD()}: ${todosOfDate.length}`);
      
      const content = await this.app.vault.read(dailyNote);
      const newContentString = this.updateReminderSection(content, todosOfDate);

      if (newContentString === null) {
        if (!quiet) {
          const marker = this.settings.dailyNoteSectionMarker.value;
          new Notice(`未找到嵌入标记: <!-- start of ${marker} -->`);
        }
        return;
      }

      if (content !== newContentString) {
        console.info(`Updating daily note content for ${targetDate.toYYYYMMDD()}...`);
        await this.app.vault.modify(dailyNote, newContentString);
        if (!quiet) {
          new Notice(`日记本待办事项已更新 (${targetDate.toYYYYMMDD()})`);
        }
      } else if (!quiet) {
        new Notice("日记本已是最新状态");
      }
    } catch (e) {
      console.error("Failed to update daily note:", e);
      if (!quiet) {
        new Notice("更新日记本失败，请查看控制台日志");
      }
    } finally {
      this.isUpdating = false;
    }
  }

  public getDailyNoteDate(file: TFile): DateTime | null {
    // Standard Obsidian Daily Note format is YYYY-MM-DD
    const match = file.name.match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) {
        return null;
    }
    const dateStr = match[1];
    const parsed = moment(dateStr, "YYYY-MM-DD");
    if (parsed.isValid()) {
        return new DateTime(parsed, false);
    }
    return null;
  }

  private findDailyNote(date: DateTime): TFile | null {
    const dateStr = date.toYYYYMMDD();
    const files = this.app.vault.getMarkdownFiles();
    // 1. Precise match (filename is exactly YYYY-MM-DD.md)
    let matchingFiles = files.filter((f: TFile) => f.basename === dateStr);
    
    // 2. Loose match (filename contains YYYY-MM-DD)
    if (matchingFiles.length === 0) {
      matchingFiles = files.filter((f: TFile) => f.name.includes(dateStr));
    }

    if (matchingFiles.length === 0) {
      return null;
    }
    // Return the most recently modified matching file
    return matchingFiles.reduce((prev: TFile, current: TFile) => (prev.stat.mtime > current.stat.mtime) ? prev : current);
  }

  private updateReminderSection(content: string, reminders: Reminder[]): string | null {
    const marker = this.settings.dailyNoteSectionMarker.value;
    const startMarker = `<!-- start of ${marker} -->`;
    const endMarker = `<!-- end of ${marker} -->`;

    console.info(`[DailyNoteManager] Searching for markers: "${startMarker}" and "${endMarker}"`);

    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1) {
      console.warn(`[DailyNoteManager] Markers not found in file content. Start: ${startIndex}, End: ${endIndex}`);
      return null;
    }

    const reminderLines = reminders.map(r => {
      console.info(`[DailyNoteManager] Embedding reminder: "${r.title}", done: ${r.done}`);
      const check = r.done ? "x" : " ";
      return `- [${check}] ${r.title} [[${r.file}|source]] <!-- reminder-key: ${r.key()} -->`;
    }).join("\n");

    const newSection = `${startMarker}\n${reminderLines}\n${endMarker}`;

    return content.substring(0, startIndex) + newSection + content.substring(endIndex + endMarker.length);
  }

  public async handleFileModify(file: TFile) {
    if (this.isUpdating || !this.settings.autoEmbedTodosInDailyNote.value) {
      return;
    }

    const fileDate = this.getDailyNoteDate(file);
    if (!fileDate) {
      return;
    }

    console.debug("Daily note modified, checking for sync...", file.path, fileDate.toYYYYMMDD());
    const contentString = await this.app.vault.read(file);
    const marker = this.settings.dailyNoteSectionMarker.value;
    const startMarker = `<!-- start of ${marker} -->`;
    const endMarker = `<!-- end of ${marker} -->`;

    const startIndex = contentString.indexOf(startMarker);
    const endIndex = contentString.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1) {
      return;
    }

    const sectionContent = contentString.substring(startIndex + startMarker.length, endIndex);
    const lines = sectionContent.split("\n");
    
    const todosOfDate = this.reminders.byDate(fileDate);

    let changed = false;
    for (const line of lines) {
      const todo = Todo.parse(0, line.trim());
      if (todo) {
        const keyMatch = todo.body.match(/<!-- reminder-key: (.*?) -->/);
        const key = keyMatch ? keyMatch[1] : null;
        
        const matchingReminder = todosOfDate.find(r => {
            if (key) {
                return r.key() === key;
            }
            return todo.body.startsWith(r.title);
        });

        if (matchingReminder) {
          const isChecked = todo.isChecked();
          if (matchingReminder.done !== isChecked) {
            console.debug("Syncing checkbox state back to source:", matchingReminder.title, isChecked);
            await this.updateReminder(matchingReminder, isChecked);
            changed = true;
          }
        }
      }
    }

    if (!changed) {
        await this.updateDailyNote(true, fileDate);
    }
  }
}
