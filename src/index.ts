import { tool, type Plugin } from "@opencode-ai/plugin"
import type {
  SessionPromptData,
  SessionMessagesResponses,
  SessionPromptResponses,
  Part,
  TextPart,
  ToolPart,
  ToolStateCompleted,
  ToolStateError,
} from "@opencode-ai/sdk"
import { readFile } from "fs/promises"
import { join } from "path"

const SERVICE = "opencode-advisor"

const ADVISOR_SYSTEM =
  "You are a senior software engineering advisor being consulted by a smaller AI model " +
  "that is actively working on a coding task. It has hit a point where it needs expert guidance.\n\n" +
  "You will be given the full conversation history so far, followed by the specific question.\n\n" +
  "Provide clear, direct, actionable advice. Be concise — the working model will synthesize your " +
  "response into its next steps. Focus on the single highest-leverage insight or direction."

type Messages = SessionMessagesResponses[200]
type PromptResponse = SessionPromptResponses[200]
type PromptBody = NonNullable<SessionPromptData["body"]>

// Mirror opencode's own transcript format from
// packages/opencode/src/cli/cmd/tui/util/transcript.ts
// so the advisor sees the same structured view as a human reading the session.

function formatPart(part: Part, maxToolOutput?: number): string {
  if (part.type === "text") {
    const p = part as TextPart
    if (p.synthetic || !p.text.trim()) return ""
    return `${p.text}\n\n`
  }

  if (part.type === "tool") {
    const p = part as ToolPart
    if (p.tool === "ask_advisor") return "" // skip recursive calls
    let result = `**Tool: ${p.tool}**\n`
    if (p.state.input && Object.keys(p.state.input).length > 0) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(p.state.input, null, 2)}\n\`\`\`\n`
    }
    if (p.state.status === "completed") {
      const state = p.state as ToolStateCompleted
      if (state.output) {
        const output =
          maxToolOutput !== undefined && state.output.length > maxToolOutput
            ? state.output.slice(0, maxToolOutput) + `\n…(truncated, ${state.output.length} chars total)`
            : state.output
        result += `\n**Output:**\n\`\`\`\n${output}\n\`\`\`\n`
      }
    }
    if (p.state.status === "error") {
      const state = p.state as ToolStateError
      result += `\n**Error:**\n\`\`\`\n${state.error}\n\`\`\`\n`
    }
    result += "\n"
    return result
  }

  return ""
}

function formatTranscript(messages: Messages, maxToolOutput?: number): string {
  return messages
    .map(({ info, parts }) => {
      const header = info.role === "user" ? "## User" : "## Assistant"
      const body = parts.map((p) => formatPart(p, maxToolOutput)).join("")
      return body.trim() ? `${header}\n\n${body}` : null
    })
    .filter(Boolean)
    .join("---\n\n")
}

function parseAdvisorModel(str: string): PromptBody["model"] {
  const slash = str.indexOf("/")
  if (slash === -1)
    throw new Error(`Advisor model must be "provider/model" format, got: "${str}"`)
  return { providerID: str.slice(0, slash), modelID: str.slice(slash + 1) }
}

type AdvisorConfig = {
  model: PromptBody["model"]
  modelSource: string
  maxToolOutput: number | undefined
}

async function resolveConfig(directory: string): Promise<AdvisorConfig> {
  let fileConfig: Record<string, unknown> = {}
  try {
    const raw = await readFile(join(directory, ".opencode", "advisor.json"), "utf-8")
    fileConfig = JSON.parse(raw)
  } catch { /* no config file — use defaults */ }

  const modelStr = process.env.ADVISOR_MODEL
    ?? (typeof fileConfig.model === "string" ? fileConfig.model : null)
    ?? "anthropic/claude-opus-4-7"
  const modelSource = process.env.ADVISOR_MODEL
    ? "env:ADVISOR_MODEL"
    : fileConfig.model ? ".opencode/advisor.json" : "default"

  const maxToolOutput = typeof fileConfig.maxToolOutput === "number"
    ? fileConfig.maxToolOutput
    : undefined

  return { model: parseAdvisorModel(modelStr), modelSource, maxToolOutput }
}

