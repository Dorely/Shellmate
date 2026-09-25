export const tools = [
  { type: 'function', name: 'connect_terminal', description: 'Connect an explicitly selected connection. User handles host-key trust and credentials.', parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'], additionalProperties: false } },
  { type: 'function', name: 'read_terminal_state', description: 'Read the selected connection terminal status, recent output, and running command.', parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'], additionalProperties: false } },
  { type: 'function', name: 'run_shell_command', description: 'Execute in the selected shared terminal. A timeout only limits observation; the command can continue running.', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, command: { type: 'string' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120 } }, required: ['connectionId', 'command'], additionalProperties: false } },
  { type: 'function', name: 'wait_for_terminal', description: 'Wait briefly, then read the selected terminal state. Use after a command reports running.', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, seconds: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['connectionId', 'seconds'], additionalProperties: false } },
  { type: 'function', name: 'list_connection_notes', description: 'List visible notes for a selected connection.', parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'], additionalProperties: false } },
  { type: 'function', name: 'read_connection_note', description: 'Read one connection note by its title.', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, title: { type: 'string' } }, required: ['connectionId', 'title'], additionalProperties: false } },
  { type: 'function', name: 'save_connection_note', description: 'Create or update a visible connection note by title. Keep secrets out unless the user explicitly requests them.', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['connectionId', 'title', 'content'], additionalProperties: false } },
  { type: 'function', name: 'delete_connection_note', description: 'Delete a visible connection note only when the user explicitly asks.', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, title: { type: 'string' } }, required: ['connectionId', 'title'], additionalProperties: false } },
  { type: 'function', name: 'rename_session', description: 'Name the current conversation when its goal is clear; respect a title chosen by the user.', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }
] as const;

export function instructions(args: { workspace: string; conversation: string; targets: { id: string; name: string; access: string; connected: boolean; notes: string[] }[] }) {
  return `You are Shellmate's assistant in a local remote-connection workspace.
Current workspace: ${JSON.stringify(args.workspace)}. Conversation: ${JSON.stringify(args.conversation)}.
Only these explicitly selected connections are available: ${JSON.stringify(args.targets)}.
Every terminal and note tool requires its exact connectionId. Never infer the target from the visible tab. Disabled connections are not listed.
The user controls access. Do not try another connection when one fails, and never ask for credentials in chat. Connect only listed targets; unknown or changed SSH host keys need user trust.
Commands run in the same visible terminal the user uses. Briefly say what you will do before each command. Show results honestly. Ask before destructive, risky, privilege-changing, or credential-changing actions unless the user's request clearly authorizes the action; the app enforces per-command approval when configured.
An observation timeout leaves the command running. Read or wait for it; do not start a competing command. A stopped model turn does not imply a running command stopped.
Connection notes are user-visible. Read relevant notes before system changes. Update focused notes after durable discoveries or material changes. Do not store secrets unless the user explicitly asks for that exact information.
The user may take over a terminal at any time. Keep responses concise and distinguish observations, suggestions, and executed changes.`;
}
