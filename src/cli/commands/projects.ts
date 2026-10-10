import chalk from 'chalk';
import { fetchAllProjects } from '../../api/pagination.js';
import { plural } from '../../utils/format.js';
import { createReporter } from '../reporter.js';
import { createRuntime } from '../runtime.js';
import { EXIT, handleCommandError } from '../errors.js';

export interface ProjectsCommandOptions {
  token?: string;
  verbose: boolean;
  json: boolean;
}

export async function projectsCommand(options: ProjectsCommandOptions): Promise<number> {
  const reporter = createReporter();
  try {
    reporter.spin('Checking your ChatGPT sign-in…');
    const runtime = await createRuntime({ tokenFlag: options.token, ui: reporter });
    reporter.spin('Fetching projects…');
    const projects = await fetchAllProjects(runtime.client);
    reporter.spinDone(`Found ${plural(projects.length, 'project')}`);
    reporter.finish();

    if (options.json) {
      const output = projects.map((p) => ({
        id: p.gizmo.id,
        name: p.gizmo.display.name,
        num_interactions: p.gizmo.num_interactions,
        last_interacted_at: p.gizmo.last_interacted_at,
        is_archived: p.gizmo.is_archived,
      }));
      console.log(JSON.stringify(output, null, 2));
      return EXIT.ok;
    }

    console.log();
    for (const project of projects) {
      const gizmo = project.gizmo;
      const lastInteracted = gizmo.last_interacted_at ? new Date(gizmo.last_interacted_at).toLocaleDateString() : 'never';
      console.log(`${chalk.cyan(gizmo.id)} ${chalk.bold(gizmo.display.name)} ${chalk.dim(`[last: ${lastInteracted}]`)}`);
    }
    console.log();
    console.log(chalk.green(`Total: ${plural(projects.length, 'project')}`));
    return EXIT.ok;
  } catch (error) {
    reporter.finish();
    return handleCommandError(error, options.verbose);
  }
}
