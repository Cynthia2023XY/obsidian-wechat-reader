import type { ReaderData } from '../collector/types';

/** 本库阅读操作串行保存；撤销只恢复 read，不覆盖收藏和归档。 */
export class ReadingStore {
    private pending: Promise<unknown> = Promise.resolve();
    private revisions = new Map<string, number>();
    private generation = 0;
    private undoState?: { generation: number; values: Map<string, boolean | undefined> };
    constructor(private data: ReaderData, private save: () => Promise<void>, private changed: () => void) {}
    revision(id: string): number { return this.revisions.get(id) || 0; }
    set(ids: string[], read: boolean, manual = true, expected?: number): Promise<number> {
        const targets = [...new Set(ids)];
        if (manual) for (const id of targets) this.revisions.set(id, this.revision(id) + 1);
        const generation = ++this.generation;
        this.undoState = undefined;
        return this.enqueue(async () => {
            const values = new Map<string, boolean | undefined>();
            for (const id of targets) {
                if (!manual && expected !== undefined && this.revision(id) !== expected) continue;
                if (!!this.data.reading[id]?.read === read) continue;
                values.set(id, this.data.reading[id]?.read);
                this.data.reading[id] = { ...this.data.reading[id], read };
            }
            if (!values.size) return 0;
            try { await this.save(); }
            catch (error) { this.restore(values); this.changed(); throw error; }
            if (manual && generation === this.generation) this.undoState = { generation, values };
            this.changed();
            return values.size;
        });
    }
    get undoToken(): number { return this.generation; }
    undo(token = this.generation): Promise<boolean> {
        const state = this.undoState;
        if (!state || token !== this.generation || state.generation !== this.generation) return Promise.resolve(false);
        this.undoState = undefined;
        ++this.generation;
        for (const id of state.values.keys()) this.revisions.set(id, this.revision(id) + 1);
        return this.enqueue(async () => {
            const current = new Map([...state.values.keys()].map(id => [id, this.data.reading[id]?.read]));
            this.restore(state.values);
            try { await this.save(); }
            catch (error) { this.restore(current); this.changed(); throw error; }
            this.changed();
            return true;
        });
    }
    private restore(values: Map<string, boolean | undefined>): void {
        for (const [id, read] of values) {
            const state = this.data.reading[id] ||= {};
            if (read === undefined) delete state.read;
            else state.read = read;
        }
    }
    private enqueue<T>(action: () => Promise<T>): Promise<T> {
        const task = this.pending.catch(() => undefined).then(action);
        this.pending = task;
        return task;
    }
}
