import type { Article, ReaderData } from '../collector/types';
import { publishedTime } from '../collector/date';

/** 本库阅读操作串行保存；撤销只恢复 read，不覆盖收藏和归档。 */
export class ReadingStore {
    private pending: Promise<unknown> = Promise.resolve();
    private revisions = new Map<string, number>();
    private generation = 0;
    private undoState?: { generation: number; values: Map<string, boolean | undefined>; readBefore?: number; baselineChanged?: boolean };
    constructor(private data: ReaderData, private save: () => Promise<void>, private changed: () => void, private lookup: (id: string) => Article | undefined = () => undefined) {}
    /** 明确的手动状态优先；仅公众号的可靠发布时间参与全部已读基准。 */
    isRead(article: Article): boolean {
        // 已保存的状态始终覆盖自动推断，包括手动设为未读。
        const explicit = this.data.reading[article.id]?.read;
        if (explicit !== undefined) return explicit;
        // 无法确认发布时间的文章不自动标记为已读。
        const published = publishedTime(article.publishedAt);
        return article.id.startsWith('article_') && published !== undefined && Number.isFinite(this.data.readBefore) && published <= this.data.readBefore!;
    }
    /** 全局标记还记录基准，让稍后回补的历史文章保持已读。 */
    markAll(articles: Article[]): Promise<number> {
        // 一次构建文章索引，避免批量操作对每篇文章重复排序。
        const indexed = new Map(articles.map(article => [article.id, article]));
        return this.set(articles.map(article => article.id), true, true, undefined, Date.now(), indexed);
    }
    revision(id: string): number { return this.revisions.get(id) || 0; }
    set(ids: string[], read: boolean, manual = true, expected?: number, readBefore?: number, indexed?: Map<string, Article>): Promise<number> {
        // 单次操作按文章身份去重。
        const targets = [...new Set(ids)];
        if (manual) for (const id of targets) this.revisions.set(id, this.revision(id) + 1);
        // 新操作使旧撤销入口失效。
        const generation = ++this.generation;
        this.undoState = undefined;
        return this.enqueue(async () => {
            // 记录原始状态供失败回滚和撤销。
            const values = new Map<string, boolean | undefined>();
            // 基准与批量状态作为一次保存及撤销操作。
            const previousBaseline = this.data.readBefore;
            for (const id of targets) {
                if (!manual && expected !== undefined && this.revision(id) !== expected) continue;
                // 计算隐式已读，确保手动未读可以覆盖时间基准。
                const article = indexed ? indexed.get(id) : this.lookup(id);
                if ((article ? this.isRead(article) : !!this.data.reading[id]?.read) === read) continue;
                values.set(id, this.data.reading[id]?.read);
                this.data.reading[id] = { ...this.data.reading[id], read };
            }
            if (readBefore !== undefined) this.data.readBefore = readBefore;
            if (!values.size && readBefore === undefined) return 0;
            try { await this.save(); }
            catch (error) { this.restore(values); this.data.readBefore = previousBaseline; this.changed(); throw error; }
            if (manual && generation === this.generation) this.undoState = { generation, values, readBefore: previousBaseline, baselineChanged: readBefore !== undefined };
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
            // 撤销同时恢复此前基准，不影响其他阅读属性。
            const currentBaseline = this.data.readBefore;
            this.restore(state.values);
            if (state.baselineChanged) this.data.readBefore = state.readBefore;
            try { await this.save(); }
            catch (error) { this.restore(current); this.data.readBefore = currentBaseline; this.changed(); throw error; }
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
