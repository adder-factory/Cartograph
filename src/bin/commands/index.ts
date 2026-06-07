import { registerAdminCommands } from './admin.js';
import { registerGeneratedCommands } from './generated.js';
import { registerLifecycleCommands } from './lifecycle.js';
import { registerReadCommands } from './read.js';
import { registerReviewCommands } from './review.js';
import { registerSessionCommands } from './session.js';
import { registerSummariesCommands } from './summaries.js';

export function registerCartographCommands(): void {
  registerAdminCommands();
  registerReadCommands();
  registerLifecycleCommands();
  registerReviewCommands();
  registerSummariesCommands();
  registerSessionCommands();
  registerGeneratedCommands();
}
