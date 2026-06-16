// Quoting for free-text search values placed into the external REST
// `or=(<col>.ilike.<value>,...)` filter grammar.
//
// That grammar treats `,` as the value separator and `(` `)` `.` `:` as
// structural, so a search term containing any of them — e.g. "Smith, John" or
// a value with parentheses — is otherwise mis-parsed into the logic tree,
// yielding wrong rows or a 400. Wrapping the value in double quotes makes those
// characters literal; an embedded `"` or `\` is backslash-escaped. The `*`
// wildcards stay outside the escaped span so they keep their substring-match
// meaning — `*` `%` `_` are matched as wildcards exactly as before this fix.
//
// The in-house @kozou/api adapter binds the term as a parameter and never
// builds this grammar, so this helper is specific to the external REST path.

/**
 * Quote a substring-search term as the value of an `ilike` filter:
 * `"*<escaped term>*"`. Escaping uses split/join (no regex) so it stays
 * unambiguously linear.
 */
export function quoteLikeValue(term: string): string {
  const escaped = term.split('\\').join('\\\\').split('"').join('\\"');
  return `"*${escaped}*"`;
}
