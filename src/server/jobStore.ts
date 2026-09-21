import { randomUUID } from "node:crypto";

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface JobError {
    code: string;
    message: string;
}

export interface Job {
    id: string;
    status: JobStatus;
    createdAt: Date;
    updatedAt: Date;
    data?: unknown;
    error?: JobError;
}

type Waiter = (job: Job) => void;

/**
 * In-memory registry backing the long-poll interface.
 *
 * Single-process only: a restart loses every in-flight job, so clients must tolerate a 404.
 */
export class JobStore {
    private readonly jobs = new Map<string, Job>();
    private readonly waiters = new Map<string, Waiter[]>();
    private readonly timer: ReturnType<typeof setInterval>;

    /**
     * @param ttlMs How long a finished job is retained. Default 300000.
     * @param sweepMs How often finished jobs are swept. Default 60000.
     */
    constructor(
        private readonly ttlMs = 300_000,
        sweepMs = 60_000,
    ) {
        // Started here rather than at module import: a library must not run a timer just
        // because it was loaded, and an import-time interval can never be stopped.
        this.timer = setInterval(() => this.sweep(), sweepMs);
        this.timer.unref?.();
    }

    /** Creates a pending job and returns its id. */
    create(): string {
        const id = randomUUID();
        const now = new Date();
        this.jobs.set(id, { id, status: "pending", createdAt: now, updatedAt: now });
        return id;
    }

    /** Returns a snapshot of a job, or undefined if it is unknown or already swept. */
    get(id: string): Job | undefined {
        const job = this.jobs.get(id);
        return job ? { ...job } : undefined;
    }

    /** Marks a job as running. */
    markRunning(id: string): void {
        this.update(id, (job) => {
            job.status = "running";
        });
    }

    /** Marks a job as completed and wakes every long-poller waiting on it. */
    complete(id: string, data: unknown): void {
        this.update(id, (job) => {
            job.status = "completed";
            job.data = data;
        });
        this.notify(id);
    }

    /** Marks a job as failed and wakes every long-poller waiting on it. */
    fail(id: string, error: JobError): void {
        this.update(id, (job) => {
            job.status = "failed";
            job.error = error;
        });
        this.notify(id);
    }

    /**
     * Waits for a job to finish.
     *
     * @param id The job id.
     * @param timeoutMs How long to block before returning the current snapshot.
     * @returns The job, or null if the id is unknown.
     */
    waitForTerminal(id: string, timeoutMs = 30_000): Promise<Job | null> {
        return new Promise((resolve) => {
            const job = this.jobs.get(id);
            if (!job) return resolve(null);
            if (job.status === "completed" || job.status === "failed") return resolve({ ...job });

            const waiter: Waiter = (finished) => {
                clearTimeout(timer);
                resolve({ ...finished });
            };
            const timer = setTimeout(() => {
                const list = this.waiters.get(id);
                if (list) {
                    const index = list.indexOf(waiter);
                    if (index !== -1) list.splice(index, 1);
                }
                const current = this.jobs.get(id);
                resolve(current ? { ...current } : null);
            }, timeoutMs);

            const list = this.waiters.get(id) ?? [];
            list.push(waiter);
            this.waiters.set(id, list);
        });
    }

    /** Drops finished jobs older than the TTL. Pending and running jobs are never swept. */
    sweep(): void {
        const cutoff = Date.now() - this.ttlMs;
        for (const [id, job] of this.jobs) {
            const finished = job.status === "completed" || job.status === "failed";
            if (finished && job.updatedAt.getTime() < cutoff) {
                this.jobs.delete(id);
                this.waiters.delete(id);
            }
        }
    }

    /** Stops the sweep timer. Safe to call more than once. */
    close(): void {
        clearInterval(this.timer);
    }

    private update(id: string, mutate: (job: Job) => void): void {
        const job = this.jobs.get(id);
        if (!job) return;
        mutate(job);
        job.updatedAt = new Date();
    }

    private notify(id: string): void {
        const list = this.waiters.get(id);
        if (!list) return;
        const job = this.jobs.get(id);
        if (job) for (const waiter of list) waiter(job);
        this.waiters.delete(id);
    }
}
