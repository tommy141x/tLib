import { type Layout, sameLayout } from "./geometry";
export interface Change {
  key: string;
  before: Layout;
  after: Layout;
}
/** Call record once at pointer/key gesture end, not for intermediate previews. */
export class LayoutHistory {
  private past: Change[] = [];
  private future: Change[] = [];
  constructor(private readonly limit = 100) {}
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  record(key: string, before: Layout, after: Layout) {
    if (sameLayout(before, after)) return;
    this.past.push({ key, before: { ...before }, after: { ...after } });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(): { key: string; layout: Layout } | undefined {
    const entry = this.past.pop();
    if (!entry) return;
    this.future.push(entry);
    return { key: entry.key, layout: { ...entry.before } };
  }
  redo(): { key: string; layout: Layout } | undefined {
    const entry = this.future.pop();
    if (!entry) return;
    this.past.push(entry);
    return { key: entry.key, layout: { ...entry.after } };
  }
  remove(key: string) {
    this.past = this.past.filter((entry) => entry.key !== key);
    this.future = this.future.filter((entry) => entry.key !== key);
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
