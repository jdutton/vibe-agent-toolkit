/**
 * EXAMPLE PACKAGE - DELETE WHEN USING THIS TEMPLATE
 *
 * This is example code to validate the template setup.
 * When using this template for your project, delete this entire package.
 *
 * String utility functions
 */

/**
 * Capitalize the first letter of a string
 * @param str - The string to capitalize
 * @returns The capitalized string
 */
export function capitalize(str: string): string {
  if (str.length === 0) {
    return str;
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Check if a string is empty or only whitespace
 * @param str - The string to check
 * @returns true if the string is empty or only whitespace
 */
export function isEmpty(str: string): boolean {
  return str.trim().length === 0;
}

/**
 * Truncate a string to a maximum length
 * @param str - The string to truncate
 * @param maxLength - The maximum length
 * @param suffix - The suffix to append (default: '...')
 * @returns The truncated string
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, Math.max(0, maxLength - suffix.length)) + suffix;
}
