// Invisible shell integration: prompt hooks report prompt, command start, exit code, cwd, and POSIX option flags
// through nonce-tagged OSC 7717 sequences, so agent commands can be typed exactly as a user would type them.
// Option flags (O) precede the exit code (D) so a finishing command sees the shell's current options, such as errexit.
export type IntegrationEvent = { kind: 'A' | 'B' | 'C' | 'D' | 'O' | 'P'; arg: string; index: number };
const OSC = '\x1b]7717;';
const KINDS = new Set(['A', 'B', 'C', 'D', 'O', 'P']);
const CLEAR_SCREEN = '\\033[H\\033[2J\\033[3J';

const powershellScript = (nonce: string, clear: boolean) => `if (-not $global:__sm_nonce) {
$global:__sm_nonce = '${nonce}'
function global:__sm_osc([string]$kind, [string]$arg) { "$([char]27)]7717;$($global:__sm_nonce);$kind;$arg$([char]7)" }
$global:__sm_prompt = $function:prompt
function global:prompt {
  $ok = $global:?
  $lec = $global:LASTEXITCODE
  $code = if ($ok) { 0 } elseif ($lec -is [int] -and $lec -ne 0) { $lec } else { 1 }
  $text = & $global:__sm_prompt
  $global:LASTEXITCODE = $lec
  $cwd = if ($PWD.Provider.Name -eq 'FileSystem') { $PWD.ProviderPath } else { $PWD.Path }
  (__sm_osc 'D' $code) + (__sm_osc 'P' $cwd) + (__sm_osc 'A' '') + ($text -join "\`n") + (__sm_osc 'B' '')
}
if (Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue) {
  $global:__sm_readline = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine { $line = $global:__sm_readline.Invoke(); [Console]::Write((__sm_osc 'C' '')); $line }
}
}${clear ? `\n[Console]::Write("$([char]27)[H$([char]27)[2J$([char]27)[3J")` : ''}
`;

const bashScript = (nonce: string) => `if [ -z "$__sm_nonce" ]; then
__sm_nonce=${nonce}
__sm_osc() { builtin printf '\\033]7717;%s;%s;%s\\007' "$__sm_nonce" "$1" "$2"; }
__sm_pre() { local __sm_st=$?; __sm_osc O "$-"; __sm_osc D "$__sm_st"; __sm_osc P "$PWD"; return $__sm_st; }
__sm_post() { case "$PS1" in *"7717;$__sm_nonce;A"*) ;; *) PS1="\\[\\e]7717;$__sm_nonce;A;\\a\\]$PS1\\[\\e]7717;$__sm_nonce;B;\\a\\]";; esac; }
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then PROMPT_COMMAND=(__sm_pre "\${PROMPT_COMMAND[@]}" __sm_post); else PROMPT_COMMAND="__sm_pre"$'\\n'"\${PROMPT_COMMAND:+$PROMPT_COMMAND$'\\n'}__sm_post"; fi
PS0="\${PS0}\\e]7717;$__sm_nonce;C;\\a"
fi
__sm_h=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null); case "$__sm_h" in *"$__sm_nonce"*) __sm_h=\${__sm_h#"\${__sm_h%%[0-9]*}"}; builtin history -d "\${__sm_h%%[!0-9]*}";; esac; unset __sm_h
`;

const zshScript = (nonce: string) => `if [ -z "$__sm_nonce" ]; then
__sm_nonce=${nonce}
__sm_osc() { builtin printf '\\033]7717;%s;%s;%s\\007' "$__sm_nonce" "$1" "$2"; }
__sm_pre() { local __sm_st=$?; __sm_osc O "$-"; __sm_osc D "$__sm_st"; __sm_osc P "$PWD"; return $__sm_st; }
__sm_post() { [[ "$PS1" == *"7717;$__sm_nonce;A"* ]] || PS1=$'%{\\e]7717;'"$__sm_nonce"$';A;\\a%}'"$PS1"$'%{\\e]7717;'"$__sm_nonce"$';B;\\a%}'; }
__sm_exec() { __sm_osc C ''; }
precmd_functions=(__sm_pre $precmd_functions __sm_post); preexec_functions+=(__sm_exec)
fi
`;

