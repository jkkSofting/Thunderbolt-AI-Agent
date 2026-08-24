import { spawn } from 'child_process';

export interface CommandResult {
	stdout: string;
	stderr: string;
}

function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: false });
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

export interface PullRequestResult {
	success: boolean;
	url?: string;
	reason?: string;
}

export class GitService {
	constructor(private readonly cwd: string) {}

	async isRepository(): Promise<boolean> {
		try {
			await run('git', ['rev-parse', '--is-inside-work-tree'], this.cwd);
			return true;
		} catch {
			return false;
		}
	}

	async initRepository(): Promise<void> {
		await run('git', ['init'], this.cwd);
	}

	async currentBranch(): Promise<string> {
		const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd);
		return stdout.trim();
	}

	async hasCommits(): Promise<boolean> {
		try {
			await run('git', ['rev-parse', 'HEAD'], this.cwd);
			return true;
		} catch {
			return false;
		}
	}

	async hasRemote(): Promise<boolean> {
		const { stdout } = await run('git', ['remote'], this.cwd);
		return stdout.trim().length > 0;
	}

	async branchExists(name: string): Promise<boolean> {
		try {
			await run('git', ['rev-parse', '--verify', name], this.cwd);
			return true;
		} catch {
			return false;
		}
	}

	async createAndCheckoutBranch(name: string): Promise<void> {
		await run('git', ['checkout', '-b', name], this.cwd);
	}

	async stageAll(): Promise<void> {
		await run('git', ['add', '-A'], this.cwd);
	}

	async hasStagedChanges(): Promise<boolean> {
		try {
			await run('git', ['diff', '--cached', '--quiet'], this.cwd);
			return false;
		} catch {
			return true;
		}
	}

	async commit(message: string): Promise<void> {
		await run('git', ['commit', '-m', message], this.cwd);
	}

	async push(branch: string): Promise<void> {
		await run('git', ['push', '-u', 'origin', branch], this.cwd);
	}

	async ghCliAvailable(): Promise<boolean> {
		try {
			await run('gh', ['--version'], this.cwd);
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
			const { stdout } = await run(
				'gh',
				['pr', 'create', '--title', title, '--body', body, '--base', base],
				this.cwd
			);
			const url = stdout.trim().split('\n').pop() ?? '';
			return { success: true, url };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return { success: false, reason };
		}
	}
}
