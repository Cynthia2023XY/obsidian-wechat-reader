import { Collector } from './collector';
import { Problem, Store, utc } from './core';
import type { StoredAccount, StoredJob } from './core';
import type { Article } from '../src/collector/types';
/** 唯一公众号串行调度器，手动和自动请求共享 SQLite 队列 */
export class Scheduler {
    /** 停止后不再发起下一篇下载 */
    stopped = false;
    /** 当前任务执行状态用于安全退出 */
    busy = false;
    /** 唯一后台循环计时器 */
    private timer?: ReturnType<typeof setTimeout>;
    /** 每篇请求间隔可由测试夹具缩短，正式沿用五秒 */
    constructor(private store: Store, private collector: Collector, private delay = 5000) { }
    /** 启动一个循环，避免 setInterval 造成采集重入 */
    start(): void { void this.loop(); }
    /** 请求安全停止，当前有界请求收尾后退出 */
    stop(): void { this.stopped = true; if (this.timer)
        clearTimeout(this.timer); }
    /** 每个到期订阅最多补排一个任务，验证状态不自动重试 */
    scheduleDue(): void { if (!this.collector.auth.status().loggedIn)
        return; for (const account of this.store.all<StoredAccount>('accounts'))
        if (account.subscribed && account.autoSync && !account.blocked && account.nextSyncAt <= Date.now() / 1000)
            this.store.enqueue(account.id, 'automatic'); }
    /** 一轮任务持久化进度，并保留在途用户设置 */
    async run(job: StoredJob): Promise<void> {
        job = this.store.get('jobs', job.id);
        if (job.state !== 'queued')
            return;
        // 工作线程提取后再次核对状态，取消的任务不能复活。
        const account = this.store.get<StoredAccount>('accounts', job.accountId);
        job.state = 'running';
        job.startedAt = utc();
        this.store.put('jobs', job);
        // 首轮十篇；后续每轮最多三十篇。
        const limit = account.firstSync ? 10 : 30;
        // 用户输入的历史原文优先下载，不被近期列表挤出上限。
        const pending: string[] = [];
        if (job.priorityArticleId) {
            // 本次操作所属的文章，不复用界面稍后的选择。
            const article = this.store.get<Article>('articles', job.priorityArticleId);
            if (['pending', 'temporary_failure'].includes(article.state))
                pending.push(article.id);
        }
        try {
            // 每页遇到一个旧项不能立即截断整轮。
            let offset = 0, more = false;
            while (offset < limit && job.source !== 'retry') {
                // 上游分页数量受本轮额度约束。
                const page = await this.collector.page(account, offset, 10);
                more = page.more;
                // 每页判断新增计数，不按标题或单个旧项停止。
                let freshCount = 0;
                for (const item of page.items.slice(0, 10)) {
                    // 发现结果和新增标识，用于准确统计及增量停止。
                    const { article, fresh } = this.store.discover(account, item);
                    freshCount += Number(fresh);
                    job.discovered += Number(fresh);
                    if (['pending', 'temporary_failure'].includes(article.state) && !pending.includes(article.id))
                        pending.push(article.id);
                }
                this.store.put('jobs', job);
                offset += 10;
                if (!page.items.length || !more || freshCount === 0)
                    break;
            }
            // 历史积压按持久化偏移继续，每轮仍有上限。
            const backlog = account.nextOffset || 0;
            if (job.source !== 'retry' && !account.firstSync && backlog && pending.length < limit && offset < limit) {
                // 本轮读取的页面或分页结果。
                const page = await this.collector.page(account, backlog, 10);
                for (const item of page.items.slice(0, 10)) {
                    // 发现结果和新增标识，用于准确统计及增量停止。
                    const { article, fresh } = this.store.discover(account, item);
                    job.discovered += Number(fresh);
                    if (['pending', 'temporary_failure'].includes(article.state) && !pending.includes(article.id))
                        pending.push(article.id);
                }
                account.nextOffset = page.more ? backlog + 10 : 0;
            }
            else if (more && offset >= limit)
                account.nextOffset = Math.max(backlog, offset);
            for (const article of this.store.all<Article>('articles'))
                if (article.accountId === account.id && ['pending', 'temporary_failure'].includes(article.state) && !pending.includes(article.id))
                    pending.push(article.id);
            for (const id of pending.slice(0, limit)) {
                if (this.stopped)
                    throw new Problem('INTERRUPTED', '采集已安全停止，可以重新同步', true);
                // 下载状态先落盘，异常退出时可修复为临时失败。
                const article = this.store.get<Article>('articles', id);
                article.state = 'downloading';
                this.store.put('articles', article);
                try {
                    await this.collector.download(article, this.store);
                    job.succeeded++;
                }
                catch (error) {
                    // 面向用户操作的结构化错误，不保留敏感上游正文。
                    const problem = error instanceof Problem ? error : new Problem('DOWNLOAD_FAILED', '正文下载异常，请稍后重试', true);
                    article.state = problem.code === 'UNAVAILABLE' ? 'unavailable' : 'temporary_failure';
                    article.error = problem.payload();
                    article.updatedAt = utc();
                    this.store.put('articles', article);
                    job.failed++;
                    if (problem.action)
                        throw problem;
                }
                this.store.put('jobs', job);
                await new Promise(resolve => setTimeout(resolve, this.delay));
            }
            job.state = job.failed ? (job.succeeded ? 'partial' : 'failed') : 'succeeded';
            account.firstSync = false;
            account.blocked = null;
        }
        catch (error) {
            // 面向用户操作的结构化错误，不保留敏感上游正文。
            const problem = error instanceof Problem ? error : new Problem('INTERNAL', '采集异常，请检查程序或重新同步', true);
            job.state = ['login', 'verify'].includes(problem.action || '') ? 'waiting_verification' : problem.code === 'INTERRUPTED' ? 'interrupted' : 'failed';
            job.error = problem.payload();
            if (problem.action)
                account.blocked = problem.payload();
        }
        finally {
            // 只回写采集游标与结果，不覆盖执行期间的暂停或改名。
            const current = this.store.get<StoredAccount>('accounts', account.id);
            Object.assign(current, { firstSync: account.firstSync, blocked: account.blocked, nextOffset: account.nextOffset, nextSyncAt: Date.now() / 1000 + (current.intervalMin + Math.random() * (current.intervalMax - current.intervalMin)) * 60 });
            job.finishedAt = utc();
            this.store.put('jobs', job);
            this.store.put('accounts', current);
        }
    }
    /** 调度间隔只在前一轮完全结束后开始 */
    private async loop(): Promise<void> {
        if (this.stopped)
            return;
        try {
            this.scheduleDue();
            // 本轮唯一队列任务的持久化快照。
            const job = this.store.all<StoredJob>('jobs').filter(job => job.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
            if (job) {
                this.busy = true;
                try {
                    await this.run(job);
                }
                finally {
                    this.busy = false;
                }
            }
        }
        catch { /* 下一次循环有限等待，不记录凭据或原始响应。 */ }
        if (!this.stopped)
            this.timer = setTimeout(() => { void this.loop(); }, 2000);
    }
}
