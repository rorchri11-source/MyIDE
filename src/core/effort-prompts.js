/**
 * Effort System — direttive di profondita' analitica per l'AI.
 * Inietta un blocco <thinking> + direttiva effort nel system prompt.
 * Ogni livello controlla quanto in profondita l'AI analizza il problema.
 */

export const EFFORT_LEVELS = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max'
};

export const EFFORT_LABELS = {
  off: '🚫 Nessun ragionamento',
  low: '⚡ Rapido',
  medium: '⚖️ Bilanciato',
  high: '🔍 Approfondito',
  max: '🧠 Massimo'
};

/**
 * Prompt di base con thinking block — iniettato in OGNI richiesta AI.
 * Definisce le regole di esecuzione obbligatorie.
 */
export const THINKING_BASE_PROMPT = `## Reasoning Protocol

Before generating any output, you MUST reason through the problem inside <thinking> tags.

<thinking>
1. **Decomposition**: Break the user request into isolated sub-problems.
2. **Context Analysis**: Identify logical dependencies, key variables, and the overall architecture of any provided code.
3. **Planning**: Describe the sequential steps needed to solve the problem.
4. **Internal Validation**: Mentally simulate the execution to catch bugs, bottlenecks, or security issues.
</thinking>

After closing </thinking>, generate ONLY the final output (code, explanation, or solution) that matches your plan.`;

/**
 * Versione senza reasoning — per modelli che NON supportano <thinking>.
 * Rimuove le istruzioni di reasoning e da' istruzioni dirette.
 */
export const NO_THINKING_PROMPT = `## Direct Response Protocol

Do NOT use <thinking> tags or any reasoning steps. Do NOT output your internal reasoning process.
Respond directly with the solution, code, or answer requested.
Be concise, accurate, and focused on the user's request.`;

/**
 * Reasoning con anti-hallucination e tool awareness.
 * Iniettato SOLO se il model supporta thinking.
 */
export const THINKING_WITH_TOOLS = `## Reasoning Protocol

Before generating any output, you MUST reason through the problem inside <thinking> tags.

<thinking>
1. **Decomposition**: Break the user request into isolated sub-problems.
2. **Context Analysis**: Identify logical dependencies, key variables, and the overall architecture of any provided code.
3. **Planning**: Describe the sequential steps needed to solve the problem.
4. **Tool Selection**: Choose the most appropriate tool. IMPORTANT:
   - If fs_read fails, the path is likely wrong. Check the directory tree shown above before retrying.
   - If fs_write fails, check if the directory exists or if you have write permissions.
   - If cmd_run fails, analyze the error message and adjust the command — don't retry the exact same command.
   - NEVER make assumptions about file contents. Always read before modifying.
5. **Internal Validation**: Mentally simulate the execution to catch bugs, bottlenecks, or security issues.
6. **Edge Cases**: Consider what could go wrong and plan fallbacks.
</thinking>

After closing </thinking>, generate ONLY the final output (code, explanation, or solution) that matches your plan.

**CRITICAL: Anti-Hallucination Rules:**
- If you don't know a file's content, READ it — don't guess.
- If you don't know a directory's structure, LIST it — don't invent paths.
- If a tool returns an error, the error message is REAL — adapt to it.
- Never output code you haven't verified the context for.
- Never claim a file exists or has specific content without reading it first.`;

/**
 * Direttive di effort per livello. Viene concatenata al base prompt.
 * Il livello 'off' non ha direttiva — usa solo NO_THINKING_PROMPT.
 */
