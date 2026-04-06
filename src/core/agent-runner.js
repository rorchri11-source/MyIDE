import AIClient, { AIClientFactory } from './ai-client.js';

/**
 * Agent Runner — loop agente: pensa -> esegui -> osserva -> ripeti
 * Gestisce il formato tool_use/tool_result compatibile con OpenAI.
 */
export const TOOL_DEFINITIONS = {
  fs_read: {
    type: 'function',
    function: {
      name: 'fs_read',
      description: 'Read the ENTIRE contents of a file from the filesystem. Always read before writing to understand current state.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read' }
        },
        required: ['path']
      }
    }
  },
  fs_write: {
    type: 'function',
    function: {
      name: 'fs_write',
      description: 'Write content to a file, creating directories if needed. Always write the COMPLETE file — patches are NOT supported.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to write' },
          content: { type: 'string', description: 'COMPLETE file content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  cmd_run: {
    type: 'function',
    function: {
      name: 'cmd_run',
      description: 'Execute a shell command and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory for the command' }
        },
        required: ['command']
      }
    }
  },
  fs_search: {
    type: 'function',
    function: {
      name: 'fs_search',
      description: 'Search for text in files using grep. Always use this instead of trying to read entire directories to find something.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in (defaults to project root if empty)' }
        },
        required: ['pattern']
      }
    }
  }
};

export default class AgentRunner {
  constructor(chatUI, modeManager, settings, mcpClient) {
    this.chat = chatUI;
    this.modeManager = modeManager;
    this.settings = settings;
    this.mcp = mcpClient;
    this.running = false;
    this.client = null;
    this.maxToolIterations = 15;
    this.pendingToolConfirmations = {};
  }

  async start(userMessage) {
    if (this.running) return;
    this.running = true;

    try {
      this.client = await AIClientFactory.createFromSettings();
      const contextMessages = (await this.modeManager.getContextMessages()).map(m => ({ ...m }));

      // Add agent tool instructions to system
      const agentInstr = this.getAgentInstructions();
      const systemMsg = contextMessages.find(m => m.role === 'system');
      if (systemMsg) {
        systemMsg.content += '\n\n' + agentInstr;
      }

      // Add user message to history
      this.chat.chatHistory.push({ role: 'user', content: userMessage });
      this.chat.addMessage('user', userMessage);

      let iteration = 0;
      let reachedLimit = true;
      const baseSystemContent = contextMessages[0] ? contextMessages[0].content : '';

      while (this.running && iteration < this.maxToolIterations) {
        this.chat.setLoading(true, `🤔 Agent: thinking (step ${iteration + 1}/${this.maxToolIterations})...`);
        iteration++;

        // Enforce reasoning: inject into system message (zero history token cost)
        if (this.modeManager && contextMessages[0]) {
          const reminder = this.modeManager.getEnforcementReminder(this.chat.chatHistory);
          contextMessages[0] = { ...contextMessages[0], content: baseSystemContent + (reminder || '') };
        }

        const messages = [
          ...contextMessages,
          ...this.chat.chatHistory
        ];

        const builtinTools = Object.values(TOOL_DEFINITIONS);
        const mcpTools = (this.mcp && typeof this.mcp.getMCPToolDefinitions === 'function')
          ? this.mcp.getMCPToolDefinitions()
          : [];
        const allTools = [...builtinTools, ...mcpTools];

        const result = await this.client.sendWithToolUse(
          messages,
          allTools,
          () => {}
        );

        if (!this.running) break;

        // Check for tool calls
        const toolCalls = result.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          // Push assistant message with tool_calls IMMEDIATELY
          this.chat.chatHistory.push({
            role: 'assistant',
            content: result.content || '',
            tool_calls: toolCalls
          });

          // Process tool calls sequentially
          for (const tc of toolCalls) {
            if (!this.running) break;

            const fnName = tc.function.name;
            let args;
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch (e) {
              this.chat.addMessage('system', `Error parsing tool args for ${fnName}: ${e.message}`);
              this.chat.chatHistory.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: fnName,
                content: `Error parsing arguments: ${e.message}. You must format arguments as valid JSON.`
              });
              continue; // Auto-retry handled by appending tool error and letting loop continue
            }

            this.chat.addToolCallMessage(fnName, args);

            // Check if confirmation needed
            const needsConfirm = (fnName === 'fs_write' || fnName === 'cmd_run');
            if (needsConfirm) {
              const confirmed = await this.requestConfirmation(fnName, args);
              if (!this.running) break;
              if (!confirmed) {
                this.chat.addMessage('system', `Tool ${fnName} cancelled by user.`);
                this.chat.chatHistory.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: fnName,
                  content: 'CANCELLED BY USER: operation not executed.'
                });
                continue;
              }
            }

