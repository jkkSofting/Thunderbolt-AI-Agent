import * as vscode from 'vscode';

export interface ModelSelector {
	vendor?: string;
	family?: string;
}

export interface ThunderstormConfig {
	models: {
		requirementsCheck: ModelSelector;
		implementation: ModelSelector;
		verification: ModelSelector;
	};
	prompts: {
		requirementsCheck: string;
		implementation: string;
		verification: string;
	};
	git: {
		baseBranch: string;
		branchPrefix: string;
		autoCreatePullRequest: boolean;
	};
}

export function getConfig(): ThunderstormConfig {
	const cfg = vscode.workspace.getConfiguration('thunderstorm');
	return {
		models: {
			requirementsCheck: {
				vendor: cfg.get<string>('models.requirementsCheck.vendor', 'copilot'),
				family: cfg.get<string>('models.requirementsCheck.family', 'gpt-4o'),
			},
			implementation: {
				vendor: cfg.get<string>('models.implementation.vendor', 'copilot'),
				family: cfg.get<string>('models.implementation.family', 'gpt-4o'),
			},
			verification: {
				vendor: cfg.get<string>('models.verification.vendor', 'copilot'),
				family: cfg.get<string>('models.verification.family', 'gpt-4o'),
			},
		},
		prompts: {
			requirementsCheck: cfg.get<string>('prompts.requirementsCheck', ''),
			implementation: cfg.get<string>('prompts.implementation', ''),
			verification: cfg.get<string>('prompts.verification', ''),
		},
		git: {
			baseBranch: cfg.get<string>('git.baseBranch', 'main'),
			branchPrefix: cfg.get<string>('git.branchPrefix', 'thunderstorm/'),
			autoCreatePullRequest: cfg.get<boolean>('git.autoCreatePullRequest', true),
		},
	};
}
