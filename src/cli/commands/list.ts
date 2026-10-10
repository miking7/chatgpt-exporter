import chalk from 'chalk';
import type { ConversationItem } from '../../api/types.js';
import { fetchAllConversations, fetchAllProjects, fetchProjectConversations } from '../../api/pagination.js';
import { plural } from '../../utils/format.js';
import { createReporter } from '../reporter.js';
import { createRuntime } from '../runtime.js';
import { EXIT, handleCommandError } from '../errors.js';

export interface ListOptions {
  token?: string;
  verbose: boolean;
  json: boolean;
  archived: boolean;
  project?: string;
}

export async function listCommand(options: ListOptions): Promise<number> {
  const reporter = createReporter();
  try {
    reporter.spin('Checking your ChatGPT sign-in…');
    const runtime = await createRuntime({ tokenFlag: options.token, ui: reporter });
    const client = runtime.client;

    let conversations: ConversationItem[];
    if (options.project) {
      reporter.spin('Resolving project…');
      const wanted = options.project.toLowerCase();
      const projects = await fetchAllProjects(client);
      const match = projects.find((p) => p.gizmo.id === options.project || p.gizmo.display.name.toLowerCase() === wanted);
      if (!match) {
        const available = projects.map((p) => p.gizmo.display.name).join(', ') || '(none)';
        throw new Error(`Project "${options.project}" not found. Available projects: ${available}`);
      }
      reporter.spin(`Listing conversations in "${match.gizmo.display.name}"…`);
      conversations = await fetchProjectConversations(client, match.gizmo.id);
    } else {
      reporter.spin(`Listing ${options.archived ? 'archived ' : ''}conversations…`);
      conversations = await fetchAllConversations(client, { archived: options.archived });
    }
    reporter.spinDone(`Found ${plural(conversations.length, 'conversation')}`);
    reporter.finish();

    if (options.json) {
      console.log(JSON.stringify(conversations, null, 2));
      return EXIT.ok;
    }
    console.log();
    for (const conv of conversations) {
      const title = conv.title ?? chalk.dim('(untitled)');
      const date = conv.update_time
        ? new Date(typeof conv.update_time === 'number' ? conv.update_time * 1000 : conv.update_time).toLocaleDateString()
        : 'unknown date';
      console.log(`${chalk.cyan(conv.id)} ${title} ${chalk.dim(`[${date}]`)}`);
    }
    console.log();
    console.log(chalk.green(`Total: ${plural(conversations.length, 'conversation')}`));
    return EXIT.ok;
  } catch (error) {
    reporter.finish();
    return handleCommandError(error, options.verbose);
  }
}