export const AdvisorPlugin: Plugin = async ({ client, directory }) => {
  await client.app.log({ body: { service: SERVICE, level: "info", message: "AdvisorPlugin initializing" } })

  let config: AdvisorConfig
  try {
    config = await resolveConfig(directory)
    await client.app.log({
      body: {
        service: SERVICE,
        level: "info",
        message: "Advisor config resolved",
        extra: { ...config.model, source: config.modelSource, maxToolOutput: config.maxToolOutput ?? "none" },
      },
    })
  } catch (err) {
    await client.app.log({ body: { service: SERVICE, level: "error", message: "Failed to resolve advisor config", extra: { error: String(err) } } })
    throw err
  }

  return {
    tool: {
      ask_advisor: tool({
        description:
          "Consult a more powerful model for guidance when you are genuinely stuck, need " +
          "architectural advice, or face a critical decision with non-obvious tradeoffs. " +
          "Use sparingly — only for hard problems where expert input materially changes the outcome. " +
          "Session context is gathered automatically; just state your question.",
        args: {
          question: tool.schema.string(),
        },
        async execute({ question }, { sessionID, directory: dir }) {
          await client.app.log({ body: { service: SERVICE, level: "info", message: "ask_advisor called", extra: { question, sessionID, directory: dir } } })

          // --- Gather current session transcript ---
          let transcript = ""
          try {
            const { data: messages, error } = await client.session.messages({ path: { id: sessionID } })
            if (error) throw error
            await client.app.log({ body: { service: SERVICE, level: "debug", message: "Transcript fetched", extra: { messageCount: messages!.length } } })
            transcript = formatTranscript(messages!, config.maxToolOutput)
          } catch (err) {
            await client.app.log({ body: { service: SERVICE, level: "warn", message: "Failed to fetch transcript — continuing without it", extra: { error: String(err) } } })
          }

          // --- Create advisor session ---
          const { data: session, error: sessionError } = await client.session.create({})
          if (sessionError) {
            await client.app.log({ body: { service: SERVICE, level: "error", message: "Failed to create advisor session", extra: { error: String(sessionError) } } })
            throw sessionError
          }
          const advisorSessionID = session!.id
          await client.app.log({ body: { service: SERVICE, level: "debug", message: "Advisor session created", extra: { advisorSessionID } } })

          // --- Build prompt and call advisor model synchronously ---
          const promptText = [
            ADVISOR_SYSTEM,
            `Working directory: ${dir}`,
            transcript && `--- Session so far ---\n${transcript}\n--- End of session ---`,
            `Question:\n${question}`,
          ]
            .filter(Boolean)
            .join("\n\n")

          await client.app.log({ body: { service: SERVICE, level: "debug", message: "Sending prompt", extra: { advisorSessionID, promptLength: promptText.length, hasTranscript: transcript.length > 0 } } })

          const { data: response, error: promptError } = await client.session.prompt({
            path: { id: advisorSessionID },
            body: {
              model: config.model,
              parts: [{ type: "text", text: promptText }],
            },
          })

          if (promptError) {
            await client.app.log({ body: { service: SERVICE, level: "error", message: "Advisor prompt failed", extra: { error: String(promptError), advisorSessionID } } })
            throw promptError
          }

          // session.prompt() is synchronous — response includes parts directly
          const text = (response as PromptResponse).parts
            .filter((p): p is TextPart => p.type === "text")
            .map((p) => p.text)
            .join("\n")

          await client.app.log({ body: { service: SERVICE, level: "info", message: "ask_advisor complete", extra: { responseLength: text.length } } })
          return text
        },
      }),
    },
  }
}

// v1 plugin module format — opencode resolves this via exports["./server"]
export default {
  id: "opencode-advisor",
  server: AdvisorPlugin,
}
