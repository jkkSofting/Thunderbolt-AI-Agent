import { spawn } from 'child_process';

export interface CommandResult {
	stdout: string;
	stderr: string;
}

export interface PullRequestResult {
	success: boolean;
	url?: string;
	reason?: string;
}

export class GitService {
	constructor(private readonly cwd: string, private readonly signal?: AbortSignal) {}

	private run(command: string, args: string[]): Promise<CommandResult> {
		return new Promise((resolve, reject) => {
			const proc = spawn(command, args, { cwd: this.cwd, shell: false, signal: this.signal });
			let stdout = '';
			let stderr = '';
			proc.stdout.on('data', (chunk) => (stdout += chunk.toString()));
			proc.stderr.on('data', (chunk) => (stderr += chunk.toString()));
			proc.on('error', (err) => reject(err));
			proc.on('close', (code) => {
				if (code === 0) {
					resolve({ stdout, stderr });
				} else {
					reject(new Error(stderr.trim() || `${command} ${args.join(' ')} beendete mit Exit-Code ${code}`));
				}
			});
		});
	}

	async isRepository(): Promise<boolean> {
		try {
			await this.run('git', ['rev-parse', '--is-inside-work-tree']);
			return true;
		} catch (err) {
			if (this.signal?.aborted) {
				throw err;
			}
			return false;
		}
	}

	async initRepository(): Promise<void> {
		await this.run('git', ['init']);
	}

	async currentBranch(): Promise<string> {
		const { stdout } = await this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
		return stdout.trim();
	}

	async hasCommits(): Promise<boolean> {
		try {
			await this.run('git', ['rev-parse', 'HEAD']);
			return true;
		} catch (err) {
			if (this.signal?.aborted) {
				throw err;
			}
			return false;
		}
	}

	async hasRemote(): Promise<boolean> {
		const { stdout } = await this.run('git', ['remote']);
		return stdout.trim().length > 0;
	}

	async createAndCheckoutBranch(name: string): Promise<void> {
		await this.run('git', ['checkout', '-b', name]);
	}

	async stageAll(): Promise<void> {
		await this.run('git', ['add', '-A']);
	}

	async hasStagedChanges(): Promise<boolean> {
		try {
			await this.run('git', ['diff', '--cached', '--quiet']);
			return false;
		} catch {
			return true;
		}
	}

	async commit(message: string): Promise<void> {
		await this.run('git', ['commit', '-m', message]);
	}

	async push(branch: string): Promise<void> {
		await this.run('git', ['push', '-u', 'origin', branch]);
	}

	async ghCliAvailable(): Promise<boolean> {
		try {
			await this.run('gh', ['--version']);
			return true;
		} catch {
			return false;
		}
	}

	async createPullRequest(title: string, body: string, base: string): Promise<PullRequestResult> {
		if (!(await this.ghCliAvailable())) {
			return { success: false, reason: 'GitHub CLI ("gh") ist nicht installiert oder nicht im PATH verfügbar.' };
		}
		try {
			const { stdout } = await this.run('gh', ['pr', 'create', '--title', title, '--body', body, '--base', base]);
			const url = stdout.trim().split('\n').pop() ?? '';
			return { success: true, url };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return { success: false, reason };
		}
	}
}
