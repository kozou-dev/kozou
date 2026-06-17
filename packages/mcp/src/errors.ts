// A deliberate, client-safe error raised by a tool handler. Its message is
// constructed only from the caller's own input (e.g. a not-found
// schema-qualified name), so the request dispatcher surfaces it to the agent
// for self-correction. An *unexpected* error (a programming fault, a zod parse
// failure, a database error) is reported generically instead, because its raw
// text could carry internal or connection detail — see createMcpServer's
// dispatch catch.
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}
