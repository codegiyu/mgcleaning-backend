/**
 * The From header: `"Name" <address>` when a sender name is set, otherwise the bare
 * address. The name is quoted so characters such as `&` or `,` stay part of it; env
 * validation already refuses quotes, angle brackets, and line breaks in the name.
 */
export function emailSender(address: string, name?: string) {
  return name ? `"${name}" <${address}>` : address;
}