            // Execute tool
            let toolResult;
            try {
              toolResult = await this.executeTool(fnName, args);
            } catch (e) {
              toolResult = { error: e.message };
            }

            // Update status based on tool action
            if (fnName === 'fs_read') {
              this.chat.setLoading(true, `📖 Reading: ${args.path}...`);
            } else if (fnName === 'fs_write') {
              this.chat.setLoading(true, `✏️ Writing: ${args.path}...`);
            } else if (fnName === 'cmd_run') {
              this.chat.setLoading(true, `⚡ Running: ${args.command.slice(0, 50)}...`);
            }

            // Add tool result to history
            this.chat.chatHistory.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: fnName,
              content: toolResult.error
                ? `Error: ${toolResult.error}`
                : (toolResult.output || toolResult.message || 'OK')
            });

            this.chat.addToolResultMessage(fnName, toolResult);
          }
        } else {
          // No tool calls — final response
          const content = result.content || '(No response)';
          this.chat.addMessage('assistant', content);
          this.chat.chatHistory.push({ role: 'assistant', content });
          reachedLimit = false;
          break;
        }
      }

      if (reachedLimit && iteration >= this.maxToolIterations) {
        this.chat.addMessage('system', 'Agent: reached maximum iteration limit.');
      }
    } catch (error) {
      console.error('Agent error:', error);
      this.chat.addMessage('system', `Agent error: ${error.message}`);
    } finally {
      for (const id of Object.keys(this.pendingToolConfirmations)) {
        this.pendingToolConfirmations[id](false);
        delete this.pendingToolConfirmations[id];
      }
      this.running = false;
      this.chat.setLoading(false);
    }
  }

  stop() {
    this.running = false;
    for (const id of Object.keys(this.pendingToolConfirmations)) {
      this.pendingToolConfirmations[id](false);
      delete this.pendingToolConfirmations[id];
    }
    if (this.client) this.client.cancel();
  }

  getAgentInstructions() {
    let toolsHint = `- \`fs_read(path)\`: Read ENTIRE file content. Always read before modifying to understand current state.
- \`fs_write(path, content)\`: Create or overwrite a file. Write the COMPLETE file content — NO patches or diffs.
- \`cmd_run(command, cwd)\`: Execute a shell command (npm install, node test.js, ls, etc.)
- \`fs_search(pattern, path)\`: Fast grep across the codebase.`;

    if (this.mcp && this.mcp.availableTools) {
      const mcpTools = Object.keys(this.mcp.availableTools);
      if (mcpTools.length > 0) {
        toolsHint += `\n- MCP tools available: ${mcpTools.join(', ')}`;
      }
    }

    return `You are an autonomous AI agent with full access to the project filesystem and shell commands. Your actions directly modify files. Act with care and precision.

**CRITICAL REASONING PROTOCOL — Follow these steps before EVERY tool call:**

**THINK FIRST:**
1. What is the goal? Restate it in one sentence.
2. What do I already know? What am I missing?
3. Do I need to read existing files first to avoid breaking things?
4. Am I using the CORRECT absolute path? Verify against the directory tree above.

**AFTER EACH TOOL:**
- fs_read: Analyze the content. Does it match what you expected? If empty, your path is wrong — check the directory tree.
- fs_write: The file is now saved. If you need to verify it, read it back.
- cmd_run: Check the output. Did it succeed? If there's an error, analyze it and fix the issue before retrying.

**BEST PRACTICES:**
- For coding: write production-quality code with proper error handling, meaningful variable names, and comments for complex logic.
- For debugging: start by reading the code to understand the architecture before making changes.
- For file creation: fs_write creates parent directories automatically.
- For commands: use the project root as cwd.
- For long output commands (grep, find, etc.), be aware the result may be very long.

**Available Tools:**
${toolsHint}

**RULES:**
1. ONE tool call per response. Think carefully before each call.
2. Always fs_read before fs_write — never assume file contents.
3. ALWAYS use absolute paths. The directory tree above shows the project root.
4. If a tool fails, analyze the error and adapt — don't blindly retry the same command. If you get a JSON parsing error, correct your JSON payload.
5. When done, respond with a summary of what you accomplished.
6. Never modify files you haven't read first (unless creating new files). If you need to find where a function is, use \`fs_search\` first.
7. Skip node_modules, .git, and hidden directories — they are not project code.
8. Write clean, readable, maintainable code. Add comments where logic isn't obvious.`;
  }

  requestConfirmation(fnName, args) {
    return new Promise((resolve) => {
      const id = `confirm_${Date.now()}`;
      this.pendingToolConfirmations[id] = resolve;

      this.chat.showToolConfirmation(id, fnName, args, (confirmed) => {
        resolve(confirmed);
        delete this.pendingToolConfirmations[id];
      });
    });
  }

  async executeTool(fnName, args) {
    if (!window.api) throw new Error('API non disponibile');

    switch (fnName) {
      case 'fs_read': {
        const result = await window.api.fsReadFile(args.path);
        if (result.ok) {
          return { output: result.content, message: `File read: ${result.content.length} characters` };
        }
        return { error: result.error };
      }
      case 'fs_write': {
        const result = await window.api.fsWriteFile(args.path, args.content);
        if (result.ok) {
          if (this.chat.onFileCreatedCallback) {
            this.chat.onFileCreatedCallback(args.path, args.content);
          }
          return { message: `File written: ${args.path}` };
        }
        return { error: result.error };
      }
      case 'cmd_run': {
        const result = await window.api.execCommand(args.command, args.cwd);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(no output)';
        const MAX_OUTPUT = 200000;
        const truncated = output.length > MAX_OUTPUT
          ? output.slice(0, MAX_OUTPUT) + '\n\n[... output truncated to ' + MAX_OUTPUT + ' char, total ' + output.length + ' char ...]'
          : output;
        return {
          output: truncated,
          message: `Exit code: ${result.exitCode}`
        };
      }
      case 'fs_search': {
        const cwd = args.path || '.';
        const escapedPattern = args.pattern.replace(/'/g, "'\\''");
        // Using ripgrep or grep recursively, ignoring node_modules and .git
        const cmd = `grep -rnIE --exclude-dir=node_modules --exclude-dir=.git '${escapedPattern}' .`;
        const result = await window.api.execCommand(cmd, cwd);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(no matches found)';
        const MAX_OUTPUT = 100000;
        const truncated = output.length > MAX_OUTPUT
          ? output.slice(0, MAX_OUTPUT) + '\n\n[... output truncated to ' + MAX_OUTPUT + ' char ...]'
          : output;
        return {
          output: truncated,
          message: `Search finished. Exit code: ${result.exitCode}`
        };
      }
      default:
        // Check if it's an MCP tool
        if (this.mcp && this.mcp.availableTools && this.mcp.availableTools[fnName]) {
          return await this.mcp.callTool(fnName, args);
        }
        return { error: `Unknown tool: ${fnName}` };
    }
  }
}
