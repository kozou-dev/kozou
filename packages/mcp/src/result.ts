// The two MCP tool-result shapes, shared by the request dispatcher and the
// `call` execution tool (which decides success vs. error itself).

export type McpToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** A successful tool result: the payload as pretty-printed JSON text. */
export function successResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** An error tool result: a safe, human-readable message. Never carries raw
 *  database text (that goes to stderr) — only a generic, identifier-free
 *  category, mirroring the REST layer's no-leak error contract. */
export function errorResult(message: string): McpToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
