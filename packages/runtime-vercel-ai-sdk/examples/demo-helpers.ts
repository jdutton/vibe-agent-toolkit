/**
 * Shared helpers for demo scripts
 */

// Colors for terminal output
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

export function log(category: string, message: string, color: string = colors.cyan): void {
  console.log(`${color}${colors.bright}[${category}]${colors.reset} ${message}`);
}

export function section(title: string): void {
  console.log('\n' + '='.repeat(70));
  console.log(`${colors.bright}${colors.blue}${title}${colors.reset}`);
  console.log('='.repeat(70) + '\n');
}