const EFFORT_DIRECTIVES = {
  low: `
## Effort: Low
Minimize the <thinking> phase. Perform only a quick scan to identify correct syntax and the most common pattern for this request. Skip complex decomposition. Deliver a direct, concise, and immediate solution.`,

  medium: `
## Effort: Medium (Default)
Balance the analysis. In the <thinking> block, clearly define the data flow. Evaluate at least one alternative approach before choosing the final one. Identify potential syntax or typo errors before generating output.`,

  high: `
## Effort: High
Perform deep structural analysis. In the <thinking> block:
- Explicitly trace the lifecycle of data for every function involved.
- List and handle at least 3 edge cases or anomalous inputs.
- Verify the scalability of the chosen approach.
- Structure code in separate modules/functions for maximum maintainability.
Do NOT generate final output until every potential logical conflict is resolved in <thinking>.`,

  max: `
## Effort: Maximum
Apply extreme and exhaustive analytical rigor. In the <thinking> block:
- Ignore superficial or intuitive solutions — seek the optimal one.
- Calculate and justify asymptotic complexity (Big O notation) for time and space.
- Perform a mental "dry-run" line by line of the code you intend to write, tracing variable values at each step.
- Identify every Single Point of Failure and design error handling patterns with fallbacks.
- Review the entire architecture for full adherence to SOLID principles and Clean Code.
The reasoning must exhaustively cover every single line of code that will be generated before writing it.
Do NOT generate the final output until every aspect has been deeply analyzed and resolved.`
};

/**
 * Few-shot examples per tool_calls — mostrano all'AI il formato CORRETTO.
 * Iniettati nel system prompt quando reasoning e' attivo.
 */
export const TOOL_USAGE_EXAMPLES = `## Tool Usage Examples

When using tools, follow this pattern:

<example>
User: "Create a new Express.js project in the current directory"
<thinking>
1. Goal: Create Express.js project structure
2. Need to: create package.json, install express, create app.js
3. Plan:
   a. cmd_run: npm init -y (create package.json)
   b. cmd_run: npm install express (install dependency)
   c. fs_write: write app.js with basic Express server
</thinking>

→ cmd_run(command: "npm init -y", cwd: "C:\\Game\\MyIDE")
</example>

<example>
User: "Read the main file"
<thinking>
1. Need the absolute path of the main file
2. Check directory tree — likely src/index.js or electron/main.js
3. Read the most likely candidate first
</thinking>

→ fs_read(path: "C:\\Game\\MyIDE\\electron\\main.js")
</example>

<example>
User: "Add error handling to the server"
<thinking>
1. Must read current server code first
2. fs_read fails → path wrong
3. Check directory tree → find correct path
4. fs_read succeeds → analyze structure
5. Write improved version with try/catch blocks
</thinking>

→ fs_read(path: "C:\\Game\\MyIDE\\server\\index.js")
→ [error: file not found]
→ fs_read(path: "C:\\Game\\MyIDE\\src\\server.js")
→ [success, 1200 chars]
→ fs_write(path: "C:\\Game\\MyIDE\\src\\server.js", content: "<improved code with error handling>")
</example>`;

/**
 * Costruisce il prompt completo per un dato livello di effort.
 * @param {string} level - One of 'low', 'medium', 'high', 'max', 'off'
 * @returns {string} The full prompt string
 */
export function buildEffortPrompt(level) {
  if (level === 'off') {
    return NO_THINKING_PROMPT;
  }

  const thinkingPrompt = THINKING_WITH_TOOLS;
  const directive = EFFORT_DIRECTIVES[level] || EFFORT_DIRECTIVES.medium;
  return thinkingPrompt + directive;
}

/**
 * Restituisce la lista completa dei livelli con label.
 */
export function getEffortOptions() {
  return Object.entries(EFFORT_LEVELS).map(([key, value]) => ({
    key,
    value,
    label: EFFORT_LABELS[key]
  }));
}

/**
 * Restituisce il text completo per modifica manuale.
 */
export function getEffortText(level, customOverride) {
  if (level !== 'custom') {
    return buildEffortPrompt(level);
  }
  return customOverride || '';
}

/**
 * Restituisce gli esempi di tool usage da iniettare nel prompt.
 */
export function getToolExamples() {
  return TOOL_USAGE_EXAMPLES;
}