const shScript = (nonce: string) => `if [ -z "$__sm_nonce" ]; then
__sm_nonce=${nonce}
PS1="$(printf '\\033]7717;%s;O;' "$__sm_nonce")"'$-'"$(printf '\\007\\033]7717;%s;D;' "$__sm_nonce")"'$?'"$(printf '\\007\\033]7717;%s;P;' "$__sm_nonce")"'$PWD'"$(printf '\\007\\033]7717;%s;A;\\007' "$__sm_nonce")$PS1$(printf '\\033]7717;%s;B;\\007' "$__sm_nonce")"
fi
`;

// Quote a script as a single-quoted printf format so the whole bootstrap stays on one input line.
const printfFormat = (script: string) => `'${script.replace(/\\/g, '\\\\').replace(/%/g, '%%').replace(/'/g, `'\\''`).replace(/\n/g, '\\n')}'`;

// Arguments for a local PowerShell process: the profile loads first, then the integration wraps its prompt.
export function powershellLaunchArgs(nonce: string): string[] {
  return ['-NoExit', '-EncodedCommand', Buffer.from(powershellScript(nonce, false), 'utf16le').toString('base64')];
}

// One input line typed into an already-running shell. The caller hides its echo from the visible terminal.
export function bootstrapLine(shell: 'powershell' | 'posix', nonce: string, clear: boolean): string {
  if (shell === 'powershell') {
    const encoded = Buffer.from(powershellScript(nonce, clear), 'utf8').toString('base64');
    return ` . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\r`;
  }
  const tail = clear ? `printf '${CLEAR_SCREEN}'` : ':';
  return ` if [ -n "$BASH_VERSION" ]; then eval "$(printf ${printfFormat(bashScript(nonce))})"; elif [ -n "$ZSH_VERSION" ]; then eval "$(printf ${printfFormat(zshScript(nonce))})"; else eval "$(printf ${printfFormat(shScript(nonce))})"; fi; ${tail}\r`;
}

// Keystrokes that submit an agent command as one logical shell command.
export function commandInput(shell: 'powershell' | 'posix', text: string, bracketedPaste: boolean): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (shell === 'powershell') {
    const body = lines.map(line => line.replace(/\t/g, '    '));
    // An open dot-sourced block keeps PSReadLine collecting lines, then runs them once in the current scope.
    return (body.length === 1 ? body : ['. {', ...body, '}']).join('\r') + '\r';
  }
  const body = lines.length === 1 ? lines[0] : `{\n${lines.join('\n')}\n}`;
  if (bracketedPaste) return `\x1b[200~${body}\x1b[201~\r`;
  return body.replace(/\t/g, '    ').replace(/\n/g, '\r') + '\r';
}

// Removes this session's integration sequences from a PTY stream, reporting where each one occurred.
export class IntegrationParser {
  private carry = '';
  constructor(private nonce: string) {}
  feed(chunk: string): { text: string; events: IntegrationEvent[] } {
    const input = this.carry + chunk; this.carry = '';
    const events: IntegrationEvent[] = [];
    let text = ''; let pos = 0;
    for (;;) {
      const start = input.indexOf(OSC, pos);
      if (start < 0) {
        const escape = input.lastIndexOf('\x1b');
        const partial = escape >= pos && OSC.startsWith(input.slice(escape));
        text += input.slice(pos, partial ? escape : undefined);
        if (partial) this.carry = input.slice(escape);
        return { text, events };
      }
      text += input.slice(pos, start);
      const bell = input.indexOf('\x07', start); const st = input.indexOf('\x1b\\', start);
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      if (end < 0) {
        if (input.length - start < 4096) { this.carry = input.slice(start); return { text, events }; }
        text += input.slice(start); return { text, events };
      }
      const [nonce, kind, ...rest] = input.slice(start + OSC.length, end).split(';');
      if (nonce === this.nonce && KINDS.has(kind)) events.push({ kind: kind as IntegrationEvent['kind'], arg: rest.join(';'), index: text.length });
      pos = end + (input[end] === '\x07' ? 1 : 2);
    }
  }
}
