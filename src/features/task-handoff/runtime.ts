import type { ContextRoute } from '../context-route/index.js';
import type { WorkingTreeOverlayReport } from '../working-tree-overlay/index.js';
import {
  TaskHandoffPacketSchema,
  type TaskHandoffAction,
  type TaskHandoffIndexFreshness,
  type TaskHandoffPacket,
} from './contract.js';

export interface BuildTaskHandoffPacketArgs {
  task: string;
  route: ContextRoute;
  contextFiles: readonly string[];
  indexFreshness: TaskHandoffIndexFreshness;
  workingTree: WorkingTreeOverlayReport;
  nextActions: readonly TaskHandoffAction[];
}

const HANDOFF_EDIT_SITE_LIMIT = 8;
const HANDOFF_FILE_LIMIT = 30;

export function buildTaskHandoffPacket(args: BuildTaskHandoffPacketArgs): TaskHandoffPacket {
  const editSites = args.route.candidates
    .filter((candidate) => candidate.bucket === 'edit-site' && candidate.confidence !== 'low')
    .slice(0, HANDOFF_EDIT_SITE_LIMIT);
  const firstAction = [...args.nextActions].sort((a, b) => a.priority - b.priority)[0];
  const resumeGuidance = [
    `Continue the coding task exactly as stated: ${args.task}`,
    ...(args.workingTree.changedFiles.length > 0
      ? [
          `Preserve the existing working-tree changes in: ${args.workingTree.changedFiles.join(', ')}. They may be user or prior-agent work; do not discard them.`,
        ]
      : ['No working-tree changes were detected when this packet was built.']),
    ...(firstAction
      ? [`Start with ${firstAction.tool} using the recorded arguments; widen only when its evidence requires it.`]
      : ['The router needs narrower code anchors before choosing an edit site.']),
    args.nextActions.some((action) => action.tool === 'cartograph_verify')
      ? 'Before reporting completion, run cartograph_verify and then execute the commands it plans.'
      : 'Before reporting completion, run the repository verification gates and inspect the structural diff.',
  ];
  return TaskHandoffPacketSchema.parse({
    version: 1,
    status: args.route.status === 'ready' ? 'ready' : 'needs-narrowing',
    task: args.task,
    route: args.route,
    editSites,
    contextFiles: [...new Set(args.contextFiles)].sort((a, b) => a.localeCompare(b)).slice(0, HANDOFF_FILE_LIMIT),
    indexFreshness: args.indexFreshness,
    workingTree: args.workingTree,
    nextActions: args.nextActions,
    resumeGuidance,
  });
}

export function renderTaskHandoffPacket(packet: TaskHandoffPacket): string {
  const lines = [
    '## Coding task handoff',
    '',
    `**Packet version:** ${packet.version}`,
    `**Status:** ${packet.status}`,
    `**Task kind:** ${packet.route.taskKind}`,
    `**Indexed graph:** ${formatIndexFreshness(packet.indexFreshness)}`,
    '',
    '### Objective',
    '',
    packet.task,
    '',
    '### Routing decision',
    '',
  ];
  if (packet.route.status === 'abstained') {
    lines.push(`- Router abstained: ${packet.route.reason}`);
  }
  if (packet.editSites.length === 0) {
    lines.push('- No medium/high-confidence edit site was selected. Use the priority-1 narrowing call below.');
  } else {
    for (const site of packet.editSites) {
      lines.push(
        `- **${site.confidence}** \`${site.name}\` (${site.kind}) — ${site.filePath}:${site.line}`,
        `  Evidence: ${site.evidence.join('; ')}`,
      );
    }
  }
  lines.push('', '### Working tree', '');
  if (packet.workingTree.changedFiles.length === 0) {
    lines.push(`- Overlay status: ${packet.workingTree.status}; no changed source files detected.`);
  } else {
    lines.push(
      `- Overlay status: ${packet.workingTree.status} (${packet.workingTree.extractedFiles.length}/${packet.workingTree.changedFiles.length} changed files parsed from live disk).`,
      `- Changed files: ${packet.workingTree.changedFiles.map((file) => `\`${file}\``).join(', ')}`,
      '- Preserve the existing working-tree changes; this packet does not authorize discarding or rewriting unrelated work.',
    );
    for (const candidate of packet.workingTree.candidates.slice(0, HANDOFF_EDIT_SITE_LIMIT)) {
      lines.push(
        `- Live symbol: \`${candidate.name}\` (${candidate.kind}) — ${candidate.filePath}:${candidate.line} [${candidate.facets.join(' + ')}]`,
      );
    }
  }
  for (const skipped of packet.workingTree.skipped) {
    lines.push(`- Overlay caveat: ${skipped.filePath} — ${skipped.reason}`);
  }
  lines.push('', '### Context files', '');
  lines.push(
    packet.contextFiles.length > 0 ? packet.contextFiles.map((file) => `- \`${file}\``).join('\n') : '- None yet.',
  );
  lines.push('', '### Suggested MCP sequence', '', '```json', JSON.stringify(packet.nextActions, null, 2), '```');
  lines.push('', '### Resume guidance', '');
  for (const guidance of packet.resumeGuidance) lines.push(`- ${guidance}`);
  return lines.join('\n');
}

function formatIndexFreshness(freshness: TaskHandoffIndexFreshness): string {
  if (!freshness.available) return `unknown (${freshness.reason})`;
  const changed = freshness.filesChanged === null ? 'unknown' : String(freshness.filesChanged);
  const drifted = freshness.contentDriftedFiles === null ? 'unknown' : String(freshness.contentDriftedFiles);
  return `${freshness.severity}; isStale=${freshness.isStale}; git-changed files=${changed}; content-drifted files=${drifted}`;
}
